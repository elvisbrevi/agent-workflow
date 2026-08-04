#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="${ROOT_DIR}/agent/claude-minimax-issue-runner/run.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/claude-minimax-runner.XXXXXX")"
TEST_BIN="${TEST_ROOT}/bin"
mkdir -p "$TEST_BIN"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'case "$1 $2" in' \
  '  "auth status") printf "%s\\n" "Logged in to github.com" ;;' \
  '  "api repos/"*) printf "%s\\n" "0" ;;' \
  '  "issue view") printf "%s\\n" '\''{"state":"OPEN","labels":[{"name":"ready-for-agent"}],"assignees":[]} '\'' ;;' \
  '  "pr list") printf "%s\\n" "[]" ;;' \
  '  *) printf "unexpected gh call: %s\\n" "$*" >&2; exit 1 ;;' \
  'esac' > "${TEST_BIN}/gh"
chmod +x "${TEST_BIN}/gh"
export PATH="${TEST_BIN}:$PATH"
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

# Writes a minimal issue-killer configuration that selects the supplied
# command as the default Claude profile. The command is invoked either
# as a directly executable program or as a shell function loaded from
# the supplied init file. Tests that need a non-default profile should
# write their own TOML and point ISSUE_KILLER_CONFIG_PATH at it.
write_default_config() {
  local target="$1"
  local command_name="$2"
  local shell_name="${3:-}"
  local init_file="${4:-}"
  local permission_mode="${5:-bypassPermissions}"

  {
    printf 'default_profile = "default"\n'
    printf '\n'
    printf '[profiles.default]\n'
    printf 'label = "Test profile"\n'
    printf 'cli = "claude"\n'
    printf 'command = "%s"\n' "$command_name"
    printf 'model = "test-model"\n'
    if [[ -n "$shell_name" ]]; then
      printf 'shell = "%s"\n' "$shell_name"
    fi
    if [[ -n "$init_file" ]]; then
      printf 'init_file = "%s"\n' "$init_file"
    fi
    printf '\n'
    printf '[profiles.default.options]\n'
    printf 'permission_mode = "%s"\n' "$permission_mode"
  } > "$target"
}

# Convenience helper for tests that previously used
# CLAUDE_MINIMAX_COMMAND. Generates a config that names the supplied
# executable and echoes the path to stdout so the caller can bind
# `ISSUE_KILLER_CONFIG_PATH` to that exact path on the same line as
# the runner invocation. A separate env-binding line is required
# because chained `&&` commands in bash do not propagate env-var
# prefixes from the previous line.
use_config_for_command() {
  local command_name="$1"
  local shell_name="${2:-}"
  local init_file="${3:-}"
  local config_path="${TEST_ROOT}/config.toml"

  write_default_config "$config_path" "$command_name" "$shell_name" "$init_file"
  unset CLAUDE_MINIMAX_COMMAND CLAUDE_MINIMAX_SHELL CLAUDE_MINIMAX_RC_FILE CLAUDE_MINIMAX_PERMISSION_MODE
  printf '%s\n' "$config_path"
}

new_repo() {
  local path="$1"
  mkdir -p "$path"
  git -C "$path" init -b main --quiet
  git -C "$path" config user.name "Runner Test"
  git -C "$path" config user.email "runner@example.test"
  printf '%s\n' '# fixture' > "${path}/README.md"
  mkdir -p "${path}/docs/agents"
  printf '%s\n' \
    '# Issue Tracker: GitHub' \
    '' \
    'Use the `gh` CLI for all operations.' > "${path}/docs/agents/issue-tracker.md"
  git -C "$path" add README.md docs/agents/issue-tracker.md
  git -C "$path" commit --quiet -m "test: seed"
  git -C "$path" remote add origin https://github.com/example/recovery-fixture.git
}

test_fresh_shell_per_issue() {
  local home="${TEST_ROOT}/function-home"
  local repo="${TEST_ROOT}/function-repo"
  local output="${TEST_ROOT}/function-output.log"
  local count_file="${TEST_ROOT}/function-count"
  local source_file="${TEST_ROOT}/function-shell-starts"
  local args_file="${TEST_ROOT}/function-args"
  local config_path="${TEST_ROOT}/function-config.toml"

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
    '    printf "%s\\n" "ISSUE_KILLER_STATUS=ISSUE_COMPLETED"' \
    '  else' \
    '    printf "%s\\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' \
    '  fi' \
    '}' > "${home}/.bashrc"

  write_default_config "$config_path" "claude-minimax" "bash" "${home}/.bashrc"

  HOME="$home" \
  RUNNER_TEST_COUNT_FILE="$count_file" \
  RUNNER_TEST_SOURCE_FILE="$source_file" \
  RUNNER_TEST_ARGS_FILE="$args_file" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
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
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 4 ]] || fail 'Dirty worktree without recovery identity must require recovery'
  [[ ! -e "$marker" ]] || fail 'Worker launched despite dirty worktree'
  grep -Fq 'RECOVERY_REQUIRED' "$output" || fail 'Missing recovery-required diagnostic'
  grep -Fq 'legacy adoption requires ISSUE_RUNNER_ADOPT_ISSUE' "$output" || \
    fail 'Missing explicit legacy-adoption diagnostic'

  pass 'dirty worktree without checkpoint requires explicit recovery before launching claude-minimax'
}

test_progress_is_reported_while_worker_runs() {
  local repo="${TEST_ROOT}/progress-repo"
  local fake="${TEST_ROOT}/claude-minimax-progress"
  local output="${TEST_ROOT}/progress-output.log"

  new_repo "$repo"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'sleep 2' \
    'printf "%s\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' > "$fake"
  chmod +x "$fake"

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_PROGRESS_INTERVAL=1 \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
    'printf "%s\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' > "$fake"
  chmod +x "$fake"

  RUNNER_TEST_STARTED="$started" \
  RUNNER_TEST_RELEASE="$release" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_PROGRESS_INTERVAL=1 \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
    'printf "%s\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' > "$fake"
  chmod +x "$fake"

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
  local config_path="${TEST_ROOT}/startup-config.toml"

  mkdir -p "$home"
  new_repo "$repo"
  printf '%s\n' \
    'enable -f /definitely/missing/libflyline.dylib flyline' \
    'claude-minimax() {' \
    '  printf "%s\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' \
    '}' > "${home}/.bashrc"

  write_default_config "$config_path" "claude-minimax" "bash" "${home}/.bashrc"

  HOME="$home" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Runner did not invoke the shell-defined worker'

  if grep -Eq 'no job control|cannot open shared object|libflyline' "$output"; then
    fail 'Runner executed interactive-only shell startup'
  fi

  pass 'shell-defined worker loads without interactive Flyline startup'
}

test_tracker_preflight_rejects_missing_cli() {
  local repo="${TEST_ROOT}/tracker-missing-cli-repo"
  local fake="${TEST_ROOT}/tracker-missing-cli-worker"
  local output="${TEST_ROOT}/tracker-missing-cli-output.log"
  local bin_dir="${TEST_ROOT}/tracker-missing-cli-bin"
  local status

  new_repo "$repo"
  printf '%s\n' '#!/usr/bin/env bash' "touch '${TEST_ROOT}/tracker-missing-cli-worker-ran'" > "$fake"
  chmod +x "$fake"
  mkdir -p "$bin_dir"
  ln -s "$(command -v jq)" "${bin_dir}/jq"

  set +e
  PATH="${bin_dir}:/usr/bin:/bin:/usr/sbin:/sbin" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 1 ]] || fail "Missing tracker CLI must fail before launch, got ${status}"
  grep -Fq 'gh is required' "$output" || fail 'Missing GitHub CLI diagnostic'
  [[ ! -e "${TEST_ROOT}/tracker-missing-cli-worker-ran" ]] || \
    fail 'Worker launched when the tracker CLI was missing'

  pass 'tracker preflight rejects a missing GitHub CLI before worker launch'
}

test_tracker_preflight_rejects_ambiguous_remote() {
  local repo="${TEST_ROOT}/tracker-ambiguous-remote-repo"
  local fake="${TEST_ROOT}/tracker-ambiguous-remote-worker"
  local output="${TEST_ROOT}/tracker-ambiguous-remote-output.log"
  local marker="${TEST_ROOT}/tracker-ambiguous-remote-worker-ran"
  local status

  new_repo "$repo"
  git -C "$repo" remote add upstream https://github.com/other/repository.git
  printf '%s\n' '#!/usr/bin/env bash' "touch '$marker'" > "$fake"
  chmod +x "$fake"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 1 ]] || fail "Ambiguous tracker remotes must fail, got ${status}"
  grep -Fq 'ambiguous GitHub remotes' "$output" || \
    fail 'Missing ambiguous-remote diagnostic'
  [[ ! -e "$marker" ]] || fail 'Worker launched for an ambiguous tracker remote'

  pass 'tracker preflight rejects conflicting GitHub remotes before worker launch'
}

test_tracker_preflight_rejects_conflicting_documentation() {
  local repo="${TEST_ROOT}/tracker-conflicting-docs-repo"
  local fake="${TEST_ROOT}/tracker-conflicting-docs-worker"
  local output="${TEST_ROOT}/tracker-conflicting-docs-output.log"
  local marker="${TEST_ROOT}/tracker-conflicting-docs-worker-ran"
  local status

  new_repo "$repo"
  printf '%s\n' '# Issue Tracker: Azure DevOps' > "${repo}/docs/agents/issue-tracker.md"
  git -C "$repo" add docs/agents/issue-tracker.md
  git -C "$repo" commit --quiet -m 'test: conflicting tracker docs'
  printf '%s\n' '#!/usr/bin/env bash' "touch '$marker'" > "$fake"
  chmod +x "$fake"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 1 ]] || fail "Conflicting tracker docs must fail, got ${status}"
  grep -Fq 'tracker documentation' "$output" || \
    fail 'Missing tracker documentation diagnostic'
  [[ ! -e "$marker" ]] || fail 'Worker launched with conflicting tracker documentation'

  pass 'tracker preflight validates repository-owned tracker documentation'
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
  printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}'
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
    '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
    '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_PROGRESS_INTERVAL=1 \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
    '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_PROGRESS_INTERVAL=1 \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
    '{"type":"result","subtype":"success","result":"echoed: Authorization Bearer gh_super_secret_token_xyz\nISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
      "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ISSUE_KILLER_STATUS=${marker}\\n\"}"

    set +e
    ISSUE_RUNNER_ASSUME_YES=true \
    ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "${TEST_ROOT}/claude-minimax-${marker}")" \
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
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
    '{"type":"result","subtype":"success","result":"need human input\nISSUE_KILLER_STATUS=BLOCKED\n"}'

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
  local config_path="${TEST_ROOT}/stream-args-config.toml"
  local stream_args_present=true

  mkdir -p "$home"
  new_repo "$repo"
  printf '%s\n' \
    'claude-minimax() {' \
    '  local arg' \
    '  for arg in "$@"; do printf "%s\n" "$arg" >>"$RUNNER_TEST_ARGS_FILE"; done' \
    '  printf "%s\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' \
    '}' > "${home}/.bashrc"

  write_default_config "$config_path" "claude-minimax" "bash" "${home}/.bashrc"

  if ! HOME="$home" \
       RUNNER_TEST_ARGS_FILE="$args_file" \
       ISSUE_RUNNER_ASSUME_YES=true \
       ISSUE_KILLER_CONFIG_PATH="$config_path" \
         "$RUNNER" "$repo" >"$output" 2>&1; then
    stream_args_present=false
  fi

  $stream_args_present || fail 'Stream-args fixture did not finish'
  grep -Fxq -- '--output-format' "$args_file" || \
    fail 'Runner did not pass --output-format when invoking claude-minimax'
  grep -Fxq -- 'stream-json' "$args_file" || \
    fail 'Runner did not request stream-json output format'
  grep -Fxq -- '--verbose' "$args_file" || \
    fail 'Runner did not pass --verbose alongside stream-json (CLI requirement)'

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
    '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
    '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=FAILED\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
    '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=FAILED\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
    '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
    '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}'

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
    '{"type":"result","subtype":"success","result":"need human input\nISSUE_KILLER_STATUS=BLOCKED\n"}'

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
    '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}'

  RUNNER_TEST_STARTED="$started" \
  RUNNER_TEST_RELEASE="$release" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_PROGRESS_INTERVAL=1 \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
  printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\\n"}'
  exit 0
fi

if [[ "\$attempt" -le 2 ]]; then
  printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"attempt '"'"'\$attempt'"'"' starting"}]}}'
  printf '%s\n' '{"type":"result","subtype":"error","is_error":true,"result":"${transient_text}"}'
  exit 1
fi

printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=${final_marker}\\n"}'
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
  printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\\n"}'
  exit 0
fi

if [[ "\$attempt" -le 1 ]]; then
  printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"attempt '"'"'\$attempt'"'"' starting"}]}}'
  printf '%s\n' '{"type":"result","subtype":"error","is_error":true,"result":"${unknown_text}"}'
  exit 1
fi

printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=${final_marker}\\n"}'
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
  printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\\n"}'
  exit 0
fi

printf '%s\n' '{"type":"result","subtype":"success","result":"needs human input\\nISSUE_KILLER_STATUS=BLOCKED\\n"}'
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
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
  printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\\n"}'
  exit 0
fi

if [[ "\$attempt" -eq 1 ]]; then
  printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-resume-xyz"}'
  printf '%s\n' '{"type":"result","subtype":"error","is_error":true,"result":"Connection closed by remote host"}'
  exit 1
fi

for arg in "\$@"; do printf '%s\n' "\$arg" >>"$args_file"; done
printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\\n"}'
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
    '    printf "%s\\n" "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ISSUE_KILLER_STATUS=QUEUE_EMPTY\\n\"}"' \
    '    return 0' \
    '  fi' \
    '  if [[ "$attempt" -eq 1 ]]; then' \
    '    printf "%s\\n" "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sess-shell-resume-xyz\"}"' \
    '    printf "%s\\n" "{\"type\":\"result\",\"subtype\":\"error\",\"is_error\":true,\"result\":\"Connection closed by remote host\"}"' \
    '    return 1' \
    '  fi' \
    '  printf "%s\\n" "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\\n\"}"' \
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

  write_default_config "${TEST_ROOT}/resume-config.toml" "claude-minimax" "bash" "${home}/.bashrc"
  HOME="$home" \
  RUNNER_TEST_ARGS_FILE="$args_file" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="1,1,1" \
  ISSUE_KILLER_CONFIG_PATH="${TEST_ROOT}/resume-config.toml" \
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
    '    printf "%s\\n" "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ISSUE_KILLER_STATUS=QUEUE_EMPTY\\n\"}"' \
    '    return 0' \
    '  fi' \
    '  if [[ "$attempt" -eq 1 ]]; then' \
    '    printf "%s\\n" "{\"type\":\"result\",\"subtype\":\"error\",\"is_error\":true,\"result\":\"Connection closed by remote host\"}"' \
    '    return 1' \
    '  fi' \
    '  printf "%s\\n" "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\\n\"}"' \
    '}' > "${home}/.bashrc"

  write_default_config "${TEST_ROOT}/no-session-config.toml" "claude-minimax" "bash" "${home}/.bashrc"
  HOME="$home" \
  RUNNER_TEST_ARGS_FILE="$args_file" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="1,1,1" \
  ISSUE_KILLER_CONFIG_PATH="${TEST_ROOT}/no-session-config.toml" \
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
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
  printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\\n"}'
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
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
  printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\\n"}'
  exit 0
