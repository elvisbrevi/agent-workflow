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
  grep -Fxq -- 'bypassPermissions' "$args_file" || \
    fail 'Missing autonomous bypassPermissions mode'
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

test_progress_is_reported_while_worker_runs() {
  local repo="${TEST_ROOT}/progress-repo"
  local fake="${TEST_ROOT}/claude-minimax-progress"
  local output="${TEST_ROOT}/progress-output.log"

  new_repo "$repo"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'sleep 2' \
    'printf "%s\n" "CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY"' > "$fake"
  chmod +x "$fake"

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_PROGRESS_INTERVAL=1 \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1 || fail 'Progress fixture did not finish'

  grep -Fq 'Worker 1 still running (elapsed ' "$output" || \
    fail 'Runner did not emit a progress heartbeat'
  grep -Fq 'Repository lock acquired:' "$output" || \
    fail 'Runner did not report the repository lock'

  pass 'long-running workers emit visible progress heartbeats'
}

test_repository_lock_rejects_second_runner() {
  local repo="${TEST_ROOT}/locked-repo"
  local worktree="${TEST_ROOT}/locked-worktree"
  local fake="${TEST_ROOT}/claude-minimax-wait"
  local started="${TEST_ROOT}/locked-started"
  local release="${TEST_ROOT}/locked-release"
  local first_output="${TEST_ROOT}/locked-first.log"
  local second_output="${TEST_ROOT}/locked-second.log"
  local first_pid status attempt

  new_repo "$repo"
  git -C "$repo" worktree add --quiet -b linked-runner-test "$worktree"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'touch "$RUNNER_TEST_STARTED"' \
    'while [[ ! -e "$RUNNER_TEST_RELEASE" ]]; do sleep 0.1; done' \
    'printf "%s\n" "CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY"' > "$fake"
  chmod +x "$fake"

  RUNNER_TEST_STARTED="$started" \
  RUNNER_TEST_RELEASE="$release" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_PROGRESS_INTERVAL=1 \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$first_output" 2>&1 &
  first_pid=$!

  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    [[ -e "$started" ]] && break
    sleep 0.1
  done
  [[ -e "$started" ]] || fail 'First runner did not start its worker'

  grep -Fq 'state=worker_running' \
    "${repo}/.git/claude-minimax-issue-runner.lock/status" || \
    fail 'Repository lock did not expose the current worker state'

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$worktree" >"$second_output" 2>&1
  status=$?
  set -e

  touch "$release"
  wait "$first_pid" || fail 'First runner failed after releasing fixture'

  [[ "$status" -eq 1 ]] || fail 'Second runner must fail while repository is locked'
  grep -Fq 'another runner is active for this repository' "$second_output" || \
    fail 'Missing active repository lock diagnostic'
  grep -Fq 'state=worker_running' "$second_output" || \
    fail 'Second runner did not report the active runner status'
  [[ ! -e "${repo}/.git/claude-minimax-issue-runner.lock" ]] || \
    fail 'Repository lock was not released when the runner exited'

  pass 'repository lock covers linked worktrees and exposes its status'
}

test_stale_repository_lock_is_recovered() {
  local repo="${TEST_ROOT}/stale-lock-repo"
  local fake="${TEST_ROOT}/claude-minimax-stale-lock"
  local output="${TEST_ROOT}/stale-lock-output.log"
  local lock_dir

  new_repo "$repo"
  lock_dir="${repo}/.git/claude-minimax-issue-runner.lock"
  mkdir "$lock_dir"
  printf '%s\n' \
    'pid=999999' \
    'token=stale-test-token' \
    "repository=${repo}" > "${lock_dir}/owner"
  printf '%s\n' 'state=worker_running' > "${lock_dir}/status"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\n" "CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY"' > "$fake"
  chmod +x "$fake"

  ISSUE_RUNNER_ASSUME_YES=true \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1 || fail 'Runner did not recover stale lock'

  grep -Fq 'Recovered stale repository lock (previous pid 999999).' "$output" || \
    fail 'Missing stale-lock recovery diagnostic'
  [[ ! -e "$lock_dir" ]] || fail 'Recovered lock was not released on exit'

  pass 'stale repository lock is recovered automatically'
}

test_shell_function_loader_skips_interactive_only_startup() {
  local home="${TEST_ROOT}/startup-home"
  local repo="${TEST_ROOT}/startup-repo"
  local output="${TEST_ROOT}/startup-output.log"

  mkdir -p "$home"
  new_repo "$repo"
  printf '%s\n' \
    'enable -f /definitely/missing/libflyline.dylib flyline' \
    'claude-minimax() {' \
    '  printf "%s\n" "CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY"' \
    '}' > "${home}/.bashrc"

  HOME="$home" \
  ISSUE_RUNNER_ASSUME_YES=true \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Runner did not invoke the shell-defined worker'

  if grep -Eq 'no job control|cannot open shared object|libflyline' "$output"; then
    fail 'Runner executed interactive-only shell startup'
  fi

  pass 'shell-defined worker loads without interactive Flyline startup'
}

# --- Streaming JSON progress tests (issue #1) -------------------------------

emit_stream_event() {
  # Write a shell line that, when the fixture runs, echoes the JSON to stdout.
  # The JSON is wrapped in single quotes with embedded apostrophes escaped.
  local escaped="${1//\'/\'\\\'\'}"
  printf 'echo %s\n' "'$escaped'"
}

# Writes a fixture that emits the supplied stream-json events on its first
# invocation, then a QUEUE_EMPTY result on every subsequent invocation. The
# runner passes `--name ${RUNNER_NAME}-${ITERATION}` so the fixture can detect
# its iteration without keeping state on disk. Any argument that starts with
# `!` is passed through verbatim as a shell command, so a test can interleave
# raw shell (e.g. `!sleep 2`) with stream events.
write_stream_fixture() {
  local target="$1"
  shift
  cat > "$target" <<'PROLOG'
#!/usr/bin/env bash
iteration=1
name_next=0
for arg in "$@"; do
  if [[ "$name_next" == 1 ]]; then
    if [[ "$arg" =~ -([0-9]+)$ ]]; then
      iteration="${BASH_REMATCH[1]}"
    fi
    break
  fi
  if [[ "$arg" == "--name" ]]; then
    name_next=1
  fi
done
if [[ "$iteration" -gt 1 ]]; then
  printf '%s\n' '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY\n"}'
  exit 0
fi
PROLOG
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == '!'* ]]; then
      printf '%s\n' "${1:1}" >> "$target"
    else
      emit_stream_event "$1" >> "$target"
    fi
    shift
  done
  chmod +x "$target"
}

