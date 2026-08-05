#!/usr/bin/env bash
# Failure classification, bounded retries, and OpenCode fallback transitions.
# Sourced by run.sh; intentionally has no source-time side effects.

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

# Returns the default CLI signatures that indicate a --resume invocation
# was rejected because the named session does not exist. The first
# pattern matches the Claude CLI's "No conversation found with session
# ID <id>" response. The second pattern covers the equivalent phrasing
# used by sibling CLIs (Codex, OpenCode). Patterns are intentionally
# kept narrow so legitimate worker output that happens to contain the
# substring "session" does not falsely trigger degradation. Patterns
# are matched as extended POSIX regular expressions against the worker
# output, case-insensitive.
default_unresumable_patterns() {
  printf '%s\n' \
    'no[[:space:]]+conversation[[:space:]]+found' \
    'session[[:space:]]+id[[:space:]]+.*not[[:space:]]+found'
}

# Parses a newline-separated list of unresumable-session regex patterns
# into the global UNRESUMABLE_PATTERN_VALUES array. Empty input means
# "use defaults".
parse_unresumable_patterns() {
  local raw="$1"
  local line
  UNRESUMABLE_PATTERN_VALUES=()

  if [[ -z "$raw" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] && UNRESUMABLE_PATTERN_VALUES+=("$line")
    done < <(default_unresumable_patterns)
    return 0
  fi

  while IFS= read -r line; do
    [[ -n "$line" ]] && UNRESUMABLE_PATTERN_VALUES+=("$line")
  done <<<"$raw"
}

# Returns 0 when any line of $1 matches any allowed unresumable-session
# pattern. Used by classify_failure to surface a permanent resume failure
# as its own outcome, distinct from transient transport and from a
# non-transient exit. The match is performed with POSIX extended regular
# expressions (case insensitive) against the worker output only.
output_matches_unresumable_pattern() {
  local output_file="$1"
  local pattern
  [[ -r "$output_file" ]] || return 1
  for pattern in "${UNRESUMABLE_PATTERN_VALUES[@]:-}"; do
    [[ -n "$pattern" ]] || continue
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
#   unresumable_session     - worker exited non-zero after a --resume rejection
# The category is the single source of truth for the retry orchestrator.
# The fourth argument names the session id the orchestrator attempted to
# resume, when any; unresumable_session is only emitted when that id was
# non-empty and the worker output carries a session-not-found signature.
classify_failure() {
  local output_file="$1"
  local exit_code="$2"
  local status_marker="$3"
  local resume_session_id="${4:-}"
  local provider_failure="none"

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

  if [[ "${ISSUE_KILLER_PROFILE_CLI:-}" == "opencode" ]] &&
     declare -F runtime_classify_provider_failure >/dev/null 2>&1; then
    provider_failure="$(runtime_classify_provider_failure "$output_file")"
    case "$provider_failure" in
      quota) printf 'provider_quota\n'; return 0 ;;
      rate_limit) printf 'provider_rate_limit\n'; return 0 ;;
      model_unavailable) printf 'provider_model_unavailable\n'; return 0 ;;
    esac
  fi

  # A resume rejected because the conversation does not exist is its own
  # outcome: a permanent, non-retryable failure for the captured session
  # that no transport-level retry can resolve. It is only meaningful when
  # the orchestrator actually attempted a resume; a fresh worker that
  # happens to print a similar message is classified normally below.
  if [[ -n "$resume_session_id" ]] && output_matches_unresumable_pattern "$output_file"; then
    printf 'unresumable_session\n'
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

# Stages the next OpenCode fallback in the checkpoint before tracker
# reconciliation. Returns 1 when the issue identity is unknown or the chain is
# exhausted; both states require operator recovery rather than queue advance.
stage_next_opencode_fallback() {
  local failure="$1"
  local next=""
  local remaining=""
  local entry skipped=false

  ISSUE_KILLER_FAILED_PROFILE="$ISSUE_KILLER_PROFILE_NAME"
  ISSUE_KILLER_NEXT_PROFILE=""
  ISSUE_KILLER_FALLBACK_FAILURE="$failure"

  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    if [[ "$skipped" == "false" ]]; then
      next="$entry"
      skipped=true
    elif [[ -z "$remaining" ]]; then
      remaining="$entry"
    else
      remaining+=$'\n'"$entry"
    fi
  done <<<"${ISSUE_KILLER_FALLBACK_REMAINING:-}"

  ISSUE_KILLER_NEXT_PROFILE="$next"
  ISSUE_KILLER_FALLBACK_REMAINING="$remaining"

  if [[ ! "${CHECKPOINT_ISSUE:-}" =~ ^[0-9]+$ ]]; then
    write_checkpoint "recovery_required"
    write_lock_status "recovery_required" 0
    printf '[%s] OpenCode fallback stopped because the failed worker did not identify an issue\n' \
      "$RUNNER_NAME" >&2
    return 1
  fi
  if [[ -z "$next" ]]; then
    write_checkpoint "fallback_exhausted"
    write_lock_status "fallback_exhausted" 0
    printf '[%s] OpenCode fallback chain exhausted after %s (%s)\n' \
      "$RUNNER_NAME" "$ISSUE_KILLER_FAILED_PROFILE" "$failure" >&2
    return 1
  fi

  write_checkpoint "fallback_pending"
  write_lock_status "fallback_pending" 0
  return 0
}