fi

if [[ "\$attempt" -eq 1 ]]; then
  touch "$started"
  printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"gh issue view 17"}}]}}'
  printf '%s\n' '{"type":"result","subtype":"error","is_error":true,"result":"Connection closed by remote host"}'
  exit 1
fi

printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\\n"}'
exit 0
PROLOG
  chmod +x "$fake"

  # Override the first delay so we can reliably observe the recovering
  # state in the lock status file before the sleep ends.
  RUNNER_TEST_STARTED="$started" \
  RUNNER_TEST_RELEASE="$release" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="10" \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
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

# --- Restart recovery tests (issue #4) --------------------------------------

write_github_state_fixture() {
  local target="$1"
  local calls_file="$2"
  cat > "$target" <<PROLOG
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$calls_file"
case "\$1 \$2" in
  "auth status")
    printf '%s\n' 'Logged in to github.com'
    ;;
  "api repos/example/recovery-fixture/issues/"*)
    printf '%s\n' '0'
    ;;
  "issue view")
    printf '%s\n' '{"state":"OPEN","labels":[{"name":"ready-for-agent"}],"assignees":[]}'
    ;;
  "pr list")
    printf '%s\n' '[]'
    ;;
  *)
    printf 'unexpected gh call: %s\n' "\$*" >&2
    exit 1
    ;;
esac
PROLOG
  chmod +x "$target"
}

test_restart_recovery_requires_confirmation_before_worker() {
  local repo="${TEST_ROOT}/restart-confirm-repo"
  local fake="${TEST_ROOT}/claude-minimax-restart-confirm"
  local fake_gh="${TEST_ROOT}/gh-restart-confirm"
  local bin_dir="${TEST_ROOT}/restart-confirm-bin"
  local output="${TEST_ROOT}/restart-confirm-output.log"
  local marker="${TEST_ROOT}/restart-confirm-worker-ran"
  local calls="${TEST_ROOT}/restart-confirm-gh-calls"
  local checkpoint_file status

  new_repo "$repo"
  git -C "$repo" switch -c issue-77 --quiet
  printf '%s\n' 'partial work' >> "${repo}/README.md"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"
  cat > "$checkpoint_file" <<EOF
pid=$$
iteration=1
issue=77
branch=issue-77
base_branch=main
base_sha=$(git -C "$repo" rev-parse main)
session_id=sess-restart-77
state=mutating
updated_at=test
EOF

  mkdir -p "$bin_dir"
  write_github_state_fixture "$fake_gh" "$calls"
  ln -s "$fake_gh" "${bin_dir}/gh"
  printf '%s\n' '#!/usr/bin/env bash' "touch \"$marker\"" > "$fake"
  chmod +x "$fake"

  set +e
  PATH="${bin_dir}:$PATH" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 4 ]] || \
    fail "Restart recovery without TTY must exit 4, got ${status}"
  [[ ! -e "$marker" ]] || \
    fail 'Restart recovery launched a worker without explicit confirmation'
  grep -Fq 'RECOVERY_REQUIRED' "$output" || \
    fail 'Missing RECOVERY_REQUIRED diagnostic for unconfirmed restart recovery'
  grep -Fq 'issue 77' "$output" || \
    fail 'Restart recovery diagnostic did not display the checkpointed issue'
  grep -Fq 'state mutating' "$output" || \
    fail 'Restart recovery diagnostic did not display the last checkpoint state'
  grep -Fq 'TTY confirmation' "$output" || \
    fail 'Restart recovery did not explain the missing confirmation'
  [[ -r "$checkpoint_file" ]] || \
    fail 'Unconfirmed restart recovery removed the checkpoint'

  pass 'restart recovery displays checkpoint identity and requires confirmation before worker launch'
}

test_legacy_adoption_requires_explicit_issue_number() {
  local repo="${TEST_ROOT}/legacy-adopt-repo"
  local fake="${TEST_ROOT}/claude-minimax-legacy-adopt"
  local output="${TEST_ROOT}/legacy-adopt-output.log"
  local marker="${TEST_ROOT}/legacy-adopt-worker-ran"
  local checkpoint_file status

  new_repo "$repo"
  git -C "$repo" switch -c issue-guessable --quiet
  printf '%s\n' 'legacy partial work' >> "${repo}/README.md"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"
  printf '%s\n' '#!/usr/bin/env bash' "touch \"$marker\"" > "$fake"
  chmod +x "$fake"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 4 ]] || \
    fail "Dirty legacy work without explicit issue must exit 4, got ${status}"
  [[ ! -e "$marker" ]] || \
    fail 'Legacy adoption launched a worker without explicit issue number'
  [[ ! -e "$checkpoint_file" ]] || \
    fail 'Legacy adoption created a checkpoint without explicit issue number'
  grep -Fq 'legacy adoption requires ISSUE_RUNNER_ADOPT_ISSUE' "$output" || \
    fail 'Missing explicit-issue diagnostic for legacy adoption'
  grep -Fq 'README.md' "$output" || \
    fail 'Legacy adoption diagnostic did not display dirty files'

  pass 'legacy adoption requires an explicit issue number and never infers it'
}

run_with_recovery_confirmation() {
  local output="$1"
  shift
  local expect_script="${TEST_ROOT}/confirm-recovery-${TESTS_RUN}.expect"

  command -v expect >/dev/null 2>&1 || \
    fail 'expect is required for confirmed TTY recovery fixtures'

  cat > "$expect_script" <<'PROLOG'
set timeout 20
log_user 1
eval spawn $env(RUNNER_TEST_COMMAND)
expect {
  -re {Profile \[1\]} {
    send "\r"
    exp_continue
  }
  -re {Continue\? \[y/N\]} {
    send "y\r"
    exp_continue
  }
  eof
}
set wait_result [wait]
exit [lindex $wait_result 3]
PROLOG

  RUNNER_TEST_COMMAND="$*" expect "$expect_script" >"$output" 2>&1
}

test_confirmed_restart_recovery_resumes_session_and_clears_checkpoint() {
  local repo="${TEST_ROOT}/restart-resume-repo"
  local fake="${TEST_ROOT}/claude-minimax-restart-resume"
  local fake_gh="${TEST_ROOT}/gh-restart-resume"
  local bin_dir="${TEST_ROOT}/restart-resume-bin"
  local output="${TEST_ROOT}/restart-resume-output.log"
  local args="${TEST_ROOT}/restart-resume-args"
  local prompt="${TEST_ROOT}/restart-resume-prompt"
  local count_file="${TEST_ROOT}/restart-resume-count"
  local calls="${TEST_ROOT}/restart-resume-gh-calls"
  local checkpoint_file

  new_repo "$repo"
  git -C "$repo" switch -c issue-77 --quiet
  printf '%s\n' 'partial restart work' >> "${repo}/README.md"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"
  cat > "$checkpoint_file" <<EOF
pid=$$
iteration=1
issue=77
branch=issue-77
base_branch=main
base_sha=$(git -C "$repo" rev-parse main)
session_id=sess-restart-77
state=mutating
updated_at=test
EOF

  mkdir -p "$bin_dir"
  write_github_state_fixture "$fake_gh" "$calls"
  ln -s "$fake_gh" "${bin_dir}/gh"
  cat > "$fake" <<'PROLOG'
#!/usr/bin/env bash
count=0
[[ -f "$RUNNER_TEST_COUNT_FILE" ]] && count="$(<"$RUNNER_TEST_COUNT_FILE")"
count=$((count + 1))
printf '%s\n' "$count" > "$RUNNER_TEST_COUNT_FILE"
for arg in "$@"; do printf '%s\n' "$arg" >> "$RUNNER_TEST_ARGS_FILE"; done
last_arg="${@: -1}"
if [[ "$count" -eq 1 ]]; then
  printf '%s\n' "$last_arg" > "$RUNNER_TEST_PROMPT_FILE"
  git add README.md
  git commit --quiet -m 'test: complete restart recovery'
  printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}'
else
  printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}'
fi
PROLOG
  chmod +x "$fake"

  run_with_recovery_confirmation "$output" \
    env PATH="${bin_dir}:$PATH" \
    ISSUE_RUNNER_ASSUME_YES=true \
    ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    RUNNER_TEST_COUNT_FILE="$count_file" \
    RUNNER_TEST_ARGS_FILE="$args" \
    RUNNER_TEST_PROMPT_FILE="$prompt" \
    "$RUNNER" "$repo"

  [[ "$(<"$count_file")" == "2" ]] || \
    fail 'Confirmed restart recovery did not return to the normal queue loop'
  grep -Fxq -- '--resume' "$args" || \
    fail 'Confirmed restart recovery did not resume the captured session'
  grep -Fxq -- 'sess-restart-77' "$args" || \
    fail 'Confirmed restart recovery used the wrong session id'
  grep -Fq 'Continue exactly issue #77' "$prompt" || \
    fail 'Confirmed restart recovery prompt was not constrained to the checkpointed issue'
  grep -Fq 'do not select another issue' "$prompt" || \
    fail 'Confirmed restart recovery prompt allowed queue selection'
  [[ ! -e "$checkpoint_file" ]] || \
    fail 'Confirmed restart recovery did not clear the checkpoint after completion'
  grep -Fq 'Restart recovery completed; returning to normal queue loop.' "$output" || \
    fail 'Confirmed restart recovery did not report returning to the queue loop'

  pass 'confirmed restart recovery resumes the captured session and clears the checkpoint'
}

test_confirmed_legacy_adoption_creates_checkpoint_and_launches_fresh_worker() {
  local repo="${TEST_ROOT}/legacy-confirm-repo"
  local fake="${TEST_ROOT}/claude-minimax-legacy-confirm"
  local fake_gh="${TEST_ROOT}/gh-legacy-confirm"
  local bin_dir="${TEST_ROOT}/legacy-confirm-bin"
  local output="${TEST_ROOT}/legacy-confirm-output.log"
  local args="${TEST_ROOT}/legacy-confirm-args"
  local prompt="${TEST_ROOT}/legacy-confirm-prompt"
  local count_file="${TEST_ROOT}/legacy-confirm-count"
  local calls="${TEST_ROOT}/legacy-confirm-gh-calls"
  local checkpoint_seen="${TEST_ROOT}/legacy-confirm-checkpoint-seen"
  local checkpoint_file

  new_repo "$repo"
  git -C "$repo" switch -c adopt-legacy --quiet
  printf '%s\n' 'legacy work to adopt' >> "${repo}/README.md"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"

  mkdir -p "$bin_dir"
  write_github_state_fixture "$fake_gh" "$calls"
  ln -s "$fake_gh" "${bin_dir}/gh"
  cat > "$fake" <<'PROLOG'
#!/usr/bin/env bash
count=0
[[ -f "$RUNNER_TEST_COUNT_FILE" ]] && count="$(<"$RUNNER_TEST_COUNT_FILE")"
count=$((count + 1))
printf '%s\n' "$count" > "$RUNNER_TEST_COUNT_FILE"
for arg in "$@"; do printf '%s\n' "$arg" >> "$RUNNER_TEST_ARGS_FILE"; done
last_arg="${@: -1}"
if [[ "$count" -eq 1 ]]; then
  printf '%s\n' "$last_arg" > "$RUNNER_TEST_PROMPT_FILE"
  grep -Fq 'issue=55' "$RUNNER_TEST_CHECKPOINT_FILE"
  grep -Fq 'session_id=unavailable' "$RUNNER_TEST_CHECKPOINT_FILE"
  grep -Fq 'state=legacy_adopted' "$RUNNER_TEST_CHECKPOINT_FILE"
  printf '%s\n' seen > "$RUNNER_TEST_CHECKPOINT_SEEN_FILE"
  git add README.md
  git commit --quiet -m 'test: complete legacy adoption'
  printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}'
else
  printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}'
fi
PROLOG
  chmod +x "$fake"

  run_with_recovery_confirmation "$output" \
    env PATH="${bin_dir}:$PATH" \
    ISSUE_RUNNER_ASSUME_YES=true \
    ISSUE_RUNNER_ADOPT_ISSUE=55 \
    ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    RUNNER_TEST_COUNT_FILE="$count_file" \
    RUNNER_TEST_ARGS_FILE="$args" \
    RUNNER_TEST_PROMPT_FILE="$prompt" \
    RUNNER_TEST_CHECKPOINT_FILE="$checkpoint_file" \
    RUNNER_TEST_CHECKPOINT_SEEN_FILE="$checkpoint_seen" \
    "$RUNNER" "$repo"

  [[ "$(<"$count_file")" == "2" ]] || \
    fail 'Confirmed legacy adoption did not return to the normal queue loop'
  [[ -r "$checkpoint_seen" ]] || \
    fail 'Confirmed legacy adoption did not create the synthetic checkpoint before worker launch'
  grep -Fxq -- '--no-session-persistence' "$args" || \
    fail 'Confirmed legacy adoption did not launch a fresh worker'
  ! grep -Fxq -- '--resume' "$args" || \
    fail 'Confirmed legacy adoption attempted to resume a session'
  grep -Fq 'Continue exactly issue #55' "$prompt" || \
    fail 'Confirmed legacy adoption prompt was not constrained to the supplied issue'
  grep -Fq 'synthetic checkpoint with no resumable session' "$prompt" || \
    fail 'Confirmed legacy adoption prompt did not describe the synthetic checkpoint'
  [[ ! -e "$checkpoint_file" ]] || \
    fail 'Confirmed legacy adoption did not clear the checkpoint after completion'
  grep -Fq 'README.md' "$output" || \
    fail 'Confirmed legacy adoption did not display dirty files before confirmation'

  pass 'confirmed legacy adoption creates a synthetic checkpoint and launches a fresh constrained worker'
}