test_streaming_worker_renders_semantic_progress() {
  local repo="${TEST_ROOT}/stream-repo"
  local fake="${TEST_ROOT}/claude-minimax-stream"
  local output="${TEST_ROOT}/stream-output.log"

  new_repo "$repo"
  write_stream_fixture "$fake" \
    '{"type":"system","subtype":"init","cwd":"/repo"}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/repo/README.md"}}]}}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"agent/run.sh"}}]}}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t3","name":"Bash","input":{"command":"bash tests/claude_minimax_issue_runner_test.sh"}}]}}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t4","name":"Bash","input":{"command":"gh pr create --title progress --body streaming"}}]}}' \
    '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=ISSUE_COMPLETED\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1 || fail 'Streaming fixture did not finish'

  grep -Fq 'Inspecting' "$output" || \
    fail 'Missing semantic progress for an inspection event'
  grep -Fq 'Editing agent/run.sh' "$output" || \
    fail 'Missing semantic progress naming the edited file'
  grep -Fq 'Running tests' "$output" || \
    fail 'Missing semantic progress for a tests command'
  grep -Fq 'Creating pull request' "$output" || \
    fail 'Missing semantic progress for a PR-creation command'
  grep -Fq 'Repository lock acquired:' "$output" || \
    fail 'Runner did not report the repository lock'

  if grep -F '"type":"assistant"' "$output" >/dev/null 2>&1; then
    fail 'Raw stream JSON event leaked into operator output'
  fi
  if grep -F '"message":{"role":"assistant"' "$output" >/dev/null 2>&1; then
    fail 'Raw stream JSON content leaked into operator output'
  fi
  if grep -F 'tool_use' "$output" >/dev/null 2>&1; then
    fail 'Raw stream JSON tool name leaked into operator output'
  fi
  if grep -F '/repo/README.md' "$output" >/dev/null 2>&1; then
    fail 'Raw tool input file path leaked into operator output'
  fi

  pass 'streaming worker renders semantic progress without leaking raw JSON'
}

test_streaming_silent_worker_heartbeats() {
  local repo="${TEST_ROOT}/silent-repo"
  local fake="${TEST_ROOT}/claude-minimax-silent"
  local output="${TEST_ROOT}/silent-output.log"

  new_repo "$repo"
  # The fixture stays silent (no stream events) for two seconds before
  # emitting the final result, so the runner must fall back to a heartbeat.
  write_stream_fixture "$fake" \
    '!sleep 2' \
    '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_PROGRESS_INTERVAL=1 \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1 || fail 'Silent streaming fixture did not finish'

  grep -Fq 'Worker 1 still running (elapsed ' "$output" || \
    fail 'Runner did not emit a progress heartbeat for a silent streaming worker'
  if grep -F '"type":"result"' "$output" >/dev/null 2>&1; then
    fail 'Raw stream JSON leaked into operator output during a silent run'
  fi

  pass 'silent streaming workers still trigger elapsed-time heartbeats'
}

test_streaming_heartbeat_suppressed_while_events_flow() {
  local repo="${TEST_ROOT}/active-repo"
  local fake="${TEST_ROOT}/claude-minimax-active"
  local output="${TEST_ROOT}/active-output.log"

  new_repo "$repo"
  # The fixture keeps producing events faster than the heartbeat interval
  # for two seconds, so no elapsed-time heartbeat should reach the operator.
  write_stream_fixture "$fake" \
    '!for i in 1 2 3 4; do printf "%s\n" "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"tick $i\"}]}}"; sleep 0.5; done' \
    '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_PROGRESS_INTERVAL=1 \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1 || fail 'Active streaming fixture did not finish'

  if grep -Fq 'Worker 1 still running (elapsed ' "$output"; then
    fail 'Heartbeat fired while the renderer was still streaming events'
  fi

  pass 'active streaming workers suppress the elapsed-time heartbeat'
}

test_streaming_worker_redacts_secrets_and_redacts_full_prompts() {
  local repo="${TEST_ROOT}/redact-repo"
  local fake="${TEST_ROOT}/claude-minimax-redact"
  local output="${TEST_ROOT}/redact-output.log"

  new_repo "$repo"
  write_stream_fixture "$fake" \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"curl -H \"Authorization: Bearer gh_super_secret_token_xyz\" https://api.example.com"}}]}}' \
    '{"type":"result","subtype":"success","result":"echoed: Authorization Bearer gh_super_secret_token_xyz\nCLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=ISSUE_COMPLETED\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1 || fail 'Redaction fixture did not finish'

  if grep -F 'gh_super_secret_token_xyz' "$output" >/dev/null 2>&1; then
    fail 'Bearer token leaked into operator output'
  fi
  if grep -F 'Authorization' "$output" >/dev/null 2>&1; then
    fail 'Authorization header fragment leaked into operator output'
  fi

  pass 'streaming worker redacts secrets and keeps full prompts out of operator output'
}

test_streaming_worker_extracts_each_status_marker() {
  local marker expected
  for marker in ISSUE_COMPLETED QUEUE_EMPTY BLOCKED FAILED; do
    case "$marker" in
      ISSUE_COMPLETED|QUEUE_EMPTY) expected=0 ;;
      BLOCKED) expected=2 ;;
      FAILED) expected=1 ;;
    esac

    new_repo "${TEST_ROOT}/markers-${marker}-repo"
    write_stream_fixture "${TEST_ROOT}/claude-minimax-${marker}" \
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"gh pr create"}}]}}' \
      "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=${marker}\\n\"}"

    set +e
    ISSUE_RUNNER_ASSUME_YES=true \
    CLAUDE_MINIMAX_COMMAND="${TEST_ROOT}/claude-minimax-${marker}" \
      "$RUNNER" "${TEST_ROOT}/markers-${marker}-repo" \
      >"${TEST_ROOT}/markers-${marker}-output.log" 2>&1
    local status=$?
    set -e

    [[ "$status" -eq "$expected" ]] || \
      fail "Expected exit ${expected} for ${marker}, got ${status}"
  done

  pass 'streaming workers yield every recognized status marker with the right exit code'
}

test_streaming_worker_preserves_non_zero_exit_code() {
  local repo="${TEST_ROOT}/exit-repo"
  local fake="${TEST_ROOT}/claude-minimax-exit"
  local output="${TEST_ROOT}/exit-output.log"
  local status

  new_repo "$repo"
  # This fixture streams one event and exits 7 with no status marker; the
  # runner must propagate the non-zero exit as a runner-side failure.
  cat > "$fake" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/etc"}}]}}'
exit 7
EOF
  chmod +x "$fake"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 1 ]] || \
    fail "Non-zero worker exit must yield runner exit 1, got ${status}"
  grep -Fq 'exited with code 7' "$output" || \
    fail 'Missing diagnostic for non-zero worker exit code'

  pass 'non-zero worker exit is preserved by the streaming renderer pipeline'
}

test_streaming_blocked_retains_artifact_path() {
  local repo="${TEST_ROOT}/blocked-repo"
  local fake="${TEST_ROOT}/claude-minimax-blocked"
  local output="${TEST_ROOT}/blocked-output.log"
  local status

  new_repo "$repo"
  write_stream_fixture "$fake" \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"AskUserQuestion","input":{"questions":[{"question":"Continue?","options":[]}]}}]}}' \
    '{"type":"result","subtype":"success","result":"need human input\nCLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=BLOCKED\n"}'

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 2 ]] || fail "BLOCKED must exit 2, got ${status}"
  grep -Fq 'output retained at' "$output" || \
    fail 'BLOCKED diagnostic did not reference the retained artifact path'

  pass 'BLOCKED outcome retains its diagnostic artifact and exits 2'
}

