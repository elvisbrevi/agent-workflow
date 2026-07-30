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
  local raw_line

  : > "$issue_file"

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
  shift
  local -a claude_args

  claude_args=(
    --print
    --no-session-persistence
    --permission-mode "$PERMISSION_MODE"
    --name "${RUNNER_NAME}-${ITERATION}"
  )

  if [[ "$STREAM_OUTPUT" == "true" ]]; then
    claude_args+=(--output-format stream-json)
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
  local exit_file="${output_file}.exit"
  local touch_file="${output_file}.touch"
  local pipeline_pid heartbeat_pid=""
  local started_at now elapsed pipeline_exit sink

  started_at="$(date +%s)"
  rm -f "$touch_file" "$exit_file"
  write_lock_status "worker_running" 0

  if [[ "$STREAM_OUTPUT" == "true" ]]; then
    sink=render_stream_pipeline
  else
    sink=tee
  fi

  {
    set +e
    invoke_worker "$prompt"
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
assert_clean_worktree
confirm_destructive_run

BASE_PROMPT="$(<"$PROMPT_FILE")"

while true; do
  ITERATION=$((ITERATION + 1))
  CHECKPOINT_ISSUE=""
  CHECKPOINT_STATE="starting"
  CHECKPOINT_SESSION_ID=""
  assert_clean_worktree

  # Record an initial checkpoint for this attempt before any worker process
  # runs. The runner fills in `issue`, `state`, and (when available)
  # `session_id` as the worker emits identifying events.
  write_checkpoint "starting"
  write_lock_status "starting" 0

  WORKER_PROMPT="${BASE_PROMPT}

Runtime configuration:
- Repository root: ${REPO_ROOT}
- Base branch: ${BASE_BRANCH}
- This is worker iteration ${ITERATION}.

Begin by inspecting the live tracker and repository state. Remember: exactly one
non-epic issue in this session."

  OUTPUT_FILE="$(mktemp "${TMPDIR:-/tmp}/${RUNNER_NAME}.XXXXXX")"
  printf '\n[%s] Starting fresh Claude-MiniMax worker %s at %s\n' \
    "$RUNNER_NAME" "$ITERATION" "$(timestamp)"

  run_worker_with_progress "$WORKER_PROMPT" "$OUTPUT_FILE"

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
