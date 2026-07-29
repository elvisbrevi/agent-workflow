#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="${ROOT_DIR}/agent/claude-minimax-issue-runner/run.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/claude-minimax-runner.XXXXXX")"
TESTS_RUN=0

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  TESTS_RUN=$((TESTS_RUN + 1))
  printf 'PASS: %s\n' "$1"
}

new_repo() {
  local path="$1"
  mkdir -p "$path"
  git -C "$path" init -b main --quiet
  git -C "$path" config user.name "Runner Test"
  git -C "$path" config user.email "runner@example.test"
  printf '%s\n' '# fixture' > "${path}/README.md"
  git -C "$path" add README.md
  git -C "$path" commit --quiet -m "test: seed"
}

test_fresh_shell_per_issue() {
  local home="${TEST_ROOT}/function-home"
  local repo="${TEST_ROOT}/function-repo"
  local output="${TEST_ROOT}/function-output.log"
  local count_file="${TEST_ROOT}/function-count"
  local source_file="${TEST_ROOT}/function-shell-starts"
  local args_file="${TEST_ROOT}/function-args"

  mkdir -p "$home"
  new_repo "$repo"

  printf '%s\n' \
    'printf "%s\\n" "new-shell" >>"$RUNNER_TEST_SOURCE_FILE"' \
    'claude-minimax() {' \
    '  local count=0 arg' \
    '  [[ -f "$RUNNER_TEST_COUNT_FILE" ]] && count="$(<"$RUNNER_TEST_COUNT_FILE")"' \
    '  count=$((count + 1))' \
    '  printf "%s\\n" "$count" >"$RUNNER_TEST_COUNT_FILE"' \
    '  for arg in "$@"; do printf "%s\\n" "$arg" >>"$RUNNER_TEST_ARGS_FILE"; done' \
    '  if [[ "$count" -eq 1 ]]; then' \
    '    printf "%s\\n" "CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=ISSUE_COMPLETED"' \
    '  else' \
    '    printf "%s\\n" "CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY"' \
    '  fi' \
    '}' > "${home}/.bashrc"

  HOME="$home" \
  RUNNER_TEST_COUNT_FILE="$count_file" \
  RUNNER_TEST_SOURCE_FILE="$source_file" \
  RUNNER_TEST_ARGS_FILE="$args_file" \
  ISSUE_RUNNER_ASSUME_YES=true \
    "$RUNNER" "$repo" >"$output" 2>&1 || fail 'Runner did not drain the simulated queue'

  [[ "$(<"$count_file")" == "2" ]] || fail 'Expected exactly two Claude-MiniMax workers'
  [[ "$(wc -l < "$source_file" | tr -d ' ')" == "2" ]] || \
    fail 'Expected .bashrc to be loaded by a fresh shell for every issue check'
  grep -Fxq -- '--print' "$args_file" || fail 'Missing --print'
  grep -Fxq -- '--no-session-persistence' "$args_file" || \
    fail 'Missing --no-session-persistence'
  grep -Fxq -- 'bypassPermissions' "$args_file" || fail 'Missing autonomous permission mode'
  grep -Fq 'No pending, available, non-epic issues remain.' "$output" || \
    fail 'Runner did not report a drained queue'

  pass 'one fresh claude-minimax shell is launched per iteration'
}

test_unknown_status_stops_loop() {
  local repo="${TEST_ROOT}/unknown-repo"
  local fake="${TEST_ROOT}/claude-minimax-no-status"
  local output="${TEST_ROOT}/unknown-output.log"
  local status

  new_repo "$repo"
  printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" "finished without marker"' > "$fake"
  chmod +x "$fake"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 1 ]] || fail 'Unknown worker status must fail'
  grep -Fq 'no recognized status' "$output" || fail 'Missing unknown-status diagnostic'

  pass 'missing worker status stops instead of looping'
}

test_dirty_worktree_is_rejected() {
  local repo="${TEST_ROOT}/dirty-repo"
  local fake="${TEST_ROOT}/must-not-run"
  local marker="${TEST_ROOT}/unexpected-worker"
  local output="${TEST_ROOT}/dirty-output.log"
  local status

  new_repo "$repo"
  printf '%s\n' 'dirty' >> "${repo}/README.md"
  printf '%s\n' '#!/usr/bin/env bash' "touch \"${marker}\"" > "$fake"
  chmod +x "$fake"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 1 ]] || fail 'Dirty worktree must fail'
  [[ ! -e "$marker" ]] || fail 'Worker launched despite dirty worktree'
  grep -Fq 'worktree is not clean' "$output" || fail 'Missing dirty-worktree diagnostic'

  pass 'dirty worktree is rejected before launching claude-minimax'
}

test_fresh_shell_per_issue
test_unknown_status_stops_loop
test_dirty_worktree_is_rejected

printf '%s Claude-MiniMax runner tests passed.\n' "$TESTS_RUN"