# Activates the staged fallback after tracker/PR reconciliation. Every target
# was validated as OpenCode during config load; adapter validation is repeated
# here because model and option safety belong to the active profile.
activate_staged_opencode_fallback() {
  local next="$ISSUE_KILLER_NEXT_PROFILE"
  local failed="$ISSUE_KILLER_FAILED_PROFILE"

  issue_killer_config_apply_profile "$next" || return 1
  [[ "$ISSUE_KILLER_PROFILE_CLI" == "opencode" ]] || return 1
  runtime_validate_profile "$ISSUE_KILLER_PROFILE_OPTIONS" || return 1

  ISSUE_KILLER_FALLBACK_POSITION=$((ISSUE_KILLER_FALLBACK_POSITION + 1))
  CLAUDE_COMMAND="$ISSUE_KILLER_PROFILE_COMMAND"
  CLAUDE_SHELL="${ISSUE_KILLER_PROFILE_SHELL:-bash}"
  CLAUDE_RC_FILE="${ISSUE_KILLER_PROFILE_INIT_FILE:-${HOME}/.bashrc}"
  write_checkpoint "fallback_ready"
  write_lock_status "fallback_ready" 0
  printf '[%s] Advancing OpenCode fallback: %s -> %s (%s)\n' \
    "$RUNNER_NAME" "$failed" "$next" "$ISSUE_KILLER_FALLBACK_FAILURE"
}