test_restart_recovery_does_not_duplicate_closed_issue() {
  local repo="${TEST_ROOT}/restart-closed-repo"
  local fake="${TEST_ROOT}/claude-minimax-restart-closed"
  local fake_gh="${TEST_ROOT}/gh-restart-closed"
  local bin_dir="${TEST_ROOT}/restart-closed-bin"
  local output="${TEST_ROOT}/restart-closed-output.log"
  local marker="${TEST_ROOT}/restart-closed-worker-ran"
  local checkpoint_file status

  new_repo "$repo"
  git -C "$repo" switch -c issue-88 --quiet
  printf '%s\n' 'partial closed work' >> "${repo}/README.md"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"
  cat > "$checkpoint_file" <<EOF
pid=$$
iteration=1
issue=88
branch=issue-88
base_branch=main
base_sha=$(git -C "$repo" rev-parse main)
session_id=unavailable
state=pr_merged
updated_at=test
EOF

  mkdir -p "$bin_dir"
  cat > "$fake_gh" <<'PROLOG'
#!/usr/bin/env bash
case "$1 $2" in
  "auth status")
    printf '%s\n' 'Logged in to github.com'
    ;;
  "api repos/example/recovery-fixture/issues/"*)
    printf '%s\n' '0'
    ;;
  "issue view")
    printf '%s\n' '{"state":"CLOSED","labels":[{"name":"ready-for-agent"}],"assignees":[]}'
    ;;
  "pr list")
    printf '%s\n' '[{"state":"MERGED","number":12,"mergedAt":"2026-07-30T12:00:00Z"}]'
    ;;
  *)
    printf 'unexpected gh call: %s\n' "$*" >&2
    exit 1
    ;;
esac
PROLOG
  chmod +x "$fake_gh"
  ln -s "$fake_gh" "${bin_dir}/gh"
  printf '%s\n' '#!/usr/bin/env bash' "touch \"$marker\"" > "$fake"
  chmod +x "$fake"

  set +e
  PATH="${bin_dir}:$PATH" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 4 ]] || \
    fail "Closed issue restart recovery must exit 4, got ${status}"
  [[ ! -e "$marker" ]] || \
    fail 'Restart recovery launched a worker for an already closed issue'
  grep -Fq 'already closed' "$output" || \
    fail 'Missing already-closed issue diagnostic'
  [[ -r "$checkpoint_file" ]] || \
    fail 'Closed-issue recovery removed the checkpoint'

  pass 'restart recovery does not duplicate effects for an already closed issue'
}

test_tracker_preflight_rejects_missing_cli
test_tracker_preflight_rejects_ambiguous_remote
test_tracker_preflight_rejects_conflicting_documentation

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
test_restart_recovery_requires_confirmation_before_worker
test_legacy_adoption_requires_explicit_issue_number
test_confirmed_restart_recovery_resumes_session_and_clears_checkpoint
test_confirmed_legacy_adoption_creates_checkpoint_and_launches_fresh_worker
test_restart_recovery_does_not_duplicate_closed_issue

# --- Issue-killer profile selection tests (issue #13) -------------------

write_profile_config() {
  local target="$1"
  local default_name="$2"
  shift 2
  local profiles_block=""
  local options_block=""

  printf 'default_profile = "%s"\n' "$default_name" > "$target"
  for entry in "$@"; do
    local name label cli command model shell init_file permission_mode
    name="${entry%%=*}"
    local rest="${entry#*=}"
    label="${rest%%|*}"
    rest="${rest#*|}"
    cli="${rest%%|*}"
    rest="${rest#*|}"
    command="${rest%%|*}"
    rest="${rest#*|}"
    model="${rest%%|*}"
    rest="${rest#*|}"
    shell="${rest%%|*}"
    rest="${rest#*|}"
    init_file="${rest%%|*}"
    rest="${rest#*|}"
    permission_mode="$rest"

    {
      printf '\n[profiles.%s]\n' "$name"
      printf 'label = "%s"\n' "$label"
      printf 'cli = "%s"\n' "$cli"
      printf 'command = "%s"\n' "$command"
      printf 'model = "%s"\n' "$model"
      if [[ -n "$shell" ]]; then
        printf 'shell = "%s"\n' "$shell"
      fi
      if [[ -n "$init_file" ]]; then
        printf 'init_file = "%s"\n' "$init_file"
      fi
      printf '\n[profiles.%s.options]\n' "$name"
      printf 'permission_mode = "%s"\n' "$permission_mode"
    } >> "$target"
  done
}

test_default_profile_used_without_tty() {
  local repo="${TEST_ROOT}/profile-default-repo"
  local fake="${TEST_ROOT}/profile-default-worker"
  local config_path="${TEST_ROOT}/profile-default-config.toml"
  local output="${TEST_ROOT}/profile-default-output.log"
  local status

  new_repo "$repo"
  printf '%s\n' '#!/usr/bin/env bash' \
    'printf "%s\\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' > "$fake"
  chmod +x "$fake"

  # The profile uses the direct executable path (no shell/init_file pair)
  # so the runner selects it through `command -v` rather than a shell
  # function. The other profile is included to exercise the lookup path
  # for multiple profiles under the default-profile branch.
  write_profile_config "$config_path" "claude-prod" \
    "claude-prod=Claude Prod|claude|${fake}|claude-3|||" \
    "claude-staging=Claude Staging|claude|/tmp/none|claude-3-5|||acceptEdits"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 0 ]] || fail "Non-interactive default-profile launch exited ${status}; output follows:\n$(cat "$output")"

  # The runner must select the default profile (claude-prod) without
  # printing the interactive prompt.
  if grep -Fq 'Select an execution profile:' "$output"; then
    fail 'Non-interactive launch should not render the profile selector'
  fi
  grep -Fq 'ISSUE_KILLER_STATUS=QUEUE_EMPTY' "$output" || \
    fail 'Default profile worker did not complete'

  pass 'non-interactive launch uses default_profile without prompting'
}

test_missing_default_profile_rejects_non_tty() {
  local repo="${TEST_ROOT}/profile-missing-default-repo"
  local fake="${TEST_ROOT}/profile-missing-default-worker"
  local config_path="${TEST_ROOT}/profile-missing-default-config.toml"
  local output="${TEST_ROOT}/profile-missing-default-output.log"
  local status

  new_repo "$repo"
  printf '%s\n' '#!/usr/bin/env bash' \
    'echo should-not-run; exit 1' > "$fake"
  chmod +x "$fake"

  # default_profile intentionally references a profile not in the file.
  write_profile_config "$config_path" "absent-profile" \
    "claude-prod=Claude Prod|claude|${fake}|claude-3|||bypassPermissions"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 1 ]] || \
    fail "Missing default_profile must exit 1, got ${status}"
  grep -Fq 'requires a valid default_profile' "$output" || \
    fail 'Missing default_profile diagnostic not surfaced'
  [[ ! -e "$repo/.git/claude-minimax-issue-runner.lock" ]] || \
    fail 'Runner acquired a lock with an invalid default profile'

  pass 'non-interactive launch fails closed without a valid default_profile'
}

test_config_rejects_unknown_top_level_key() {
  local config_path="${TEST_ROOT}/profile-unknown-top.toml"
  local output="${TEST_ROOT}/profile-unknown-top-output.log"

  printf 'default_profile = "x"\nunknown_field = "bad"\n[profiles.x]\nlabel = "x"\ncli = "claude"\ncommand = "/bin/echo"\nmodel = "x"\n' \
    > "$config_path"

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "${TEST_ROOT}/any-repo" >"$output" 2>&1 || true
  grep -Fq 'unknown top-level key' "$output" || \
    fail 'Unknown top-level key not rejected before mutation'

  pass 'config rejects unknown top-level keys before any mutation'
}

test_config_rejects_unknown_profile_field() {
  local config_path="${TEST_ROOT}/profile-unknown-field.toml"

  printf 'default_profile = "x"\n[profiles.x]\nlabel = "x"\ncli = "claude"\ncommand = "/bin/echo"\nmodel = "x"\nbogus_field = "bad"\n' \
    > "$config_path"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "${TEST_ROOT}/any-repo" >/dev/null 2>&1
  local status=$?
  set -e
  [[ "$status" -eq 1 ]] || fail 'Unknown profile field must fail closed'

  pass 'config rejects unknown profile fields and fails closed'
}

test_checkpoint_records_profile_identity() {
  local repo="${TEST_ROOT}/profile-checkpoint-repo"
  local fake="${TEST_ROOT}/profile-checkpoint-worker"
  local config_path="${TEST_ROOT}/profile-checkpoint-config.toml"
  local output="${TEST_ROOT}/profile-checkpoint-output.log"
  local checkpoint_file

  new_repo "$repo"
  printf '%s\n' '#!/usr/bin/env bash' \
    'printf "%s\\n" "ISSUE_KILLER_STATUS=FAILED"' > "$fake"
  chmod +x "$fake"

  write_profile_config "$config_path" "claude-prod" \
    "claude-prod=Claude Prod|claude|${fake}|claude-3-pro|||"

  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1 || true

  [[ -r "$checkpoint_file" ]] || \
    fail 'Checkpoint file was not written for a FAILED outcome'
  grep -Eq '^profile=claude-prod$' "$checkpoint_file" || \
    fail 'Checkpoint did not record the profile name'
  grep -Eq '^cli=claude$' "$checkpoint_file" || \
    fail 'Checkpoint did not record the CLI name'
  grep -Eq '^model=claude-3-pro$' "$checkpoint_file" || \
    fail 'Checkpoint did not record the model name'
  grep -Eq "^command=${fake}\$" "$checkpoint_file" || \
    fail 'Checkpoint did not record the command path'

  pass 'checkpoint records profile, cli, model, and command identity'
}

test_checkpoint_enforces_profile_identity_on_recovery() {
  local repo="${TEST_ROOT}/profile-mismatch-repo"
  local fake="${TEST_ROOT}/profile-mismatch-worker"
  local config_path="${TEST_ROOT}/profile-mismatch-config.toml"
  local checkpoint_file
  local status
  local output="${TEST_ROOT}/profile-mismatch-output.log"

  new_repo "$repo"
  git -C "$repo" switch -c issue-91 --quiet
  printf 'dirty\n' >> "${repo}/README.md"
  printf '%s\n' '#!/usr/bin/env bash' \
    'echo should-not-run; exit 1' > "$fake"
  chmod +x "$fake"

  write_profile_config "$config_path" "claude-prod" \
    "claude-prod=Claude Prod|claude|${fake}|claude-3-pro|||bypassPermissions"

  # Pre-seed a checkpoint whose profile does not match the live config.
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"
  base_sha="$(git -C "$repo" rev-parse main)"
  cat > "$checkpoint_file" <<EOF
pid=$$
iteration=1
issue=91
branch=issue-91
base_branch=main
base_sha=${base_sha}
session_id=sess-mismatch
profile=claude-staging
cli=claude
model=claude-3-5
command=/different/path
state=mutating
updated_at=test
EOF

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 4 ]] || \
    fail "Profile-mismatched recovery must exit 4, got ${status}"
  grep -Fq 'checkpoint profile claude-staging does not match selected profile claude-prod' "$output" || \
    fail 'Recovery did not explain the profile identity mismatch'

  pass 'recovery enforces checkpoint profile identity and rejects mismatches'
}

test_destructive_confirmation_lists_profile_identity() {
  local repo="${TEST_ROOT}/profile-confirm-repo"
  local fake="${TEST_ROOT}/profile-confirm-worker"
  local config_path="${TEST_ROOT}/profile-confirm-config.toml"
  local expect_script="${TEST_ROOT}/profile-confirm.expect"
  local output="${TEST_ROOT}/profile-confirm-output.log"

  new_repo "$repo"
  printf '%s\n' '#!/usr/bin/env bash' \
    'printf "%s\\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' > "$fake"
  chmod +x "$fake"

  write_profile_config "$config_path" "claude-prod" \
    "claude-prod=Claude Prod Label|claude|${fake}|claude-3-pro|||bypassPermissions"

  cat > "$expect_script" <<PROLOG
set timeout 15
log_user 1
spawn env PATH=$PATH ISSUE_KILLER_CONFIG_PATH=$config_path /Users/elvis/Code/tools/workflow/agent/claude-minimax-issue-runner/run.sh "$repo"
expect {
  -re {Profile \[1\]} {
    send "\r"
    exp_continue
  }
  -re {Continue\? \[y/N\]} {
    send "n\r"
    exp_continue
  }
  eof
}
PROLOG

  expect "$expect_script" >"$output" 2>&1 || \
    fail 'Destructive confirmation did not display the profile identity'

  grep -Fq 'claude-prod' "$output" || \
    fail 'Destructive confirmation missing profile name'
  grep -Fq 'Claude Prod Label' "$output" || \
    fail 'Destructive confirmation missing profile label'
  grep -Fq 'claude-3-pro' "$output" || \
    fail 'Destructive confirmation missing model identifier'
  grep -Fq 'bypassPermissions' "$output" || \
    fail 'Destructive confirmation missing autonomy mode'
  grep -Fq 'base branch:' "$output" || \
    fail 'Destructive confirmation missing base branch label'

  pass 'destructive confirmation lists profile, model, autonomy, and base branch'
}

test_black_box_claude_profile_completes_issue() {
  local repo="${TEST_ROOT}/profile-blackbox-repo"
  local fake="${TEST_ROOT}/profile-blackbox-worker"
  local config_path="${TEST_ROOT}/profile-blackbox-config.toml"
  local output="${TEST_ROOT}/profile-blackbox-output.log"

  new_repo "$repo"
  cat > "$fake" <<'PROLOG'
#!/usr/bin/env bash
echo fake called >&2
for arg in "$@"; do echo "ARG: $arg" >&2; done
printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}'
PROLOG
  chmod +x "$fake"

  write_profile_config "$config_path" "claude-prod" \
    "claude-prod=Claude Prod|claude|${fake}|claude-3-pro|||bypassPermissions"

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Black-box Claude profile did not drain the queue'

  grep -Fq 'No pending, available, non-epic issues remain.' "$output" || \
    fail 'Black-box Claude profile did not reach empty queue'

  pass 'black-box Claude profile drains the queue through the generic command'
}

