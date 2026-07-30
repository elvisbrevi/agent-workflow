#!/usr/bin/env bash
set -euo pipefail

RUNNER_NAME="claude-minimax-issue-runner"
STATUS_PREFIX="CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS="
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

# Reconciles the checkpoint against the live Git, PR, and issue state.
# Reads $CHECKPOINT_ISSUE and the current branch. Returns one of:
#   completed          - issue is closed and its PR (if any) is merged
#   merged_no_issue    - PR exists and is merged but the issue is still open
#   pr_open            - PR exists and is open or closed without merge
#   branch_only        - branch exists but no PR has been created
#   no_work            - no branch exists; the previous attempt died early
#   unknown            - the reconciler could not determine the state
# The function intentionally only consults the local Git refs plus the
# GitHub CLI; it never mutates the worktree.
reconcile_recovery_state() {
  local branch
  local issue_number="$1"
  local pr_state pr_json issue_state

  branch="$(current_branch)"
  if [[ "$branch" == "unknown" ]]; then
    printf 'unknown\n'
    return 0
  fi

  # No worktree mutation means no PR was created.
  if [[ -z "$issue_number" || ! "$issue_number" =~ ^[0-9]+$ ]]; then
    if git show-ref --verify --quiet "refs/heads/${branch}" 2>/dev/null; then
      printf 'branch_only\n'
    else
      printf 'no_work\n'
    fi
    return 0
  fi

  if ! command -v gh >/dev/null 2>&1; then
    printf 'unknown\n'
    return 0
  fi

  if ! pr_json="$(gh pr list --state all --head "$branch" --json state,number,mergedAt 2>/dev/null)"; then
    printf 'unknown\n'
    return 0
  fi

  pr_state="$(jq -r 'if (length == 0) then "none" else (.[0].state // "none") end' \
    2>/dev/null <<<"$pr_json")"
  if [[ "$pr_state" == "none" ]]; then
    if git show-ref --verify --quiet "refs/heads/${branch}" 2>/dev/null; then
      printf 'branch_only\n'
    else
      printf 'no_work\n'
    fi
    return 0
  fi

  local merged
  merged="$(jq -r 'if (length == 0) then false else ((.[0].mergedAt // null) != null) end' \
    2>/dev/null <<<"$pr_json")"

  if [[ "$merged" == "true" ]]; then
    issue_state="$(gh issue view "$issue_number" --json state 2>/dev/null \
      | jq -r '.state // "OPEN"' 2>/dev/null)"
    case "$issue_state" in
      CLOSED)
        printf 'completed\n'
        ;;
      *)
        printf 'merged_no_issue\n'
        ;;
    esac
  else
    printf 'pr_open\n'
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

  printf 'This will use Claude permission mode %s, repeatedly merge PRs into %s, and close issues. Continue? [y/N] ' \
    "$PERMISSION_MODE" "$BASE_BRANCH" >/dev/tty
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

