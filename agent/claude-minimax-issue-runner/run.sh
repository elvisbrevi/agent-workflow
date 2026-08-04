#!/usr/bin/env bash
set -euo pipefail

RUNNER_NAME="claude-minimax-issue-runner"
# The status marker is the generic ISSUE_KILLER_STATUS namespace; later
# tickets will rename the executable to `issue-killer` while keeping the
# orchestrator's behavior stable. The orchestrator must not depend on the
# Claude-specific historical name.
STATUS_PREFIX="ISSUE_KILLER_STATUS="
LOCK_HELD=false
LOCK_TOKEN=""

die() {
  printf '%s: %s\n' "$RUNNER_NAME" "$*" >&2
  exit 1
}

resolve_script_dir() {
  local source_path="${BASH_SOURCE[0]}"
  local source_dir link_target

  while [[ -L "$source_path" ]]; do
    source_dir="$(cd -P "$(dirname "$source_path")" && pwd)"
    link_target="$(readlink "$source_path")"
    if [[ "$link_target" == /* ]]; then
      source_path="$link_target"
    else
      source_path="${source_dir}/${link_target}"
    fi
  done

  cd -P "$(dirname "$source_path")" && pwd
}

is_non_negative_integer() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

timestamp() {
  date '+%Y-%m-%d %H:%M:%S %z'
}

write_lock_status() {
  local state="$1"
  local elapsed="${2:-0}"
  local status_tmp

  [[ "$LOCK_HELD" == "true" ]] || return
  status_tmp="${LOCK_DIR}/status.$$"
  {
    printf 'pid=%s\n' "$$"
    printf 'state=%s\n' "$state"
    printf 'iteration=%s\n' "$ITERATION"
    printf 'elapsed_seconds=%s\n' "$elapsed"
    printf 'updated_at=%s\n' "$(timestamp)"
    if [[ -n "${CHECKPOINT_ISSUE:-}" ]]; then
      printf 'issue=%s\n' "${CHECKPOINT_ISSUE}"
    fi
    printf 'branch=%s\n' "$(current_branch)"
    printf 'base_branch=%s\n' "$BASE_BRANCH"
    if [[ -n "${RECOVERY_ATTEMPT:-}" && "${RECOVERY_ATTEMPT:-0}" -gt 0 ]]; then
      printf 'recovery_attempt=%s\n' "${RECOVERY_ATTEMPT}"
    fi
    if [[ -n "${RECOVERY_DELAY:-}" ]]; then
      printf 'recovery_delay=%s\n' "${RECOVERY_DELAY}"
    fi
    if [[ -n "${RECOVERY_CATEGORY:-}" ]]; then
      printf 'recovery_category=%s\n' "${RECOVERY_CATEGORY}"
    fi
    if [[ -n "${ISSUE_KILLER_PROFILE_NAME:-}" ]]; then
      printf 'profile=%s\n' "$ISSUE_KILLER_PROFILE_NAME"
      printf 'cli=%s\n' "$ISSUE_KILLER_PROFILE_CLI"
      printf 'model=%s\n' "$ISSUE_KILLER_PROFILE_MODEL"
    fi
  } > "$status_tmp"
  mv -f "$status_tmp" "${LOCK_DIR}/status"
}

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
    if [[ -n "${CHECKPOINT_ISSUE:-}" ]]; then
      printf 'issue=%s\n' "${CHECKPOINT_ISSUE}"
    else
      printf 'issue=unknown\n'
    fi
    printf 'branch=%s\n' "$(current_branch)"
    printf 'base_branch=%s\n' "$BASE_BRANCH"
    printf 'base_sha=%s\n' "$(current_base_sha)"
    if [[ -n "${CHECKPOINT_SESSION_ID:-}" ]]; then
      printf 'session_id=%s\n' "${CHECKPOINT_SESSION_ID}"
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
    fi
    printf 'state=%s\n' "$state"
    printf 'updated_at=%s\n' "$(timestamp)"
  } > "$tmp"
  mv -f "$tmp" "$target"
}

# Returns the comma-separated default transient transport failure signatures
# that are considered safe to retry with bounded backoff. Unknown process
# failures, semantic failures, and human-input blockers must never match
# these patterns. Patterns are matched as extended POSIX regular
# expressions against the worker output; case-insensitive.
default_transient_patterns() {
  printf '%s\n' \
    'connection[[:space:]]+(closed|reset|refused|aborted|hangup)' \
    'read[[:space:]]+timeout' \
    'write[[:space:]]+timeout' \
    'timed?[[:space:]]+out' \
    'econnreset' \
    'econnrefused' \
    'etimedout' \
    'enotfound' \
    'eai_again' \
    'broken[[:space:]]+pipe' \
    'unexpected[[:space:]]+eof' \
    'tls[[:space:]]+handshake' \
    'stream[[:space:]]+(closed|hangup|reset)' \
    'network[[:space:]]+(error|unreachable|down)' \
    'server[[:space:]]+(disconnect|hangup|reset)' \
    'socket[[:space:]]+hangup'
}

# Parses a comma-separated list of retry delays (in seconds) into the
# global RETRY_DELAY_VALUES array. Returns 0 on success, 1 on a malformed
# value. Empty input or whitespace-only entries are rejected.
parse_retry_delays() {
  local raw="$1"
  local entry
  RETRY_DELAY_VALUES=()

  if [[ -z "$raw" ]]; then
    printf '%s: ISSUE_RUNNER_RETRY_DELAYS must be a comma-separated list\n' \
      "$RUNNER_NAME" >&2
    return 1
  fi

  IFS=',' read -r -a entries <<<"$raw"
  for entry in "${entries[@]}"; do
    entry="${entry//[[:space:]]/}"
    if [[ ! "$entry" =~ ^[0-9]+$ ]] || [[ "$entry" -eq 0 ]]; then
      printf '%s: invalid retry delay: %s\n' "$RUNNER_NAME" "$entry" >&2
      return 1
    fi
    RETRY_DELAY_VALUES+=("$entry")
  done

  [[ "${#RETRY_DELAY_VALUES[@]}" -gt 0 ]] || return 1
}

# Parses a newline-separated list of transient regex patterns into the
# global TRANSIENT_PATTERN_VALUES array. Empty input means "use defaults".
parse_transient_patterns() {
  local raw="$1"
  local line
  TRANSIENT_PATTERN_VALUES=()

  if [[ -z "$raw" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] && TRANSIENT_PATTERN_VALUES+=("$line")
    done < <(default_transient_patterns)
    return 0
  fi

  while IFS= read -r line; do
    [[ -n "$line" ]] && TRANSIENT_PATTERN_VALUES+=("$line")
  done <<<"$raw"
}

# Returns 0 when any line of $1 matches any allowed transient pattern. The
# match is performed with POSIX extended regular expressions (case
# insensitive) and is intentionally restricted to the worker output — the
# failure category is computed solely from what the worker printed, not
# from any external signal or heuristic.
output_matches_transient_pattern() {
  local output_file="$1"
  local pattern
  [[ -r "$output_file" ]] || return 1
  for pattern in "${TRANSIENT_PATTERN_VALUES[@]}"; do
    if grep -Eqi -- "$pattern" "$output_file" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

# Classifies the outcome of a finished worker attempt. Returns one of:
#   completed               - worker emitted ISSUE_COMPLETED or QUEUE_EMPTY
#   blocked                 - worker emitted BLOCKED
#   failed                  - worker emitted FAILED
#   invalid_marker          - worker exited 0 with no recognized status
#   non_transient_exit      - worker exited non-zero without a transient signature
#   transient_transport     - worker exited non-zero with a transient signature
# The category is the single source of truth for the retry orchestrator.
classify_failure() {
  local output_file="$1"
  local exit_code="$2"
  local status_marker="$3"

  case "$status_marker" in
    ISSUE_COMPLETED|QUEUE_EMPTY)
      printf 'completed\n'
      return 0
      ;;
    BLOCKED)
      printf 'blocked\n'
      return 0
      ;;
    FAILED)
      printf 'failed\n'
      return 0
      ;;
  esac

  if [[ "$exit_code" -eq 0 ]]; then
    printf 'invalid_marker\n'
    return 0
  fi

  if output_matches_transient_pattern "$output_file"; then
    printf 'transient_transport\n'
  else
    printf 'non_transient_exit\n'
  fi
}

# Returns 0 when the captured Claude session is safe to resume: the
# checkpoint carries a session id, the branch matches the worktree, and the
# base SHA still resolves. Returns 1 otherwise (a fresh recovery worker
# must be launched instead).
is_session_resumable() {
  local session_id="$1"
  local checkpoint_branch="$2"
  local checkpoint_base_sha="$3"

  [[ -n "$session_id" && "$session_id" != "unavailable" ]] || return 1
  [[ -n "$checkpoint_branch" && "$checkpoint_branch" != "unknown" ]] || return 1
  local current
  current="$(current_branch)"
  [[ "$current" == "$checkpoint_branch" ]] || return 1
  if [[ -n "$checkpoint_base_sha" && "$checkpoint_base_sha" != "unknown" ]]; then
    git rev-parse --verify --quiet "${checkpoint_base_sha}^{commit}" >/dev/null 2>&1 || \
      return 1
  fi
  return 0
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

release_repository_lock() {
  local current_token

  [[ "$LOCK_HELD" == "true" ]] || return
  current_token="$(
    sed -n 's/^token=//p' "${LOCK_DIR}/owner" 2>/dev/null | head -n 1
  )"
  if [[ "$current_token" == "$LOCK_TOKEN" ]]; then
    rm -f "${LOCK_DIR}/status" "${LOCK_DIR}/status.$$" "${LOCK_DIR}/owner"
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
  if declare -F tracker_cleanup_worker_environment >/dev/null 2>&1; then
    tracker_cleanup_worker_environment
  fi
  LOCK_HELD=false
}

report_active_lock() {
  local owner_pid="$1"

  printf '%s: another runner is active for this repository (pid %s)\n' \
    "$RUNNER_NAME" "${owner_pid:-unknown}" >&2
  if [[ -r "${LOCK_DIR}/status" ]]; then
    sed 's/^/  /' "${LOCK_DIR}/status" >&2
  fi
  exit 1
}

acquire_repository_lock() {
  local owner_file owner_pid owner_snapshot current_snapshot

  LOCK_DIR="${GIT_COMMON_DIR}/${RUNNER_NAME}.lock"
  owner_file="${LOCK_DIR}/owner"
  LOCK_TOKEN="$$-$(date +%s)"

  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if [[ ! -r "$owner_file" ]]; then
      sleep 1
      [[ -r "$owner_file" ]] || \
        die "repository lock exists without readable owner metadata: ${LOCK_DIR}"
    fi

    owner_snapshot="$(<"$owner_file")"
    owner_pid="$(
      sed -n 's/^pid=//p' "$owner_file" 2>/dev/null | head -n 1
    )"
    if is_non_negative_integer "${owner_pid:-}" &&
       kill -0 "$owner_pid" 2>/dev/null; then
      report_active_lock "$owner_pid"
    fi

    current_snapshot="$(<"$owner_file")"
    if [[ "$current_snapshot" != "$owner_snapshot" ]]; then
      continue
    fi

    rm -f "${LOCK_DIR}/status" "$owner_file"
    if ! rmdir "$LOCK_DIR" 2>/dev/null; then
      die "unable to recover stale repository lock: ${LOCK_DIR}"
    fi
    printf '[%s] Recovered stale repository lock (previous pid %s).\n' \
      "$RUNNER_NAME" "${owner_pid:-unknown}"
  done

  {
    printf 'pid=%s\n' "$$"
    printf 'token=%s\n' "$LOCK_TOKEN"
    printf 'repository=%s\n' "$REPO_ROOT"
    printf 'started_at=%s\n' "$(timestamp)"
  } > "$owner_file"
  LOCK_HELD=true
  trap release_repository_lock EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  write_lock_status "starting" 0
  printf '[%s] Repository lock acquired: %s (pid %s)\n' \
    "$RUNNER_NAME" "$LOCK_DIR" "$$"
}

confirm_destructive_run() {
  local answer

  if [[ "${ISSUE_RUNNER_ASSUME_YES:-false}" == "true" ]]; then
    return
  fi

  if [[ ! -r /dev/tty ]]; then
    die "confirmation requires a TTY; set ISSUE_RUNNER_ASSUME_YES=true only after explicit authorization"
  fi

  printf 'About to launch issue-killer repeatedly against %s with these settings:\n' "$REPO_ROOT" >/dev/tty
  printf '  profile:      %s (%s)\n' \
    "$ISSUE_KILLER_PROFILE_NAME" "$ISSUE_KILLER_PROFILE_LABEL" >/dev/tty
  printf '  cli:          %s\n' "$ISSUE_KILLER_PROFILE_CLI" >/dev/tty
  printf '  model:        %s\n' "$ISSUE_KILLER_PROFILE_MODEL" >/dev/tty
  printf '  autonomy:     permission_mode=%s\n' "$PERMISSION_MODE" >/dev/tty
  printf '  tracker:      %s\n' "${TRACKER_KIND:-unknown}" >/dev/tty
  printf '  base branch:  %s\n' "$BASE_BRANCH" >/dev/tty
  if [[ -n "$ISSUE_KILLER_PROFILE_FALLBACKS" ]]; then
    printf '  fallbacks:    %s\n' \
      "$(printf '%s, ' $ISSUE_KILLER_PROFILE_FALLBACKS | sed 's/, $//')" >/dev/tty
  fi
  printf 'This will repeatedly merge PRs into %s and close issues. Continue? [y/N] ' \
    "$BASE_BRANCH" >/dev/tty
  IFS= read -r answer </dev/tty || die "unable to read confirmation"
  [[ "$answer" =~ ^[Yy]$ ]] || die "cancelled"
}

assert_clean_worktree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    die "worktree is not clean; refusing to launch another worker"
  fi
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

emit_recovery_required() {
  local message="$1"
  local checkpoint="${2:-$(checkpoint_file)}"

  printf '%s: RECOVERY_REQUIRED: %s\n' "$RUNNER_NAME" "$message" >&2
  if [[ -r "$checkpoint" ]]; then
    printf '%s: checkpoint retained at %s\n' "$RUNNER_NAME" "$checkpoint" >&2
  fi
  exit 4
}

require_recovery_tty_confirmation() {
  local prompt="$1"
  local answer

  if [[ -r /dev/tty && -w /dev/tty ]]; then
    printf '%s Continue? [y/N] ' "$prompt" >/dev/tty || \
      emit_recovery_required "TTY confirmation is required before recovery can continue"
    IFS= read -r answer </dev/tty || \
      emit_recovery_required "unable to read TTY confirmation for recovery"
  elif [[ -t 0 && -t 1 ]]; then
    printf '%s Continue? [y/N] ' "$prompt" || \
      emit_recovery_required "TTY confirmation is required before recovery can continue"
    IFS= read -r answer || \
      emit_recovery_required "unable to read TTY confirmation for recovery"
  else
    emit_recovery_required "TTY confirmation is required before recovery can continue"
  fi

  [[ "$answer" =~ ^[Yy]$ ]] || \
    emit_recovery_required "operator declined recovery confirmation"
}

validate_checkpoint_for_dirty_recovery() {
  local checkpoint="$1"
  local issue branch base_branch base_sha state
  local current profile cli model command_name

  [[ -r "$checkpoint" ]] || \
    emit_recovery_required "dirty worktree requires a readable checkpoint or explicit legacy adoption"

  issue="$(checkpoint_value issue "$checkpoint")"
  branch="$(checkpoint_value branch "$checkpoint")"
  base_branch="$(checkpoint_value base_branch "$checkpoint")"
  base_sha="$(checkpoint_value base_sha "$checkpoint")"
  state="$(checkpoint_value state "$checkpoint")"
  current="$(current_branch)"

  [[ "$issue" =~ ^[0-9]+$ ]] || \
    emit_recovery_required "checkpoint is missing a concrete issue number"
  [[ -n "$branch" && "$branch" != "unknown" ]] || \
    emit_recovery_required "checkpoint is missing a concrete branch"
  [[ "$current" == "$branch" ]] || \
    emit_recovery_required "checkpoint branch ${branch} does not match current branch ${current}"
  [[ "$base_branch" == "$BASE_BRANCH" ]] || \
    emit_recovery_required "checkpoint base branch ${base_branch:-unknown} does not match configured base ${BASE_BRANCH}"
  [[ -n "$base_sha" && "$base_sha" != "unknown" ]] || \
    emit_recovery_required "checkpoint is missing a concrete base SHA"
  git rev-parse --verify --quiet "${base_sha}^{commit}" >/dev/null 2>&1 || \
    emit_recovery_required "checkpoint base SHA ${base_sha} is stale or unavailable"
  [[ -n "$state" ]] || \
    emit_recovery_required "checkpoint is missing a lifecycle state"

  # Checkpoints written before the profile migration may not carry
  # the profile/CLI/model fields. A legacy checkpoint is allowed
  # here only when no profile was selected for the current run; any
  # mismatch between the live profile and the persisted identity
  # fails closed so a restart cannot silently change the runtime.
  profile="$(checkpoint_value profile "$checkpoint")"
  cli="$(checkpoint_value cli "$checkpoint")"
  model="$(checkpoint_value model "$checkpoint")"
  command_name="$(checkpoint_value command "$checkpoint")"
  if [[ -n "$profile" || -n "$cli" || -n "$model" || -n "$command_name" ]]; then
    [[ "$profile" == "$ISSUE_KILLER_PROFILE_NAME" ]] || \
      emit_recovery_required "checkpoint profile ${profile:-unknown} does not match selected profile ${ISSUE_KILLER_PROFILE_NAME:-unknown}"
    [[ "$cli" == "$ISSUE_KILLER_PROFILE_CLI" ]] || \
      emit_recovery_required "checkpoint cli ${cli:-unknown} does not match selected cli ${ISSUE_KILLER_PROFILE_CLI:-unknown}"
    [[ "$model" == "$ISSUE_KILLER_PROFILE_MODEL" ]] || \
      emit_recovery_required "checkpoint model ${model:-unknown} does not match selected model ${ISSUE_KILLER_PROFILE_MODEL:-unknown}"
    [[ "$command_name" == "$ISSUE_KILLER_PROFILE_COMMAND" ]] || \
      emit_recovery_required "checkpoint command ${command_name:-unknown} does not match selected command ${ISSUE_KILLER_PROFILE_COMMAND:-unknown}"
  fi
}

write_legacy_checkpoint() {
  local issue_number="$1"
  local target tmp

  target="$(checkpoint_file)"
  tmp="${target}.tmp.$$"
  mkdir -p "$(dirname "$target")"
  {
    printf 'pid=%s\n' "$$"
    printf 'iteration=1\n'
    printf 'issue=%s\n' "$issue_number"
    printf 'branch=%s\n' "$(current_branch)"
    printf 'base_branch=%s\n' "$BASE_BRANCH"
    printf 'base_sha=%s\n' "$(current_base_sha)"
    printf 'session_id=unavailable\n'
    printf 'state=legacy_adopted\n'
    if [[ -n "${ISSUE_KILLER_PROFILE_NAME:-}" ]]; then
      printf 'profile=%s\n' "$ISSUE_KILLER_PROFILE_NAME"
      printf 'cli=%s\n' "$ISSUE_KILLER_PROFILE_CLI"
      printf 'model=%s\n' "$ISSUE_KILLER_PROFILE_MODEL"
      printf 'command=%s\n' "$ISSUE_KILLER_PROFILE_COMMAND"
    fi
    printf 'updated_at=%s\n' "$(timestamp)"
  } > "$tmp"
  mv -f "$tmp" "$target"
}

prepare_dirty_startup_recovery() {
  local checkpoint
  local dirty_files
  local issue branch base_sha state session_id strategy

  STARTUP_RECOVERY_MODE=""
  STARTUP_RECOVERY_ISSUE=""
  STARTUP_RECOVERY_SESSION=""
  STARTUP_RECOVERY_PROMPT=""

  dirty_files="$(dirty_worktree_snapshot)"
  [[ -n "$dirty_files" ]] || return 0

  checkpoint="$(checkpoint_file)"
  if [[ -r "$checkpoint" ]]; then
    validate_checkpoint_for_dirty_recovery "$checkpoint"
    issue="$(checkpoint_value issue "$checkpoint")"
    branch="$(checkpoint_value branch "$checkpoint")"
    base_sha="$(checkpoint_value base_sha "$checkpoint")"
    state="$(checkpoint_value state "$checkpoint")"
    session_id="$(checkpoint_value session_id "$checkpoint")"
    if is_session_resumable "$session_id" "$branch" "$base_sha"; then
      strategy="resume captured Claude session"
      STARTUP_RECOVERY_SESSION="$session_id"
    else
      strategy="launch fresh recovery worker constrained to checkpointed issue"
      STARTUP_RECOVERY_SESSION=""
    fi

    printf '[%s] Restart recovery target: issue %s, branch %s, base SHA %s, state %s, strategy: %s\n' \
      "$RUNNER_NAME" "$issue" "$branch" "$base_sha" "$state" "$strategy"
    printf '[%s] Dirty files to preserve:\n%s\n' "$RUNNER_NAME" "$dirty_files"
    tracker_reconcile_startup_state "$issue" "$branch"
    require_recovery_tty_confirmation \
      "Recover issue ${issue} on branch ${branch} from checkpoint state ${state} using strategy '${strategy}'."

    STARTUP_RECOVERY_MODE="checkpoint"
    STARTUP_RECOVERY_ISSUE="$issue"
    STARTUP_RECOVERY_PROMPT="Restart recovery:
- Continue exactly issue #${issue}; do not select another issue.
- Preserve and inspect the existing dirty files; do not discard, reset, stash, or overwrite partial work.
- The checkpoint branch is ${branch}, base SHA is ${base_sha}, and last state is ${state}.
- Reconcile live issue and PR state before any mutation, then complete the existing work."
    return 0
  fi

  if [[ -z "${ISSUE_RUNNER_ADOPT_ISSUE:-}" ]]; then
    printf '[%s] Dirty files without checkpoint:\n%s\n' "$RUNNER_NAME" "$dirty_files" >&2
    emit_recovery_required "legacy adoption requires ISSUE_RUNNER_ADOPT_ISSUE; refusing to infer the issue from branch, files, or queue order"
  fi
  [[ "${ISSUE_RUNNER_ADOPT_ISSUE}" =~ ^[0-9]+$ ]] || \
    emit_recovery_required "ISSUE_RUNNER_ADOPT_ISSUE must be a numeric issue number"

  issue="$ISSUE_RUNNER_ADOPT_ISSUE"
  branch="$(current_branch)"
  [[ "$branch" != "unknown" ]] || \
    emit_recovery_required "legacy adoption requires a named branch"
  printf '[%s] Legacy adoption target: issue %s, branch %s, base SHA %s, strategy: fresh recovery worker\n' \
    "$RUNNER_NAME" "$issue" "$branch" "$(current_base_sha)"
  printf '[%s] Dirty files to preserve:\n%s\n' "$RUNNER_NAME" "$dirty_files"
  tracker_reconcile_startup_state "$issue" "$branch"
  require_recovery_tty_confirmation \
    "Adopt existing dirty work as issue ${issue} on branch ${branch}."
  write_legacy_checkpoint "$issue"

  STARTUP_RECOVERY_MODE="legacy"
  STARTUP_RECOVERY_ISSUE="$issue"
  STARTUP_RECOVERY_SESSION=""
  STARTUP_RECOVERY_PROMPT="Legacy recovery adoption:
- Continue exactly issue #${issue}; do not select another issue.
- Preserve and inspect the existing dirty files; do not discard, reset, stash, or overwrite partial work.
- This is a synthetic checkpoint with no resumable session.
- Reconcile live issue and PR state before any mutation, then complete the existing work."
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

# Backward-compatible alias for the historical `redact_secrets` name. The
# runtime adapter exposes the implementation under the generic
# `runtime_redact` function; orchestration code that still imports the
# old name keeps working through this shim.
redact_secrets() {
  runtime_redact
}

run_worker_with_progress() {
  local prompt="$1"
  local output_file="$2"
  local session_id="${3:-}"
  local exit_file="${output_file}.exit"
  local touch_file="${output_file}.touch"
  local pipeline_pid heartbeat_pid=""
  local started_at now elapsed pipeline_exit sink

  started_at="$(date +%s)"
  rm -f "$touch_file" "$exit_file" "${output_file}.session"
  write_lock_status "worker_running" 0

  if [[ "$STREAM_OUTPUT" == "true" ]]; then
    sink=runtime_render_stream
  else
    sink=tee
  fi

  {
    set +e
    runtime_invoke "$prompt" "$session_id"
    printf '%s\n' "$?" > "$exit_file"
  } 2>&1 | "$sink" "$output_file" &
  pipeline_pid=$!

  if [[ "$PROGRESS_INTERVAL" -gt 0 ]]; then
    (
      while sleep "$PROGRESS_INTERVAL"; do
        kill -0 "$pipeline_pid" 2>/dev/null || exit 0
        now="$(date +%s)"
        elapsed=$((now - started_at))
        write_lock_status "worker_running" "$elapsed"
        # Suppress the heartbeat while the stream is still producing events.
        if [[ "$STREAM_OUTPUT" == "true" && -e "$touch_file" ]]; then
          : > "$touch_file"
          continue
        fi
        printf '\n[%s] Worker %s still running (elapsed %ss; live output above).\n' \
          "$RUNNER_NAME" "$ITERATION" "$elapsed"
      done
    ) &
    heartbeat_pid=$!
  fi

  set +e
  wait "$pipeline_pid"
  pipeline_exit=$?
  set -e

  if [[ -n "$heartbeat_pid" ]]; then
    kill "$heartbeat_pid" 2>/dev/null || true
    wait "$heartbeat_pid" 2>/dev/null || true
  fi

  now="$(date +%s)"
  elapsed=$((now - started_at))
  if [[ -r "$exit_file" ]]; then
    WORKER_EXIT="$(<"$exit_file")"
  else
    WORKER_EXIT="$pipeline_exit"
  fi
  rm -f "$exit_file" "$touch_file"
  write_lock_status "worker_finished" "$elapsed"
  printf '[%s] Worker %s exited after %ss (code %s).\n' \
    "$RUNNER_NAME" "$ITERATION" "$elapsed" "$WORKER_EXIT"
}

# Drives the worker with optional transient retry and reconciliation. The
# function loops until the worker produces a recognized status, exits with
# a non-retryable failure, or exhausts the configured retry budget.
# Returns 0 when the runner should advance normally to the status case
# statement, and non-zero when retries are exhausted and the supervisor
# must emit RECOVERY_REQUIRED.
attempt_with_recovery() {
  local prompt="$1"
  local output_file="$2"
  local initial_session_id="${3:-}"
  local session_id="$initial_session_id"
  local attempt=0
  local max_attempts=$(( ${#RETRY_DELAY_VALUES[@]} + 1 ))
  local configured_limit=""
  local category reconciled last_safe
  local checkpoint_branch checkpoint_base_sha resume_session

  # The configured retry limit caps the total number of attempts
  # including the initial attempt. An empty value means "use the
  # declared delay count plus one initial attempt". Setting the limit
  # explicitly is useful for tests and for operators who want fewer
  # retries than the default schedule allows.
  configured_limit="${ISSUE_RUNNER_RETRY_LIMIT:-}"
  if [[ -n "$configured_limit" ]]; then
    max_attempts="$configured_limit"
  fi

  while true; do
    attempt=$((attempt + 1))
    RECOVERY_ATTEMPT="$attempt"
    RECOVERY_DELAY=""
    RECOVERY_CATEGORY=""

    # Decide whether the captured Claude session is safe to resume. The
    # first attempt has no checkpoint session and always launches fresh.
    resume_session=""
    if [[ "$attempt" -eq 1 && -n "$initial_session_id" ]]; then
      resume_session="$initial_session_id"
    elif [[ "$attempt" -gt 1 && -n "${CHECKPOINT_SESSION_ID:-}" ]]; then
      checkpoint_branch="$(sed -n 's/^branch=//p' "$(checkpoint_file)" 2>/dev/null | head -n 1)"
      checkpoint_base_sha="$(sed -n 's/^base_sha=//p' "$(checkpoint_file)" 2>/dev/null | head -n 1)"
      if is_session_resumable "${CHECKPOINT_SESSION_ID}" "$checkpoint_branch" "$checkpoint_base_sha"; then
        resume_session="${CHECKPOINT_SESSION_ID}"
      fi
    fi

    if [[ -n "$resume_session" && "$attempt" -eq 1 && -n "$initial_session_id" ]]; then
      printf '[%s] Restart recovery resuming Claude session %s\n' \
        "$RUNNER_NAME" "$resume_session"
    elif [[ -n "$resume_session" ]]; then
      printf '[%s] Recovery attempt %s resuming Claude session %s\n' \
        "$RUNNER_NAME" "$attempt" "$resume_session"
    elif [[ "$attempt" -gt 1 ]]; then
      printf '[%s] Recovery attempt %s launching a fresh Claude worker\n' \
        "$RUNNER_NAME" "$attempt"
    fi

    run_worker_with_progress "$prompt" "$output_file" "$resume_session"

    # Adopt the issue identity from the renderer side-channel. The
    # renderer's CHECKPOINT_ISSUE write does not propagate back to the
    # supervisor because it runs in a subshell; reading the file is
    # the only way to keep the in-memory variable aligned with the
    # persisted checkpoint before any recovery-related lock snapshot.
    # A short drain loop waits for the renderer's pipe-buffered writes
    # to flush when the worker exited before any item-read event
    # was processed (e.g. an immediate transport failure on a fresh
    # checkout).
    local waited=0
    while [[ $waited -lt 20 && -z "${CHECKPOINT_ISSUE:-}" && ! -s "${output_file}.issue" ]]; do
      sleep 0.05
      waited=$((waited + 1))
    done
    if [[ -s "${output_file}.issue" ]]; then
      CHECKPOINT_ISSUE="$(<"${output_file}.issue")"
    fi

    # Adopt the captured session id from the worker side-channel so the
    # next attempt (if any) can resume it.
    session_id="$(read_captured_session_id "${output_file}.session")"
    if [[ -n "$session_id" ]]; then
      CHECKPOINT_SESSION_ID="$session_id"
      write_checkpoint "${CHECKPOINT_STATE:-starting}"
    fi

    WORKER_STATUS="$(
      sed -n "s/^${STATUS_PREFIX}//p" "$output_file" | tail -n 1
    )"

    category="$(classify_failure "$output_file" "$WORKER_EXIT" "$WORKER_STATUS")"
    RECOVERY_CATEGORY="$category"

    case "$category" in
      completed)
        # Preserve the most-progressed safe state we reached.
        last_safe="${CHECKPOINT_STATE:-starting}"
        case "$last_safe" in
          starting) write_checkpoint "starting" ;;
          *) write_checkpoint "$last_safe" ;;
        esac
        write_lock_status "worker_finished" 0
        return 0
        ;;
      blocked)
        finalize_attempt_state "blocked"
        return 0
        ;;
      failed)
        finalize_attempt_state "failed"
        return 0
        ;;
      invalid_marker)
        finalize_attempt_state "malformed"
        return 0
        ;;
      non_transient_exit)
        finalize_attempt_state "failed"
        return 0
        ;;
      transient_transport)
        # Fall through to retry handling below.
        :
        ;;
    esac

    printf '[%s] Recovering from transient transport failure (attempt %s of %s)\n' \
      "$RUNNER_NAME" "$attempt" "$max_attempts"

    # Treat a checkpoint that already reached the PR-merged or
    # issue-closed lifecycle as a no-op recovery: the previous attempt
    # completed the issue before it died, so retrying would only duplicate
    # side effects (push, PR creation, merge, issue close). This is the
    # cheapest, safest reconciliation because it does not require the
    # tracker CLI or external state to be reachable. Read the persisted
    # checkpoint directly so a pre-existing checkpoint (e.g. from a
    # previous restart) is respected even after the in-memory
    # CHECKPOINT_STATE has been reset by the main loop.
    local persisted_state=""
    if [[ -r "$(checkpoint_file)" ]]; then
      persisted_state="$(sed -n 's/^state=//p' "$(checkpoint_file)" 2>/dev/null | head -n 1)"
    fi
    if [[ "$TRACKER_KIND" != "azure-devops" ]]; then
      case "${persisted_state:-${CHECKPOINT_STATE:-}}" in
        pr_merged|issue_closed)
          printf '[%s] Recovery detected an already-completed issue (checkpoint state=%s); advancing without retry\n' \
            "$RUNNER_NAME" "${persisted_state:-${CHECKPOINT_STATE:-}}"
          write_lock_status "worker_finished" 0
          printf '%s\n' "${STATUS_PREFIX}ISSUE_COMPLETED" >> "$output_file"
          WORKER_STATUS="ISSUE_COMPLETED"
          WORKER_EXIT=0
          return 0
          ;;
      esac
    fi

    # Reconcile the checkpoint against live Git, PR, and issue state before
    # touching the worktree again. A "completed" reconciliation means the
    # previous attempt already finished the work; surface it as a normal
    # completion without launching another worker.
    printf '[%s] Reconciling recovery state against branch, PR, and issue tracker\n' \
      "$RUNNER_NAME"
    reconciled="$(tracker_reconcile_recovery_state "${CHECKPOINT_ISSUE:-}")"
    if [[ "$reconciled" == "completed" ]]; then
      printf '[%s] Recovery detected an already-completed issue; advancing without retry\n' \
        "$RUNNER_NAME"
      last_safe="${CHECKPOINT_STATE:-starting}"
      case "$last_safe" in
        starting) write_checkpoint "starting" ;;
        *) write_checkpoint "$last_safe" ;;
      esac
      write_lock_status "worker_finished" 0
      # Inject a synthetic ISSUE_COMPLETED so the caller's case statement
      # clears the checkpoint and advances.
      printf '%s\n' "${STATUS_PREFIX}ISSUE_COMPLETED" >> "$output_file"
      WORKER_STATUS="ISSUE_COMPLETED"
      WORKER_EXIT=0
      return 0
    fi

    if [[ "$TRACKER_KIND" == "azure-devops" && "${CHECKPOINT_ISSUE:-}" =~ ^[0-9]+$ ]]; then
      RECOVERY_CATEGORY="recovery_required"
      return 1
    fi

    if [[ "$attempt" -ge "$max_attempts" ]]; then
      RECOVERY_CATEGORY="recovery_required"
      return 1
    fi

    RECOVERY_DELAY="${RETRY_DELAY_VALUES[$((attempt - 1))]}"
    write_lock_status "recovering" 0
    printf '[%s] Sleeping %s seconds before recovery attempt %s (recovery_delay=%s, recovery_category=%s)\n' \
      "$RUNNER_NAME" "$RECOVERY_DELAY" "$((attempt + 1))" \
      "$RECOVERY_DELAY" "$RECOVERY_CATEGORY"
    sleep "$RECOVERY_DELAY"
  done
}

# Source the tracker selector and config adapter before entering orchestration.
# The runtime adapter is sourced later, after the active profile is
# known, so the orchestrator picks the right adapter (claude, codex,
# ...) without depending on a single hardcoded path. The supervisor
# consumes normalized tracker operations and lifecycle events only;
# provider-specific command construction remains inside the adapters.
SCRIPT_DIR="$(resolve_script_dir)"
TRACKER_SELECTOR="${SCRIPT_DIR}/tracker/selector.sh"
RUNTIME_ADAPTER_DIR="${SCRIPT_DIR}/runtime"
CONFIG_ADAPTER="${SCRIPT_DIR}/config/issue-killer-config.sh"
# shellcheck source=agent/claude-minimax-issue-runner/config/issue-killer-config.sh
source "$CONFIG_ADAPTER"
# shellcheck source=agent/claude-minimax-issue-runner/tracker/selector.sh
source "$TRACKER_SELECTOR"
PROMPT_FILE="${SCRIPT_DIR}/PROMPT.md"

# Parse the optional positional repository argument together with the
# optional `--config <path>` flag. The legacy positional form is
# preserved so existing shell invocations keep working.
CONFIG_PATH_OVERRIDE=""
REPOSITORY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      [[ $# -ge 2 ]] || die "--config requires a path argument"
      CONFIG_PATH_OVERRIDE="$2"
      shift 2
      ;;
    --config=*)
      CONFIG_PATH_OVERRIDE="${1#--config=}"
      shift
      ;;
    --help|-h)
      printf 'usage: %s [--config <path>] [repository]\n' "$RUNNER_NAME"
      exit 0
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      [[ -z "$REPOSITORY" ]] || die "only one repository argument is accepted"
      REPOSITORY="$1"
      shift
      ;;
  esac
done
REPOSITORY="${REPOSITORY:-.}"

BASE_BRANCH="${ISSUE_RUNNER_BASE_BRANCH:-main}"
MAX_ITERATIONS="${ISSUE_RUNNER_MAX_ITERATIONS:-0}"
PROGRESS_INTERVAL="${ISSUE_RUNNER_PROGRESS_INTERVAL:-30}"
STREAM_OUTPUT="${ISSUE_RUNNER_STREAM_OUTPUT:-true}"
RETRY_DELAY_VALUES=()
TRANSIENT_PATTERN_VALUES=()
RECOVERY_ATTEMPT=0
RECOVERY_CATEGORY=""
RECOVERY_DELAY=""
ITERATION=0
ISSUE_KILLER_PROFILE_NAME=""
ISSUE_KILLER_PROFILE_LABEL=""
ISSUE_KILLER_PROFILE_CLI=""
ISSUE_KILLER_PROFILE_COMMAND=""
ISSUE_KILLER_PROFILE_MODEL=""
ISSUE_KILLER_PROFILE_SHELL=""
ISSUE_KILLER_PROFILE_INIT_FILE=""
ISSUE_KILLER_PROFILE_OPTIONS=""
ISSUE_KILLER_PROFILE_FALLBACKS=""

# Resolve and load the operator's TOML configuration. The runner
# refuses to launch without a profile: the destructive confirmation,
# checkpoint persistence, and recovery enforcement all rely on the
# canonical profile identity the loader establishes.
ISSUE_KILLER_CONFIG_PATH="$(issue_killer_config_resolve_path ${CONFIG_PATH_OVERRIDE:+--config "$CONFIG_PATH_OVERRIDE"})"
issue_killer_config_load "$ISSUE_KILLER_CONFIG_PATH" || \
  die "issue-killer configuration is invalid; edit ${ISSUE_KILLER_CONFIG_PATH} and retry"

# Select a profile: the operator chooses interactively when a TTY is
# available, otherwise the configured `default_profile` is used
# deterministically. The runner never picks a CLI/model outside the
# declared profile set.
if [[ -r /dev/tty && -t 0 && -t 1 ]]; then
  SELECTED_PROFILE="$(
    issue_killer_config_prompt_profile \
      "$(issue_killer_config_lookup top.default_profile)"
  )" || die "unable to select an execution profile"
else
  SELECTED_PROFILE=""
  issue_killer_config_select_default_profile || \
    die "non-interactive launch requires a valid default_profile in ${ISSUE_KILLER_CONFIG_PATH}"
  SELECTED_PROFILE="$ISSUE_KILLER_PROFILE_NAME"
fi
issue_killer_config_apply_profile "$SELECTED_PROFILE" || \
  die "profile ${SELECTED_PROFILE} is invalid"

# Project the selected profile onto the legacy runtime variables the
# adapter consumes. The adapter treats these as the single source of
# truth for the worker invocation. `PERMISSION_MODE` is only relevant
# for the Claude adapter; other adapters ignore it. The Claude-only
# projection stays here so existing test fixtures and out-of-tree
# consumers that read CLAUDE_COMMAND / CLAUDE_RC_FILE keep working.
CLAUDE_COMMAND="$ISSUE_KILLER_PROFILE_COMMAND"
CLAUDE_SHELL="${ISSUE_KILLER_PROFILE_SHELL:-bash}"
CLAUDE_RC_FILE="${ISSUE_KILLER_PROFILE_INIT_FILE:-${HOME}/.bashrc}"
PERMISSION_MODE="bypassPermissions"
if [[ -n "$ISSUE_KILLER_PROFILE_OPTIONS" ]]; then
  option_line=""
  option_key=""
  option_value=""
  while IFS= read -r option_line; do
    [[ -z "$option_line" ]] && continue
    option_key="${option_line%%=*}"
    option_value="${option_line#*=}"
    case "$option_key" in
      permission_mode) PERMISSION_MODE="$option_value" ;;
    esac
  done <<<"$ISSUE_KILLER_PROFILE_OPTIONS"
fi

# Source the runtime adapter that matches the selected profile's CLI.
# The orchestrator calls only the generic `runtime_*` interface, so the
# adapter file selected here is the sole place that knows the CLI's
# invocation flags, JSON event shape, and session identity. The
# adapter is sourced after the profile so we can validate the
# CLI-specific options (e.g. codex reasoning_effort and sandbox)
# before the worker is launched.
case "$ISSUE_KILLER_PROFILE_CLI" in
  claude)
    RUNTIME_ADAPTER="${RUNTIME_ADAPTER_DIR}/claude-adapter.sh"
    ;;
  codex)
    RUNTIME_ADAPTER="${RUNTIME_ADAPTER_DIR}/codex-adapter.sh"
    ;;
  *)
    die "runtime adapter is not available for CLI: ${ISSUE_KILLER_PROFILE_CLI:-unset}"
    ;;
esac
[[ -r "$RUNTIME_ADAPTER" ]] || die "runtime adapter not found: ${RUNTIME_ADAPTER}"
# shellcheck source=agent/claude-minimax-issue-runner/runtime/codex-adapter.sh
source "$RUNTIME_ADAPTER"
# Validate CLI-specific profile options. The Claude adapter tolerates
# any permission_mode string; the Codex adapter strictly rejects
# malformed reasoning_effort, sandbox, and auto_approve values so a
# misspelled safety setting is never silently ignored.
if [[ "$ISSUE_KILLER_PROFILE_CLI" == "codex" ]]; then
  codex_runtime_validate_profile "$ISSUE_KILLER_PROFILE_OPTIONS" || \
    die "codex profile ${ISSUE_KILLER_PROFILE_NAME} has invalid options"
fi

[[ -f "$PROMPT_FILE" ]] || die "worker prompt not found: ${PROMPT_FILE}"
[[ "$BASE_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid base branch: ${BASE_BRANCH}"
[[ "$STREAM_OUTPUT" =~ ^(true|false)$ ]] || \
  die "ISSUE_RUNNER_STREAM_OUTPUT must be 'true' or 'false'"
is_non_negative_integer "$MAX_ITERATIONS" || \
  die "ISSUE_RUNNER_MAX_ITERATIONS must be a non-negative integer"
is_non_negative_integer "$PROGRESS_INTERVAL" || \
  die "ISSUE_RUNNER_PROGRESS_INTERVAL must be a non-negative integer"
parse_retry_delays "${ISSUE_RUNNER_RETRY_DELAYS:-15,30,60}" || \
  die "ISSUE_RUNNER_RETRY_DELAYS must be a comma-separated list of positive integers (seconds)"
parse_transient_patterns "${ISSUE_RUNNER_TRANSIENT_PATTERNS:-}"
if [[ -n "${ISSUE_RUNNER_RETRY_LIMIT:-}" ]]; then
  is_non_negative_integer "${ISSUE_RUNNER_RETRY_LIMIT}" || \
    die "ISSUE_RUNNER_RETRY_LIMIT must be a non-negative integer"
fi
command -v "$CLAUDE_SHELL" >/dev/null 2>&1 || die "shell not found: ${CLAUDE_SHELL}"
if [[ "$STREAM_OUTPUT" == "true" ]]; then
  command -v jq >/dev/null 2>&1 || \
    die "jq is required for stream-json output rendering"
fi

cd "$REPOSITORY" 2>/dev/null || die "repository not found: ${REPOSITORY}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a Git repository"
cd "$REPO_ROOT"
GIT_COMMON_DIR_RAW="$(git rev-parse --git-common-dir 2>/dev/null)" || \
  die "unable to resolve Git common directory"
GIT_COMMON_DIR="$(cd "$GIT_COMMON_DIR_RAW" 2>/dev/null && pwd -P)" || \
  die "Git common directory not found: ${GIT_COMMON_DIR_RAW}"

if ! git show-ref --verify --quiet "refs/heads/${BASE_BRANCH}" &&
   ! git show-ref --verify --quiet "refs/remotes/origin/${BASE_BRANCH}"; then
  die "base branch not found locally or at origin: ${BASE_BRANCH}"
fi

TRACKER_ADAPTER="$(tracker_select_adapter "$REPO_ROOT")" || \
  die "unable to select a tracker adapter"
[[ -r "$TRACKER_ADAPTER" ]] || die "tracker adapter not found: ${TRACKER_ADAPTER}"
# shellcheck source=agent/claude-minimax-issue-runner/tracker/github-adapter.sh
source "$TRACKER_ADAPTER"
tracker_initialize "$REPO_ROOT" || die "tracker validation failed; run setup-elvis-brevi-skills and retry"
tracker_prepare_worker_environment || die "unable to prepare the selected tracker runtime environment"

acquire_repository_lock
confirm_destructive_run
prepare_dirty_startup_recovery
if [[ -z "${STARTUP_RECOVERY_MODE:-}" ]]; then
  assert_clean_worktree
fi

BASE_PROMPT="$(<"$PROMPT_FILE")"

while true; do
  ITERATION=$((ITERATION + 1))
  if [[ -n "${STARTUP_RECOVERY_MODE:-}" ]]; then
    CHECKPOINT_ISSUE="$STARTUP_RECOVERY_ISSUE"
    CHECKPOINT_STATE="$(checkpoint_value state "$(checkpoint_file)")"
    CHECKPOINT_SESSION_ID="$(checkpoint_value session_id "$(checkpoint_file)")"
  else
    CHECKPOINT_ISSUE=""
    CHECKPOINT_STATE="starting"
    CHECKPOINT_SESSION_ID=""
  fi
  RECOVERY_ATTEMPT=0
  RECOVERY_CATEGORY=""
  RECOVERY_DELAY=""
  if [[ -z "${STARTUP_RECOVERY_MODE:-}" ]]; then
    assert_clean_worktree
  fi

  if [[ -z "${STARTUP_RECOVERY_MODE:-}" ]]; then
    # Record an initial checkpoint for this attempt before any worker process
    # runs. The runner fills in `issue`, `state`, and (when available)
    # `session_id` as the worker emits identifying events.
    write_checkpoint "starting"
    write_lock_status "starting" 0
  else
    write_lock_status "recovery_starting" 0
  fi

  if [[ -n "${STARTUP_RECOVERY_MODE:-}" ]]; then
    WORKER_PROMPT="${BASE_PROMPT}

${STARTUP_RECOVERY_PROMPT}

Runtime configuration:
- Repository root: ${REPO_ROOT}
- Base branch: ${BASE_BRANCH}
- This is restart recovery iteration ${ITERATION}.

Do not inspect the queue for another issue. Continue only the recovery target."
  else
    WORKER_PROMPT="${BASE_PROMPT}

Runtime configuration:
- Repository root: ${REPO_ROOT}
- Base branch: ${BASE_BRANCH}
- This is worker iteration ${ITERATION}.

Begin by inspecting the live tracker and repository state. Remember: exactly one
non-epic issue in this session."
  fi

  OUTPUT_FILE="$(mktemp "${TMPDIR:-/tmp}/${RUNNER_NAME}.XXXXXX")"
  if [[ -n "${STARTUP_RECOVERY_MODE:-}" ]]; then
    printf '\n[%s] Starting recovery Claude-MiniMax worker for issue %s at %s\n' \
      "$RUNNER_NAME" "$STARTUP_RECOVERY_ISSUE" "$(timestamp)"
  else
    printf '\n[%s] Starting fresh Claude-MiniMax worker %s at %s\n' \
      "$RUNNER_NAME" "$ITERATION" "$(timestamp)"
  fi

  RECOVERY_REQUIRED_REACHED=false
  attempt_with_recovery "$WORKER_PROMPT" "$OUTPUT_FILE" "${STARTUP_RECOVERY_SESSION:-}" || \
    RECOVERY_REQUIRED_REACHED=true

  # The renderer subshell carries the identified issue in a side-channel
  # file so the supervisor can adopt it before writing the final
  # checkpoint for this attempt.
  ISSUE_FILE="${OUTPUT_FILE}.issue"
  if [[ -s "$ISSUE_FILE" ]]; then
    CHECKPOINT_ISSUE="$(<"$ISSUE_FILE")"
  fi

  WORKER_STATUS="$(
    sed -n "s/^${STATUS_PREFIX}//p" "$OUTPUT_FILE" | tail -n 1
  )"

  if [[ "$RECOVERY_REQUIRED_REACHED" == "true" ]]; then
    finalize_attempt_state "recovery_required"
    RECOVERY_CATEGORY="recovery_required"
    write_lock_status "recovery_required" 0
    printf '%s%s\n' "$STATUS_PREFIX" "RECOVERY_REQUIRED" >> "$OUTPUT_FILE"
    printf '%s: RECOVERY_REQUIRED for issue %s after %s attempt(s); output retained at %s\n' \
      "$RUNNER_NAME" "${CHECKPOINT_ISSUE:-unknown}" "$RECOVERY_ATTEMPT" "$OUTPUT_FILE" >&2
    exit 4
  fi

  if [[ "$WORKER_EXIT" -ne 0 ]]; then
    finalize_attempt_state "failed"
    printf '%s: worker %s exited with code %s; output retained at %s\n' \
      "$RUNNER_NAME" "$ITERATION" "$WORKER_EXIT" "$OUTPUT_FILE" >&2
    exit 1
  fi

  case "$WORKER_STATUS" in
    ISSUE_COMPLETED)
      if [[ "$TRACKER_KIND" == "azure-devops" ]]; then
        if [[ ! "${CHECKPOINT_ISSUE:-}" =~ ^[0-9]+$ ]]; then
          finalize_attempt_state "recovery_required"
          write_lock_status "recovery_required" 0
          printf '%s%s\n' "$STATUS_PREFIX" "RECOVERY_REQUIRED" >> "$OUTPUT_FILE"
          printf '%s: Azure completion marker did not identify a numeric work item; output retained at %s\n' \
            "$RUNNER_NAME" "$OUTPUT_FILE" >&2
          exit 4
        fi
        completion_branch="$(current_branch)"
        if [[ "$completion_branch" == "$BASE_BRANCH" || "$completion_branch" == "unknown" ]]; then
          completion_branch="$(checkpoint_value branch "$(checkpoint_file)")"
        fi
        if ! tracker_item_completion_verified "$CHECKPOINT_ISSUE" "$completion_branch"; then
          finalize_attempt_state "recovery_required"
          write_lock_status "recovery_required" 0
          printf '%s%s\n' "$STATUS_PREFIX" "RECOVERY_REQUIRED" >> "$OUTPUT_FILE"
          printf '%s: Azure completion marker was not confirmed by live work-item and PR state; output retained at %s\n' \
            "$RUNNER_NAME" "$OUTPUT_FILE" >&2
          exit 4
        fi
        advance_checkpoint_state "pr_merged" "$OUTPUT_FILE"
        advance_checkpoint_state "issue_closed" "$OUTPUT_FILE"
      fi
      rm -f "$OUTPUT_FILE" "${OUTPUT_FILE}.issue" "${OUTPUT_FILE}.touch" 2>/dev/null || true
      clear_checkpoint
      printf '[%s] Worker %s completed one issue.\n' "$RUNNER_NAME" "$ITERATION"
      if [[ -n "${STARTUP_RECOVERY_MODE:-}" ]]; then
        printf '[%s] Restart recovery completed; returning to normal queue loop.\n' "$RUNNER_NAME"
        STARTUP_RECOVERY_MODE=""
        STARTUP_RECOVERY_ISSUE=""
        STARTUP_RECOVERY_SESSION=""
        STARTUP_RECOVERY_PROMPT=""
      fi
      if [[ "$MAX_ITERATIONS" -gt 0 && "$ITERATION" -ge "$MAX_ITERATIONS" ]]; then
        printf '%s: iteration limit reached after %s completed issue(s)\n' \
          "$RUNNER_NAME" "$ITERATION"
        exit 3
      fi
      ;;
    QUEUE_EMPTY)
      rm -f "$OUTPUT_FILE" "${OUTPUT_FILE}.issue" "${OUTPUT_FILE}.touch" 2>/dev/null || true
      clear_checkpoint
      printf '[%s] No pending, available, non-epic issues remain.\n' "$RUNNER_NAME"
      exit 0
      ;;
    BLOCKED)
      finalize_attempt_state "blocked"
      printf '%s: pending work requires human input; output retained at %s\n' \
        "$RUNNER_NAME" "$OUTPUT_FILE" >&2
      exit 2
      ;;
    FAILED)
      finalize_attempt_state "failed"
      printf '%s: worker failed to finish its issue; output retained at %s\n' \
        "$RUNNER_NAME" "$OUTPUT_FILE" >&2
      exit 1
      ;;
    *)
      finalize_attempt_state "malformed"
      printf '%s: worker returned no recognized status; output retained at %s\n' \
        "$RUNNER_NAME" "$OUTPUT_FILE" >&2
      exit 1
      ;;
  esac
done