# A degenerate test that exercises the profile picker with multiple profiles
# without launching a worker. The expect script verifies each profile appears
# in the rendered menu and that the destructive confirmation shows the
# selected profile's identity.
test_profile_picker_lists_every_profile_with_footer() {
  local repo="${TEST_ROOT}/profile-picker-repo"
  local fake="${TEST_ROOT}/profile-picker-worker"
  local config_path="${TEST_ROOT}/profile-picker-config.toml"
  local expect_script="${TEST_ROOT}/profile-picker.expect"
  local output="${TEST_ROOT}/profile-picker-output.log"

  new_repo "$repo"
  printf '%s\n' '#!/usr/bin/env bash' 'echo should-not-run; exit 1' > "$fake"
  chmod +x "$fake"

  write_profile_config "$config_path" "claude-prod" \
    "claude-prod=Claude Prod Label|claude|/no/such/path|claude-3-pro|||bypassPermissions" \
    "codex-luna=Codex Luna|codex|/no/such/path|gpt-5-luna|||default"

  cat > "$expect_script" <<PROLOG
set timeout 15
log_user 1
spawn env PATH=$PATH ISSUE_KILLER_CONFIG_PATH=$config_path /Users/elvis/Code/tools/workflow/agent/claude-minimax-issue-runner/run.sh "$repo"
expect {
  -re {Profile \[1\]:} {
    send "2\r"
    exp_continue
  }
  -re {Continue\? \[y/N\]} {
    send "n\r"
    exp_continue
  }
  eof
}
PROLOG

  expect "$expect_script" >"$output" 2>&1 || \
    fail 'TTY profile selector did not render the expected menu'

  grep -Fq 'Select an execution profile:' "$output" || \
    fail 'Profile picker did not render the menu header'
  grep -Fq 'Claude Prod Label' "$output" || \
    fail 'Profile picker did not show the first profile label'
  grep -Fq 'Codex Luna' "$output" || \
    fail 'Profile picker did not show the second profile label'
  grep -Fq 'config.toml to add or change profiles' "$output" || \
    fail 'Profile picker footer did not invite configuration edits'
  grep -Fq 'codex-luna' "$output" || \
    fail 'Selecting profile 2 did not switch to codex-luna'

  pass 'TTY profile picker lists every profile and points at the config path'
}

# Builds a fake codex worker that emits one set of JSONL events on the
# first invocation and a different set on subsequent invocations, with
# the iteration tracked in a counter file next to the worker. The
# first-iteration body is taken from stdin-equivalent heredoc content
# (already provided by the caller), and the post-iteration body is
# the JSONL the worker emits after the iteration counter exceeds the
# initial pass. Each invocation increments the counter.
write_codex_fixture() {
  local target="$1"
  local counter_file="$2"
  cat > "$target" <<PROLOG
#!/usr/bin/env bash
counter_file="\$1"
shift
iteration=0
if [[ -r "\$counter_file" ]]; then
  iteration="\$(<"\$counter_file")"
fi
iteration=\$((iteration + 1))
printf '%s' "\$iteration" > "\$counter_file"
if [[ "\$iteration" -gt 1 ]]; then
  printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}'
  exit 0
fi
PROLOG
  chmod +x "$target"
}

# --- Codex profile black-box tests (issue #14) ------------------------

# Writes a Codex profile configuration. The arguments are pipe-delimited
# records of the form:
#   name=label|cli|command|model|shell|init_file|reasoning_effort|sandbox|auto_approve
# Empty fields are skipped. Tests for issue #14 use this helper to
# configure a profile whose CLI is `codex` and whose options include
# `reasoning_effort`, `sandbox`, and `auto_approve`. The parser walks
# the pipe-separated fields one delimiter at a time so empty values
# (e.g. when `shell` and `init_file` are unset) are preserved
# correctly.
write_codex_profile_config() {
  local target="$1"
  local default_name="$2"
  shift 2

  printf 'default_profile = "%s"\n' "$default_name" > "$target"
  for entry in "$@"; do
    local name label cli command model shell init_file
    local reasoning_effort sandbox auto_approve field_idx field
    name="${entry%%=*}"
    local rest="${entry#*=}"
    label=""
    cli=""
    command=""
    model=""
    shell=""
    init_file=""
    reasoning_effort=""
    sandbox=""
    auto_approve=""
    field_idx=0
    while [[ -n "$rest" ]]; do
      field="${rest%%|*}"
      if [[ "$field" == "$rest" ]]; then
        rest=""
      else
        rest="${rest#*|}"
      fi
      case "$field_idx" in
        0) label="$field" ;;
        1) cli="$field" ;;
        2) command="$field" ;;
        3) model="$field" ;;
        4) shell="$field" ;;
        5) init_file="$field" ;;
        6) reasoning_effort="$field" ;;
        7) sandbox="$field" ;;
        8) auto_approve="$field" ;;
      esac
      field_idx=$((field_idx + 1))
    done

    {
      printf '\n[profiles.%s]\n' "$name"
      printf 'label = "%s"\n' "$label"
      printf 'cli = "%s"\n' "$cli"
      printf 'command = "%s"\n' "$command"
      printf 'model = "%s"\n' "$model"
      if [[ -n "$shell" ]]; then
        printf 'shell = "%s"\n' "$shell"
      fi
      if [[ -n "$init_file" ]]; then
        printf 'init_file = "%s"\n' "$init_file"
      fi
      printf '\n[profiles.%s.options]\n' "$name"
      [[ -n "$reasoning_effort" ]] && \
        printf 'reasoning_effort = "%s"\n' "$reasoning_effort"
      [[ -n "$sandbox" ]] && \
        printf 'sandbox = "%s"\n' "$sandbox"
      [[ -n "$auto_approve" ]] && \
        printf 'auto_approve = "%s"\n' "$auto_approve"
    } >> "$target"
  done
}

test_black_box_codex_profile_invokes_codex_exec_with_expected_args() {
  local repo="${TEST_ROOT}/codex-args-repo"
  local fake="${TEST_ROOT}/codex-args-worker"
  local args_file="${TEST_ROOT}/codex-args-recorded"
  local config_path="${TEST_ROOT}/codex-args-config.toml"
  local output="${TEST_ROOT}/codex-args-output.log"

  new_repo "$repo"
  cat > "$fake" <<PROLOG
#!/usr/bin/env bash
: > "\$RUNNER_TEST_ARGS_FILE"
for arg in "\$@"; do
  printf '%s\n' "\$arg" >> "\$RUNNER_TEST_ARGS_FILE"
done
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}'
PROLOG
  chmod +x "$fake"

  write_codex_profile_config "$config_path" "codex-luna" \
    "codex-luna=Codex Luna|codex|${fake}|gpt-5-luna|||high|workspace-write|true"

  RUNNER_TEST_ARGS_FILE="$args_file" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Black-box Codex profile did not finish its first attempt'

  # `codex exec` is the canonical subcommand. The adapter must not
  # pass arbitrary free-form shell expressions; the args list must
  # enumerate the documented flags.
  grep -Fxq -- 'exec' "$args_file" || \
    fail 'Codex adapter did not invoke the `exec` subcommand'
  grep -Fxq -- '--json' "$args_file" || \
    fail 'Codex adapter did not request JSONL output'
  grep -Fxq -- '--model' "$args_file" || \
    fail 'Codex adapter did not pass the model flag'
  grep -Fxq -- 'gpt-5-luna' "$args_file" || \
    fail 'Codex adapter did not pass the configured model identifier'
  grep -Fxq -- '--reasoning-effort' "$args_file" || \
    fail 'Codex adapter did not pass reasoning effort'
  grep -Fxq -- 'high' "$args_file" || \
    fail 'Codex adapter did not pass the configured reasoning effort value'
  grep -Fxq -- '--sandbox' "$args_file" || \
    fail 'Codex adapter did not pass the sandbox flag'
  grep -Fxq -- 'workspace-write' "$args_file" || \
    fail 'Codex adapter did not pass the configured sandbox mode'
  grep -Fxq -- '--full-auto' "$args_file" || \
    fail 'Codex adapter did not enable full-auto when auto_approve=true'

  pass 'codex profile invokes codex exec with --json, --model, --reasoning-effort, --sandbox, and --full-auto'
}

test_black_box_codex_profile_decodes_jsonl_progress_events() {
  local repo="${TEST_ROOT}/codex-progress-repo"
  local fake="${TEST_ROOT}/codex-progress-worker"
  local counter="${TEST_ROOT}/codex-progress-counter"
  local config_path="${TEST_ROOT}/codex-progress-config.toml"
  local output="${TEST_ROOT}/codex-progress-output.log"

  new_repo "$repo"
  cat > "$fake" <<'PROLOG'
#!/usr/bin/env bash
counter="$RUNNER_TEST_COUNTER_FILE"
iteration=0
if [[ -r "$counter" ]]; then
  iteration="$(<"$counter")"
fi
iteration=$((iteration + 1))
printf '%s' "$iteration" > "$counter"
if [[ "$iteration" -gt 1 ]]; then
  printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}'
  exit 0
fi
printf '%s\n' '{"type":"thread.started","thread_id":"thread-abc"}'
printf '%s\n' '{"type":"item.started","item":{"type":"command_execution","command":"ls -la"}}'
printf '%s\n' '{"type":"item.started","item":{"type":"file_change","path":"agent/run.sh"}}'
printf '%s\n' '{"type":"item.started","item":{"type":"command_execution","command":"git push origin issue-14"}}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}}'
PROLOG
  chmod +x "$fake"

  write_codex_profile_config "$config_path" "codex-luna" \
    "codex-luna=Codex Luna|codex|${fake}|gpt-5-luna|||medium|workspace-write|false"

  RUNNER_TEST_COUNTER_FILE="$counter" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Black-box Codex progress did not complete the issue'

  grep -Fq 'Running shell command' "$output" || \
    fail 'Codex JSONL did not surface a shell command event'
  grep -Fq 'Editing agent/run.sh' "$output" || \
    fail 'Codex JSONL did not surface a file-change mutation event'
  grep -Fq 'Pushing branch' "$output" || \
    fail 'Codex JSONL did not surface a `git push` event'
  grep -Fq 'Worker 1 completed one issue.' "$output" || \
    fail 'Codex worker did not report the issue as completed'

  pass 'codex JSONL streams translate into the same normalized progress as Claude'
}

test_black_box_codex_profile_captures_thread_id_from_session_event() {
  local repo="${TEST_ROOT}/codex-session-repo"
  local fake="${TEST_ROOT}/codex-session-worker"
  local counter="${TEST_ROOT}/codex-session-counter"
  local config_path="${TEST_ROOT}/codex-session-config.toml"
  local output="${TEST_ROOT}/codex-session-output.log"

  new_repo "$repo"
  cat > "$fake" <<'PROLOG'
#!/usr/bin/env bash
counter="$RUNNER_TEST_COUNTER_FILE"
iteration=0
if [[ -r "$counter" ]]; then
  iteration="$(<"$counter")"
fi
iteration=$((iteration + 1))
printf '%s' "$iteration" > "$counter"
if [[ "$iteration" -gt 1 ]]; then
  printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}'
  exit 0
fi
printf '%s\n' '{"type":"thread.started","thread_id":"thread-xyz-001"}'
# Emit FAILED so the orchestrator preserves the checkpoint that
# records the captured session id. The test inspects the checkpoint
# to verify the runtime adapter wrote the thread id into the
# recovery record before the FAILED terminal state.
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ISSUE_KILLER_STATUS=FAILED\n"}}'
PROLOG
  chmod +x "$fake"

  write_codex_profile_config "$config_path" "codex-luna" \
    "codex-luna=Codex Luna|codex|${fake}|gpt-5-luna|||high|workspace-write|false"

  set +e
  RUNNER_TEST_COUNTER_FILE="$counter" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1
  set -e

  # The orchestrator records the captured thread id into the
  # checkpoint when the worker emits `thread.started`. FAILED
  # preserves the checkpoint so the runtime observable is durable.
  checkpoint="${repo}/.git/claude-minimax-issue-runner.checkpoint"
  grep -Eq '^session_id=thread-xyz-001' "$checkpoint" || \
    fail 'Codex adapter did not capture the thread id from thread.started'
  grep -Eq '^cli=codex' "$checkpoint" || \
    fail 'Codex checkpoint did not record the codex CLI identity'

  pass 'codex adapter captures the thread id and records it on the checkpoint'
}

test_codex_profile_validation_rejects_unknown_options() {
  local adapter="${ROOT_DIR}/agent/claude-minimax-issue-runner/runtime/codex-adapter.sh"
  local output

  set +e
  RUNNER_NAME="claude-minimax-issue-runner" \
  bash -c "source '${adapter}' && codex_runtime_validate_profile 'unknown_option=1'" \
    >"$TEST_ROOT/codex-validate-unknown.out" \
    2>"$TEST_ROOT/codex-validate-unknown.err"
  local rc=$?
  set -e

  [[ "$rc" -ne 0 ]] || fail 'Unknown Codex option must fail validation'
  grep -Fq 'unknown option' "$TEST_ROOT/codex-validate-unknown.err" || \
    fail 'Validation diagnostic did not name the unknown option'

  pass 'codex profile validation rejects unknown options'
}

test_codex_profile_validation_rejects_invalid_sandbox() {
  local adapter="${ROOT_DIR}/agent/claude-minimax-issue-runner/runtime/codex-adapter.sh"

  set +e
  RUNNER_NAME="claude-minimax-issue-runner" \
  bash -c "source '${adapter}' && codex_runtime_validate_profile 'sandbox=not-a-mode'" \
    >"$TEST_ROOT/codex-validate-sandbox.out" \
    2>"$TEST_ROOT/codex-validate-sandbox.err"
  local rc=$?
  set -e

  [[ "$rc" -ne 0 ]] || fail 'Invalid Codex sandbox must fail validation'
  grep -Fq 'invalid sandbox' "$TEST_ROOT/codex-validate-sandbox.err" || \
    fail 'Sandbox validation diagnostic did not name the bad value'

  pass 'codex profile validation rejects an unknown sandbox mode'
}

test_codex_profile_validation_rejects_auto_approve_with_read_only_sandbox() {
  local adapter="${ROOT_DIR}/agent/claude-minimax-issue-runner/runtime/codex-adapter.sh"

  set +e
  RUNNER_NAME="claude-minimax-issue-runner" \
  bash -c "source '${adapter}' && codex_runtime_validate_profile $'sandbox=read-only\nauto_approve=true'" \
    >"$TEST_ROOT/codex-validate-conflict.out" \
    2>"$TEST_ROOT/codex-validate-conflict.err"
  local rc=$?
  set -e

  [[ "$rc" -ne 0 ]] || fail 'Conflicting Codex options must fail validation'
  grep -Fq 'auto_approve=true with sandbox=read-only' \
    "$TEST_ROOT/codex-validate-conflict.err" || \
    fail 'Conflict diagnostic did not name the contradictory options'

  pass 'codex profile validation rejects auto_approve=true with sandbox=read-only'
}