# Produces a fresh-worker prompt that pins fallback recovery to the already
# identified issue and existing worktree. Compatible OpenCode sessions receive
# the same constraint when resumed; workers without a session cannot inspect
# the queue for a replacement issue. The tracker-specific supplement is
# included so lifecycle rules remain consistent with the fresh-worker prompt
# while the orchestrator's recovery constraints continue to lead.
build_fallback_worker_prompt() {
  printf '%s\n\n%s\n\n%s\n\n%s\n' \
    "$BASE_PROMPT" "$TRACKER_SUPPLEMENT" "${TRACKER_SCOPE_PROMPT:-}" "Provider fallback recovery:
- Continue exactly issue #${CHECKPOINT_ISSUE}; do not select or inspect another issue.
- Preserve the existing branch and dirty work; do not discard, reset, stash, or overwrite partial work.
- The failed profile was ${ISSUE_KILLER_FAILED_PROFILE}; continue with ${ISSUE_KILLER_PROFILE_NAME} at fallback position ${ISSUE_KILLER_FALLBACK_POSITION}.
- Tracker and pull-request state were reconciled before this transition.
- Finish implementation, verification, merge, and closure for this issue only."
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
  local total_attempt=0
  local attempt_output
  local max_attempts=$(( ${#RETRY_DELAY_VALUES[@]} + 1 ))
  local configured_limit=""
  local category reconciled last_safe should_transition
  local checkpoint_branch checkpoint_base_sha resume_session
  # Tracks how many resume-rejection degradations have already fired
  # for this invocation of attempt_with_recovery. The orchestrator
  # bounds degradation to a single occurrence per attempt so a
  # misbehaving CLI cannot drive an unbounded fresh-worker loop.
  local unresumable_degradation_count=0

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
    total_attempt=$((total_attempt + 1))
    attempt_output="${output_file}.attempt-${total_attempt}"
    rm -f "$attempt_output" "${attempt_output}.issue" \
      "${attempt_output}.session" "${attempt_output}.touch"
    RECOVERY_ATTEMPT="$attempt"
    RECOVERY_DELAY=""
    RECOVERY_CATEGORY=""
    should_transition=false

    # Resume a captured session on retries, fallback transitions, or restart
    # recovery when branch and base identity still match. A normal first
    # attempt has no checkpoint session and therefore launches fresh.
    resume_session=""
    if [[ "$attempt" -eq 1 && -n "$initial_session_id" ]]; then
      resume_session="$initial_session_id"
    elif [[ -n "${CHECKPOINT_SESSION_ID:-}" ]]; then
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

    run_worker_with_progress "$prompt" "$attempt_output" "$resume_session"
    if [[ -r "$attempt_output" ]]; then
      cat "$attempt_output" >> "$output_file"
    fi

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
    while [[ $waited -lt 20 && -z "${CHECKPOINT_ISSUE:-}" && ! -s "${attempt_output}.issue" ]]; do
      sleep 0.05
      waited=$((waited + 1))
    done
    if [[ -s "${attempt_output}.issue" ]]; then
      CHECKPOINT_ISSUE="$(<"${attempt_output}.issue")"
      printf '%s' "$CHECKPOINT_ISSUE" > "${output_file}.issue"
    fi

    # Adopt the captured session id from the worker side-channel so the
    # next attempt (if any) can resume it.
    session_id="$(read_captured_session_id "${attempt_output}.session")"
    if [[ -n "$session_id" ]]; then
      CHECKPOINT_SESSION_ID="$session_id"
      write_checkpoint "${CHECKPOINT_STATE:-starting}"
    fi

    WORKER_STATUS="$(
      sed -n "s/^${STATUS_PREFIX}//p" "$attempt_output" | tail -n 1
    )"

    category="$(classify_failure "$attempt_output" "$WORKER_EXIT" "$WORKER_STATUS" "$resume_session")"
    RECOVERY_CATEGORY="$category"
    rm -f "$attempt_output" "${attempt_output}.issue" \
      "${attempt_output}.session" "${attempt_output}.touch"

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
      unresumable_session)
        unresumable_degradation_count=$((unresumable_degradation_count + 1))
        if [[ "$unresumable_degradation_count" -gt 1 ]]; then
          # Defense-in-depth: the classification guard already keeps a
          # second resume rejection out of this branch (CHECKPOINT_SESSION_ID
          # is cleared on the first degradation, so the next iteration
          # launches fresh and classify_failure sees an empty resume
          # id). This explicit counter exists so a future change that
          # weakens that invariant cannot silently drive an unbounded
          # fresh-worker loop.
          RECOVERY_CATEGORY="non_transient_exit"
          finalize_attempt_state "failed"
          return 0
        fi
        # Log the strategy clearly so the operator can see why a
        # worker relaunch is happening without a transient-retry
        # backoff or retry-budget consumption.
        printf '[%s] Captured Claude session %s could not be resumed; continuing the same issue with a fresh worker (no backoff applied)\n' \
          "$RUNNER_NAME" "${resume_session}"
        # Forget the captured session so the next iteration launches
        # fresh with --no-session-persistence rather than re-trying
        # the same dead --resume invocation. Clear both the
        # checkpoint-stored id and the function-local id supplied to
        # the first attempt on restart recovery; otherwise the next
        # iteration's attempt==1 guard would re-issue --resume with
        # the same dead session id.
        CHECKPOINT_SESSION_ID=""
        initial_session_id=""
        write_checkpoint "${CHECKPOINT_STATE:-starting}"
        # Drop the side-channel session file so the renderer does
        # not re-persist it after the relaunch.
        rm -f "${attempt_output}.session"
        # Reset the transient-retry counter so the fresh-worker
        # attempt gets its own retry budget rather than inheriting
        # the budget consumed by the dead-session resume.
        attempt=0
        RECOVERY_ATTEMPT=0
        RECOVERY_DELAY=""
        continue
        ;;
      transient_transport)
        printf '[%s] Recovering from transient transport failure (attempt %s of %s)\n' \
          "$RUNNER_NAME" "$attempt" "$max_attempts"
        ;;
      provider_rate_limit)
        printf '[%s] OpenCode provider rate limit persists (attempt %s of %s)\n' \
          "$RUNNER_NAME" "$attempt" "$max_attempts"
        if [[ "$attempt" -ge "$max_attempts" ]]; then
          should_transition=true
          stage_next_opencode_fallback "$category" || return 1
        fi
        ;;
      provider_quota|provider_model_unavailable)
        should_transition=true
        stage_next_opencode_fallback "$category" || return 1
        ;;
    esac

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

    if [[ "$should_transition" == "true" && "$reconciled" == "unknown" ]]; then
      RECOVERY_CATEGORY="recovery_required"
      write_checkpoint "recovery_required"
      write_lock_status "recovery_required" 0
      printf '[%s] OpenCode fallback reconciliation was ambiguous; checkpoint retained\n' \
        "$RUNNER_NAME" >&2
      return 1
    fi

    if [[ "$TRACKER_KIND" == "azure-devops" &&
          "$should_transition" != "true" &&
          "${CHECKPOINT_ISSUE:-}" =~ ^[0-9]+$ ]]; then
      RECOVERY_CATEGORY="recovery_required"
      return 1
    fi

    if [[ "$should_transition" == "true" ]]; then
      if ! activate_staged_opencode_fallback; then
        RECOVERY_CATEGORY="recovery_required"
        write_checkpoint "recovery_required"
        write_lock_status "recovery_required" 0
        return 1
      fi
      prompt="$(build_fallback_worker_prompt)"
      initial_session_id=""
      attempt=0
      continue
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