test_streaming_invokes_worker_with_stream_json_output_flag() {
  local home="${TEST_ROOT}/stream-args-home"
  local repo="${TEST_ROOT}/stream-args-repo"
  local output="${TEST_ROOT}/stream-args-output.log"
  local args_file="${TEST_ROOT}/stream-args"
  local stream_args_present=true

  mkdir -p "$home"
  new_repo "$repo"
  printf '%s\n' \
    'claude-minimax() {' \
    '  local arg' \
    '  for arg in "$@"; do printf "%s\n" "$arg" >>"$RUNNER_TEST_ARGS_FILE"; done' \
    '  printf "%s\n" "CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY"' \
    '}' > "${home}/.bashrc"

  if ! HOME="$home" \
       RUNNER_TEST_ARGS_FILE="$args_file" \
       ISSUE_RUNNER_ASSUME_YES=true \
         "$RUNNER" "$repo" >"$output" 2>&1; then
    stream_args_present=false
  fi

  $stream_args_present || fail 'Stream-args fixture did not finish'
  grep -Fxq -- '--output-format' "$args_file" || \
    fail 'Runner did not pass --output-format when invoking claude-minimax'
  grep -Fxq -- 'stream-json' "$args_file" || \
    fail 'Runner did not request stream-json output format'

  pass 'runner invokes claude-minimax with stream-json output enabled'
}

# --- Checkpoint persistence tests (issue #2) -------------------------------

RUNNER_NAME="claude-minimax-issue-runner"