test_black_box_codex_profile_rejects_invalid_options_before_launch() {
  local repo="${TEST_ROOT}/codex-bad-options-repo"
  local fake="${TEST_ROOT}/codex-bad-options-worker"
  local marker="${TEST_ROOT}/codex-bad-options-ran"
  local config_path="${TEST_ROOT}/codex-bad-options-config.toml"
  local output="${TEST_ROOT}/codex-bad-options-output.log"
  local status

  new_repo "$repo"
  printf '%s\n' '#!/usr/bin/env bash' "touch '${marker}'" > "$fake"
  chmod +x "$fake"

  # Override the loader to permit `sandbox` even when the value is
  # invalid. The adapter itself is responsible for the strict check,
  # so the test exercises that layer end-to-end.
  cat > "$config_path" <<PROLOG
default_profile = "codex-broken"

[profiles.codex-broken]
label = "Codex Broken"
cli = "codex"
command = "${fake}"
model = "gpt-5-luna"

[profiles.codex-broken.options]
sandbox = "not-a-mode"
PROLOG

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -ne 0 ]] || \
    fail 'Invalid Codex sandbox must reject the launch'
  [[ ! -e "$marker" ]] || \
    fail 'Worker was launched despite an invalid Codex sandbox'
  grep -Fq 'invalid sandbox' "$output" || \
    fail 'Runner did not surface the invalid-sandbox diagnostic'

  pass 'codex profile with an invalid sandbox stops the run before worker launch'
}

test_black_box_codex_profile_resumes_thread_when_session_captured() {
  local repo="${TEST_ROOT}/codex-resume-repo"
  local fake="${TEST_ROOT}/codex-resume-worker"
  local counter="${TEST_ROOT}/codex-resume-counter"
  local args_file="${TEST_ROOT}/codex-resume-args"
  local config_path="${TEST_ROOT}/codex-resume-config.toml"
  local output="${TEST_ROOT}/codex-resume-output.log"

  new_repo "$repo"
  cat > "$fake" <<PROLOG
#!/usr/bin/env bash
counter_file="\$RUNNER_TEST_COUNTER_FILE"
attempt=0
if [[ -r "\$counter_file" ]]; then
  attempt="\$(<"\$counter_file")"
fi
attempt=\$((attempt + 1))
printf '%s' "\$attempt" > "\$counter_file"

for arg in "\$@"; do
  printf '%s\n' "\$arg" >> "\$RUNNER_TEST_ARGS_FILE"
done
printf '%s\n' 'EOF' >> "\$RUNNER_TEST_ARGS_FILE"

if [[ "\$attempt" -eq 1 ]]; then
  # First attempt: emit a captured thread id, then a transient
  # transport failure so the orchestrator captures the session and
  # retries with --resume on the next attempt.
  printf '%s\n' '{"type":"thread.started","thread_id":"thread-resume-1"}'
  printf '%s\n' 'connection reset by peer' >&2
  exit 1
fi

if [[ "\$attempt" -eq 2 ]]; then
  # Resumed attempt: succeed with ISSUE_COMPLETED so the orchestrator
  # proceeds to the next queue iteration and we can assert that
  # --resume was used.
  printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}}'
  exit 0
fi

# Subsequent attempts: report an empty queue so the orchestrator exits.
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}'
PROLOG
  chmod +x "$fake"

  write_codex_profile_config "$config_path" "codex-luna" \
    "codex-luna=Codex Luna|codex|${fake}|gpt-5-luna|||medium|workspace-write|false"

  RUNNER_TEST_ARGS_FILE="$args_file" \
  RUNNER_TEST_COUNTER_FILE="$counter" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="1,1,1" \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Black-box Codex resume did not finish its first attempt'

  grep -Fxq -- '--resume' "$args_file" || \
    fail 'Codex adapter did not pass --resume on a captured session'
  grep -Fxq -- 'thread-resume-1' "$args_file" || \
    fail 'Codex adapter did not pass the captured thread id to --resume'

  pass 'codex adapter passes --resume <thread_id> when a session is safely captured'
}

test_black_box_codex_profile_drains_queue_through_status_marker() {
  local repo="${TEST_ROOT}/codex-drain-repo"
  local fake="${TEST_ROOT}/codex-drain-worker"
  local counter="${TEST_ROOT}/codex-drain-counter"
  local config_path="${TEST_ROOT}/codex-drain-config.toml"
  local output="${TEST_ROOT}/codex-drain-output.log"

  new_repo "$repo"
  cat > "$fake" <<'PROLOG'
#!/usr/bin/env bash
counter="$RUNNER_TEST_COUNTER_FILE"
iteration=0
if [[ -r "$counter" ]]; then
  iteration="$(<"$counter")"
fi
iteration=$((iteration + 1))
printf '%s' "$iteration" > "$counter"
if [[ "$iteration" -eq 1 ]]; then
  printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}}'
  exit 0
fi
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}'
PROLOG
  chmod +x "$fake"

  write_codex_profile_config "$config_path" "codex-luna" \
    "codex-luna=Codex Luna|codex|${fake}|gpt-5-luna|||low|workspace-write|false"

  RUNNER_TEST_COUNTER_FILE="$counter" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Codex queue drain did not exit cleanly'

  grep -Fq 'Worker 1 completed one issue.' "$output" || \
    fail 'Codex worker did not report the first issue as completed'
  grep -Fq 'No pending, available, non-epic issues remain.' "$output" || \
    fail 'Codex worker did not drain the queue'

  pass 'codex profile drains a two-issue queue through the generic status marker'
}

# --- OpenCode profile black-box tests (issue #15) ----------------------

# Writes an OpenCode profile configuration. The arguments are
# pipe-delimited records of the form:
#   name=label|cli|command|model|shell|init_file|variant|auto_approve|fallbacks
# Empty fields are skipped. The optional fallbacks field is a TOML array
# literal, for example `["opencode-backup"]`.
# Tests configure profiles whose CLI is `opencode` and whose options include
# `variant` and `auto_approve`. The parser walks the pipe-separated
# fields one delimiter at a time so empty values (e.g. when `shell`
# and `init_file` are unset) are preserved correctly.
write_opencode_profile_config() {
  local target="$1"
  local default_name="$2"
  shift 2

  printf 'default_profile = "%s"\n' "$default_name" > "$target"
  for entry in "$@"; do
    local name label cli command model shell init_file
    local variant auto_approve fallbacks field_idx field
    name="${entry%%=*}"
    local rest="${entry#*=}"
    label=""
    cli=""
    command=""
    model=""
    shell=""
    init_file=""
    variant=""
    auto_approve=""
    fallbacks=""
    field_idx=0
    while [[ -n "$rest" ]]; do
      field="${rest%%|*}"
      if [[ "$field" == "$rest" ]]; then
        rest=""
      else
        rest="${rest#*|}"
      fi
      case "$field_idx" in
        0) label="$field" ;;
        1) cli="$field" ;;
        2) command="$field" ;;
        3) model="$field" ;;
        4) shell="$field" ;;
        5) init_file="$field" ;;
        6) variant="$field" ;;
        7) auto_approve="$field" ;;
        8) fallbacks="$field" ;;
      esac
      field_idx=$((field_idx + 1))
    done

    {
      printf '\n[profiles.%s]\n' "$name"
      printf 'label = "%s"\n' "$label"
      printf 'cli = "%s"\n' "$cli"
      printf 'command = "%s"\n' "$command"
      printf 'model = "%s"\n' "$model"
      if [[ -n "$shell" ]]; then
        printf 'shell = "%s"\n' "$shell"
      fi
      if [[ -n "$init_file" ]]; then
        printf 'init_file = "%s"\n' "$init_file"
      fi
      if [[ -n "$fallbacks" ]]; then
        printf 'fallbacks = %s\n' "$fallbacks"
      fi
      printf '\n[profiles.%s.options]\n' "$name"
      [[ -n "$variant" ]] && \
        printf 'variant = "%s"\n' "$variant"
      [[ -n "$auto_approve" ]] && \
        printf 'auto_approve = "%s"\n' "$auto_approve"
    } >> "$target"
  done
}

test_black_box_opencode_fallback_validation_rejects_missing_profile() {
  local repo="${TEST_ROOT}/opencode-missing-fallback-repo"
  local fake="${TEST_ROOT}/opencode-missing-fallback-worker"
  local marker="${TEST_ROOT}/opencode-missing-fallback-ran"
  local config_path="${TEST_ROOT}/opencode-missing-fallback-config.toml"
  local output="${TEST_ROOT}/opencode-missing-fallback-output.log"
  local status

  new_repo "$repo"
  printf '%s\n' '#!/usr/bin/env bash' "touch '${marker}'" > "$fake"
  chmod +x "$fake"

  write_opencode_profile_config "$config_path" "opencode-primary" \
    "opencode-primary=OpenCode Primary|opencode|${fake}|provider/primary|||high|true|[\"opencode-missing\"]"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -ne 0 ]] || \
    fail 'A missing OpenCode fallback reference must reject the launch'
  [[ ! -e "$marker" ]] || \
    fail 'Worker launched despite a missing OpenCode fallback reference'
  grep -Fq 'fallback profile opencode-missing is not configured' "$output" || \
    fail 'Missing fallback validation diagnostic did not name the unknown profile'

  pass 'opencode fallback validation rejects missing profile references'
}

test_black_box_opencode_fallback_validation_rejects_invalid_chains() {
  local case_name config_path output status
  local repo="${TEST_ROOT}/opencode-invalid-fallback-repo"
  local fake="${TEST_ROOT}/opencode-invalid-fallback-worker"
  local marker="${TEST_ROOT}/opencode-invalid-fallback-ran"

  new_repo "$repo"
  printf '%s\n' '#!/usr/bin/env bash' "touch '${marker}'" > "$fake"
  chmod +x "$fake"

  for case_name in duplicate cross-cli cycle; do
    config_path="${TEST_ROOT}/opencode-${case_name}-fallback-config.toml"
    output="${TEST_ROOT}/opencode-${case_name}-fallback-output.log"
    case "$case_name" in
      duplicate)
        write_opencode_profile_config "$config_path" "opencode-primary" \
          "opencode-primary=OpenCode Primary|opencode|${fake}|provider/primary|||high|true|[\"opencode-backup\", \"opencode-backup\"]" \
          "opencode-backup=OpenCode Backup|opencode|${fake}|provider/backup|||medium|true"
        ;;
      cross-cli)
        write_opencode_profile_config "$config_path" "opencode-primary" \
          "opencode-primary=OpenCode Primary|opencode|${fake}|provider/primary|||high|true|[\"codex-backup\"]" \
          "codex-backup=Codex Backup|codex|${fake}|codex-model||||false"
        ;;
      cycle)
        write_opencode_profile_config "$config_path" "opencode-primary" \
          "opencode-primary=OpenCode Primary|opencode|${fake}|provider/primary|||high|true|[\"opencode-backup\"]" \
          "opencode-backup=OpenCode Backup|opencode|${fake}|provider/backup|||medium|true|[\"opencode-primary\"]"
        ;;
    esac

    set +e
    ISSUE_RUNNER_ASSUME_YES=true \
    ISSUE_KILLER_CONFIG_PATH="$config_path" \
      "$RUNNER" "$repo" >"$output" 2>&1
    status=$?
    set -e

    [[ "$status" -ne 0 ]] || \
      fail "An invalid ${case_name} fallback chain must reject the launch"
    [[ ! -e "$marker" ]] || \
      fail "Worker launched despite an invalid ${case_name} fallback chain"
  done

  grep -Fq 'duplicate fallback opencode-backup' \
    "${TEST_ROOT}/opencode-duplicate-fallback-output.log" || \
    fail 'Duplicate fallback validation diagnostic did not name the repeated profile'
  grep -Fq 'fallback profile codex-backup uses cli codex' \
    "${TEST_ROOT}/opencode-cross-cli-fallback-output.log" || \
    fail 'Cross-CLI fallback validation diagnostic did not name the invalid CLI'
  grep -Fq 'fallback chain contains a cycle through profile' \
    "${TEST_ROOT}/opencode-cycle-fallback-output.log" || \
    fail 'Cycle validation diagnostic did not identify the repeated profile'

  pass 'opencode fallback validation rejects duplicates, cycles, and cross-CLI entries'
}

test_tty_opencode_fallback_picker_builds_ordered_unique_chain() {
  local repo="${TEST_ROOT}/opencode-fallback-picker-repo"
  local fake="${TEST_ROOT}/opencode-fallback-picker-worker"
  local config_path="${TEST_ROOT}/opencode-fallback-picker-config.toml"
  local expect_script="${TEST_ROOT}/opencode-fallback-picker.expect"
  local output="${TEST_ROOT}/opencode-fallback-picker-output.log"

  new_repo "$repo"
  printf '%s\n' '#!/usr/bin/env bash' 'echo should-not-run; exit 1' > "$fake"
  chmod +x "$fake"

  write_opencode_profile_config "$config_path" "opencode-primary" \
    "opencode-primary=OpenCode Primary|opencode|${fake}|provider/primary|||high|true" \
    "opencode-backup-a=OpenCode Backup A|opencode|${fake}|provider/backup-a|||medium|true" \
    "opencode-backup-b=OpenCode Backup B|opencode|${fake}|provider/backup-b|||low|true" \
    "opencode-backup-c=OpenCode Backup C|opencode|${fake}|provider/backup-c|||low|true" \
    "codex-other=Codex Other|codex|${fake}|codex-model||||false"

  cat > "$expect_script" <<PROLOG
set timeout 15
log_user 1
set fallback_prompt 0
spawn env PATH=$PATH ISSUE_KILLER_CONFIG_PATH=$config_path $RUNNER "$repo"
expect {
  -re {Profile \\[5\\]:} {
    send "\r"
    exp_continue
  }
  -re {Fallback \\[0\\]:} {
    incr fallback_prompt
    if {\$fallback_prompt == 1} {
      send "2\r"
    } elseif {\$fallback_prompt == 2} {
      send "1\r"
    } else {
      send "0\r"
    }
    exp_continue
  }
  -re {Continue\\? \\[y/N\\]} {
    send "n\r"
    exp_continue
  }
  eof
}
PROLOG

  expect "$expect_script" >"$output" 2>&1 || \
    fail 'TTY OpenCode fallback selector did not render the expected menus'

  grep -Fq 'Select the next OpenCode fallback profile:' "$output" || \
    fail 'OpenCode selection did not open the fallback-chain builder'
  [[ "$(grep -Fc 'Codex Other' "$output")" -eq 1 ]] || \
    fail 'Non-OpenCode profile was offered outside the primary profile menu'
  grep -Fq 'fallbacks:    opencode-backup-b, opencode-backup-a' "$output" || \
    fail 'Destructive confirmation did not preserve the selected fallback order'

  pass 'TTY OpenCode picker builds an ordered chain from unused OpenCode profiles only'
}

