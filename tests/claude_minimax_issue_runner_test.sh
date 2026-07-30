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
  # checkpoint file directly.
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

printf '%s Claude-MiniMax runner tests passed.\n' "$TESTS_RUN"
