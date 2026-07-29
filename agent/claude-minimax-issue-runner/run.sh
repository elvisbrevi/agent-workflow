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
  } > "$status_tmp"
  mv -f "$status_tmp" "${LOCK_DIR}/status"
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

invoke_worker() {
  local prompt="$1"
  shift
  local -a claude_args

  claude_args=(
    --print
    --no-session-persistence
    --permission-mode "$PERMISSION_MODE"
    --name "${RUNNER_NAME}-${ITERATION}"
    "$prompt"
  )

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
  local pipeline_pid heartbeat_pid=""
  local started_at now elapsed pipeline_exit

  started_at="$(date +%s)"
  write_lock_status "worker_running" 0

  {
    set +e
    invoke_worker "$prompt"
    printf '%s\n' "$?" > "$exit_file"
  } 2>&1 | tee "$output_file" &
  pipeline_pid=$!

  if [[ "$PROGRESS_INTERVAL" -gt 0 ]]; then
    (
      while sleep "$PROGRESS_INTERVAL"; do
        kill -0 "$pipeline_pid" 2>/dev/null || exit 0
        now="$(date +%s)"
        elapsed=$((now - started_at))
        write_lock_status "worker_running" "$elapsed"
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
  rm -f "$exit_file"
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
PERMISSION_MODE="${CLAUDE_MINIMAX_PERMISSION_MODE:-auto}"
ITERATION=0

[[ $# -le 1 ]] || die "usage: ${RUNNER_NAME} [repository]"
[[ -f "$PROMPT_FILE" ]] || die "worker prompt not found: ${PROMPT_FILE}"
[[ "$BASE_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid base branch: ${BASE_BRANCH}"
is_non_negative_integer "$MAX_ITERATIONS" || \
  die "ISSUE_RUNNER_MAX_ITERATIONS must be a non-negative integer"
is_non_negative_integer "$PROGRESS_INTERVAL" || \
  die "ISSUE_RUNNER_PROGRESS_INTERVAL must be a non-negative integer"
command -v "$CLAUDE_SHELL" >/dev/null 2>&1 || die "shell not found: ${CLAUDE_SHELL}"

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
  assert_clean_worktree

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

  WORKER_STATUS="$(
    sed -n "s/^${STATUS_PREFIX}//p" "$OUTPUT_FILE" | tail -n 1
  )"

  if [[ "$WORKER_EXIT" -ne 0 ]]; then
    printf '%s: worker %s exited with code %s; output retained at %s\n' \
      "$RUNNER_NAME" "$ITERATION" "$WORKER_EXIT" "$OUTPUT_FILE" >&2
    exit 1
  fi

  case "$WORKER_STATUS" in
    ISSUE_COMPLETED)
      rm -f "$OUTPUT_FILE"
      printf '[%s] Worker %s completed one issue.\n' "$RUNNER_NAME" "$ITERATION"
      if [[ "$MAX_ITERATIONS" -gt 0 && "$ITERATION" -ge "$MAX_ITERATIONS" ]]; then
        printf '%s: iteration limit reached after %s completed issue(s)\n' \
          "$RUNNER_NAME" "$ITERATION"
        exit 3
      fi
      ;;
    QUEUE_EMPTY)
      rm -f "$OUTPUT_FILE"
      printf '[%s] No pending, available, non-epic issues remain.\n' "$RUNNER_NAME"
      exit 0
      ;;
    BLOCKED)
      printf '%s: pending work requires human input; output retained at %s\n' \
        "$RUNNER_NAME" "$OUTPUT_FILE" >&2
      exit 2
      ;;
    FAILED)
      printf '%s: worker failed to finish its issue; output retained at %s\n' \
        "$RUNNER_NAME" "$OUTPUT_FILE" >&2
      exit 1
      ;;
    *)
      printf '%s: worker returned no recognized status; output retained at %s\n' \
        "$RUNNER_NAME" "$OUTPUT_FILE" >&2
      exit 1
      ;;
  esac
done