test_black_box_opencode_quota_failure_advances_fallback_with_same_session() {
  local repo="${TEST_ROOT}/opencode-quota-fallback-repo"
  local primary="${TEST_ROOT}/opencode-quota-primary"
  local backup="${TEST_ROOT}/opencode-quota-backup"
  local primary_count="${TEST_ROOT}/opencode-quota-primary-count"
  local backup_count="${TEST_ROOT}/opencode-quota-backup-count"
  local args_file="${TEST_ROOT}/opencode-quota-backup-args"
  local checkpoint_snapshot="${TEST_ROOT}/opencode-quota-checkpoint-snapshot"
  local config_path="${TEST_ROOT}/opencode-quota-fallback-config.toml"
  local output="${TEST_ROOT}/opencode-quota-fallback-output.log"

  new_repo "$repo"
  cat > "$primary" <<'PROLOG'
#!/usr/bin/env bash
count=0
[[ -r "$RUNNER_TEST_PRIMARY_COUNT" ]] && count="$(<"$RUNNER_TEST_PRIMARY_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$RUNNER_TEST_PRIMARY_COUNT"
printf '%s\n' '{"type":"session","sessionID":"sess-fallback-18"}'
printf '%s\n' '{"type":"step_start","part":{"type":"tool","tool":"bash","input":{"command":"gh issue view 18"}}}'
printf '%s\n' 'subscription quota exhausted for provider' >&2
exit 1
PROLOG
  cat > "$backup" <<'PROLOG'
#!/usr/bin/env bash
count=0
[[ -r "$RUNNER_TEST_BACKUP_COUNT" ]] && count="$(<"$RUNNER_TEST_BACKUP_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$RUNNER_TEST_BACKUP_COUNT"
for arg in "$@"; do printf '%s\n' "$arg" >> "$RUNNER_TEST_ARGS_FILE"; done
printf '%s\n' 'EOF' >> "$RUNNER_TEST_ARGS_FILE"
if [[ "$count" -eq 1 ]]; then
  cp "$RUNNER_TEST_CHECKPOINT" "$RUNNER_TEST_CHECKPOINT_SNAPSHOT"
  printf '%s\n' '{"type":"text","sessionID":"sess-fallback-18","part":{"type":"text","text":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}}'
else
  printf '%s\n' '{"type":"text","sessionID":"","part":{"type":"text","text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}'
fi
PROLOG
  chmod +x "$primary" "$backup"

  write_opencode_profile_config "$config_path" "opencode-primary" \
    "opencode-primary=OpenCode Primary|opencode|${primary}|provider/primary|||high|true|[\"opencode-backup\", \"opencode-tertiary\"]" \
    "opencode-backup=OpenCode Backup|opencode|${backup}|provider/backup|||medium|true" \
    "opencode-tertiary=OpenCode Tertiary|opencode|${backup}|provider/tertiary|||low|true"

  RUNNER_TEST_PRIMARY_COUNT="$primary_count" \
  RUNNER_TEST_BACKUP_COUNT="$backup_count" \
  RUNNER_TEST_ARGS_FILE="$args_file" \
  RUNNER_TEST_CHECKPOINT="${repo}/.git/claude-minimax-issue-runner.checkpoint" \
  RUNNER_TEST_CHECKPOINT_SNAPSHOT="$checkpoint_snapshot" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="1,1" \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'OpenCode quota failure did not continue through the fallback profile'

  [[ "$(<"$primary_count")" -eq 1 ]] || \
    fail 'Quota exhaustion retried the failed primary profile before fallback'
  [[ "$(<"$backup_count")" -eq 2 ]] || \
    fail 'Fallback profile did not complete the issue and verify the empty queue'
  grep -Fxq -- 'provider/backup' "$args_file" || \
    fail 'Fallback worker did not use the next profile model'
  grep -Fxq -- '--session' "$args_file" || \
    fail 'Fallback worker did not continue the compatible OpenCode session'
  grep -Fxq -- 'sess-fallback-18' "$args_file" || \
    fail 'Fallback worker did not receive the captured session identity'
  grep -Fq 'Advancing OpenCode fallback: opencode-primary -> opencode-backup' "$output" || \
    fail 'Runner did not report the ordered fallback transition'
  grep -Eq '^profile=opencode-backup$' "$checkpoint_snapshot" || \
    fail 'Transition checkpoint did not record the active fallback profile'
  grep -Eq '^failed_profile=opencode-primary$' "$checkpoint_snapshot" || \
    fail 'Transition checkpoint did not record the failed profile'
  grep -Eq '^next_profile=opencode-backup$' "$checkpoint_snapshot" || \
    fail 'Transition checkpoint did not record the next profile'
  grep -Eq '^fallback_remaining=opencode-tertiary$' "$checkpoint_snapshot" || \
    fail 'Transition checkpoint did not retain the remaining fallback order'
  grep -Eq '^fallback_position=1$' "$checkpoint_snapshot" || \
    fail 'Transition checkpoint did not advance the fallback position'

  local reconcile_line fallback_line
  reconcile_line="$(grep -n 'Reconciling recovery state' "$output" | head -n 1 | cut -d: -f1)"
  fallback_line="$(grep -n 'Advancing OpenCode fallback' "$output" | head -n 1 | cut -d: -f1)"
  [[ -n "$reconcile_line" && -n "$fallback_line" && "$reconcile_line" -lt "$fallback_line" ]] || \
    fail 'Fallback profile was activated before tracker and PR reconciliation'

  pass 'explicit OpenCode quota exhaustion advances the same issue and compatible session'
}

test_black_box_opencode_rate_limit_retries_before_fallback() {
  local repo="${TEST_ROOT}/opencode-rate-limit-repo"
  local primary="${TEST_ROOT}/opencode-rate-limit-primary"
  local backup="${TEST_ROOT}/opencode-rate-limit-backup"
  local primary_count="${TEST_ROOT}/opencode-rate-limit-primary-count"
  local backup_count="${TEST_ROOT}/opencode-rate-limit-backup-count"
  local config_path="${TEST_ROOT}/opencode-rate-limit-config.toml"
  local output="${TEST_ROOT}/opencode-rate-limit-output.log"

  new_repo "$repo"
  cat > "$primary" <<'PROLOG'
#!/usr/bin/env bash
count=0
[[ -r "$RUNNER_TEST_PRIMARY_COUNT" ]] && count="$(<"$RUNNER_TEST_PRIMARY_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$RUNNER_TEST_PRIMARY_COUNT"
printf '%s\n' '{"type":"step_start","part":{"type":"tool","tool":"bash","input":{"command":"gh issue view 18"}}}'
printf '%s\n' 'HTTP 429: provider rate limit reached' >&2
exit 1
PROLOG
  cat > "$backup" <<'PROLOG'
#!/usr/bin/env bash
count=0
[[ -r "$RUNNER_TEST_BACKUP_COUNT" ]] && count="$(<"$RUNNER_TEST_BACKUP_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$RUNNER_TEST_BACKUP_COUNT"
if [[ "$count" -eq 1 ]]; then
  printf '%s\n' '{"type":"text","sessionID":"","part":{"type":"text","text":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}}'
else
  printf '%s\n' '{"type":"text","sessionID":"","part":{"type":"text","text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}'
fi
PROLOG
  chmod +x "$primary" "$backup"

  write_opencode_profile_config "$config_path" "opencode-primary" \
    "opencode-primary=OpenCode Primary|opencode|${primary}|provider/primary|||high|true|[\"opencode-backup\"]" \
    "opencode-backup=OpenCode Backup|opencode|${backup}|provider/backup|||medium|true"

  RUNNER_TEST_PRIMARY_COUNT="$primary_count" \
  RUNNER_TEST_BACKUP_COUNT="$backup_count" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="1" \
  ISSUE_RUNNER_RETRY_LIMIT=2 \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Persistent OpenCode rate limiting did not reach the fallback profile'

  [[ "$(<"$primary_count")" -eq 2 ]] || \
    fail 'Rate-limited profile did not consume its bounded retry before fallback'
  [[ "$(<"$backup_count")" -eq 2 ]] || \
    fail 'Fallback profile did not complete the rate-limited issue and drain the queue'
  grep -Fq 'recovery_category=provider_rate_limit' "$output" || \
    fail 'Rate-limit retry did not retain its provider failure category'
  grep -Fq 'Advancing OpenCode fallback: opencode-primary -> opencode-backup' "$output" || \
    fail 'Persistent rate limiting did not advance the fallback chain'

  pass 'persistent OpenCode rate limiting retries before consuming a fallback'
}

test_black_box_opencode_model_unavailable_launches_constrained_fresh_fallback() {
  local repo="${TEST_ROOT}/opencode-model-fallback-repo"
  local primary="${TEST_ROOT}/opencode-model-primary"
  local backup="${TEST_ROOT}/opencode-model-backup"
  local backup_count="${TEST_ROOT}/opencode-model-backup-count"
  local args_file="${TEST_ROOT}/opencode-model-backup-args"
  local config_path="${TEST_ROOT}/opencode-model-fallback-config.toml"
  local output="${TEST_ROOT}/opencode-model-fallback-output.log"

  new_repo "$repo"
  cat > "$primary" <<'PROLOG'
#!/usr/bin/env bash
printf '%s\n' '{"type":"step_start","part":{"type":"tool","tool":"bash","input":{"command":"gh issue view 18"}}}'
printf '%s\n' 'requested model provider/primary is unavailable' >&2
exit 1
PROLOG
  cat > "$backup" <<'PROLOG'
#!/usr/bin/env bash
count=0
[[ -r "$RUNNER_TEST_BACKUP_COUNT" ]] && count="$(<"$RUNNER_TEST_BACKUP_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$RUNNER_TEST_BACKUP_COUNT"
for arg in "$@"; do printf '%s\n' "$arg" >> "$RUNNER_TEST_ARGS_FILE"; done
printf '%s\n' 'EOF' >> "$RUNNER_TEST_ARGS_FILE"
if [[ "$count" -eq 1 ]]; then
  printf '%s\n' '{"type":"text","sessionID":"","part":{"type":"text","text":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}}'
else
  printf '%s\n' '{"type":"text","sessionID":"","part":{"type":"text","text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}'
fi
PROLOG
  chmod +x "$primary" "$backup"

  write_opencode_profile_config "$config_path" "opencode-primary" \
    "opencode-primary=OpenCode Primary|opencode|${primary}|provider/primary|||high|true|[\"opencode-backup\"]" \
    "opencode-backup=OpenCode Backup|opencode|${backup}|provider/backup|||medium|true"

  RUNNER_TEST_BACKUP_COUNT="$backup_count" \
  RUNNER_TEST_ARGS_FILE="$args_file" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Model-unavailable failure did not launch a fresh fallback worker'

  if grep -Fxq -- '--session' "$args_file"; then
    fail 'Fallback without a captured session attempted unsafe session continuation'
  fi
  grep -Fq 'Continue exactly issue #18; do not select or inspect another issue.' "$args_file" || \
    fail 'Fresh fallback prompt was not constrained to the identified issue'
  grep -Fq 'provider_model_unavailable' "$output" || \
    fail 'Model-unavailable transition did not retain its failure classification'

  pass 'model unavailability launches a fresh fallback constrained to the same issue'
}

test_black_box_opencode_excluded_failures_never_consume_fallbacks() {
  local kind expected repo primary backup marker config_path output status

  for kind in context network worker malformed blocked failed implementation; do
    repo="${TEST_ROOT}/opencode-excluded-${kind}-repo"
    primary="${TEST_ROOT}/opencode-excluded-${kind}-primary"
    backup="${TEST_ROOT}/opencode-excluded-${kind}-backup"
    marker="${TEST_ROOT}/opencode-excluded-${kind}-backup-ran"
    config_path="${TEST_ROOT}/opencode-excluded-${kind}-config.toml"
    output="${TEST_ROOT}/opencode-excluded-${kind}-output.log"

    new_repo "$repo"
    cat > "$primary" <<'PROLOG'
#!/usr/bin/env bash
printf '%s\n' '{"type":"step_start","part":{"type":"tool","tool":"bash","input":{"command":"gh issue view 18"}}}'
case "$RUNNER_TEST_FAILURE_KIND" in
  context) printf '%s\n' 'context window exhausted'; exit 1 ;;
  network) printf '%s\n' 'connection reset by peer'; exit 1 ;;
  worker) printf '%s\n' 'worker process crashed unexpectedly'; exit 7 ;;
  malformed) printf '%s\n' '{"type":"text","part":{"text":"finished without status"}}'; exit 0 ;;
  blocked) printf '%s\n' '{"type":"text","part":{"text":"ISSUE_KILLER_STATUS=BLOCKED\n"}}'; exit 0 ;;
  failed) printf '%s\n' '{"type":"text","part":{"text":"ISSUE_KILLER_STATUS=FAILED\n"}}'; exit 0 ;;
  implementation) printf '%s\n' 'implementation failed because tests did not pass'; exit 1 ;;
esac
PROLOG
    printf '%s\n' '#!/usr/bin/env bash' "touch '${marker}'" > "$backup"
    chmod +x "$primary" "$backup"

    write_opencode_profile_config "$config_path" "opencode-primary" \
      "opencode-primary=OpenCode Primary|opencode|${primary}|provider/primary|||high|true|[\"opencode-backup\"]" \
      "opencode-backup=OpenCode Backup|opencode|${backup}|provider/backup|||medium|true"

    case "$kind" in
      network) expected=4 ;;
      blocked) expected=2 ;;
      *) expected=1 ;;
    esac

    set +e
    RUNNER_TEST_FAILURE_KIND="$kind" \
    ISSUE_RUNNER_ASSUME_YES=true \
    ISSUE_RUNNER_RETRY_LIMIT=1 \
    ISSUE_RUNNER_RETRY_DELAYS="1" \
    ISSUE_KILLER_CONFIG_PATH="$config_path" \
      "$RUNNER" "$repo" >"$output" 2>&1
    status=$?
    set -e

    [[ "$status" -eq "$expected" ]] || \
      fail "Excluded ${kind} failure exited ${status}, expected ${expected}"
    [[ ! -e "$marker" ]] || \
      fail "Excluded ${kind} failure consumed an OpenCode fallback"
  done

  pass 'context, network, worker, malformed, BLOCKED, FAILED, and implementation failures never consume fallbacks'
}

