#!/usr/bin/env bash
# Durable checkpoint state and lifecycle transitions.
# Sourced by run.sh; intentionally has no source-time side effects.

# Returns the absolute path to the recovery checkpoint file. The checkpoint
# lives next to the repository lock so it spans linked worktrees and is
# available even when no lock is currently held.
checkpoint_file() {
  printf '%s/%s.checkpoint\n' "$GIT_COMMON_DIR" "$RUNNER_NAME"
}

# Returns the current branch name, falling back to "unknown" when the
# repository is in detached HEAD (e.g. mid-rebase) or unwritable.
current_branch() {
  local branch
  branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [[ -z "$branch" ]]; then
    printf 'unknown\n'
  else
    printf '%s\n' "$branch"
  fi
}

# Resolves the SHA of the configured base branch, falling back to "unknown"
# when the local ref or its origin counterpart cannot be resolved.
current_base_sha() {
  local sha
  if sha="$(git rev-parse --verify --quiet "refs/heads/${BASE_BRANCH}^{commit}" 2>/dev/null)"; then
    printf '%s\n' "$sha"
    return
  fi
  if sha="$(git rev-parse --verify --quiet "refs/remotes/origin/${BASE_BRANCH}^{commit}" 2>/dev/null)"; then
    printf '%s\n' "$sha"
    return
  fi
  printf 'unknown\n'
}

# Writes a newline-separated list as repeated metadata keys. Profile names
# are identifier-safe and contain no newlines, so the checkpoint remains a
# simple line-oriented, non-secret record.
write_checkpoint_list() {
  local key="$1"
  local values="$2"
  local value

  while IFS= read -r value; do
    [[ -n "$value" ]] || continue
    printf '%s=%s\n' "$key" "$value"
  done <<<"$values"
}