github_repo_slug() {
  local url slug

  url="$(git config --get remote.origin.url 2>/dev/null || true)"
  case "$url" in
    git@github.com:*)
      slug="${url#git@github.com:}"
      ;;
    https://github.com/*)
      slug="${url#https://github.com/}"
      ;;
    http://github.com/*)
      slug="${url#http://github.com/}"
      ;;
    *)
      return 1
      ;;
  esac
  slug="${slug%.git}"
  [[ "$slug" == */* ]] || return 1
  printf '%s\n' "$slug"
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

reconcile_startup_recovery_state() {
  local issue_number="$1"
  local branch="$2"
  local issue_state pr_json pr_count repo_slug blocked_by

  if ! command -v gh >/dev/null 2>&1; then
    emit_recovery_required "gh is required to reconcile issue and PR state before recovery"
  fi

  if ! issue_state="$(gh issue view "$issue_number" --json state,labels,assignees 2>/dev/null \
      | jq -r '.state // empty' 2>/dev/null)"; then
    emit_recovery_required "unable to reconcile issue ${issue_number} before recovery"
  fi
  [[ -n "$issue_state" ]] || \
    emit_recovery_required "unable to determine issue ${issue_number} state before recovery"

  repo_slug="$(github_repo_slug)" || \
    emit_recovery_required "unable to determine GitHub repository for dependency reconciliation"
  if ! blocked_by="$(gh api "repos/${repo_slug}/issues/${issue_number}" \
      --jq '.issue_dependencies_summary.blocked_by // 0' 2>/dev/null)"; then
    emit_recovery_required "unable to reconcile dependency state for issue ${issue_number}"
  fi
  [[ "$blocked_by" =~ ^[0-9]+$ ]] || \
    emit_recovery_required "ambiguous dependency state for issue ${issue_number}"
  if [[ "$blocked_by" -gt 0 ]]; then
    emit_recovery_required "issue ${issue_number} is blocked by ${blocked_by} open issue(s)"
  fi

  if ! pr_json="$(gh pr list --state all --head "$branch" --json state,number,mergedAt 2>/dev/null)"; then
    emit_recovery_required "unable to reconcile PR state for branch ${branch} before recovery"
  fi
  pr_count="$(jq -r 'length' 2>/dev/null <<<"$pr_json")"
  [[ "$pr_count" =~ ^[0-9]+$ ]] || \
    emit_recovery_required "ambiguous PR state for branch ${branch}"
  if [[ "$pr_count" -gt 1 ]]; then
    emit_recovery_required "ambiguous PR state for branch ${branch}: ${pr_count} PRs found"
  fi
  if [[ "$issue_state" == "CLOSED" ]]; then
    emit_recovery_required "issue ${issue_number} is already closed; refusing to launch a recovery worker over dirty files"
  fi
  if [[ "$pr_count" -eq 1 ]]; then
    local merged
    merged="$(jq -r '((.[0].mergedAt // null) != null)' 2>/dev/null <<<"$pr_json")"
    [[ "$merged" == "true" ]] || [[ "$merged" == "false" ]] || \
      emit_recovery_required "ambiguous merged state for PR on branch ${branch}"
    if [[ "$merged" == "true" ]]; then
      emit_recovery_required "PR for branch ${branch} is already merged; refusing to duplicate recovery effects over dirty files"
    fi
  fi

  printf '[%s] Reconciled recovery target: issue %s is %s; open blockers: %s; PRs for %s: %s\n' \
    "$RUNNER_NAME" "$issue_number" "$issue_state" "$blocked_by" "$branch" "$pr_count"
}

validate_checkpoint_for_dirty_recovery() {
  local checkpoint="$1"
  local issue branch base_branch base_sha state
  local current

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
    reconcile_startup_recovery_state "$issue" "$branch"
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
  reconcile_startup_recovery_state "$issue" "$branch"
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

# Returns 0 (success) when the input line is a JSON object. Avoids emitting
# raw stream JSON into operator output.
stream_event_is_object() {
  jq -e 'type == "object"' >/dev/null 2>&1 <<<"$1"
}

stream_event_field() {
  local field="$1"
  local line="$2"
  jq -r --arg f "$field" 'try (getpath($f | split(".")) // empty) catch empty' 2>/dev/null <<<"$line"
}

# Map a Claude stream-json event to one human-readable progress line for the
# operator. Never prints raw JSON, secrets, full prompts, or complete tool
# arguments. Status text is captured in the renderer pipeline, not here.
render_stream_event() {
  local raw_line="$1"
  local output_file="${2:-}"

  [[ "$(stream_event_field 'type' "$raw_line")" == "assistant" ]] || return 0

  local tool_block tool_name tool_input
  tool_block="$(
    jq -c 'try (.message.content[] | select(.type=="tool_use")) catch empty' \
      2>/dev/null <<<"$raw_line" | head -n 1
  )"
  [[ -z "$tool_block" ]] && return 0
  tool_name="$(jq -r '.name // ""' 2>/dev/null <<<"$tool_block")"
  tool_input="$(jq -c '.input // {}' 2>/dev/null <<<"$tool_block")"
  [[ -z "$tool_name" ]] && return 0
  render_semantic_progress "$tool_name" "$tool_input" "$output_file"
}

render_semantic_progress() {
  local tool_name="$1"
  local tool_input="$2"
  local output_file="${3:-}"

  case "$tool_name" in
    Read|Glob|Grep|NotebookRead|WebFetch|WebSearch|LS|ListMcpResources)
      printf '[%s] Inspecting repository or tracker state\n' "$RUNNER_NAME"
      ;;
    Edit|Write|MultiEdit|NotebookEdit)
      local file_path
      file_path="$(jq -r '.file_path // .notebook_path // ""' 2>/dev/null <<<"$tool_input")"
      advance_checkpoint_state "mutating" "$output_file"
      if [[ -n "$file_path" && "$file_path" != "null" ]]; then
        printf '[%s] Editing %s\n' "$RUNNER_NAME" "$file_path"
      else
        printf '[%s] Editing files\n' "$RUNNER_NAME"
      fi
      ;;
    Bash)
      local cmd
      cmd="$(jq -r '.command // ""' 2>/dev/null <<<"$tool_input")"
      render_bash_progress "$cmd" "$output_file"
      ;;
    TodoWrite|Task)
      printf '[%s] Planning the next worker step\n' "$RUNNER_NAME"
      ;;
    *)
      printf '[%s] Worker tool: %s\n' "$RUNNER_NAME" "$tool_name"
      ;;
  esac
}

render_bash_progress() {
  local cmd="$1"
  local output_file="${2:-}"

  if [[ -z "$cmd" || "$cmd" == "null" ]]; then
    printf '[%s] Running shell command\n' "$RUNNER_NAME"
    return
  fi

  case "$cmd" in
    "gh issue view "*)
      local issue_number
      issue_number="$(printf '%s\n' "$cmd" | sed -nE 's/^gh issue view[[:space:]]+([0-9]+).*/\1/p')"
      if [[ -n "$issue_number" ]]; then
        record_identified_issue "$issue_number" "$output_file"
      else
        printf '[%s] Inspecting issue tracker\n' "$RUNNER_NAME"
      fi
      ;;
    "gh pr create"*)
      advance_checkpoint_state "pr_created" "$output_file"
      printf '[%s] Creating pull request\n' "$RUNNER_NAME"
      ;;
    "gh pr merge"*|"gh pr close"*)
      advance_checkpoint_state "pr_merged" "$output_file"
      printf '[%s] Merging or closing pull request\n' "$RUNNER_NAME"
      ;;
    "gh issue close"*)
      advance_checkpoint_state "issue_closed" "$output_file"
      printf '[%s] Closing issue\n' "$RUNNER_NAME"
      ;;
    "gh issue"*)
      printf '[%s] Inspecting issue tracker\n' "$RUNNER_NAME"
      ;;
    "git push"*)
      advance_checkpoint_state "branch_pushed" "$output_file"
      printf '[%s] Pushing branch\n' "$RUNNER_NAME"
      ;;
    "git commit"*)
      advance_checkpoint_state "mutating" "$output_file"
      printf '[%s] Committing changes\n' "$RUNNER_NAME"
      ;;
    "git merge"*|"git rebase"*)
      printf '[%s] Merging or rebasing branch\n' "$RUNNER_NAME"
      ;;
    *code-review*|*"/code-review"*)
      printf '[%s] Reviewing changes\n' "$RUNNER_NAME"
      ;;
    *npm*test*|*bats*|*pytest*|*cargo*test*|*swift*test*|*jest*|*mocha*|*bash*tests/*|*"go test"*)
      advance_checkpoint_state "mutating" "$output_file"
      printf '[%s] Running tests or verification\n' "$RUNNER_NAME"
      ;;
    *)
      printf '[%s] Running shell command\n' "$RUNNER_NAME"
      ;;
  esac
}

# Records the issue number identified by the worker and transitions the
# checkpoint to "issue_selected". The renderer subshell cannot propagate
# variables back to the supervisor, so the issue is also persisted to the
# side-channel file "$output_file.issue" for the parent process to pick up
# after the worker exits. The issue is captured as soon as the assistant
# inspects it via `gh issue view N`, before any edit, push, PR creation,
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

# Redact common credential shapes from arbitrary assistant text. The raw text
# still ends up in OUTPUT_FILE for the failure diagnostic path.
redact_secrets() {
  sed -E \
    -e 's/[Aa]uthorization([[:space:][:punct:]]+[A-Za-z0-9._~+/-]+)+/<redacted:authorization>/g' \
    -e 's/[Bb]earer[[:space:][:punct:]]+[A-Za-z0-9._~+/-]{6,}/<redacted:bearer>/g' \
    -e "s/(api[_-]?key|secret|password|access[_-]?token|auth[_-]?token)['\"[:space:]]*[:=]['\"[:space:]]*[A-Za-z0-9._~+/-]+/\1=<redacted>/gI" \
    -e 's/(ghp_[A-Za-z0-9]+|ghs_[A-Za-z0-9]+|gho_[A-Za-z0-9]+|ghu_[A-Za-z0-9]+|ghr_[A-Za-z0-9]+)/<redacted:credential>/g' \
    -e 's/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/<redacted:private-key>/g'
}

# Reads the worker stdout stream, persists raw lines to OUTPUT_FILE so existing
# status-marker extraction continues to work, and renders redacted semantic
# progress to the operator's stdout. Plain-text output from non-streaming
# workers is forwarded unchanged. The side-channel timestamp file at
# "$1.touch" lets the heartbeat loop suppress the empty-interval message while
# events are still flowing. The side-channel file at "$1.issue" carries the
# identified issue number from the renderer subshell back to the supervisor
# so the final checkpoint (written in the parent process after the worker
# exits) records the correct issue identity.
render_stream_pipeline() {
  local output_file="$1"
  local touch_file="${output_file}.touch"
  local issue_file="${output_file}.issue"
  local session_file="${output_file}.session"
  local raw_line

  : > "$issue_file"
  : > "$session_file"

  while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    [[ -z "$raw_line" ]] && continue

    printf '%s\n' "$raw_line" >> "$output_file"

    if ! stream_event_is_object "$raw_line"; then
      printf '%s\n' "$raw_line"
      continue
    fi

    case "$(stream_event_field 'type' "$raw_line")" in
      assistant)
        render_stream_event "$raw_line" "$output_file"
        : > "$touch_file"
        ;;
      system)
        if [[ "$(stream_event_field 'subtype' "$raw_line")" == "init" ]]; then
          local sid
          sid="$(jq -r '.session_id // ""' 2>/dev/null <<<"$raw_line")"
          if [[ -n "$sid" && "$sid" != "null" ]]; then
            printf '%s' "$sid" > "$session_file"
          fi
        fi
        ;;
      result)
        local result_text
        result_text="$(jq -r '.result // ""' 2>/dev/null <<<"$raw_line")"
        if [[ -n "$result_text" && "$result_text" != "null" ]]; then
          # Persist the assistant's final text on its own lines so existing
          # status-marker extraction (sed -n s/^PREFIX/p) still finds the line.
          printf '%s\n' "$result_text" >> "$output_file"
          printf '[%s] Worker finished (see %s for full output)\n' \
            "$RUNNER_NAME" "$output_file"
        fi
        ;;
    esac
  done
}

invoke_worker() {
  local prompt="$1"
  local session_id="${2:-}"
  local -a claude_args

  claude_args=(
    --print
    --permission-mode "$PERMISSION_MODE"
    --name "${RUNNER_NAME}-${ITERATION}"
  )

  if [[ -n "$session_id" ]]; then
    claude_args+=(--resume "$session_id")
  else
    claude_args+=(--no-session-persistence)
  fi

  if [[ "$STREAM_OUTPUT" == "true" ]]; then
    # `--print` requires `--verbose` whenever `--output-format stream-json`
    # is requested; without it the CLI aborts before producing any output.
    claude_args+=(--output-format stream-json --verbose)
  fi

  claude_args+=("$prompt")

  if command -v "$CLAUDE_COMMAND" >/dev/null 2>&1; then
    "$CLAUDE_COMMAND" "${claude_args[@]}"
    return
  fi

  [[ -r "$CLAUDE_RC_FILE" ]] || \
    die "shell command not found and init file is not readable: ${CLAUDE_RC_FILE}"

  "$CLAUDE_SHELL" --noprofile --norc -c '
    runner_command="$1"
    runner_rc_file="$2"
    shift 2

    enable() {
      if [[ "$*" == *flyline* ]]; then
        return 0
      fi
      builtin enable "$@"
    }

    source "$runner_rc_file"
    "$runner_command" "$@"
  ' "$RUNNER_NAME" "$CLAUDE_COMMAND" "$CLAUDE_RC_FILE" "${claude_args[@]}"
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
    sink=render_stream_pipeline
  else
    sink=tee
  fi

  {
    set +e
    invoke_worker "$prompt" "$session_id"
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
    # to flush when the worker exited before any `gh issue view` event
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
    # `gh` CLI or any external state to be reachable. Read the persisted
    # checkpoint directly so a pre-existing checkpoint (e.g. from a
    # previous restart) is respected even after the in-memory
    # CHECKPOINT_STATE has been reset by the main loop.
    local persisted_state=""
    if [[ -r "$(checkpoint_file)" ]]; then
      persisted_state="$(sed -n 's/^state=//p' "$(checkpoint_file)" 2>/dev/null | head -n 1)"
    fi
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

    # Reconcile the checkpoint against live Git, PR, and issue state before
    # touching the worktree again. A "completed" reconciliation means the
    # previous attempt already finished the work; surface it as a normal
    # completion without launching another worker.
    printf '[%s] Reconciling recovery state against branch, PR, and issue tracker\n' \
      "$RUNNER_NAME"
    reconciled="$(reconcile_recovery_state "${CHECKPOINT_ISSUE:-}")"
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

SCRIPT_DIR="$(resolve_script_dir)"
PROMPT_FILE="${SCRIPT_DIR}/PROMPT.md"
REPOSITORY="${1:-.}"
BASE_BRANCH="${ISSUE_RUNNER_BASE_BRANCH:-main}"
MAX_ITERATIONS="${ISSUE_RUNNER_MAX_ITERATIONS:-0}"
PROGRESS_INTERVAL="${ISSUE_RUNNER_PROGRESS_INTERVAL:-30}"
CLAUDE_COMMAND="${CLAUDE_MINIMAX_COMMAND:-claude-minimax}"
CLAUDE_SHELL="${CLAUDE_MINIMAX_SHELL:-bash}"
CLAUDE_RC_FILE="${CLAUDE_MINIMAX_RC_FILE:-${HOME}/.bashrc}"
PERMISSION_MODE="${CLAUDE_MINIMAX_PERMISSION_MODE:-bypassPermissions}"
STREAM_OUTPUT="${ISSUE_RUNNER_STREAM_OUTPUT:-true}"
RETRY_DELAY_VALUES=()
TRANSIENT_PATTERN_VALUES=()
RECOVERY_ATTEMPT=0
RECOVERY_CATEGORY=""
RECOVERY_DELAY=""
ITERATION=0

[[ $# -le 1 ]] || die "usage: ${RUNNER_NAME} [repository]"
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