test_black_box_opencode_fallback_exhaustion_retains_recovery_checkpoint() {
  local repo="${TEST_ROOT}/opencode-fallback-exhausted-repo"
  local primary="${TEST_ROOT}/opencode-fallback-exhausted-primary"
  local backup="${TEST_ROOT}/opencode-fallback-exhausted-backup"
  local primary_count="${TEST_ROOT}/opencode-fallback-exhausted-primary-count"
  local backup_count="${TEST_ROOT}/opencode-fallback-exhausted-backup-count"
  local config_path="${TEST_ROOT}/opencode-fallback-exhausted-config.toml"
  local output="${TEST_ROOT}/opencode-fallback-exhausted-output.log"
  local checkpoint status

  new_repo "$repo"
  cat > "$primary" <<'PROLOG'
#!/usr/bin/env bash
count=0
[[ -r "$RUNNER_TEST_PRIMARY_COUNT" ]] && count="$(<"$RUNNER_TEST_PRIMARY_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$RUNNER_TEST_PRIMARY_COUNT"
printf '%s\n' '{"type":"step_start","part":{"type":"tool","tool":"bash","input":{"command":"gh issue view 18"}}}'
printf '%s\n' 'Authorization: Bearer ghp_fallback_secret subscription quota exhausted for provider primary' >&2
exit 1
PROLOG
  cat > "$backup" <<'PROLOG'
#!/usr/bin/env bash
count=0
[[ -r "$RUNNER_TEST_BACKUP_COUNT" ]] && count="$(<"$RUNNER_TEST_BACKUP_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$RUNNER_TEST_BACKUP_COUNT"
printf '%s\n' 'insufficient_quota for provider backup' >&2
exit 1
PROLOG
  chmod +x "$primary" "$backup"

  write_opencode_profile_config "$config_path" "opencode-primary" \
    "opencode-primary=OpenCode Primary|opencode|${primary}|provider/primary|||high|true|[\"opencode-backup\"]" \
    "opencode-backup=OpenCode Backup|opencode|${backup}|provider/backup|||medium|true"

  set +e
  RUNNER_TEST_PRIMARY_COUNT="$primary_count" \
  RUNNER_TEST_BACKUP_COUNT="$backup_count" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 4 ]] || \
    fail "Exhausted OpenCode fallback chain must exit 4, got ${status}"
  [[ "$(<"$primary_count")" -eq 1 && "$(<"$backup_count")" -eq 1 ]] || \
    fail 'Fallback exhaustion launched a profile more than once or advanced the queue'
  checkpoint="${repo}/.git/claude-minimax-issue-runner.checkpoint"
  grep -Eq '^profile=opencode-backup$' "$checkpoint" || \
    fail 'Exhausted checkpoint did not retain the active fallback profile'
  grep -Eq '^selected_profile=opencode-primary$' "$checkpoint" || \
    fail 'Exhausted checkpoint did not retain the original selected profile'
  grep -Eq '^fallback_position=1$' "$checkpoint" || \
    fail 'Exhausted checkpoint did not retain the fallback position'
  grep -Eq '^failed_profile=opencode-backup$' "$checkpoint" || \
    fail 'Exhausted checkpoint did not retain the final failed profile'
  grep -Eq '^fallback_failure=provider_quota$' "$checkpoint" || \
    fail 'Exhausted checkpoint did not retain the provider failure classification'
  grep -Eq '^state=fallback_exhausted$' "$checkpoint" || \
    fail 'Exhausted checkpoint did not retain its recoverable lifecycle state'
  if grep -Eqi 'authorization|ghp_fallback_secret' "$checkpoint"; then
    fail 'Fallback checkpoint persisted credentials from provider diagnostics'
  fi
  grep -Fq 'RECOVERY_REQUIRED' "$output" || \
    fail 'Fallback exhaustion did not emit RECOVERY_REQUIRED diagnostics'

  pass 'fallback exhaustion retains non-secret diagnostics and never advances the queue'
}

test_black_box_opencode_restart_restores_active_fallback_position() {
  local repo="${TEST_ROOT}/opencode-fallback-restart-repo"
  local primary="${TEST_ROOT}/opencode-fallback-restart-primary"
  local backup="${TEST_ROOT}/opencode-fallback-restart-backup"
  local primary_count="${TEST_ROOT}/opencode-fallback-restart-primary-count"
  local backup_count="${TEST_ROOT}/opencode-fallback-restart-backup-count"
  local dirty_file="${repo}/partial-fallback-work.txt"
  local config_path="${TEST_ROOT}/opencode-fallback-restart-config.toml"
  local first_output="${TEST_ROOT}/opencode-fallback-restart-first.log"
  local expect_script="${TEST_ROOT}/opencode-fallback-restart.expect"
  local restart_output="${TEST_ROOT}/opencode-fallback-restart-second.log"
  local status

  new_repo "$repo"
  cat > "$primary" <<'PROLOG'
#!/usr/bin/env bash
count=0
[[ -r "$RUNNER_TEST_PRIMARY_COUNT" ]] && count="$(<"$RUNNER_TEST_PRIMARY_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$RUNNER_TEST_PRIMARY_COUNT"
printf '%s\n' '{"type":"session","sessionID":"sess-restart-fallback-18"}'
printf '%s\n' '{"type":"step_start","part":{"type":"tool","tool":"bash","input":{"command":"gh issue view 18"}}}'
printf '%s\n' 'subscription quota exhausted for primary' >&2
exit 1
PROLOG
  cat > "$backup" <<'PROLOG'
#!/usr/bin/env bash
count=0
[[ -r "$RUNNER_TEST_BACKUP_COUNT" ]] && count="$(<"$RUNNER_TEST_BACKUP_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$RUNNER_TEST_BACKUP_COUNT"
case "$count" in
  1)
    printf '%s\n' 'partial work' > "$RUNNER_TEST_DIRTY_FILE"
    printf '%s\n' '{"type":"text","sessionID":"sess-restart-fallback-18","part":{"type":"text","text":"ISSUE_KILLER_STATUS=FAILED\n"}}'
    ;;
  2)
    rm -f "$RUNNER_TEST_DIRTY_FILE"
    printf '%s\n' '{"type":"text","sessionID":"sess-restart-fallback-18","part":{"type":"text","text":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}}'
    ;;
  *)
    printf '%s\n' '{"type":"text","sessionID":"","part":{"type":"text","text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}'
    ;;
esac
PROLOG
  chmod +x "$primary" "$backup"

  write_opencode_profile_config "$config_path" "opencode-primary" \
    "opencode-primary=OpenCode Primary|opencode|${primary}|provider/primary|||high|true|[\"opencode-backup\", \"opencode-tertiary\"]" \
    "opencode-backup=OpenCode Backup|opencode|${backup}|provider/backup|||medium|true" \
    "opencode-tertiary=OpenCode Tertiary|opencode|${backup}|provider/tertiary|||low|true"

  set +e
  RUNNER_TEST_PRIMARY_COUNT="$primary_count" \
  RUNNER_TEST_BACKUP_COUNT="$backup_count" \
  RUNNER_TEST_DIRTY_FILE="$dirty_file" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$first_output" 2>&1
  status=$?
  set -e
  [[ "$status" -eq 1 ]] || \
    fail "Initial fallback interruption must exit 1, got ${status}"
  [[ -e "$dirty_file" ]] || \
    fail 'Initial fallback interruption did not leave recoverable dirty work'

  cat > "$expect_script" <<PROLOG
set timeout 20
log_user 1
set fallback_prompt 0
spawn env PATH=$PATH RUNNER_TEST_PRIMARY_COUNT=$primary_count RUNNER_TEST_BACKUP_COUNT=$backup_count RUNNER_TEST_DIRTY_FILE=$dirty_file ISSUE_RUNNER_ASSUME_YES=true ISSUE_KILLER_CONFIG_PATH=$config_path $RUNNER "$repo"
expect {
  -re {Profile \\[2\\]:} {
    send "\r"
    exp_continue
  }
  -re {Fallback \\[0\\]:} {
    incr fallback_prompt
    send "1\r"
    exp_continue
  }
  -re {Recover issue 18.*Continue\\? \\[y/N\\]} {
    send "y\r"
    exp_continue
  }
  eof
}
PROLOG

  expect "$expect_script" >"$restart_output" 2>&1 || \
    fail 'Restart recovery did not complete the checkpointed fallback issue'

  [[ "$(<"$primary_count")" -eq 1 ]] || \
    fail 'Restart recovery silently returned to the original failed profile'
  [[ "$(<"$backup_count")" -eq 3 ]] || \
    fail 'Restart recovery did not reuse the active fallback and then verify the queue'
  [[ ! -e "$dirty_file" ]] || \
    fail 'Restart recovery did not preserve and complete the dirty fallback work'
  grep -Fq 'Restored OpenCode fallback checkpoint at position 1 with profile opencode-backup' "$restart_output" || \
    fail 'Restart did not report the restored active fallback position'
  grep -Fq 'resuming Claude session sess-restart-fallback-18' "$restart_output" || \
    fail 'Restart did not preserve the compatible session identity on the fallback profile'

  pass 'restart recovery restores the active OpenCode profile, position, remaining chain, and session'
}

test_black_box_opencode_prior_provider_error_does_not_reclassify_fallback_failure() {
  local repo="${TEST_ROOT}/opencode-fallback-reclassification-repo"
  local primary="${TEST_ROOT}/opencode-fallback-reclassification-primary"
  local backup="${TEST_ROOT}/opencode-fallback-reclassification-backup"
  local tertiary="${TEST_ROOT}/opencode-fallback-reclassification-tertiary"
  local tertiary_marker="${TEST_ROOT}/opencode-fallback-reclassification-tertiary-ran"
  local config_path="${TEST_ROOT}/opencode-fallback-reclassification-config.toml"
  local output="${TEST_ROOT}/opencode-fallback-reclassification-output.log"
  local status

  new_repo "$repo"
  cat > "$primary" <<'PROLOG'
#!/usr/bin/env bash
printf '%s\n' '{"type":"step_start","part":{"type":"tool","tool":"bash","input":{"command":"gh issue view 18"}}}'
printf '%s\n' 'subscription quota exhausted for primary' >&2
exit 1
PROLOG
  printf '%s\n' '#!/usr/bin/env bash' \
    'printf "%s\n" "implementation failed because verification broke" >&2' \
    'exit 1' > "$backup"
  printf '%s\n' '#!/usr/bin/env bash' \
    "touch '${tertiary_marker}'" \
    'printf "%s\n" '\''{"type":"text","part":{"text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\\n"}}'\''' > "$tertiary"
  chmod +x "$primary" "$backup" "$tertiary"

  write_opencode_profile_config "$config_path" "opencode-primary" \
    "opencode-primary=OpenCode Primary|opencode|${primary}|provider/primary|||high|true|[\"opencode-backup\", \"opencode-tertiary\"]" \
    "opencode-backup=OpenCode Backup|opencode|${backup}|provider/backup|||medium|true" \
    "opencode-tertiary=OpenCode Tertiary|opencode|${tertiary}|provider/tertiary|||low|true"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 1 ]] || \
    fail "Fallback implementation failure must exit 1, got ${status}"
  [[ ! -e "$tertiary_marker" ]] || \
    fail 'A prior provider error reclassified a fallback implementation failure'

  pass 'provider classification is scoped to the current attempt after fallback'
}

test_black_box_opencode_profile_invokes_opencode_run_with_expected_args() {
  local repo="${TEST_ROOT}/opencode-args-repo"
  local fake="${TEST_ROOT}/opencode-args-worker"
  local args_file="${TEST_ROOT}/opencode-args-recorded"
  local config_path="${TEST_ROOT}/opencode-args-config.toml"
  local output="${TEST_ROOT}/opencode-args-output.log"

  new_repo "$repo"
  cat > "$fake" <<PROLOG
#!/usr/bin/env bash
: > "\$RUNNER_TEST_ARGS_FILE"
for arg in "\$@"; do
  printf '%s\n' "\$arg" >> "\$RUNNER_TEST_ARGS_FILE"
done
printf '%s\n' '{"type":"text","sessionID":"","part":{"type":"text","text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}'
PROLOG
  chmod +x "$fake"

  write_opencode_profile_config "$config_path" "opencode-luna" \
    "opencode-luna=OpenCode Luna|opencode|${fake}|openai/gpt-5-luna|||high|true"

  RUNNER_TEST_ARGS_FILE="$args_file" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Black-box OpenCode profile did not finish its first attempt'

  # `opencode run` is the canonical subcommand. The adapter must not
  # pass arbitrary free-form shell expressions; the args list must
  # enumerate the documented flags.
  grep -Fxq -- 'run' "$args_file" || \
    fail 'OpenCode adapter did not invoke the `run` subcommand'
  grep -Fxq -- '--format' "$args_file" || \
    fail 'OpenCode adapter did not request a structured output format'
  grep -Fxq -- 'json' "$args_file" || \
    fail 'OpenCode adapter did not request the JSON output format'
  grep -Fxq -- '--model' "$args_file" || \
    fail 'OpenCode adapter did not pass the model flag'
  grep -Fxq -- 'openai/gpt-5-luna' "$args_file" || \
    fail 'OpenCode adapter did not pass the configured provider/model identifier'
  grep -Fxq -- '--variant' "$args_file" || \
    fail 'OpenCode adapter did not pass the variant flag'
  grep -Fxq -- 'high' "$args_file" || \
    fail 'OpenCode adapter did not pass the configured variant value'
  grep -Fxq -- '--auto-approve' "$args_file" || \
    fail 'OpenCode adapter did not enable auto-approve when configured'

  pass 'opencode profile invokes opencode run with --format json, --model provider/model, --variant, and --auto-approve'
}