# Writes a non-sensitive checkpoint describing the worker's progress. The
# write is atomic: the destination is replaced by `mv` from a sibling temp
# file so partial checkpoints never appear. The function deliberately
# records only identity, branch, lifecycle state, and attempt number; it
# never captures prompts, credentials, tokens, or full tool inputs.
write_checkpoint() {
  local state="$1"
  local target tmp

  target="$(checkpoint_file)"
  tmp="${target}.tmp.$$"
  mkdir -p "$(dirname "$target")"

  CHECKPOINT_STATE="$state"
  {
    printf 'pid=%s\n' "$$"
    printf 'iteration=%s\n' "$ITERATION"
    if [[ "$state" == "lock_lost" ]]; then
      # The lock-loss path cannot prove which branch or issue is still safe
      # to resume. Keep the checkpoint as evidence, not as a recovery target.
      printf 'issue=unknown\n'
    elif [[ -n "${CHECKPOINT_ISSUE:-}" ]]; then
      printf 'issue=%s\n' "${CHECKPOINT_ISSUE}"
    else
      printf 'issue=unknown\n'
    fi
    if [[ "$state" != "lock_lost" && -n "${CHECKPOINT_HU:-}" ]]; then
      printf 'hu=%s\n' "$CHECKPOINT_HU"
    fi
    if [[ "$state" != "lock_lost" && -n "${CHECKPOINT_TICKET:-}" ]]; then
      printf 'ticket=%s\n' "$CHECKPOINT_TICKET"
    fi
    if [[ "$state" == "lock_lost" ]]; then
      printf 'branch=unknown\n'
    else
      printf 'branch=%s\n' "$(current_branch)"
    fi
    printf 'base_branch=%s\n' "$BASE_BRANCH"
    if [[ "$state" == "lock_lost" ]]; then
      printf 'base_sha=unknown\n'
    else
      printf 'base_sha=%s\n' "$(current_base_sha)"
    fi
    if [[ -n "${TRACKER_HU_BRANCH:-}" ]]; then
      printf 'hu_branch=%s\n' "$TRACKER_HU_BRANCH"
    fi
    if [[ -n "${TRACKER_HU_BRANCH_CATEGORY:-}" ]]; then
      printf 'hu_category=%s\n' "$TRACKER_HU_BRANCH_CATEGORY"
    fi
    if [[ -n "${TRACKER_HU_BRANCH_ORIGIN:-}" ]]; then
      printf 'hu_origin=%s\n' "$TRACKER_HU_BRANCH_ORIGIN"
    fi
    if [[ -n "${TRACKER_HU_BRANCH_ORIGIN_SHA:-}" ]]; then
      printf 'hu_origin_sha=%s\n' "$TRACKER_HU_BRANCH_ORIGIN_SHA"
    fi
    if [[ -n "${CHECKPOINT_SESSION_ID:-}" ]]; then
      printf 'session_id=%s\n' "${CHECKPOINT_SESSION_ID}"
      # Persist the CLI that captured the session alongside the id.
      # The orchestrator uses this to reject a cross-CLI resume:
      # a Claude session id is opaque to Codex/OpenCode, so passing
      # it through `--resume` would be silently rejected by the
      # destination CLI and waste an attempt on a guaranteed
      # unresumable_session outcome. Persisted only when a session
      # is present so legacy checkpoints written before this field
      # existed stay readable.
      if [[ -n "${CHECKPOINT_SESSION_CLI:-}" ]]; then
        printf 'session_cli=%s\n' "${CHECKPOINT_SESSION_CLI}"
      fi
    else
      printf 'session_id=unavailable\n'
    fi
    # Persist the profile identity so a restart cannot silently
    # change CLI, model, or fallback chain. Credentials and prompts
    # remain excluded; the runner only records the names and
    # identifiers needed to re-invoke the same profile.
    if [[ -n "${ISSUE_KILLER_PROFILE_NAME:-}" ]]; then
      printf 'profile=%s\n' "$ISSUE_KILLER_PROFILE_NAME"
      printf 'cli=%s\n' "$ISSUE_KILLER_PROFILE_CLI"
      printf 'model=%s\n' "$ISSUE_KILLER_PROFILE_MODEL"
      printf 'command=%s\n' "$ISSUE_KILLER_PROFILE_COMMAND"
      if [[ -n "${ISSUE_KILLER_SELECTED_PROFILE_NAME:-}" ]]; then
        printf 'selected_profile=%s\n' "$ISSUE_KILLER_SELECTED_PROFILE_NAME"
        printf 'fallback_position=%s\n' "${ISSUE_KILLER_FALLBACK_POSITION:-0}"
        write_checkpoint_list fallback_chain "${ISSUE_KILLER_FALLBACK_CHAIN:-}"
        write_checkpoint_list fallback_remaining "${ISSUE_KILLER_FALLBACK_REMAINING:-}"
      fi
      if [[ -n "${ISSUE_KILLER_FAILED_PROFILE:-}" ]]; then
        printf 'failed_profile=%s\n' "$ISSUE_KILLER_FAILED_PROFILE"
      fi
      if [[ -n "${ISSUE_KILLER_NEXT_PROFILE:-}" ]]; then
        printf 'next_profile=%s\n' "$ISSUE_KILLER_NEXT_PROFILE"
      fi
      if [[ -n "${ISSUE_KILLER_FALLBACK_FAILURE:-}" ]]; then
        printf 'fallback_failure=%s\n' "$ISSUE_KILLER_FALLBACK_FAILURE"
      fi
    fi
    printf 'state=%s\n' "$state"
    printf 'updated_at=%s\n' "$(timestamp)"
  } > "$tmp"
  mv -f "$tmp" "$target"
}

# Reads the captured Claude session id from the worker side-channel file
# written by the renderer when the worker's init event exposes one.
read_captured_session_id() {
  local session_file="$1"
  if [[ -s "$session_file" ]]; then
    cat "$session_file"
  fi
}

# Removes the recovery checkpoint. Called after ISSUE_COMPLETED or after a
# verified empty queue. Failures, blocked outcomes, abnormal exits, and
# unknown statuses retain the checkpoint instead.
clear_checkpoint() {
  local target
  target="$(checkpoint_file)"
  rm -f "$target" "${target}.tmp."*
}