# Absolute path to the Git common directory, matching how the runner
# resolves the lock and checkpoint destinations.
checkpoint_path() {
  local repo="$1"
  local common_dir
  common_dir="$(git -C "$repo" rev-parse --git-common-dir)"
  if [[ "$common_dir" = /* ]]; then
    printf '%s' "$common_dir"
  else
    (cd "$repo" && printf '%s/%s' "$(pwd -P)" "$common_dir")
  fi
}

test_streaming_worker_identifies_issue_before_first_mutation() {
  local repo="${TEST_ROOT}/identify-repo"
  local fake="${TEST_ROOT}/claude-minimax-identify"
  local output="${TEST_ROOT}/identify-output.log"
  local checkpoint_file
  local status_file

  new_repo "$repo"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"
  status_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.lock/status"

  # Issue identification precedes any Edit or git mutation. The issue number
  # must be captured from `gh issue view N` before the assistant edits a file.
  write_stream_fixture "$fake" \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"gh issue view 42"}}]}}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"agent/run.sh"}}]}}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t3","name":"Bash","input":{"command":"git commit -m feat: implement"}}]}}' \
    '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=ISSUE_COMPLETED\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Identify-before-mutation fixture did not finish'

  # Issue 42 must be recorded before the Edit event reached the renderer.
  # We inspect the output ordering: the 'Identified issue 42' progress line
  # must appear before 'Editing agent/run.sh'.
  local identify_line edit_line
  identify_line="$( { grep -n 'Identified issue 42' "$output" || true; } | head -n 1 | cut -d: -f1)"
  edit_line="$( { grep -n 'Editing agent/run.sh' "$output" || true; } | head -n 1 | cut -d: -f1)"
  [[ -n "$identify_line" && -n "$edit_line" ]] || \
    fail 'Runner did not surface the identified issue before the first mutation'
  (( identify_line < edit_line )) || \
    fail 'Issue identification was emitted after a mutation event'

  pass 'streamed worker identifies its issue before its first mutation'
}

test_checkpoint_records_required_fields_atomically() {
  local repo="${TEST_ROOT}/fields-repo"
  local fake="${TEST_ROOT}/claude-minimax-fields"
  local output="${TEST_ROOT}/fields-output.log"
  local checkpoint_file lock_status_file

  new_repo "$repo"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"
  lock_status_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.lock/status"

  # Force a worker failure so the checkpoint survives to be inspected.
  write_stream_fixture "$fake" \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"gh issue view 7"}}]}}' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"agent/run.sh"}}]}}' \
    '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=FAILED\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1 || true

  [[ -r "$checkpoint_file" ]] || \
    fail 'Checkpoint file was not written atomically on FAILED outcome'
  # Atomic means the file is either present in full or absent; a stray .tmp
  # sibling would indicate a non-atomic write.
  [[ ! -e "${checkpoint_file}.tmp" ]] || \
    fail 'Checkpoint left a stray temporary file (non-atomic write)'

  for field in iteration issue branch base_branch base_sha state updated_at; do
    grep -Eq "^${field}=" "$checkpoint_file" || \
      fail "Checkpoint missing required field: ${field}"
  done

  grep -Eq '^issue=7$' "$checkpoint_file" || \
    fail 'Checkpoint did not capture the selected issue number'
  grep -Eq '^branch=main$' "$checkpoint_file" || \
    fail 'Checkpoint did not capture the current branch'
  grep -Eq '^base_branch=main$' "$checkpoint_file" || \
    fail 'Checkpoint did not capture the configured base branch'
  grep -Eq '^base_sha=[0-9a-f]{40}$' "$checkpoint_file" || \
    fail 'Checkpoint did not capture a valid base branch SHA'

  pass 'checkpoint records required fields and survives a failed outcome'
}

test_checkpoint_does_not_persist_secrets_or_full_commands() {
  local repo="${TEST_ROOT}/redact-checkpoint-repo"
  local fake="${TEST_ROOT}/claude-minimax-redact-checkpoint"
  local output="${TEST_ROOT}/redact-checkpoint-output.log"
  local checkpoint_file

  new_repo "$repo"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"

  # The worker passes a bearer token in its command; the checkpoint must
  # capture only the issue number, never the credential or the full command.
  write_stream_fixture "$fake" \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"gh issue view 9 -H \"Authorization: Bearer gh_super_secret_token_xyz\""}}]}}' \
    '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=FAILED\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1 || true

  [[ -r "$checkpoint_file" ]] || \
    fail 'Checkpoint was not written for a FAILED outcome'
  if grep -Fq 'gh_super_secret_token_xyz' "$checkpoint_file"; then
    fail 'Checkpoint persisted a bearer token'
  fi
  if grep -Fqi 'authorization' "$checkpoint_file"; then
    fail 'Checkpoint persisted an authorization header fragment'
  fi
  if grep -Fq 'gh issue view' "$checkpoint_file"; then
    fail 'Checkpoint persisted the full shell command'
  fi

  pass 'checkpoint never persists secrets, full commands, or authorization fragments'
}

test_checkpoint_cleared_on_issue_completed() {
  local repo="${TEST_ROOT}/clear-completed-repo"
  local fake="${TEST_ROOT}/claude-minimax-clear-completed"
  local output="${TEST_ROOT}/clear-completed-output.log"
  local checkpoint_file

  new_repo "$repo"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"

  write_stream_fixture "$fake" \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"gh issue view 11"}}]}}' \
    '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=ISSUE_COMPLETED\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Completed fixture did not finish'

  [[ ! -e "$checkpoint_file" ]] || \
    fail 'Checkpoint was not cleared after ISSUE_COMPLETED'

  pass 'checkpoint is cleared after a successful ISSUE_COMPLETED'
}

test_checkpoint_cleared_on_queue_empty() {
  local repo="${TEST_ROOT}/clear-empty-repo"
  local fake="${TEST_ROOT}/claude-minimax-clear-empty"
  local output="${TEST_ROOT}/clear-empty-output.log"
  local checkpoint_file

  new_repo "$repo"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"

  write_stream_fixture "$fake" \
    '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Empty queue fixture did not finish'

  [[ ! -e "$checkpoint_file" ]] || \
    fail 'Checkpoint was not cleared after QUEUE_EMPTY'

  pass 'checkpoint is cleared after a verified empty queue'
}

test_checkpoint_retained_on_non_zero_exit() {
  local repo="${TEST_ROOT}/retain-exit-repo"
  local fake="${TEST_ROOT}/claude-minimax-retain-exit"
  local output="${TEST_ROOT}/retain-exit-output.log"
  local checkpoint_file lock_status_file

  new_repo "$repo"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"
  lock_status_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.lock/status"

  # Fixture streams a single event then exits 7 with no status marker. The
  # runner must surface the failure AND retain the checkpoint with the last
  # safe state so the next startup can attempt recovery.
  cat > "$fake" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"gh issue view 13"}}]}}'
exit 7
EOF
  chmod +x "$fake"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1
  set -e

  [[ -r "$checkpoint_file" ]] || \
    fail 'Checkpoint was lost after a non-zero worker exit'
  grep -Eq '^issue=13$' "$checkpoint_file" || \
    fail 'Checkpoint did not retain the identified issue on non-zero exit'
  grep -Eq '^state=' "$checkpoint_file" || \
    fail 'Checkpoint did not retain its last safe state'

  pass 'non-zero worker exit retains the checkpoint with the last safe state'
}

test_checkpoint_retained_on_blocked_outcome() {
  local repo="${TEST_ROOT}/retain-blocked-repo"
  local fake="${TEST_ROOT}/claude-minimax-retain-blocked"
  local output="${TEST_ROOT}/retain-blocked-output.log"
  local checkpoint_file

  new_repo "$repo"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"

  write_stream_fixture "$fake" \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"gh issue view 21"}}]}}' \
    '{"type":"result","subtype":"success","result":"need human input\nCLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=BLOCKED\n"}'

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1
  local status=$?
  set -e

  [[ "$status" -eq 2 ]] || fail "BLOCKED must exit 2, got ${status}"

  [[ -r "$checkpoint_file" ]] || \
    fail 'Checkpoint was not retained after BLOCKED'
  grep -Eq '^issue=21$' "$checkpoint_file" || \
    fail 'BLOCKED checkpoint did not record the issue'
  grep -Eq '^state=blocked$' "$checkpoint_file" || \
    fail 'BLOCKED checkpoint did not record a blocked lifecycle state'

  pass 'BLOCKED outcome retains the checkpoint with its lifecycle state'
}

test_lock_status_exposes_checkpoint_identity() {
  local repo="${TEST_ROOT}/status-identity-repo"
  local fake="${TEST_ROOT}/claude-minimax-status-identity"
  local output="${TEST_ROOT}/status-identity-output.log"
  local lock_status_file
  local first_pid attempt
  local started="${TEST_ROOT}/status-identity-started"
  local release="${TEST_ROOT}/status-identity-release"

  new_repo "$repo"
  lock_status_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.lock/status"

  # The fixture sleeps so the runner remains alive long enough to inspect
  # the lock status file from another shell — exactly how an operator
  # would observe progress during a long issue implementation. The
  # `gh issue view` event is emitted first so the checkpoint captures the
  # issue identity BEFORE the worker blocks.
  write_stream_fixture "$fake" \
    '!touch "$RUNNER_TEST_STARTED"' \
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"gh issue view 33"}}]}}' \
    '!while [[ ! -e "$RUNNER_TEST_RELEASE" ]]; do sleep 0.1; done' \
    '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY\n"}'

  RUNNER_TEST_STARTED="$started" \
  RUNNER_TEST_RELEASE="$release" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_PROGRESS_INTERVAL=1 \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1 &
  first_pid=$!

  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    [[ -e "$started" ]] && break
    sleep 0.1
  done
  [[ -e "$started" ]] || fail 'Runner did not start the identity fixture'

  # The lock status snapshot is observable from another terminal. The runner
  # must publish the same identity fields (issue, branch, base_branch,
  # lifecycle state) so operators can inspect progress without reading the
  # checkpoint file directly. Wait for the renderer to publish the issue
  # identity from the `gh issue view` event before inspecting the lock
  # status — the worker may touch `started` before the renderer has
  # processed that stream event.
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40; do
    if grep -Eq '^issue=33$' "$lock_status_file" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done

  [[ -r "$lock_status_file" ]] || \
    fail 'Lock status file was not produced'
  for field in issue branch base_branch state; do
    grep -Eq "^${field}=" "$lock_status_file" || \
      fail "Lock status missing checkpoint field: ${field}"
  done
  grep -Eq '^issue=33$' "$lock_status_file" || \
    fail 'Lock status did not expose the identified issue'
  grep -Eq '^branch=main$' "$lock_status_file" || \
    fail 'Lock status did not expose the current branch'

  touch "$release"
  wait "$first_pid" || fail 'Identity runner failed after release'

  pass 'repository lock status exposes the same checkpoint identity'
}

# --- Transient disconnect retry tests (issue #3) ---------------------------
#
# A "transient fixture" simulates a Claude worker that emits a stream-json
# result event whose text matches one of the approved transport failure
# signatures, then exits with a non-zero status. The runner must recognize
# the pattern, apply the bounded backoff, and retry until the fixture
# eventually returns a recognized status marker.

# Writes a fixture that:
#   - reads the current attempt number from $2 (an on-disk counter file);
#   - extracts the runner iteration from --name <runner>-<N>;
#   - on attempt 1, 2, ..., emits the supplied "transient" result event
#     and exits with a non-zero status; the fixture's own attempt count
#     drives the loop, so the runner's ITERATION counter does not change;
#   - on the final attempt, emits a recognized status marker;
#   - on subsequent iterations (after the issue is "completed"), emits
#     QUEUE_EMPTY so the runner exits normally instead of looping.
# Args: target, counter, transient_result_text, final_marker
write_transient_fixture() {
  local target="$1"
  local counter="$2"
  local transient_text="$3"
  local final_marker="$4"

  cat > "$target" <<PROLOG
#!/usr/bin/env bash
counter_file="$counter"
attempt=0
[[ -f "\$counter_file" ]] && attempt=\$(<"\$counter_file")
attempt=\$((attempt + 1))
printf '%s\n' "\$attempt" > "\$counter_file"

iteration=1
name_next=0
for arg in "\$@"; do
  if [[ "\$name_next" == "1" ]]; then
    if [[ "\$arg" =~ -([0-9]+)\$ ]]; then
      iteration="\${BASH_REMATCH[1]}"
    fi
    break
  fi
  if [[ "\$arg" == "--name" ]]; then
    name_next=1
  fi
done

if [[ "\$iteration" -gt 1 ]]; then
  printf '%s\n' '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY\\n"}'
  exit 0
fi

if [[ "\$attempt" -le 2 ]]; then
  printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"attempt '"'"'\$attempt'"'"' starting"}]}}'
  printf '%s\n' '{"type":"result","subtype":"error","is_error":true,"result":"${transient_text}"}'
  exit 1
fi

printf '%s\n' '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=${final_marker}\\n"}'
exit 0
PROLOG
  chmod +x "$target"
}

# Writes a fixture that emits a non-transient failure on attempt 1 and a
# recognized status marker on attempt 2. The retry path must NOT trigger.
# On subsequent iterations the fixture returns QUEUE_EMPTY so the runner
# can drain its loop instead of looping indefinitely.
write_non_transient_fixture() {
  local target="$1"
  local counter="$2"
  local unknown_text="$3"
  local final_marker="$4"

  cat > "$target" <<PROLOG
#!/usr/bin/env bash
counter_file="$counter"
attempt=0
[[ -f "\$counter_file" ]] && attempt=\$(<"\$counter_file")
attempt=\$((attempt + 1))
printf '%s\n' "\$attempt" > "\$counter_file"

iteration=1
name_next=0
for arg in "\$@"; do
  if [[ "\$name_next" == "1" ]]; then
    if [[ "\$arg" =~ -([0-9]+)\$ ]]; then
      iteration="\${BASH_REMATCH[1]}"
    fi
    break
  fi
  if [[ "\$arg" == "--name" ]]; then
    name_next=1
  fi
done

if [[ "\$iteration" -gt 1 ]]; then
  printf '%s\n' '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY\\n"}'
  exit 0
fi

if [[ "\$attempt" -le 1 ]]; then
  printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"attempt '"'"'\$attempt'"'"' starting"}]}}'
  printf '%s\n' '{"type":"result","subtype":"error","is_error":true,"result":"${unknown_text}"}'
  exit 1
fi

printf '%s\n' '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=${final_marker}\\n"}'
exit 0
PROLOG
  chmod +x "$target"
}

# Writes a fixture that emits a non-transient BLOCKED outcome on attempt 1.
# Retry must NOT trigger. On subsequent iterations the fixture returns
# QUEUE_EMPTY so the runner can drain its loop.
write_blocked_fixture() {
  local target="$1"
  local counter="$2"

  cat > "$target" <<PROLOG
#!/usr/bin/env bash
counter_file="$counter"
attempt=0
[[ -f "\$counter_file" ]] && attempt=\$(<"\$counter_file")
attempt=\$((attempt + 1))
printf '%s\n' "\$attempt" > "\$counter_file"

iteration=1
name_next=0
for arg in "\$@"; do
  if [[ "\$name_next" == "1" ]]; then
    if [[ "\$arg" =~ -([0-9]+)\$ ]]; then
      iteration="\${BASH_REMATCH[1]}"
    fi
    break
  fi
  if [[ "\$arg" == "--name" ]]; then
    name_next=1
  fi
done

if [[ "\$iteration" -gt 1 ]]; then
  printf '%s\n' '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY\\n"}'
  exit 0
fi

printf '%s\n' '{"type":"result","subtype":"success","result":"needs human input\\nCLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=BLOCKED\\n"}'
exit 0
PROLOG
  chmod +x "$target"
}

test_transient_disconnect_retries_with_bounded_backoff() {
  local repo="${TEST_ROOT}/transient-retry-repo"
  local fake="${TEST_ROOT}/claude-minimax-transient-retry"
  local output="${TEST_ROOT}/transient-retry-output.log"
  local counter="${TEST_ROOT}/transient-retry-counter"
  local lock_status

  new_repo "$repo"
  write_transient_fixture "$fake" "$counter" \
    "Connection closed by remote host" \
    "ISSUE_COMPLETED"

  # Override the default 15,30,60 backoff so the test completes quickly.
  # The fixture still fails on attempts 1 and 2 then succeeds, so we
  # expect the runner to retry through three total attempts.
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="1,1,1" \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Transient retry fixture did not finish'

  # The fixture was invoked three times: two transient failures and one
  # successful completion.
  local attempts
  attempts="$(<"$counter")"
  [[ "$attempts" -ge 3 ]] || \
    fail "Expected at least three worker attempts, got ${attempts}"

  # The runner must log the retry attempt and the backoff sleep.
  grep -Fq 'Recovering from transient transport failure' "$output" || \
    fail 'Runner did not announce the transient retry'
  grep -Fq 'attempt 1 of' "$output" || \
    fail 'Runner did not report the attempt counter'
  grep -Fq 'recovery_delay=' "$output" || \
    fail 'Runner did not publish the configured backoff delay'

  # The runner announces the retry in stdout with the category, attempt,
  # and delay. The lock-status snapshot is also written between the
  # first failure and the backoff sleep, but it is released on exit;
  # the stdout announcement is the observable signal.
  grep -Fq 'recovery_category=transient_transport' "$output" || \
    fail 'Runner did not publish the transient failure category in stdout'

  pass 'transient transport failure retries with bounded backoff'
}

test_non_transient_disconnect_does_not_retry() {
  local repo="${TEST_ROOT}/non-transient-repo"
  local fake="${TEST_ROOT}/claude-minimax-non-transient"
  local output="${TEST_ROOT}/non-transient-output.log"
  local counter="${TEST_ROOT}/non-transient-counter"
  local status

  new_repo "$repo"
  write_non_transient_fixture "$fake" "$counter" \
    "Something completely unexpected went wrong" \
    "ISSUE_COMPLETED"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  # Only one attempt: the unknown error must stop the loop.
  [[ "$(<"$counter")" == "1" ]] || \
    fail 'Non-transient failure must not trigger a retry'
  [[ "$status" -eq 1 ]] || \
    fail "Non-transient worker failure must exit 1, got ${status}"
  if grep -Fq 'Recovering from transient transport failure' "$output"; then
    fail 'Runner announced a transient retry for a non-transient failure'
  fi

  pass 'non-transient failure stops the loop without retrying'
}

test_blocked_outcome_does_not_retry() {
  local repo="${TEST_ROOT}/blocked-no-retry-repo"
  local fake="${TEST_ROOT}/claude-minimax-blocked-no-retry"
  local output="${TEST_ROOT}/blocked-no-retry-output.log"
  local counter="${TEST_ROOT}/blocked-no-retry-counter"
  local status

  new_repo "$repo"
  write_blocked_fixture "$fake" "$counter"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$(<"$counter")" == "1" ]] || \
    fail 'BLOCKED outcome must not trigger a retry'
  [[ "$status" -eq 2 ]] || \
    fail "BLOCKED must exit 2, got ${status}"

  pass 'BLOCKED outcome stops immediately and never retries'
}

test_recovery_reconciles_local_state_before_continuing() {
  local repo="${TEST_ROOT}/reconcile-repo"
  local fake="${TEST_ROOT}/claude-minimax-reconcile"
  local output="${TEST_ROOT}/reconcile-output.log"
  local counter="${TEST_ROOT}/reconcile-counter"
  local checkpoint_file

  new_repo "$repo"
  write_transient_fixture "$fake" "$counter" \
    "Connection reset by peer" \
    "ISSUE_COMPLETED"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"

  # Pre-seed a checkpoint that identifies the in-flight issue, branch, and
  # base SHA so the orchestrator has identity context for reconciliation.
  cat > "$checkpoint_file" <<EOF
pid=$$
iteration=1
issue=99
branch=main
base_branch=main
base_sha=$(git -C "$repo" rev-parse HEAD)
state=mutating
updated_at=test
EOF

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="1,1,1" \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Reconcile fixture did not finish'

  grep -Fq 'Reconciling recovery state' "$output" || \
    fail 'Runner did not announce the reconciliation step'

  pass 'recovery reconciles local branch and checkpoint state before retrying'
}

test_session_resume_when_checkpoint_has_safe_session_id() {
  local repo="${TEST_ROOT}/resume-repo"
  local home="${TEST_ROOT}/resume-home"
  local fake="${TEST_ROOT}/claude-minimax-resume"
  local output="${TEST_ROOT}/resume-output.log"
  local counter="${TEST_ROOT}/resume-counter"
  local args_file="${TEST_ROOT}/resume-args"
  local checkpoint_file

  mkdir -p "$home"
  new_repo "$repo"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"

  # The first attempt emits a transient failure. The second attempt must
  # receive --resume <session_id> from the captured Claude session id.
  cat > "$fake" <<PROLOG
#!/usr/bin/env bash
counter_file="$counter"
attempt=0
[[ -f "\$counter_file" ]] && attempt=\$(<"\$counter_file")
attempt=\$((attempt + 1))
printf '%s\n' "\$attempt" > "\$counter_file"

iteration=1
name_next=0
for arg in "\$@"; do
  if [[ "\$name_next" == "1" ]]; then
    if [[ "\$arg" =~ -([0-9]+)\$ ]]; then
      iteration="\${BASH_REMATCH[1]}"
    fi
    break
  fi
  if [[ "\$arg" == "--name" ]]; then
    name_next=1
  fi
done

if [[ "\$iteration" -gt 1 ]]; then
  printf '%s\n' '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY\\n"}'
  exit 0
fi

if [[ "\$attempt" -eq 1 ]]; then
  printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-resume-xyz"}'
  printf '%s\n' '{"type":"result","subtype":"error","is_error":true,"result":"Connection closed by remote host"}'
  exit 1
fi

for arg in "\$@"; do printf '%s\n' "\$arg" >>"$args_file"; done
printf '%s\n' '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=ISSUE_COMPLETED\\n"}'
exit 0
PROLOG
  chmod +x "$fake"

  printf '%s\n' \
    'claude-minimax() {' \
    '  local arg' \
    '  for arg in "$@"; do printf "%s\\n" "$arg" >>"$RUNNER_TEST_ARGS_FILE"; done' \
    '  counter_file="'"$counter"'"' \
    '  attempt=0' \
    '  [[ -f "$counter_file" ]] && attempt=$(<"$counter_file")' \
    '  attempt=$((attempt + 1))' \
    '  printf "%s\\n" "$attempt" >"$counter_file"' \
    '  iteration=1' \
    '  name_next=0' \
    '  for arg in "$@"; do' \
    '    if [[ "$name_next" == "1" ]]; then' \
    '      if [[ "$arg" =~ -([0-9]+)$ ]]; then' \
    '        iteration="${BASH_REMATCH[1]}"' \
    '      fi' \
    '      break' \
    '    fi' \
    '    if [[ "$arg" == "--name" ]]; then' \
    '      name_next=1' \
    '    fi' \
    '  done' \
    '  if [[ "$iteration" -gt 1 ]]; then' \
    '    printf "%s\\n" "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY\\n\"}"' \
    '    return 0' \
    '  fi' \
    '  if [[ "$attempt" -eq 1 ]]; then' \
    '    printf "%s\\n" "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sess-shell-resume-xyz\"}"' \
    '    printf "%s\\n" "{\"type\":\"result\",\"subtype\":\"error\",\"is_error\":true,\"result\":\"Connection closed by remote host\"}"' \
    '    return 1' \
    '  fi' \
    '  printf "%s\\n" "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=ISSUE_COMPLETED\\n\"}"' \
    '}' > "${home}/.bashrc"

  # Pre-seed the checkpoint with a session id and a matching branch so the
  # runner considers the session safe to resume.
  cat > "$checkpoint_file" <<EOF
pid=$$
iteration=1
issue=5
branch=main
base_branch=main
base_sha=$(git -C "$repo" rev-parse HEAD)
session_id=sess-preflight
state=mutating
updated_at=test
EOF

  HOME="$home" \
  RUNNER_TEST_ARGS_FILE="$args_file" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="1,1,1" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Resume fixture did not finish'

  # The second worker invocation must receive --resume with the captured id.
  # This is the runtime observable of the resume path: if the worker was
  # invoked with --resume <captured-id>, then the orchestrator both
  # captured the session id and decided it was safe to resume.
  grep -Fxq -- '--resume' "$args_file" || \
    fail 'Recovery worker was not invoked with --resume'
  grep -Fxq -- 'sess-shell-resume-xyz' "$args_file" || \
    fail 'Recovery worker did not receive the captured session id'

  pass 'recovery worker resumes the captured Claude session when safe'
}

test_session_resume_skipped_when_no_captured_session_id() {
  local repo="${TEST_ROOT}/no-session-repo"
  local home="${TEST_ROOT}/no-session-home"
  local fake="${TEST_ROOT}/claude-minimax-no-session"
  local output="${TEST_ROOT}/no-session-output.log"
  local counter="${TEST_ROOT}/no-session-counter"
  local args_file="${TEST_ROOT}/no-session-args"

  mkdir -p "$home"
  new_repo "$repo"

  # Fixture emits a transient failure on attempt 1 WITHOUT a system init
  # event, so no session id is captured. Attempt 2 succeeds.
  printf '%s\n' \
    'claude-minimax() {' \
    '  local arg' \
    '  for arg in "$@"; do printf "%s\\n" "$arg" >>"$RUNNER_TEST_ARGS_FILE"; done' \
    '  counter_file="'"$counter"'"' \
    '  attempt=0' \
    '  [[ -f "$counter_file" ]] && attempt=$(<"$counter_file")' \
    '  attempt=$((attempt + 1))' \
    '  printf "%s\\n" "$attempt" >"$counter_file"' \
    '  iteration=1' \
    '  name_next=0' \
    '  for arg in "$@"; do' \
    '    if [[ "$name_next" == "1" ]]; then' \
    '      if [[ "$arg" =~ -([0-9]+)$ ]]; then' \
    '        iteration="${BASH_REMATCH[1]}"' \
    '      fi' \
    '      break' \
    '    fi' \
    '    if [[ "$arg" == "--name" ]]; then' \
    '      name_next=1' \
    '    fi' \
    '  done' \
    '  if [[ "$iteration" -gt 1 ]]; then' \
    '    printf "%s\\n" "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY\\n\"}"' \
    '    return 0' \
    '  fi' \
    '  if [[ "$attempt" -eq 1 ]]; then' \
    '    printf "%s\\n" "{\"type\":\"result\",\"subtype\":\"error\",\"is_error\":true,\"result\":\"Connection closed by remote host\"}"' \
    '    return 1' \
    '  fi' \
    '  printf "%s\\n" "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=ISSUE_COMPLETED\\n\"}"' \
    '}' > "${home}/.bashrc"

  HOME="$home" \
  RUNNER_TEST_ARGS_FILE="$args_file" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="1,1,1" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'No-session fixture did not finish'

  # Without a captured session id, the recovery worker must launch fresh
  # with --no-session-persistence and must NOT receive --resume.
  if grep -Fxq -- '--resume' "$args_file"; then
    fail 'Recovery worker received --resume despite no captured session id'
  fi
  grep -Fxq -- '--no-session-persistence' "$args_file" || \
    fail 'Fresh recovery worker did not receive --no-session-persistence'

  pass 'session resume is skipped when no session id was captured'
}

test_recovery_required_after_exhausted_retries() {
  local repo="${TEST_ROOT}/recovery-required-repo"
  local fake="${TEST_ROOT}/claude-minimax-recovery-required"
  local output="${TEST_ROOT}/recovery-required-output.log"
  local counter="${TEST_ROOT}/recovery-required-counter"
  local checkpoint_file
  local status

  new_repo "$repo"
  write_transient_fixture "$fake" "$counter" \
    "Connection closed by remote host" \
    "ISSUE_COMPLETED"
  # The fixture only retries twice (attempt 1 and 2), then would succeed
  # on attempt 3. Override the limit so the runner gives up before the
  # fixture succeeds.
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="1,1,1" \
  ISSUE_RUNNER_RETRY_LIMIT=1 \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 4 ]] || \
    fail "Exhausted retries must exit 4 (RECOVERY_REQUIRED), got ${status}"
  grep -Fq 'RECOVERY_REQUIRED' "$output" || \
    fail 'Runner did not announce RECOVERY_REQUIRED'
  # The checkpoint must be retained for the next restart to inspect.
  [[ -r "$checkpoint_file" ]] || \
    fail 'Checkpoint was cleared after a RECOVERY_REQUIRED outcome'
  grep -Eq '^state=' "$checkpoint_file" || \
    fail 'Checkpoint lost its last safe state after exhaustion'

  pass 'exhausted retries return RECOVERY_REQUIRED and retain the checkpoint'
}

test_recovery_required_does_not_advance_to_next_issue() {
  local repo="${TEST_ROOT}/no-next-repo"
  local fake="${TEST_ROOT}/claude-minimax-no-next"
  local output="${TEST_ROOT}/no-next-output.log"
  local counter="${TEST_ROOT}/no-next-counter"
  local status

  new_repo "$repo"
  write_transient_fixture "$fake" "$counter" \
    "Connection closed by remote host" \
    "QUEUE_EMPTY"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="1,1,1" \
  ISSUE_RUNNER_RETRY_LIMIT=1 \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 4 ]] || \
    fail "Exhausted retries must exit 4, got ${status}"
  # The runner must NOT advance to a second iteration. Only attempt 1 of
  # the recovery loop should run because the retry limit was 1.
  [[ "$(<"$counter")" -le 2 ]] || \
    fail 'Runner advanced past the failed issue after RECOVERY_REQUIRED'
  if grep -Fq 'No pending, available, non-epic issues remain.' "$output"; then
    fail 'Runner reported QUEUE_EMPTY while still recovering'
  fi

  pass 'RECOVERY_REQUIRED never advances to the next issue'
}

test_idempotent_retry_recognizes_already_merged_pr() {
  local repo="${TEST_ROOT}/merged-repo"
  local fake="${TEST_ROOT}/claude-minimax-merged"
  local output="${TEST_ROOT}/merged-output.log"
  local counter="${TEST_ROOT}/merged-counter"

  new_repo "$repo"

  # Fixture simulates a worker that successfully merged its PR for
  # issue 42 and advanced the checkpoint to state=pr_merged via the
  # renderer, then died on a transient transport failure before it
  # could emit the ISSUE_COMPLETED status marker. The orchestrator must
  # detect the pr_merged checkpoint and treat the retry as a no-op.
  cat > "$fake" <<PROLOG
#!/usr/bin/env bash
counter_file="$counter"
attempt=0
[[ -f "\$counter_file" ]] && attempt=\$(<"\$counter_file")
attempt=\$((attempt + 1))
printf '%s\n' "\$attempt" > "\$counter_file"

iteration=1
name_next=0
for arg in "\$@"; do
  if [[ "\$name_next" == "1" ]]; then
    if [[ "\$arg" =~ -([0-9]+)\$ ]]; then
      iteration="\${BASH_REMATCH[1]}"
    fi
    break
  fi
  if [[ "\$arg" == "--name" ]]; then
    name_next=1
  fi
done

if [[ "\$iteration" -gt 1 ]]; then
  # Track which iteration the runner reached. The orchestrator must NOT
  # launch a retry within iteration 1, so the iteration must advance
  # exactly once — and only after the orchestrator injects
  # ISSUE_COMPLETED for the already-merged issue.
  printf '%s\n' "\$iteration" >> "\${counter_file}.iter"
  printf '%s\n' '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY\\n"}'
  exit 0
fi

printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"gh issue view 42"}}]}}'
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"gh pr create --title issue 42 --body x"}}]}}'
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t3","name":"Bash","input":{"command":"gh pr merge --auto"}}]}}'
printf '%s\n' '{"type":"result","subtype":"error","is_error":true,"result":"Connection closed by remote host"}'
exit 1
PROLOG
  chmod +x "$fake"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="1,1,1" \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  # The orchestrator must observe the pr_merged checkpoint, inject a
  # synthetic ISSUE_COMPLETED, and advance to iteration 2 without
  # launching a retry. The fixture is invoked exactly twice: once for
  # the failing first attempt, once for the QUEUE_EMPTY iteration.
  # A retry would show up as a counter > 2 or as a second iteration
  # line being recorded before the orchestrator injected the
  # completion.
  local iter_count final_counter
  iter_count="$(wc -l < "${counter}.iter" 2>/dev/null | tr -d ' ')"
  final_counter="$(<"$counter")"
  [[ "$iter_count" == "1" ]] || \
    fail "Runner launched unexpected retry attempts (got ${iter_count} post-recovery iterations)"
  [[ "$final_counter" == "2" ]] || \
    fail "Runner expected exactly two fixture invocations (initial + drain), got ${final_counter}"
  # No retry can happen after the recovery detected the already-completed
  # state. Verify by inspecting the orchestrator's announcement and the
  # absence of a second transient retry log line.
  if grep -c 'Recovering from transient transport failure' "$output" | grep -qv '^1$'; then
    fail 'Runner announced more than one transient retry attempt'
  fi
  [[ "$status" -eq 0 ]] || \
    fail "Already-merged retry must exit cleanly, got ${status}"
  grep -Fq 'Recovery detected an already-completed issue' "$output" || \
    fail 'Runner did not announce the idempotent recovery'

  pass 'retry recognizes an already-completed checkpoint and does not duplicate work'
}

test_retry_delays_are_configurable() {
  local repo="${TEST_ROOT}/custom-delays-repo"
  local fake="${TEST_ROOT}/claude-minimax-custom-delays"
  local output="${TEST_ROOT}/custom-delays-output.log"
  local counter="${TEST_ROOT}/custom-delays-counter"

  new_repo "$repo"
  write_transient_fixture "$fake" "$counter" \
    "Connection closed by remote host" \
    "ISSUE_COMPLETED"

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="2,3,5" \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Custom delays fixture did not finish'

  # The runner must publish the configured delays in its progress output.
  grep -Fq 'recovery_delay=2' "$output" || \
    fail 'Runner did not publish the first configured delay'
  grep -Fq 'recovery_delay=3' "$output" || \
    fail 'Runner did not publish the second configured delay'

  pass 'retry delays are configurable via ISSUE_RUNNER_RETRY_DELAYS'
}

test_lock_status_publishes_recovery_fields() {
  local repo="${TEST_ROOT}/lock-recovery-repo"
  local fake="${TEST_ROOT}/claude-minimax-lock-recovery"
  local output="${TEST_ROOT}/lock-recovery-output.log"
  local counter="${TEST_ROOT}/lock-recovery-counter"
  local started="${TEST_ROOT}/lock-recovery-started"
  local release="${TEST_ROOT}/lock-recovery-release"
  local first_pid attempt
  local lock_status_file

  new_repo "$repo"
  lock_status_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.lock/status"

  cat > "$fake" <<PROLOG
#!/usr/bin/env bash
counter_file="$counter"
attempt=0
[[ -f "\$counter_file" ]] && attempt=\$(<"\$counter_file")
attempt=\$((attempt + 1))
printf '%s\n' "\$attempt" > "\$counter_file"

iteration=1
name_next=0
for arg in "\$@"; do
  if [[ "\$name_next" == "1" ]]; then
    if [[ "\$arg" =~ -([0-9]+)\$ ]]; then
      iteration="\${BASH_REMATCH[1]}"
    fi
    break
  fi
  if [[ "\$arg" == "--name" ]]; then
    name_next=1
  fi
done

if [[ "\$iteration" -gt 1 ]]; then
  printf '%s\n' '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY\\n"}'
  exit 0
fi

if [[ "\$attempt" -eq 1 ]]; then
  touch "$started"
  printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"gh issue view 17"}}]}}'
  printf '%s\n' '{"type":"result","subtype":"error","is_error":true,"result":"Connection closed by remote host"}'
  exit 1
fi

printf '%s\n' '{"type":"result","subtype":"success","result":"CLAUDE_MINIMAX_ISSUE_RUNNER_STATUS=QUEUE_EMPTY\\n"}'
exit 0
PROLOG
  chmod +x "$fake"

  # Override the first delay so we can reliably observe the recovering
  # state in the lock status file before the sleep ends.
  RUNNER_TEST_STARTED="$started" \
  RUNNER_TEST_RELEASE="$release" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="10" \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1 &
  first_pid=$!

  # Wait for the runner to publish state=recovering in the lock status.
  # This happens AFTER the renderer has captured the identified issue
  # from `gh issue view 17` and AFTER the orchestrator has classified
  # the failure as transient_transport.
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40; do
    if grep -Eq '^state=recovering$' "$lock_status_file" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done

  [[ -r "$lock_status_file" ]] || \
    fail 'Lock status file was not produced during recovery'
  for field in state recovery_attempt recovery_delay recovery_category; do
    grep -Eq "^${field}=" "$lock_status_file" || \
      fail "Lock status missing recovery field: ${field}"
  done
  grep -Eq '^state=recovering$' "$lock_status_file" || \
    fail 'Lock status did not publish state=recovering'
  grep -Eq '^issue=17$' "$lock_status_file" || \
    fail 'Lock status did not publish the identified issue'
  grep -Eq '^recovery_attempt=1$' "$lock_status_file" || \
    fail 'Lock status did not publish recovery_attempt=1'
  grep -Eq '^recovery_delay=10$' "$lock_status_file" || \
    fail 'Lock status did not publish the configured recovery delay'
  grep -Eq '^recovery_category=transient_transport$' "$lock_status_file" || \
    fail 'Lock status did not publish the transient failure category'

  touch "$release"
  wait "$first_pid" || fail 'Recovery runner failed after release'

  pass 'lock status exposes recovering state with attempt, delay, and category'
}

test_recovery_retains_output_artifact_on_recovery_required() {
  local repo="${TEST_ROOT}/retain-artifact-repo"
  local fake="${TEST_ROOT}/claude-minimax-retain-artifact"
  local output="${TEST_ROOT}/retain-artifact-output.log"
  local counter="${TEST_ROOT}/retain-artifact-counter"
  local status

  new_repo "$repo"
  # Fixture never recovers, so the orchestrator must exhaust retries and
  # emit RECOVERY_REQUIRED while keeping the output artifact for diagnosis.
  cat > "$fake" <<PROLOG
#!/usr/bin/env bash
counter_file="$counter"
attempt=0
[[ -f "\$counter_file" ]] && attempt=\$(<"\$counter_file")
attempt=\$((attempt + 1))
printf '%s\n' "\$attempt" > "\$counter_file"
printf '%s\n' '{"type":"result","subtype":"error","is_error":true,"result":"Connection closed by remote host"}'
exit 1
PROLOG
  chmod +x "$fake"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="1" \
  ISSUE_RUNNER_RETRY_LIMIT=1 \
  CLAUDE_MINIMAX_COMMAND="$fake" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 4 ]] || \
    fail "RECOVERY_REQUIRED must exit 4, got ${status}"
  # The diagnostic must point to a retained artifact on disk.
  grep -Fq 'output retained at' "$output" || \
    fail 'RECOVERY_REQUIRED diagnostic did not reference the retained artifact'

  pass 'RECOVERY_REQUIRED retains the output artifact for diagnosis'
}

test_fresh_shell_per_issue
test_unknown_status_stops_loop
test_dirty_worktree_is_rejected
test_progress_is_reported_while_worker_runs
test_repository_lock_rejects_second_runner
test_stale_repository_lock_is_recovered
test_shell_function_loader_skips_interactive_only_startup
test_streaming_worker_renders_semantic_progress
test_streaming_silent_worker_heartbeats
test_streaming_heartbeat_suppressed_while_events_flow
test_streaming_worker_redacts_secrets_and_redacts_full_prompts
test_streaming_worker_extracts_each_status_marker
test_streaming_worker_preserves_non_zero_exit_code
test_streaming_blocked_retains_artifact_path
test_streaming_invokes_worker_with_stream_json_output_flag
test_streaming_worker_identifies_issue_before_first_mutation
test_checkpoint_records_required_fields_atomically
test_checkpoint_does_not_persist_secrets_or_full_commands
test_checkpoint_cleared_on_issue_completed
test_checkpoint_cleared_on_queue_empty
test_checkpoint_retained_on_non_zero_exit
test_checkpoint_retained_on_blocked_outcome
test_lock_status_exposes_checkpoint_identity
test_transient_disconnect_retries_with_bounded_backoff
test_non_transient_disconnect_does_not_retry
test_blocked_outcome_does_not_retry
test_recovery_reconciles_local_state_before_continuing
test_session_resume_when_checkpoint_has_safe_session_id
test_session_resume_skipped_when_no_captured_session_id
test_recovery_required_after_exhausted_retries
test_recovery_required_does_not_advance_to_next_issue
test_idempotent_retry_recognizes_already_merged_pr
test_retry_delays_are_configurable
test_lock_status_publishes_recovery_fields
test_recovery_retains_output_artifact_on_recovery_required

printf '%s Claude-MiniMax runner tests passed.\n' "$TESTS_RUN"