test_black_box_opencode_profile_decodes_json_progress_events() {
  local repo="${TEST_ROOT}/opencode-progress-repo"
  local fake="${TEST_ROOT}/opencode-progress-worker"
  local counter="${TEST_ROOT}/opencode-progress-counter"
  local config_path="${TEST_ROOT}/opencode-progress-config.toml"
  local output="${TEST_ROOT}/opencode-progress-output.log"

  new_repo "$repo"
  cat > "$fake" <<'PROLOG'
#!/usr/bin/env bash
counter="$RUNNER_TEST_COUNTER_FILE"
iteration=0
if [[ -r "$counter" ]]; then
  iteration="$(<"$counter")"
fi
iteration=$((iteration + 1))
printf '%s' "$iteration" > "$counter"
if [[ "$iteration" -gt 1 ]]; then
  printf '%s\n' '{"type":"text","sessionID":"","part":{"type":"text","text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}'
  exit 0
fi
printf '%s\n' '{"type":"session","sessionID":"sess-opencode-001"}'
printf '%s\n' '{"type":"step_start","part":{"type":"tool","tool":"bash","input":{"command":"ls -la"}}}'
printf '%s\n' '{"type":"step_finish","part":{"type":"tool","tool":"edit","input":{"filePath":"agent/run.sh"}}}'
printf '%s\n' '{"type":"step_start","part":{"type":"tool","tool":"bash","input":{"command":"git push origin issue-15"}}}'
printf '%s\n' '{"type":"text","sessionID":"sess-opencode-001","part":{"type":"text","text":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}}'
PROLOG
  chmod +x "$fake"

  write_opencode_profile_config "$config_path" "opencode-luna" \
    "opencode-luna=OpenCode Luna|opencode|${fake}|openai/gpt-5-luna|||medium|false"

  RUNNER_TEST_COUNTER_FILE="$counter" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Black-box OpenCode progress did not complete the issue'

  grep -Fq 'Running shell command' "$output" || \
    fail 'OpenCode JSON did not surface a shell command event'
  grep -Fq 'Editing agent/run.sh' "$output" || \
    fail 'OpenCode JSON did not surface an edit event'
  grep -Fq 'Pushing branch' "$output" || \
    fail 'OpenCode JSON did not surface a `git push` event'
  grep -Fq 'Worker 1 completed one issue.' "$output" || \
    fail 'OpenCode worker did not report the issue as completed'

  pass 'opencode JSON events translate into the same normalized progress as Claude'
}

test_black_box_opencode_profile_captures_session_id() {
  local repo="${TEST_ROOT}/opencode-session-repo"
  local fake="${TEST_ROOT}/opencode-session-worker"
  local counter="${TEST_ROOT}/opencode-session-counter"
  local config_path="${TEST_ROOT}/opencode-session-config.toml"
  local output="${TEST_ROOT}/opencode-session-output.log"

  new_repo "$repo"
  cat > "$fake" <<'PROLOG'
#!/usr/bin/env bash
counter="$RUNNER_TEST_COUNTER_FILE"
iteration=0
if [[ -r "$counter" ]]; then
  iteration="$(<"$counter")"
fi
iteration=$((iteration + 1))
printf '%s' "$iteration" > "$counter"
if [[ "$iteration" -gt 1 ]]; then
  printf '%s\n' '{"type":"text","sessionID":"","part":{"type":"text","text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}'
  exit 0
fi
printf '%s\n' '{"type":"session","sessionID":"sess-opencode-capture"}'
# Emit FAILED so the orchestrator preserves the checkpoint that
# records the captured session id. The test inspects the checkpoint
# to verify the runtime adapter wrote the session id into the
# recovery record before the FAILED terminal state.
printf '%s\n' '{"type":"text","sessionID":"sess-opencode-capture","part":{"type":"text","text":"ISSUE_KILLER_STATUS=FAILED\n"}}'
PROLOG
  chmod +x "$fake"

  write_opencode_profile_config "$config_path" "opencode-luna" \
    "opencode-luna=OpenCode Luna|opencode|${fake}|openai/gpt-5-luna|||medium|false"

  set +e
  RUNNER_TEST_COUNTER_FILE="$counter" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1
  set -e

  # The orchestrator records the captured session id into the
  # checkpoint when the worker emits a session event. FAILED
  # preserves the checkpoint so the runtime observable is durable.
  checkpoint="${repo}/.git/claude-minimax-issue-runner.checkpoint"
  grep -Eq '^session_id=sess-opencode-capture' "$checkpoint" || \
    fail 'OpenCode adapter did not capture the session id from the session event'
  grep -Eq '^cli=opencode' "$checkpoint" || \
    fail 'OpenCode checkpoint did not record the opencode CLI identity'

  pass 'opencode adapter captures the session id and records it on the checkpoint'
}

test_opencode_profile_validation_rejects_unknown_options() {
  local adapter="${ROOT_DIR}/agent/claude-minimax-issue-runner/runtime/opencode-adapter.sh"

  set +e
  RUNNER_NAME="claude-minimax-issue-runner" \
  bash -c "source '${adapter}' && opencode_runtime_validate_profile 'unknown_option=1'" \
    >"$TEST_ROOT/opencode-validate-unknown.out" \
    2>"$TEST_ROOT/opencode-validate-unknown.err"
  local rc=$?
  set -e

  [[ "$rc" -ne 0 ]] || fail 'Unknown OpenCode option must fail validation'
  grep -Fq 'unknown option' "$TEST_ROOT/opencode-validate-unknown.err" || \
    fail 'Validation diagnostic did not name the unknown option'

  pass 'opencode profile validation rejects unknown options'
}

test_opencode_profile_validation_rejects_invalid_variant() {
  local adapter="${ROOT_DIR}/agent/claude-minimax-issue-runner/runtime/opencode-adapter.sh"

  set +e
  RUNNER_NAME="claude-minimax-issue-runner" \
  bash -c "source '${adapter}' && opencode_runtime_validate_profile 'variant=banana'" \
    >"$TEST_ROOT/opencode-validate-variant.out" \
    2>"$TEST_ROOT/opencode-validate-variant.err"
  local rc=$?
  set -e

  [[ "$rc" -ne 0 ]] || fail 'Invalid OpenCode variant must fail validation'
  grep -Fq 'invalid variant' "$TEST_ROOT/opencode-validate-variant.err" || \
    fail 'Variant validation diagnostic did not name the bad value'

  pass 'opencode profile validation rejects an unknown variant'
}

test_opencode_profile_validation_rejects_invalid_model_format() {
  local adapter="${ROOT_DIR}/agent/claude-minimax-issue-runner/runtime/opencode-adapter.sh"

  set +e
  RUNNER_NAME="claude-minimax-issue-runner" \
  ISSUE_KILLER_PROFILE_MODEL="not-a-provider-model" \
  bash -c "source '${adapter}' && opencode_runtime_validate_profile ''" \
    >"$TEST_ROOT/opencode-validate-model.out" \
    2>"$TEST_ROOT/opencode-validate-model.err"
  local rc=$?
  set -e

  [[ "$rc" -ne 0 ]] || fail 'Invalid OpenCode model format must fail validation'
  grep -Fq 'invalid model' "$TEST_ROOT/opencode-validate-model.err" || \
    fail 'Model validation diagnostic did not name the bad value'

  pass 'opencode profile validation rejects an invalid provider/model format'
}

test_black_box_opencode_profile_rejects_invalid_options_before_launch() {
  local repo="${TEST_ROOT}/opencode-bad-options-repo"
  local fake="${TEST_ROOT}/opencode-bad-options-worker"
  local marker="${TEST_ROOT}/opencode-bad-options-ran"
  local config_path="${TEST_ROOT}/opencode-bad-options-config.toml"
  local output="${TEST_ROOT}/opencode-bad-options-output.log"
  local status

  new_repo "$repo"
  printf '%s\n' '#!/usr/bin/env bash' "touch '${marker}'" > "$fake"
  chmod +x "$fake"

  cat > "$config_path" <<PROLOG
default_profile = "opencode-broken"

[profiles.opencode-broken]
label = "OpenCode Broken"
cli = "opencode"
command = "${fake}"
model = "openai/gpt-5-luna"

[profiles.opencode-broken.options]
variant = "not-a-variant"
PROLOG

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -ne 0 ]] || \
    fail 'Invalid OpenCode variant must reject the launch'
  [[ ! -e "$marker" ]] || \
    fail 'Worker was launched despite an invalid OpenCode variant'
  grep -Fq 'invalid variant' "$output" || \
    fail 'Runner did not surface the invalid-variant diagnostic'

  pass 'opencode profile with an invalid variant stops the run before worker launch'
}

test_black_box_opencode_profile_resumes_session_when_captured() {
  local repo="${TEST_ROOT}/opencode-resume-repo"
  local fake="${TEST_ROOT}/opencode-resume-worker"
  local counter="${TEST_ROOT}/opencode-resume-counter"
  local args_file="${TEST_ROOT}/opencode-resume-args"
  local config_path="${TEST_ROOT}/opencode-resume-config.toml"
  local output="${TEST_ROOT}/opencode-resume-output.log"

  new_repo "$repo"
  cat > "$fake" <<PROLOG
#!/usr/bin/env bash
counter_file="\$RUNNER_TEST_COUNTER_FILE"
attempt=0
if [[ -r "\$counter_file" ]]; then
  attempt="\$(<"\$counter_file")"
fi
attempt=\$((attempt + 1))
printf '%s' "\$attempt" > "\$counter_file"

for arg in "\$@"; do
  printf '%s\n' "\$arg" >> "\$RUNNER_TEST_ARGS_FILE"
done
printf '%s\n' 'EOF' >> "\$RUNNER_TEST_ARGS_FILE"

if [[ "\$attempt" -eq 1 ]]; then
  # First attempt: emit a captured session id, then a transient
  # transport failure so the orchestrator captures the session and
  # retries with --session on the next attempt.
  printf '%s\n' '{"type":"session","sessionID":"sess-resume-1"}'
  printf '%s\n' 'connection reset by peer' >&2
  exit 1
fi

if [[ "\$attempt" -eq 2 ]]; then
  # Resumed attempt: succeed with ISSUE_COMPLETED so the orchestrator
  # proceeds to the next queue iteration and we can assert that
  # --session was used.
  printf '%s\n' '{"type":"text","sessionID":"sess-resume-1","part":{"type":"text","text":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}}'
  exit 0
fi

# Subsequent attempts: report an empty queue so the orchestrator exits.
printf '%s\n' '{"type":"text","sessionID":"","part":{"type":"text","text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}'
PROLOG
  chmod +x "$fake"

  write_opencode_profile_config "$config_path" "opencode-luna" \
    "opencode-luna=OpenCode Luna|opencode|${fake}|openai/gpt-5-luna|||medium|false"

  RUNNER_TEST_ARGS_FILE="$args_file" \
  RUNNER_TEST_COUNTER_FILE="$counter" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="1,1,1" \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Black-box OpenCode resume did not finish its first attempt'

  grep -Fxq -- '--session' "$args_file" || \
    fail 'OpenCode adapter did not pass --session on a captured session'
  grep -Fxq -- 'sess-resume-1' "$args_file" || \
    fail 'OpenCode adapter did not pass the captured session id to --session'

  pass 'opencode adapter passes --session <session_id> when a session is safely captured'
}

test_black_box_opencode_profile_drains_queue_through_status_marker() {
  local repo="${TEST_ROOT}/opencode-drain-repo"
  local fake="${TEST_ROOT}/opencode-drain-worker"
  local counter="${TEST_ROOT}/opencode-drain-counter"
  local config_path="${TEST_ROOT}/opencode-drain-config.toml"
  local output="${TEST_ROOT}/opencode-drain-output.log"

  new_repo "$repo"
  cat > "$fake" <<'PROLOG'
#!/usr/bin/env bash
counter="$RUNNER_TEST_COUNTER_FILE"
iteration=0
if [[ -r "$counter" ]]; then
  iteration="$(<"$counter")"
fi
iteration=$((iteration + 1))
printf '%s' "$iteration" > "$counter"
if [[ "$iteration" -eq 1 ]]; then
  printf '%s\n' '{"type":"text","sessionID":"","part":{"type":"text","text":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}}'
  exit 0
fi
printf '%s\n' '{"type":"text","sessionID":"","part":{"type":"text","text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}'
PROLOG
  chmod +x "$fake"

  write_opencode_profile_config "$config_path" "opencode-luna" \
    "opencode-luna=OpenCode Luna|opencode|${fake}|openai/gpt-5-luna|||low|false"

  RUNNER_TEST_COUNTER_FILE="$counter" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'OpenCode queue drain did not exit cleanly'

  grep -Fq 'Worker 1 completed one issue.' "$output" || \
    fail 'OpenCode worker did not report the first issue as completed'
  grep -Fq 'No pending, available, non-epic issues remain.' "$output" || \
    fail 'OpenCode worker did not drain the queue'

  pass 'opencode profile drains a two-issue queue through the generic status marker'
}

test_default_profile_used_without_tty
test_missing_default_profile_rejects_non_tty
test_config_rejects_unknown_top_level_key
test_config_rejects_unknown_profile_field
test_checkpoint_records_profile_identity
test_checkpoint_enforces_profile_identity_on_recovery
test_destructive_confirmation_lists_profile_identity
test_black_box_claude_profile_completes_issue
test_profile_picker_lists_every_profile_with_footer
test_black_box_codex_profile_invokes_codex_exec_with_expected_args
test_black_box_codex_profile_decodes_jsonl_progress_events
test_black_box_codex_profile_captures_thread_id_from_session_event
test_codex_profile_validation_rejects_unknown_options
test_codex_profile_validation_rejects_invalid_sandbox
test_codex_profile_validation_rejects_auto_approve_with_read_only_sandbox
test_black_box_codex_profile_rejects_invalid_options_before_launch
test_black_box_codex_profile_resumes_thread_when_session_captured
test_black_box_codex_profile_drains_queue_through_status_marker
test_black_box_opencode_fallback_validation_rejects_missing_profile
test_black_box_opencode_fallback_validation_rejects_invalid_chains
test_tty_opencode_fallback_picker_builds_ordered_unique_chain
test_black_box_opencode_quota_failure_advances_fallback_with_same_session
test_black_box_opencode_rate_limit_retries_before_fallback
test_black_box_opencode_model_unavailable_launches_constrained_fresh_fallback
test_black_box_opencode_excluded_failures_never_consume_fallbacks
test_black_box_opencode_fallback_exhaustion_retains_recovery_checkpoint
test_black_box_opencode_restart_restores_active_fallback_position
test_black_box_opencode_prior_provider_error_does_not_reclassify_fallback_failure
test_black_box_opencode_profile_invokes_opencode_run_with_expected_args
test_black_box_opencode_profile_decodes_json_progress_events
test_black_box_opencode_profile_captures_session_id
test_opencode_profile_validation_rejects_unknown_options
test_opencode_profile_validation_rejects_invalid_variant
test_opencode_profile_validation_rejects_invalid_model_format
test_black_box_opencode_profile_rejects_invalid_options_before_launch
test_black_box_opencode_profile_resumes_session_when_captured
test_black_box_opencode_profile_drains_queue_through_status_marker

printf '%s Claude-MiniMax runner tests passed.\n' "$TESTS_RUN"