# Removes any sibling .tmp.* files left behind by a crashed or interrupted
# write. Safe to invoke on every finalization; if the write completed
# atomically there is nothing to clean up. Called on terminal states so
# an aborted attempt does not pollute the checkpoint directory with stale
# temp files that could shadow a future write.
cleanup_checkpoint_tmp() {
  local target
  target="$(checkpoint_file)"
  rm -f "${target}.tmp."*
}

dirty_worktree_snapshot() {
  git status --porcelain
}

checkpoint_value() {
  local field="$1"
  local file="${2:-}"
  [[ -n "$file" ]] || file="$(checkpoint_file)"
  sed -n "s/^${field}=//p" "$file" 2>/dev/null | head -n 1
}

checkpoint_values() {
  local field="$1"
  local file="${2:-}"
  [[ -n "$file" ]] || file="$(checkpoint_file)"
  sed -n "s/^${field}=//p" "$file" 2>/dev/null
}

# Records the issue number identified by the worker and transitions the
# checkpoint to "issue_selected". The renderer subshell cannot propagate
# variables back to the supervisor, so the issue is also persisted to the
# side-channel file "$output_file.issue" for the parent process to pick up
# after the worker exits. The issue is captured as soon as the assistant
# inspects it through the tracker CLI, before any edit, push, PR creation,
# or merge. This satisfies the "identify before mutation" acceptance
# criterion.
record_identified_issue() {
  local issue_number="$1"
  local output_file="${2:-}"

  if [[ -z "$issue_number" || ! "$issue_number" =~ ^[0-9]+$ ]]; then
    return
  fi

  if [[ -n "${CHECKPOINT_ISSUE:-}" && "$CHECKPOINT_ISSUE" != "$issue_number" ]]; then
    printf '[%s] Ignoring tracker identity %s; issue %s is already fixed for this worker\n' \
      "$RUNNER_NAME" "$issue_number" "$CHECKPOINT_ISSUE" >&2
    return
  fi

  CHECKPOINT_ISSUE="$issue_number"
  write_checkpoint "issue_selected"
  write_lock_status "issue_selected" 0

  if [[ -n "$output_file" ]]; then
    printf '%s' "$issue_number" > "${output_file}.issue"
  fi

  printf '[%s] Identified issue %s\n' "$RUNNER_NAME" "$issue_number"
}

# Advances the checkpoint lifecycle to a new state. Repeated calls for the
# same state are idempotent. When invoked from the renderer subshell, also
# writes the new issue (if any) to the side-channel file so the supervisor
# can pick it up after the worker exits.
advance_checkpoint_state() {
  local next_state="$1"
  local output_file="${2:-}"
  local current="${CHECKPOINT_STATE:-starting}"

  if [[ "$next_state" == "$current" ]]; then
    return
  fi

  CHECKPOINT_STATE="$next_state"
  write_checkpoint "$next_state"
  write_lock_status "$next_state" 0

  if [[ -n "$output_file" && -n "${CHECKPOINT_ISSUE:-}" ]]; then
    printf '%s' "$CHECKPOINT_ISSUE" > "${output_file}.issue"
  fi
}

# Records the final state of an attempt after the worker has exited. If the
# worker reached a progressed state (issue_selected, mutating, branch_pushed,
# pr_created, pr_merged, or issue_closed), the most-progressed state is
# preserved as the "last safe state" so the next restart can determine
# whether recovery is safe. The terminal state is recorded only when no
# progressed state was reached (i.e. the worker never identified its issue
# or completed any mutation). This satisfies the "last safe state"
# acceptance criterion for transient, failed, killed, and malformed
# outcomes.
finalize_attempt_state() {
  local terminal_state="$1"
  local current="${CHECKPOINT_STATE:-starting}"

  cleanup_checkpoint_tmp

  case "$current" in
    starting|issue_selected)
      CHECKPOINT_STATE="$terminal_state"
      write_checkpoint "$terminal_state"
      write_lock_status "$terminal_state" 0
      ;;
    *)
      write_checkpoint "$current"
      write_lock_status "$current" 0
      ;;
  esac
}
