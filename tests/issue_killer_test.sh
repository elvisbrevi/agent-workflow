#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="${ROOT_DIR}/agent/issue-killer/run.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/issue-killer-runner.XXXXXX")"
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

# Seeds a transcript file under the fake Claude config directory at
# the location the runtime adapter computes for the supplied session
# id. The harness sets `CLAUDE_CONFIG_DIR` for the worker; the test
# mirrors that here so the existence check sees a real transcript.
# Bash canonicalises `${PWD}` after `cd` (resolving `/var/folders` to
# `/private/var/folders` on macOS), and Claude stores transcripts
# under that resolved location, so the helper uses `pwd -P` against
# the same path the orchestrator will see.
seed_claude_transcript() {
  local home="$1"
  local repo="$2"
  local session_id="$3"
  local transcript
  local canonical_repo
  canonical_repo="$(cd "$repo" && pwd -P)"
  transcript="${home}/.claude/projects/$(printf '%s' "$canonical_repo" | sed 's|/|-|g')/${session_id}.jsonl"
  mkdir -p "$(dirname "$transcript")"
  printf '%s\n' '{"type":"user","message":{"role":"user","content":"seed"}}' > "$transcript"
  printf '%s\n' "$transcript"
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
  if grep -Fxq -- '--no-session-persistence' "$args_file"; then
    fail 'Fresh launch unexpectedly disabled session persistence'
  fi
  grep -Fxq -- 'bypassPermissions' "$args_file" || \
    fail 'Missing autonomous bypassPermissions mode'
  grep -Fq 'No pending, available, non-epic issues remain.' "$output" || \
    fail 'Runner did not report a drained queue'

  pass 'one fresh claude-minimax shell is launched per iteration'
}

test_unknown_status_stops_loop() {
  local repo="${TEST_ROOT}/unknown-repo"
  local fake="${TEST_ROOT}/issue-killer-no-status"
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
  local fake="${TEST_ROOT}/issue-killer-progress"
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
  local fake="${TEST_ROOT}/issue-killer-wait"
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
    "${repo}/.git/issue-killer.lock/status" || \
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
  [[ ! -e "${repo}/.git/issue-killer.lock" ]] || \
    fail 'Repository lock was not released when the runner exited'

  pass 'repository lock covers linked worktrees and exposes its status'
}

test_stale_repository_lock_is_recovered() {
  local repo="${TEST_ROOT}/stale-lock-repo"
  local fake="${TEST_ROOT}/issue-killer-stale-lock"
  local output="${TEST_ROOT}/stale-lock-output.log"
  local lock_dir

  new_repo "$repo"
  lock_dir="${repo}/.git/issue-killer.lock"
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

# Builds a provider CLI fixture from an exact JSONL event file. Every provider
# test feeds the same file to the executable and to the assertion helper, so
# payload fidelity is checked against the bytes parsed from the original
# provider events rather than against a provider-neutral reconstruction.
write_provider_native_stream_fixture() {
  local target="$1"

  cat > "$target" <<'PROLOG'
#!/usr/bin/env bash
counter="$RUNNER_TEST_COUNTER_FILE"
iteration=0
if [[ -r "$counter" ]]; then
  iteration="$(<"$counter")"
fi
iteration=$((iteration + 1))
printf '%s' "$iteration" > "$counter"

if [[ "$iteration" -gt 1 ]]; then
  printf '%s\n' "$RUNNER_TEST_EMPTY_EVENT"
  exit 0
fi

while IFS= read -r event || [[ -n "$event" ]]; do
  printf '%s\n' "$event"
done < "$RUNNER_TEST_EVENTS_FILE"
PROLOG
  chmod +x "$target"
}

# Verifies the public issue-killer stdout seam. Non-JSON runner diagnostics are
# intentionally ignored; every structured progress object from iteration one
# must have the exact public categories, complete provider events in provider
# order, the provider identity and iteration, an RFC 3339 UTC timestamp, and a
# generic status on the final event. Private normalized decoder tags must never
# substitute for the operator-facing category.
assert_provider_native_progress() {
  local output="$1"
  local cli="$2"
  local expected_events="$3"
  local actual_events="${expected_events}.actual"

  jq -Rrc 'fromjson? | select(type == "object" and has("category") and .iteration == 1)' \
    "$output" > "$actual_events"

  if ! jq -s -e --arg cli "$cli" --slurpfile expected "$expected_events" '
    def required_fields:
      has("category") and has("cli") and has("iteration") and
      has("timestamp") and has("event");
    def valid_timestamp:
      .timestamp | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$");
    def public_categories: [
      "Inspecting issue tracker",
      "Planning the next worker step",
      "Running shell command",
      "Pushing branch",
      "Committing changes",
      "Merging or rebasing branch",
      "Creating pull request",
      "Merging or closing pull request",
      "Closing issue",
      "Reviewing changes",
      "Worker finished"
    ];
    def private_tags: [
      "inspect", "mutate", "test", "push", "commit", "merge_rebase",
      "pr_create", "pr_close", "close", "review", "plan", "identify",
      "tracker", "shell", "unknown_tool"
    ];

    length == 11 and
    length == ($expected | length) and
    [.[].category] == public_categories and
    [.[].event] == $expected and
    all(.[];
      required_fields and .cli == $cli and .iteration == 1 and
      valid_timestamp and
      (.category as $category | private_tags | index($category) == null)
    ) and
    all(.[0:-1][]; has("status") | not) and
    (.[-1].status == "ISSUE_COMPLETED")
  ' "$actual_events" >/dev/null; then
    printf 'Expected provider events:\n' >&2
    jq -sc '.' "$expected_events" >&2
    printf 'Actual structured progress:\n' >&2
    jq -sc '.' "$actual_events" >&2
    fail "${cli} stream did not preserve the provider-native public JSON contract"
  fi
}

test_black_box_claude_stream_preserves_provider_native_json() {
  local repo="${TEST_ROOT}/claude-native-stream-repo"
  local fake="${TEST_ROOT}/claude-native-stream-worker"
  local counter="${TEST_ROOT}/claude-native-stream-counter"
  local events="${TEST_ROOT}/claude-native-stream-events.jsonl"
  local output="${TEST_ROOT}/claude-native-stream-output.log"

  new_repo "$repo"
  cat > "$events" <<'JSONL'
{"type":"assistant","provider_sequence":1,"message":{"role":"assistant","content":[{"type":"tool_use","id":"claude-1","name":"Bash","input":{"command":"gh issue list --state open","provider_secret":"claude-secret-1","nested":{"flags":["one","two"]}}}]}}
{"type":"assistant","provider_sequence":2,"message":{"role":"assistant","content":[{"type":"tool_use","id":"claude-2","name":"Task","input":{"description":"plan issue 23","metadata":{"provider":"claude"}}}]}}
{"type":"assistant","provider_sequence":3,"message":{"role":"assistant","content":[{"type":"tool_use","id":"claude-3","name":"Bash","input":{"command":"printf shell-command","timeout":17}}]}}
{"type":"assistant","provider_sequence":4,"message":{"role":"assistant","content":[{"type":"tool_use","id":"claude-4","name":"Bash","input":{"command":"git push origin issue-23","description":"push exact branch"}}]}}
{"type":"assistant","provider_sequence":5,"message":{"role":"assistant","content":[{"type":"tool_use","id":"claude-5","name":"Bash","input":{"command":"git commit -m 'test: provider native'","git":{"sign":false}}}]}}
{"type":"assistant","provider_sequence":6,"message":{"role":"assistant","content":[{"type":"tool_use","id":"claude-6","name":"Bash","input":{"command":"git rebase main","branch":"issue-23"}}]}}
{"type":"assistant","provider_sequence":7,"message":{"role":"assistant","content":[{"type":"tool_use","id":"claude-7","name":"Bash","input":{"command":"gh pr create --title native --body json","pull_request":{"draft":false}}}]}}
{"type":"assistant","provider_sequence":8,"message":{"role":"assistant","content":[{"type":"tool_use","id":"claude-8","name":"Bash","input":{"command":"gh pr merge 23 --squash","pull_request":{"number":23}}}]}}
{"type":"assistant","provider_sequence":9,"message":{"role":"assistant","content":[{"type":"tool_use","id":"claude-9","name":"Bash","input":{"command":"gh issue close 23","issue":{"number":23}}}]}}
{"type":"assistant","provider_sequence":10,"message":{"role":"assistant","content":[{"type":"tool_use","id":"claude-10","name":"Bash","input":{"command":"/code-review","review":{"mode":"full"}}}]}}
{"type":"result","subtype":"success","provider_sequence":11,"result":"completed with provider payload\nISSUE_KILLER_STATUS=ISSUE_COMPLETED\n","usage":{"input_tokens":101,"output_tokens":202},"provider_metadata":{"request_id":"claude-request-23"}}
JSONL
  write_provider_native_stream_fixture "$fake"

  RUNNER_TEST_COUNTER_FILE="$counter" \
  RUNNER_TEST_EVENTS_FILE="$events" \
  RUNNER_TEST_EMPTY_EVENT='{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}' \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Claude provider-native stream fixture did not drain the queue'

  assert_provider_native_progress "$output" "claude" "$events"
  grep -Fq 'Worker 1 completed one issue.' "$output" || \
    fail 'Claude final generic status did not complete the issue'

  pass 'claude stream preserves exact provider events, public categories, order, fields, and final status'
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
  jq -Rre 'fromjson? | select(
    .category == "Worker finished" and
    .cli == "claude" and
    .iteration == 1 and
    .status == "QUEUE_EMPTY" and
    .event.type == "result"
  )' "$output" >/dev/null || \
    fail 'Silent worker final event was not emitted as structured JSON'

  pass 'silent streaming workers emit heartbeats and structured final status'
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

RUNNER_NAME="issue-killer"

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
  local checkpoint_file status

  new_repo "$repo"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"

  # Issue identification precedes any Edit or git mutation. Keep the
  # checkpoint by ending in FAILED, then verify that the private identify
  # event recorded issue 42 before the public mutation event advanced state.
  write_stream_fixture "$fake" \
    '{"type":"assistant","provider_sequence":1,"message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"gh issue view 42"}}]}}' \
    '{"type":"assistant","provider_sequence":2,"message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"agent/run.sh"}}]}}' \
    '{"type":"assistant","provider_sequence":3,"message":{"role":"assistant","content":[{"type":"tool_use","id":"t3","name":"Bash","input":{"command":"git commit -m feat: implement"}}]}}' \
    '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=FAILED\n"}'

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 1 ]] || \
    fail "Identify-before-mutation fixture must retain a failed checkpoint, got exit ${status}"
  [[ -r "$checkpoint_file" ]] || \
    fail 'Identify-before-mutation fixture did not retain its checkpoint'
  grep -Eq '^issue=42$' "$checkpoint_file" || \
    fail 'Private identify event did not record issue 42 before mutation'
  jq -Rre 'fromjson? | select(
    .category == "Planning the next worker step" and
    .event.provider_sequence == 2 and
    .event.message.content[0].input.file_path == "agent/run.sh"
  )' "$output" >/dev/null || \
    fail 'First mutation was not surfaced through the provider-native JSON event'

  pass 'streamed worker records issue identity before provider-native mutation progress'
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

test_transcript_removed_on_issue_completed() {
  local repo="${TEST_ROOT}/remove-completed-repo"
  local home="${TEST_ROOT}/remove-completed-home"
  local fake="${TEST_ROOT}/claude-minimax-remove-completed"
  local output="${TEST_ROOT}/remove-completed-output.log"
  local session_id="sess-completed-77"
  local transcript

  mkdir -p "$home"
  new_repo "$repo"

  # The fixture emits a system init event so the renderer captures the
  # session id, then signals verified ISSUE_COMPLETED. On any later
  # iteration it emits verified QUEUE_EMPTY so the runner exits
  # naturally instead of looping forever on the same successful
  # outcome. The transcript seeded at the adapter-computed path lets
  # us verify removal alongside the cleared checkpoint.
  cat > "$fake" <<PROLOG
#!/usr/bin/env bash
iteration=1
name_next=0
for arg in "\$@"; do
  if [[ "\$name_next" == 1 ]]; then
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
  printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}'
  exit 0
fi
printf '%s\n' '{"type":"system","subtype":"init","session_id":"$session_id"}'
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"gh issue view 11"}}]}}'
printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}'
exit 0
PROLOG
  chmod +x "$fake"

  transcript="$(seed_claude_transcript "$home" "$repo" "$session_id")"

  HOME="$home" \
  CLAUDE_CONFIG_DIR="${home}/.claude" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Completed fixture did not finish'

  [[ ! -e "$transcript" ]] || \
    fail 'Session transcript was not removed after ISSUE_COMPLETED'

  pass 'verified ISSUE_COMPLETED removes the worker session transcript'
}

test_transcript_removed_on_queue_empty() {
  local repo="${TEST_ROOT}/remove-empty-repo"
  local home="${TEST_ROOT}/remove-empty-home"
  local fake="${TEST_ROOT}/claude-minimax-remove-empty"
  local output="${TEST_ROOT}/remove-empty-output.log"
  local session_id="sess-empty-77"
  local transcript

  mkdir -p "$home"
  new_repo "$repo"

  # The fixture emits a system init event so the renderer captures the
  # session id, then signals verified QUEUE_EMPTY. The transcript
  # seeded at the adapter-computed path proves the verified-empty
  # outcome is the second terminal state that triggers removal.
  cat > "$fake" <<PROLOG
#!/usr/bin/env bash
printf '%s\n' '{"type":"system","subtype":"init","session_id":"$session_id"}'
printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}'
exit 0
PROLOG
  chmod +x "$fake"

  transcript="$(seed_claude_transcript "$home" "$repo" "$session_id")"

  HOME="$home" \
  CLAUDE_CONFIG_DIR="${home}/.claude" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Empty queue fixture did not finish'

  [[ ! -e "$transcript" ]] || \
    fail 'Session transcript was not removed after QUEUE_EMPTY'

  pass 'verified QUEUE_EMPTY removes the worker session transcript'
}

test_transcript_retained_on_blocked_outcome() {
  local repo="${TEST_ROOT}/retain-blocked-transcript-repo"
  local home="${TEST_ROOT}/retain-blocked-transcript-home"
  local fake="${TEST_ROOT}/claude-minimax-retain-blocked-transcript"
  local output="${TEST_ROOT}/retain-blocked-transcript-output.log"
  local session_id="sess-blocked-77"
  local transcript

  mkdir -p "$home"
  new_repo "$repo"

  # The fixture emits a system init event then BLOCKED. Evidence
  # retention on a non-terminal outcome is the whole point of the
  # bug fix; the transcript must survive alongside the retained
  # checkpoint so the operator can diagnose what blocked the worker.
  cat > "$fake" <<PROLOG
#!/usr/bin/env bash
printf '%s\n' '{"type":"system","subtype":"init","session_id":"$session_id"}'
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"gh issue view 21"}}]}}'
printf '%s\n' '{"type":"result","subtype":"success","result":"need human input\nISSUE_KILLER_STATUS=BLOCKED\n"}'
exit 0
PROLOG
  chmod +x "$fake"

  transcript="$(seed_claude_transcript "$home" "$repo" "$session_id")"

  set +e
  HOME="$home" \
  CLAUDE_CONFIG_DIR="${home}/.claude" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo" >"$output" 2>&1
  local status=$?
  set -e

  [[ "$status" -eq 2 ]] || fail "BLOCKED must exit 2, got ${status}"
  [[ -e "$transcript" ]] || \
    fail 'Session transcript was unexpectedly removed after BLOCKED'

  pass 'BLOCKED outcome retains the worker session transcript'
}

test_transcript_retained_on_failed_outcome() {
  local repo="${TEST_ROOT}/retain-failed-transcript-repo"
  local home="${TEST_ROOT}/retain-failed-transcript-home"
  local fake="${TEST_ROOT}/claude-minimax-retain-failed-transcript"
  local output="${TEST_ROOT}/retain-failed-transcript-output.log"
  local session_id="sess-failed-77"
  local transcript

  mkdir -p "$home"
  new_repo "$repo"

  # The fixture emits a system init event then FAILED. The transcript
  # must survive so the operator can read what the worker did before
  # reporting failure.
  cat > "$fake" <<PROLOG
#!/usr/bin/env bash
printf '%s\n' '{"type":"system","subtype":"init","session_id":"$session_id"}'
printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=FAILED\n"}'
exit 0
PROLOG
  chmod +x "$fake"

  transcript="$(seed_claude_transcript "$home" "$repo" "$session_id")"

  set +e
  HOME="$home" \
  CLAUDE_CONFIG_DIR="${home}/.claude" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo" >"$output" 2>&1
  local status=$?
  set -e

  [[ "$status" -eq 1 ]] || fail "FAILED must exit 1, got ${status}"
  [[ -e "$transcript" ]] || \
    fail 'Session transcript was unexpectedly removed after FAILED'

  pass 'FAILED outcome retains the worker session transcript'
}

test_transcript_retained_on_recovery_required_outcome() {
  local repo="${TEST_ROOT}/retain-recovery-transcript-repo"
  local home="${TEST_ROOT}/retain-recovery-transcript-home"
  local fake="${TEST_ROOT}/claude-minimax-retain-recovery-transcript"
  local output="${TEST_ROOT}/retain-recovery-transcript-output.log"
  local session_id="sess-recovery-77"
  local transcript

  mkdir -p "$home"
  new_repo "$repo"

  # A worker that exits non-zero on every invocation drives the
  # runner into RECOVERY_REQUIRED (exit 4). The transcript must
  # survive so a future recovery attempt can diagnose what went
  # wrong.
  cat > "$fake" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-recovery-77"}'
exit 7
EOF
  chmod +x "$fake"

  transcript="$(seed_claude_transcript "$home" "$repo" "$session_id")"

  set +e
  HOME="$home" \
  CLAUDE_CONFIG_DIR="${home}/.claude" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_LIMIT=1 \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo" >"$output" 2>&1
  local status=$?
  set -e

  [[ "$status" -eq 1 ]] || fail "Worker exit must surface as FAILED exit 1, got ${status}"
  [[ -e "$transcript" ]] || \
    fail 'Session transcript was unexpectedly removed after a non-terminal outcome'

  pass 'non-terminal outcome retains the worker session transcript'
}

test_transcript_removal_failure_does_not_fail_run() {
  local repo="${TEST_ROOT}/removal-failure-repo"
  local home="${TEST_ROOT}/removal-failure-home"
  local fake="${TEST_ROOT}/claude-minimax-removal-failure"
  local output="${TEST_ROOT}/removal-failure-output.log"
  local session_id="sess-removal-failure"
  local transcript_dir
  local transcript

  mkdir -p "$home"
  new_repo "$repo"

  # The fixture emits a system init event then ISSUE_COMPLETED. The
  # transcript seeded here points at a real file so the adapter's
  # transcript-path resolution succeeds; the file is then made
  # un-removable by pointing its parent directory at a read-only
  # path (the directory is removed and recreated without write
  # permission for the runner user). On later iterations the
  # fixture emits verified QUEUE_EMPTY so the runner exits
  # naturally after the first completion instead of looping.
  cat > "$fake" <<PROLOG
#!/usr/bin/env bash
iteration=1
name_next=0
for arg in "\$@"; do
  if [[ "\$name_next" == 1 ]]; then
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
  printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}'
  exit 0
fi
printf '%s\n' '{"type":"system","subtype":"init","session_id":"$session_id"}'
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"gh issue view 11"}}]}}'
printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}'
exit 0
PROLOG
  chmod +x "$fake"

  transcript="$(seed_claude_transcript "$home" "$repo" "$session_id")"
  transcript_dir="$(dirname "$transcript")"

  # Remove write permission from the directory after seeding so the
  # runner cannot delete the transcript file inside it. The runner
  # must still clear the checkpoint and exit 0; a removal failure
  # cannot abort the run.
  chmod -w "$transcript_dir"

  set +e
  HOME="$home" \
  CLAUDE_CONFIG_DIR="${home}/.claude" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo" >"$output" 2>&1
  local status=$?
  set -e

  chmod u+w "$transcript_dir"

  [[ "$status" -eq 0 ]] || \
    fail "Removal failure must not abort the run, got status ${status}"

  pass 'transcript removal failure does not fail the run'
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

  # The migrated-checkpoint adoption path now requires operator
  # confirmation (issue #55), so the test must drive the TTY prompt
  # via expect, the same way the confirmed recovery tests do.
  run_with_recovery_confirmation "$output" \
    env PATH="${TEST_BIN}:$PATH" \
    ISSUE_RUNNER_ASSUME_YES=true \
    ISSUE_RUNNER_RETRY_DELAYS="1,1,1" \
    ISSUE_RUNNER_PROGRESS_INTERVAL=0 \
    ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo"

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
  # The existence check now gates resume; seed a real transcript under
  # the fake Claude config dir so the resume path is genuinely verified
  # rather than passing against a session that does not exist.
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

  # Seed a real transcript file under the fake Claude config directory
  # so the runtime adapter's existence check verifies resume rather
  # than passing against a missing file. The captured session id is
  # `sess-shell-resume-xyz` because attempt 1 emits a system init event
  # with that id; the orchestrator persists it as CHECKPOINT_SESSION_ID
  # and uses it for the resume on attempt 2.
  seed_claude_transcript "$home" "$repo" "sess-shell-resume-xyz" >/dev/null

  write_default_config "${TEST_ROOT}/resume-config.toml" "claude-minimax" "bash" "${home}/.bashrc"

  # The migrated-checkpoint adoption path now requires operator
  # confirmation (issue #55), so the test must drive the TTY prompt
  # via expect, the same way the confirmed recovery tests do.
  run_with_recovery_confirmation "$output" \
    env PATH="${TEST_BIN}:$PATH" \
    HOME="$home" \
    CLAUDE_CONFIG_DIR="${home}/.claude" \
    RUNNER_TEST_ARGS_FILE="$args_file" \
    ISSUE_RUNNER_ASSUME_YES=true \
    ISSUE_RUNNER_RETRY_DELAYS="1,1,1" \
    ISSUE_RUNNER_PROGRESS_INTERVAL=0 \
    ISSUE_KILLER_CONFIG_PATH="${TEST_ROOT}/resume-config.toml" \
    "$RUNNER" "$repo"

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
  # without --resume. Session persistence is now the default for fresh
  # launches (issue #56), so the absence of `--no-session-persistence`
  # proves the fresh worker is leaving its transcript on disk for the
  # next restart to resume.
  if grep -Fxq -- '--resume' "$args_file"; then
    fail 'Recovery worker received --resume despite no captured session id'
  fi
  if grep -Fxq -- '--no-session-persistence' "$args_file"; then
    fail 'Fresh recovery worker unexpectedly disabled session persistence'
  fi

  pass 'session resume is skipped when no session id was captured'
}

test_session_resume_skipped_when_transcript_missing() {
  local repo="${TEST_ROOT}/missing-transcript-repo"
  local home="${TEST_ROOT}/missing-transcript-home"
  local fake="${TEST_ROOT}/claude-minimax-missing-transcript"
  local output="${TEST_ROOT}/missing-transcript-output.log"
  local counter="${TEST_ROOT}/missing-transcript-counter"
  local args_file="${TEST_ROOT}/missing-transcript-args"
  local checkpoint_file
  local status

  mkdir -p "$home"
  new_repo "$repo"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"

  # The checkpoint carries a captured session id but no transcript file
  # exists in the configured Claude directory. The runner must treat
  # the session as not resumable and launch a fresh recovery worker
  # rather than aborting the run.
  cat > "$checkpoint_file" <<EOF
pid=$$
iteration=1
issue=5
branch=main
base_branch=main
base_sha=$(git -C "$repo" rev-parse HEAD)
session_id=sess-missing-transcript
state=mutating
updated_at=test
EOF

  cat > "$fake" <<PROLOG
#!/usr/bin/env bash
counter_file="$counter"
attempt=0
[[ -f "\$counter_file" ]] && attempt=\$(<"\$counter_file")
attempt=\$((attempt + 1))
printf '%s\n' "\$attempt" > "\$counter_file"
printf '%s\n' '{"type":"system","subtype":"init","session_id":"sess-fresh"}'
printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\\n"}'
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
    '  printf "%s\n" "$attempt" >"$counter_file"' \
    '  printf "%s\n" "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sess-shell-fresh\"}"' \
    '  printf "%s\n" "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ISSUE_KILLER_STATUS=QUEUE_EMPTY\\n\"}"' \
    '}' > "${home}/.bashrc"

  write_default_config "${TEST_ROOT}/missing-transcript-config.toml" "claude-minimax" "bash" "${home}/.bashrc"

  # The migrated-checkpoint adoption path now requires operator
  # confirmation (issue #55), so the test must drive the TTY prompt
  # via expect, the same way the confirmed recovery tests do.
  set +e
  run_with_recovery_confirmation "$output" \
    env PATH="${TEST_BIN}:$PATH" \
    HOME="$home" \
    CLAUDE_CONFIG_DIR="${home}/.claude" \
    RUNNER_TEST_ARGS_FILE="$args_file" \
    ISSUE_RUNNER_ASSUME_YES=true \
    ISSUE_RUNNER_RETRY_DELAYS="1,1,1" \
    ISSUE_RUNNER_PROGRESS_INTERVAL=0 \
    ISSUE_KILLER_CONFIG_PATH="${TEST_ROOT}/missing-transcript-config.toml" \
    "$RUNNER" "$repo"
  status=$?
  set -e

  # A missing transcript must not abort the run.
  [[ "$status" -eq 0 ]] || \
    fail "Missing transcript must exit 0, got ${status}"

  # The runner must NOT pass --resume because the captured session has
  # no transcript on disk. Session persistence is the default for a
  # fresh launch (issue #56), so a fresh recovery worker must leave
  # its transcript on disk by omitting `--no-session-persistence`.
  if grep -Fxq -- '--resume' "$args_file"; then
    fail 'Recovery worker received --resume despite a missing transcript'
  fi
  if grep -Fxq -- 'sess-missing-transcript' "$args_file"; then
    fail 'Recovery worker was invoked with the dead session id'
  fi
  if grep -Fxq -- '--no-session-persistence' "$args_file"; then
    fail 'Fresh recovery worker unexpectedly disabled session persistence'
  fi

  pass 'a checkpoint naming a session with no transcript launches a fresh recovery worker'
}

test_disable_session_persistence_profile_option_opts_out() {
  local repo="${TEST_ROOT}/opt-out-repo"
  local home="${TEST_ROOT}/opt-out-home"
  local fake="${TEST_ROOT}/claude-minimax-opt-out"
  local output="${TEST_ROOT}/opt-out-output.log"
  local args_file="${TEST_ROOT}/opt-out-args"
  local checkpoint_file

  mkdir -p "$home"
  new_repo "$repo"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"

  cat > "$fake" <<'PROLOG'
#!/usr/bin/env bash
for arg in "$@"; do printf '%s\n' "$arg" >>"$RUNNER_TEST_ARGS_FILE"; done
printf '%s\n' '{"type":"result","subtype":"success","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}'
exit 0
PROLOG
  chmod +x "$fake"

  printf '%s\n' \
    'claude-minimax() {' \
    '  for arg in "$@"; do printf "%s\\n" "$arg" >>"$RUNNER_TEST_ARGS_FILE"; done' \
    '  printf "%s\\n" "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ISSUE_KILLER_STATUS=QUEUE_EMPTY\\n\"}"' \
    '}' > "${home}/.bashrc"

  # Custom config that declares the disable_session_persistence opt-out
  # on the only profile. The TOML parser must accept the new option key
  # without rejecting it as unknown, and the runner must translate the
  # opt-out into `--no-session-persistence` on every fresh launch.
  cat > "${TEST_ROOT}/opt-out-config.toml" <<CONFIG
 default_profile = "opt-out"

[profiles.opt-out]
label = "Opt out"
cli = "claude"
command = "$fake"
model = "fixture-model"
shell = "bash"
init_file = "${home}/.bashrc"

[profiles.opt-out.options]
permission_mode = "bypassPermissions"
disable_session_persistence = "true"
CONFIG

  HOME="$home" \
  RUNNER_TEST_ARGS_FILE="$args_file" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="${TEST_ROOT}/opt-out-config.toml" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Opt-out fixture did not finish'

  grep -Fxq -- '--no-session-persistence' "$args_file" || \
    fail 'disable_session_persistence=true did not translate into --no-session-persistence'
  # When the operator opts out, the worker MUST NOT receive --resume
  # either: there is no captured session id and none should ever be
  # persisted.
  if grep -Fxq -- '--resume' "$args_file"; then
    fail 'Opt-out worker unexpectedly received --resume'
  fi

  # The checkpoint file format must stay unchanged; an opt-out fresh
  # launch that captures no session id writes the existing
  # `session_id=unavailable` sentinel rather than an identifier that
  # can never be honoured.
  [[ -e "$checkpoint_file" ]] && \
    fail 'Opt-out fresh launch unexpectedly left a checkpoint behind (queue was empty)'

  pass 'disable_session_persistence profile option opts out and leaves the sentinel-only checkpoint format'
}

test_fresh_worker_persists_session_by_default() {
  local repo="${TEST_ROOT}/persist-default-repo"
  local home="${TEST_ROOT}/persist-default-home"
  local output="${TEST_ROOT}/persist-default-output.log"
  local count_file="${TEST_ROOT}/persist-default-count"
  local args_file="${TEST_ROOT}/persist-default-args"
  local config_path="${TEST_ROOT}/persist-default-config.toml"

  mkdir -p "$home"
  new_repo "$repo"

  # The fixture mimics a single ready issue followed by an empty
  # queue: the first invocation emits ISSUE_COMPLETED, the second
  # emits QUEUE_EMPTY so the runner exits cleanly. The dedicated
  # unresumable-session tests already seed a real transcript and
  # verify the on-disk layout; this test only needs to prove the
  # fresh-worker CLI invocation opts into session persistence
  # rather than silently disabling it (issue #51, ADR #12).
  printf '%s\n' \
    'claude-minimax() {' \
    '  local count=0' \
    '  [[ -f "$RUNNER_TEST_COUNT_FILE" ]] && count=$(<"$RUNNER_TEST_COUNT_FILE")' \
    '  count=$((count + 1))' \
    '  printf "%s\\n" "$count" >"$RUNNER_TEST_COUNT_FILE"' \
    '  for arg in "$@"; do printf "%s\\n" "$arg" >>"$RUNNER_TEST_ARGS_FILE"; done' \
    '  if [[ "$count" -eq 1 ]]; then' \
    '    printf "%s\\n" "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\\n\"}"' \
    '  else' \
    '    printf "%s\\n" "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ISSUE_KILLER_STATUS=QUEUE_EMPTY\\n\"}"' \
    '  fi' \
    '}' > "${home}/.bashrc"

  write_default_config "$config_path" "claude-minimax" "bash" "${home}/.bashrc"

  HOME="$home" \
  RUNNER_TEST_COUNT_FILE="$count_file" \
  RUNNER_TEST_ARGS_FILE="$args_file" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_RETRY_DELAYS="1,1,1" \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Persist-default fixture did not finish'

  # The whole reason this test exists: a fresh Claude worker must be
  # invoked without --no-session-persistence so the session transcript
  # is written to disk and a later restart has something real to
  # resume (issue #51, ADR #12).
  if grep -Fxq -- '--no-session-persistence' "$args_file"; then
    fail 'Fresh Claude worker was invoked with --no-session-persistence (persistence must be the default)'
  fi
  # The runner must NOT pass --resume either: no captured session id
  # exists yet on a clean run, so resume is meaningless and must be
  # absent from the fresh-worker argument vector.
  if grep -Fxq -- '--resume' "$args_file"; then
    fail 'Fresh Claude worker was invoked with --resume without a captured session id'
  fi

  pass 'fresh Claude worker persists its session by default and does not silently opt out'
}

test_unresumable_session_degrades_to_fresh_worker() {
  local repo="${TEST_ROOT}/unresumable-repo"
  local home="${TEST_ROOT}/unresumable-home"
  local fake="${TEST_ROOT}/claude-minimax-unresumable"
  local output="${TEST_ROOT}/unresumable-output.log"
  local counter="${TEST_ROOT}/unresumable-counter"
  local args_file="${TEST_ROOT}/unresumable-args"
  local checkpoint_file
  local status

  mkdir -p "$home"
  new_repo "$repo"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"

  # First invocation: the orchestrator resumes the captured session, the
  # fake CLI rejects it with the Claude-style "No conversation found"
  # signature and exits non-zero. Second invocation: the orchestrator
  # must launch fresh without --resume. Third and later invocations
  # (post-completion drain) return QUEUE_EMPTY.
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
    '    printf "%s\\n" "No conversation found with session ID sess-unresumable-77\\n" >&2' \
    '    return 1' \
    '  fi' \
    '  printf "%s\\n" "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\\n\"}"' \
    '}' > "${home}/.bashrc"

  # Pre-seed the checkpoint with a session id and a matching branch so the
  # runner considers the session safe to resume on attempt 1. The
  # existence check now requires a real transcript for resume, so seed
  # one under the fake Claude config dir.
  cat > "$checkpoint_file" <<EOF
pid=$$
iteration=1
issue=77
branch=main
base_branch=main
base_sha=$(git -C "$repo" rev-parse HEAD)
session_id=sess-unresumable-77
state=mutating
updated_at=test
EOF

  seed_claude_transcript "$home" "$repo" "sess-unresumable-77" >/dev/null

  write_default_config "${TEST_ROOT}/unresumable-config.toml" "claude-minimax" "bash" "${home}/.bashrc"
  set +e
  run_with_recovery_confirmation "$output" \
    env PATH="${TEST_BIN}:$PATH" \
    HOME="$home" \
    CLAUDE_CONFIG_DIR="${home}/.claude" \
    RUNNER_TEST_ARGS_FILE="$args_file" \
    ISSUE_RUNNER_ASSUME_YES=true \
    ISSUE_RUNNER_RETRY_DELAYS="1,1,1" \
    ISSUE_RUNNER_PROGRESS_INTERVAL=0 \
    ISSUE_KILLER_CONFIG_PATH="${TEST_ROOT}/unresumable-config.toml" \
    "$RUNNER" "$repo"
  status=$?
  set -e

  # The unresumable resume must not abort the run; the fresh worker must
  # complete the issue cleanly.
  [[ "$status" -eq 0 ]] || \
    fail "Unresumable resume must exit 0, got ${status}"
  [[ "$(<"$counter")" -ge 2 ]] || \
    fail "Runner did not relaunch after unresumable session (got $(<"$counter") invocations)"

  # First invocation must carry --resume and the captured session id; the
  # second must NOT carry --resume (resume is suppressed for the fresh
  # degradation relaunch). Session persistence is the default for the
  # fresh worker (issue #56), so the second invocation must omit
  # `--no-session-persistence` and prove the fresh worker is leaving
  # its transcript on disk.
  local first_block last_block resume_seen second_resume_seen fresh_marker
  first_block="$(awk -v marker='--resume' '
    { lines[NR]=$0 }
    $0 == marker { print "RESUME_FOUND_AT_LINE_" NR; exit }
  ' "$args_file")"
  [[ -n "$first_block" ]] || \
    fail 'First worker invocation did not receive --resume'
  if awk '/^--resume$/{exit 1}' "$args_file"; then
    fail 'First worker invocation never included --resume'
  fi
  grep -Fxq -- 'sess-unresumable-77' "$args_file" || \
    fail 'First worker invocation did not receive the captured session id'

  # Locate the position of the first --resume and confirm the second
  # invocation (everything after it) contains no further --resume and
  # contains no `--no-session-persistence` (persistence is the default).
  resume_seen=false
  second_resume_seen=false
  fresh_marker=true
  while IFS= read -r line; do
    if [[ "$line" == "--resume" ]]; then
      if [[ "$resume_seen" == "true" ]]; then
        second_resume_seen=true
      fi
      resume_seen=true
      continue
    fi
    if [[ "$resume_seen" == "true" && "$line" == "--no-session-persistence" ]]; then
      fresh_marker=false
    fi
  done <"$args_file"
  if [[ "$second_resume_seen" == "true" ]]; then
    fail 'Second worker invocation still carried --resume after degradation'
  fi
  if [[ "$fresh_marker" != "true" ]]; then
    fail 'Fresh-worker relaunch disabled session persistence'
  fi

  # The runner must announce the strategy in its log so the operator
  # can tell a degradation from a transient retry or a non-transient
  # failure without reading the source.
  grep -Fq 'could not be resumed' "$output" || \
    fail 'Runner did not announce the unresumable session degradation'
  grep -Fq 'continuing the same issue with a fresh worker' "$output" || \
    fail 'Runner did not announce the fresh-worker continuation'
  if grep -Fq 'Sleeping' "$output"; then
    fail 'Runner applied backoff before the degradation relaunch'
  fi
  if grep -Fq 'recovery_delay=' "$output"; then
    fail 'Runner published a transient-style recovery_delay on a degradation'
  fi

  pass 'unresumable session degrades to a fresh worker without backoff or budget consumption'
}

test_unresumable_degradation_is_bounded() {
  local repo="${TEST_ROOT}/unresumable-bound-repo"
  local home="${TEST_ROOT}/unresumable-bound-home"
  local fake="${TEST_ROOT}/claude-minimax-unresumable-bound"
  local output="${TEST_ROOT}/unresumable-bound-output.log"
  local counter="${TEST_ROOT}/unresumable-bound-counter"
  local args_file="${TEST_ROOT}/unresumable-bound-args"
  local checkpoint_file
  local status

  mkdir -p "$home"
  new_repo "$repo"
  checkpoint_file="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"

  # A fresh worker that happens to print the same "No conversation
  # found" string in its output must NOT be misclassified as another
  # degradation. The orchestrator already cleared CHECKPOINT_SESSION_ID
  # after the first degradation, so the second invocation launches
  # without --resume; classify_failure must treat the same string as a
  # regular non_transient_exit so the run aborts once instead of
  # looping.
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
    '  resume_seen=0' \
    '  for arg in "$@"; do [[ "$arg" == "--resume" ]] && resume_seen=1; done' \
    '  if [[ "$resume_seen" -eq 1 ]]; then' \
    '    printf "%s\\n" "No conversation found with session ID fake-session\\n" >&2' \
    '    return 1' \
    '  fi' \
    '  if [[ "$attempt" -eq 2 ]]; then' \
    '    printf "%s\\n" "No conversation found with session ID stray-mention\\n" >&2' \
    '    return 1' \
    '  fi' \
    '  printf "%s\\n" "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\\n\"}"' \
    '}' > "${home}/.bashrc"

  cat > "$checkpoint_file" <<EOF
pid=$$
iteration=1
issue=42
branch=main
base_branch=main
base_sha=$(git -C "$repo" rev-parse HEAD)
session_id=sess-unresumable-42
state=mutating
updated_at=test
EOF

  # The existence check requires a real transcript for resume to be
  # attempted; seed one so the CLI rejects it with the documented
  # "No conversation found" signature and the unresumable_session
  # classification can fire.
  seed_claude_transcript "$home" "$repo" "sess-unresumable-42" >/dev/null

  write_default_config "${TEST_ROOT}/unresumable-bound-config.toml" "claude-minimax" "bash" "${home}/.bashrc"
  # The migrated-checkpoint adoption path now requires operator
  # confirmation (issue #55), so the test must drive the TTY prompt
  # via expect. Unlike the typical recovery fixtures, this one is
  # expected to fail with status 1 after the bounded degradation
  # completes; run_with_recovery_confirmation_tolerate_failure
  # drives the same prompt but records the runner exit status in
  # RUNNER_TEST_CONFIRM_STATUS instead of failing the test.
  run_with_recovery_confirmation_tolerate_failure "$output" \
    env PATH="${TEST_BIN}:$PATH" \
    HOME="$home" \
    CLAUDE_CONFIG_DIR="${home}/.claude" \
    RUNNER_TEST_ARGS_FILE="$args_file" \
    ISSUE_RUNNER_ASSUME_YES=true \
    ISSUE_RUNNER_RETRY_LIMIT=1 \
    ISSUE_RUNNER_PROGRESS_INTERVAL=0 \
    ISSUE_KILLER_CONFIG_PATH="${TEST_ROOT}/unresumable-bound-config.toml" \
    "$RUNNER" "$repo"
  status="$RUNNER_TEST_CONFIRM_STATUS"

  # Two invocations: the resume rejection on attempt 1, the fresh
  # worker emitting the same signature on attempt 2. The orchestrator
  # must not treat attempt 2 as a second degradation; classify_failure
  # only emits unresumable_session when resume_session is non-empty,
  # so attempt 2 is classified as non_transient_exit and the run
  # aborts after one retry.
  local attempts
  attempts="$(<"$counter")"
  [[ "$attempts" -le 2 ]] || \
    fail "Bounded degradation must not loop, got ${attempts} invocations"
  # Exactly one degradation announcement, regardless of how many times
  # the signature appears in worker output.
  local degradation_count
  degradation_count="$(grep -c 'continuing the same issue with a fresh worker' "$output" || true)"
  [[ "$degradation_count" -le 1 ]] || \
    fail "Bounded degradation announced fresh-worker continuation ${degradation_count} times"

  pass 'fresh worker emitting the signature is not misclassified as a second degradation'
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
  local status

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
  timeout {
    send_user "Timed out waiting for the issue-killer recovery prompt\n"
    catch {close}
    catch {wait}
    exit 124
  }
  eof
}
set wait_result [wait]
exit [lindex $wait_result 3]
PROLOG

  set +e
  RUNNER_TEST_COMMAND="$*" expect "$expect_script" >"$output" 2>&1
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    sed 's/^/  /' "$output" >&2
    fail "Recovery confirmation fixture exited ${status}"
  fi
}

# Variant of run_with_recovery_confirmation for fixtures that are
# expected to exit non-zero after a successful confirmation. Drives
# the same TTY prompts but records the runner exit status in the
# RUNNER_TEST_CONFIRM_STATUS global instead of failing the test,
# so callers can assert on bounded-degradation scenarios where
# the worker is expected to fail.
RUNNER_TEST_CONFIRM_STATUS=0
run_with_recovery_confirmation_tolerate_failure() {
  local output="$1"
  shift
  local expect_script="${TEST_ROOT}/confirm-recovery-${TESTS_RUN}-tolerate.expect"

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
  timeout {
    send_user "Timed out waiting for the issue-killer recovery prompt\n"
    catch {close}
    catch {wait}
    exit 124
  }
  eof
}
set wait_result [wait]
exit [lindex $wait_result 3]
PROLOG

  set +e
  RUNNER_TEST_COMMAND="$*" expect "$expect_script" >"$output" 2>&1
  RUNNER_TEST_CONFIRM_STATUS=$?
  set -e
  return 0
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
  local home="${TEST_ROOT}/restart-resume-home"

  mkdir -p "$home"
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

  # Seed a transcript under the fake Claude config dir so the
  # existence check verifies resume rather than passing against a
  # missing session.
  seed_claude_transcript "$home" "$repo" "sess-restart-77" >/dev/null

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
    HOME="$home" \
    CLAUDE_CONFIG_DIR="${home}/.claude" \
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
  ! grep -Fxq -- '--no-session-persistence' "$args" || \
    fail 'Confirmed legacy adoption unexpectedly disabled session persistence'
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
  # The migrated-checkpoint adoption path now detects a closed issue
  # before the dirty-worktree reconciliation step (issue #55) and
  # clears the checkpoint so queue selection can resume without
  # relaunching work that was already finished. The dry-worktree
  # recovery then fails closed because no checkpoint survived and
  # no explicit ISSUE_RUNNER_ADOPT_ISSUE was supplied; either way
  # no recovery worker is launched.
  if ! grep -Fq 'Stale checkpoint discarded' "$output" &&
     ! grep -Fq 'legacy adoption requires ISSUE_RUNNER_ADOPT_ISSUE' "$output"; then
    fail 'Missing stale-checkpoint or legacy-adoption diagnostic'
  fi

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
test_black_box_claude_stream_preserves_provider_native_json
test_streaming_silent_worker_heartbeats
test_streaming_heartbeat_suppressed_while_events_flow
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
test_session_resume_skipped_when_transcript_missing
test_disable_session_persistence_profile_option_opts_out
test_fresh_worker_persists_session_by_default
test_unresumable_session_degrades_to_fresh_worker
test_unresumable_degradation_is_bounded
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
  local config_tmp="${TEST_ROOT}/profile-default-tmp"
  local output="${TEST_ROOT}/profile-default-output.log"
  local status

  new_repo "$repo"
  mkdir -p "$config_tmp"
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
  TMPDIR="$config_tmp" \
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
  if compgen -G "${config_tmp}/issue-killer-config.*" >/dev/null; then
    fail 'Runner left its parsed configuration state in TMPDIR'
  fi

  pass 'non-interactive launch uses default_profile and cleans parsed configuration state'
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
  [[ ! -e "$repo/.git/issue-killer.lock" ]] || \
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
spawn env PATH=$PATH ISSUE_KILLER_CONFIG_PATH=$config_path /Users/elvis/Code/tools/workflow/agent/issue-killer/run.sh "$repo"
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
spawn env PATH=$PATH ISSUE_KILLER_CONFIG_PATH=$config_path /Users/elvis/Code/tools/workflow/agent/issue-killer/run.sh "$repo"
expect {
  -re {Profile \[1\]:} {
    send "2\r"
    exp_continue
  }
  -re {Fallback \[0\]:} {
    send "0\r"
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

test_black_box_codex_stream_preserves_provider_native_json() {
  local repo="${TEST_ROOT}/codex-native-stream-repo"
  local fake="${TEST_ROOT}/codex-native-stream-worker"
  local counter="${TEST_ROOT}/codex-native-stream-counter"
  local events="${TEST_ROOT}/codex-native-stream-events.jsonl"
  local config_path="${TEST_ROOT}/codex-native-stream-config.toml"
  local output="${TEST_ROOT}/codex-native-stream-output.log"

  new_repo "$repo"
  cat > "$events" <<'JSONL'
{"type":"item.started","provider_sequence":1,"item":{"id":"codex-1","type":"command_execution","command":"gh issue list --state open","provider_secret":"codex-secret-1","details":{"arguments":["--state","open"]}}}
{"type":"item.started","provider_sequence":2,"item":{"id":"codex-2","type":"reasoning","text":"plan issue 23","summary":["inspect","implement"]}}
{"type":"item.started","provider_sequence":3,"item":{"id":"codex-3","type":"command_execution","command":"printf shell-command","exit_context":{"cwd":"/repo"}}}
{"type":"item.started","provider_sequence":4,"item":{"id":"codex-4","type":"command_execution","command":"git push origin issue-23","git":{"remote":"origin"}}}
{"type":"item.started","provider_sequence":5,"item":{"id":"codex-5","type":"command_execution","command":"git commit -m 'test: provider native'","git":{"sign":false}}}
{"type":"item.started","provider_sequence":6,"item":{"id":"codex-6","type":"command_execution","command":"git merge main","git":{"strategy":"ort"}}}
{"type":"item.started","provider_sequence":7,"item":{"id":"codex-7","type":"command_execution","command":"gh pr create --title native --body json","pull_request":{"draft":false}}}
{"type":"item.started","provider_sequence":8,"item":{"id":"codex-8","type":"command_execution","command":"gh pr close 23","pull_request":{"number":23}}}
{"type":"item.started","provider_sequence":9,"item":{"id":"codex-9","type":"command_execution","command":"gh issue close 23","issue":{"number":23}}}
{"type":"item.started","provider_sequence":10,"item":{"id":"codex-10","type":"command_execution","command":"/code-review","review":{"mode":"full"}}}
{"type":"turn.completed","provider_sequence":11,"output_text":"completed with provider payload\nISSUE_KILLER_STATUS=ISSUE_COMPLETED\n","usage":{"input_tokens":303,"output_tokens":404},"provider_metadata":{"thread_id":"codex-thread-23"}}
JSONL
  write_provider_native_stream_fixture "$fake"

  write_codex_profile_config "$config_path" "codex-luna" \
    "codex-luna=Codex Luna|codex|${fake}|gpt-5-luna|||medium|workspace-write|false"

  RUNNER_TEST_COUNTER_FILE="$counter" \
  RUNNER_TEST_EVENTS_FILE="$events" \
  RUNNER_TEST_EMPTY_EVENT='{"type":"turn.completed","output_text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}' \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Codex provider-native stream fixture did not drain the queue'

  assert_provider_native_progress "$output" "codex" "$events"
  grep -Fq 'Worker 1 completed one issue.' "$output" || \
    fail 'Codex final generic status did not complete the issue'

  pass 'codex stream preserves exact provider events, public categories, order, fields, and final status'
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
  checkpoint="${repo}/.git/issue-killer.checkpoint"
  grep -Eq '^session_id=thread-xyz-001' "$checkpoint" || \
    fail 'Codex adapter did not capture the thread id from thread.started'
  grep -Eq '^cli=codex' "$checkpoint" || \
    fail 'Codex checkpoint did not record the codex CLI identity'

  pass 'codex adapter captures the thread id and records it on the checkpoint'
}

test_codex_profile_validation_rejects_unknown_options() {
  local adapter="${ROOT_DIR}/agent/issue-killer/runtime/codex-adapter.sh"
  local output

  set +e
  RUNNER_NAME="issue-killer" \
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
  local adapter="${ROOT_DIR}/agent/issue-killer/runtime/codex-adapter.sh"

  set +e
  RUNNER_NAME="issue-killer" \
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
  local adapter="${ROOT_DIR}/agent/issue-killer/runtime/codex-adapter.sh"

  set +e
  RUNNER_NAME="issue-killer" \
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

  for case_name in duplicate cycle; do
    config_path="${TEST_ROOT}/opencode-${case_name}-fallback-config.toml"
    output="${TEST_ROOT}/opencode-${case_name}-fallback-output.log"
    case "$case_name" in
      duplicate)
        write_opencode_profile_config "$config_path" "opencode-primary" \
          "opencode-primary=OpenCode Primary|opencode|${fake}|provider/primary|||high|true|[\"opencode-backup\", \"opencode-backup\"]" \
          "opencode-backup=OpenCode Backup|opencode|${fake}|provider/backup|||medium|true"
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
  grep -Fq 'fallback chain contains a cycle through profile' \
    "${TEST_ROOT}/opencode-cycle-fallback-output.log" || \
    fail 'Cycle validation diagnostic did not identify the repeated profile'

  pass 'opencode fallback validation rejects duplicates and cycles'
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
      send "3\r"
    } elseif {\$fallback_prompt == 2} {
      send "2\r"
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

  grep -Fq 'Select the next fallback profile:' "$output" || \
    fail 'Picker did not open the mixed-provider fallback-chain builder'
  grep -Fq 'cli=codex' "$output" || \
    fail 'Codex profile was not offered in the mixed-provider fallback menu'
  grep -Fq 'cli=opencode' "$output" || \
    fail 'OpenCode profile was not offered in the mixed-provider fallback menu'
  grep -Fq 'opencode-backup-b=opencode' "$output" || \
    fail 'Destructive confirmation did not preserve the selected fallback order with CLI labels'
  grep -Fq 'opencode-backup-a=opencode' "$output" || \
    fail 'Destructive confirmation did not preserve the selected fallback order with CLI labels'

  pass 'TTY mixed-provider picker builds an ordered chain from unused profiles'
}

# A black-box acceptance test for the issue #46 spec: a valid mixed-provider
# fallback chain (OpenCode -> Codex -> Claude) is accepted by the runner
# without being rejected by the fallback validator. The runner refuses the
# launch because the configured worker command is intentionally not on
# PATH; the validator must not reject the chain before the worker can be
# launched. A validator failure would surface as a "fallback chain"
# diagnostic instead.
test_black_box_mixed_provider_fallback_chain_validates() {
  local repo="${TEST_ROOT}/mixed-provider-fallback-repo"
  local config_path="${TEST_ROOT}/mixed-provider-fallback-config.toml"
  local output="${TEST_ROOT}/mixed-provider-fallback-output.log"
  local status

  new_repo "$repo"

  write_opencode_profile_config "$config_path" "opencode-primary" \
    "opencode-primary=OpenCode Primary|opencode|/no/such/opencode|provider/primary|||high|true|[\"codex-other\", \"claude-other\"]" \
    "codex-other=Codex Other|codex|/no/such/codex|codex-model||||false" \
    "claude-other=Claude Other|claude|/no/such/claude|claude-model||||false"

  set +e
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  # The mixed-provider chain is intentionally valid. The runner rejects
  # the launch because the configured worker command is not on PATH;
  # the diagnostic must come from the application stage, not the
  # fallback validator. A validator failure would surface as a
  # "fallback chain" diagnostic instead.
  [[ "$status" -ne 0 ]] || \
    fail 'Mixed-provider fallback chain unexpectedly launched a worker'
  grep -Fq 'fallback chain' "$output" && \
    fail 'Mixed-provider fallback chain was wrongly rejected by the validator' || \
    :

  pass 'mixed-provider fallback chain is accepted'
}

# Issue #47 — Claude-to-Codex handoff. When a Claude worker fails
# with an eligible provider-capacity error, the runner must transition
# to a Codex profile, launch the destination fresh, and never pass the
# Claude session identifier to Codex. Partial work must be preserved.
test_black_box_claude_to_codex_handoff_preserves_partial_work() {
  local repo="${TEST_ROOT}/claude-to-codex-handoff-repo"
  local partial_file="${repo}/issue-23-partial-work.txt"
  local claude="${TEST_ROOT}/claude-to-codex-handoff-claude"
  local codex="${TEST_ROOT}/claude-to-codex-handoff-codex"
  local claude_count="${TEST_ROOT}/claude-to-codex-handoff-claude-count"
  local codex_count="${TEST_ROOT}/claude-to-codex-handoff-codex-count"
  local codex_args_file="${TEST_ROOT}/claude-to-codex-handoff-codex-args"
  local checkpoint_snapshot="${TEST_ROOT}/claude-to-codex-handoff-checkpoint-snapshot"
  local config_path="${TEST_ROOT}/claude-to-codex-handoff-config.toml"
  local output="${TEST_ROOT}/claude-to-codex-handoff-output.log"
  local status

  new_repo "$repo"
  cat > "$claude" <<'PROLOG'
#!/usr/bin/env bash
count=0
[[ -r "$RUNNER_TEST_CLAUDE_COUNT" ]] && count="$(<"$RUNNER_TEST_CLAUDE_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$RUNNER_TEST_CLAUDE_COUNT"
# Emit a system init event so the Claude adapter captures a session
# id; this is the value the runner must NEVER forward to Codex.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"claude-sess-47-secret-id"}'
# Identify the issue, drop a partial file, then fail with a Claude
# provider-quota error so the fallback chain advances.
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"gh issue view 23"}}]}}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"issue-23-partial-work.txt","content":"partial work from claude\n"}}]}}'
printf '%s\n' 'subscription quota exhausted for Claude provider' >&2
exit 1
PROLOG
  cat > "$codex" <<'PROLOG'
#!/usr/bin/env bash
count=0
[[ -r "$RUNNER_TEST_CODEX_COUNT" ]] && count="$(<"$RUNNER_TEST_CODEX_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$RUNNER_TEST_CODEX_COUNT"
: > "$RUNNER_TEST_CODEX_ARGS_FILE"
for arg in "$@"; do printf '%s\n' "$arg" >> "$RUNNER_TEST_CODEX_ARGS_FILE"; done
# The Codex worker continues from the partial file the Claude
# worker left behind (without resetting, overwriting, or
# discarding it), commits the result so the next iteration
# observes a clean worktree, then completes the issue. Crucially,
# the fake CLI inspects argv: a Claude session id appearing in
# the recorded args is the failure the test asserts against.
if [[ "$count" -eq 1 ]]; then
  printf '%s\n' 'continued partial work from codex' >> "$RUNNER_TEST_DIRTY_FILE"
  # Snapshot the checkpoint while the fallback transition state is
  # still persisted (fallback_ready before ISSUE_COMPLETED clears it).
  cp "$RUNNER_TEST_CHECKPOINT" "$RUNNER_TEST_CHECKPOINT_SNAPSHOT" 2>/dev/null || true
  git -C "$(dirname "$RUNNER_TEST_DIRTY_FILE")" add "$(basename "$RUNNER_TEST_DIRTY_FILE")" 2>/dev/null || true
  git -C "$(dirname "$RUNNER_TEST_DIRTY_FILE")" commit --quiet -m "codex: continue partial work" 2>/dev/null || true
  printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}}'
else
  printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}'
fi
PROLOG
  chmod +x "$claude" "$codex"

  # Hand-write the TOML so the profile block declares an explicit
  # cross-CLI fallback chain. The Claude profile is selected as
  # default; the chain advances to the Codex profile on quota.
  printf 'default_profile = "claude-primary"\n' > "$config_path"
  cat >> "$config_path" <<PROLOG

[profiles.claude-primary]
label = "Claude Primary"
cli = "claude"
command = "${claude}"
model = "claude-model"
fallbacks = ["codex-other"]

[profiles.claude-primary.options]
permission_mode = "bypassPermissions"

[profiles.codex-other]
label = "Codex Other"
cli = "codex"
command = "${codex}"
model = "codex-model"

[profiles.codex-other.options]
reasoning_effort = "medium"
sandbox = "workspace-write"
auto_approve = "true"
PROLOG

  set +e
  RUNNER_TEST_CLAUDE_COUNT="$claude_count" \
  RUNNER_TEST_CODEX_COUNT="$codex_count" \
  RUNNER_TEST_CODEX_ARGS_FILE="$codex_args_file" \
  RUNNER_TEST_DIRTY_FILE="$partial_file" \
  RUNNER_TEST_CHECKPOINT="${repo}/.git/issue-killer.checkpoint" \
  RUNNER_TEST_CHECKPOINT_SNAPSHOT="$checkpoint_snapshot" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 0 ]] || \
    fail "Claude-to-Codex handoff did not finish successfully, got exit ${status}"
  [[ "$(<"$claude_count")" -eq 1 ]] || \
    fail 'Claude primary ran more than once before the fallback transition'
  [[ "$(<"$codex_count")" -eq 2 ]] || \
    fail 'Codex fallback did not continue the same issue and drain the queue'
  [[ -s "$partial_file" ]] || \
    fail 'Codex fallback did not preserve and complete the partial Claude work'
  grep -Fxq -- 'claude-sess-47-secret-id' "$codex_args_file" && \
    fail 'Codex fallback received the Claude session id (cross-CLI leak)'
  grep -Fxq -- '--resume' "$codex_args_file" && \
    fail 'Codex fallback was invoked with --resume despite the CLI mismatch'
  grep -Fq 'Advancing fallback: claude-primary -> codex-other' "$output" || \
    fail 'Runner did not report the cross-CLI fallback transition'
  [[ -r "$checkpoint_snapshot" ]] || \
    fail 'Checkpoint snapshot was not captured during the fallback transition'
  grep -Eq '^failed_profile=claude-primary$' "$checkpoint_snapshot" || \
    fail 'Transition checkpoint did not record the failed Claude profile'
  grep -Eq '^next_profile=codex-other$' "$checkpoint_snapshot" || \
    fail 'Transition checkpoint did not record the destination Codex profile'
  grep -Eq '^cli=codex$' "$checkpoint_snapshot" || \
    fail 'Transition checkpoint did not record the destination CLI'
  grep -Eq '^fallback_failure=provider_quota$' "$checkpoint_snapshot" || \
    fail 'Transition checkpoint did not record the provider quota classification'

  pass 'Claude quota failure advances to Codex, preserves partial work, and never passes the Claude session id'
}

test_black_box_multi_profile_fallback_chain_persists_state() {
  # Issue #48 — multi-profile fallback chain. A Claude worker that
  # exhausts its quota advances to a Codex profile; the Codex worker
  # that hits a model-unavailable error advances to an OpenCode
  # profile; the OpenCode profile completes the issue and drains
  # the queue. The configured order, the active profile, the
  # remaining chain, and the normalized failure category must be
  # persisted at every transition so a restart could resume the
  # chain at the right position with the right identity. No
  # captured session id from an earlier CLI may be forwarded to
  # the destination CLI.
  local repo="${TEST_ROOT}/multi-profile-fallback-repo"
  local claude="${TEST_ROOT}/multi-profile-fallback-claude"
  local codex="${TEST_ROOT}/multi-profile-fallback-codex"
  local opencode="${TEST_ROOT}/multi-profile-fallback-opencode"
  local claude_count="${TEST_ROOT}/multi-profile-fallback-claude-count"
  local codex_count="${TEST_ROOT}/multi-profile-fallback-codex-count"
  local opencode_count="${TEST_ROOT}/multi-profile-fallback-opencode-count"
  local codex_args="${TEST_ROOT}/multi-profile-fallback-codex-args"
  local opencode_args="${TEST_ROOT}/multi-profile-fallback-opencode-args"
  local codex_checkpoint_snapshot="${TEST_ROOT}/multi-profile-fallback-codex-checkpoint"
  local opencode_checkpoint_snapshot="${TEST_ROOT}/multi-profile-fallback-opencode-checkpoint"
  local config_path="${TEST_ROOT}/multi-profile-fallback-config.toml"
  local output="${TEST_ROOT}/multi-profile-fallback-output.log"
  local status

  new_repo "$repo"
  cat > "$claude" <<'PROLOG'
#!/usr/bin/env bash
count=0
[[ -r "$RUNNER_TEST_CLAUDE_COUNT" ]] && count="$(<"$RUNNER_TEST_CLAUDE_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$RUNNER_TEST_CLAUDE_COUNT"
# Emit a system init event so the Claude adapter captures a session
# id; this is the value the runner must NEVER forward to Codex.
printf '%s\n' '{"type":"system","subtype":"init","session_id":"claude-multi-48-secret"}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"gh issue view 48"}}]}}'
printf '%s\n' 'subscription quota exhausted for Claude provider' >&2
exit 1
PROLOG
  cat > "$codex" <<'PROLOG'
#!/usr/bin/env bash
count=0
[[ -r "$RUNNER_TEST_CODEX_COUNT" ]] && count="$(<"$RUNNER_TEST_CODEX_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$RUNNER_TEST_CODEX_COUNT"
: > "$RUNNER_TEST_CODEX_ARGS_FILE"
for arg in "$@"; do printf '%s\n' "$arg" >> "$RUNNER_TEST_CODEX_ARGS_FILE"; done
# Capture the Codex thread id so the test can verify the runner
# does NOT pass it to OpenCode.
printf '%s\n' '{"type":"thread.started","thread_id":"codex-multi-48-secret"}'
# Snapshot the checkpoint at the moment the Codex worker begins
# running: the checkpoint was just rewritten to fallback_ready by
# the Claude→Codex transition, so it carries the failed profile,
# the next profile, and the normalized quota classification.
if [[ "$count" -eq 1 ]]; then
  cp "$RUNNER_TEST_CHECKPOINT" "$RUNNER_TEST_CODEX_CHECKPOINT" 2>/dev/null || true
fi
# Fail with a model-unavailable signature so the chain advances
# to the OpenCode profile (the third entry in the chain).
printf '%s\n' 'requested model codex-multi is unavailable' >&2
exit 1
PROLOG
  cat > "$opencode" <<'PROLOG'
#!/usr/bin/env bash
count=0
[[ -r "$RUNNER_TEST_OPENCODE_COUNT" ]] && count="$(<"$RUNNER_TEST_OPENCODE_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$RUNNER_TEST_OPENCODE_COUNT"
: > "$RUNNER_TEST_OPENCODE_ARGS_FILE"
for arg in "$@"; do printf '%s\n' "$arg" >> "$RUNNER_TEST_OPENCODE_ARGS_FILE"; done
# Snapshot the checkpoint at the moment the OpenCode worker
# begins running: the checkpoint was just rewritten to
# fallback_ready by the Codex→OpenCode transition, so it carries
# the Codex profile as the failed entry, OpenCode as the active
# profile, and the normalized model_unavailable classification.
if [[ "$count" -eq 1 ]]; then
  cp "$RUNNER_TEST_CHECKPOINT" "$RUNNER_TEST_OPENCODE_CHECKPOINT" 2>/dev/null || true
  printf '%s\n' '{"type":"session","sessionID":""}'
  printf '%s\n' '{"type":"text","part":{"text":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}}'
else
  printf '%s\n' '{"type":"session","sessionID":""}'
  printf '%s\n' '{"type":"text","part":{"text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}'
fi
PROLOG
  chmod +x "$claude" "$codex" "$opencode"

  # Hand-write the TOML so the profile block declares an explicit
  # three-profile mixed-CLI fallback chain. The Claude profile is
  # selected as default; the chain advances to Codex on quota, then
  # to OpenCode on model-unavailable.
  printf 'default_profile = "claude-primary"\n' > "$config_path"
  cat >> "$config_path" <<PROLOG

[profiles.claude-primary]
label = "Claude Primary"
cli = "claude"
command = "${claude}"
model = "claude-model"
fallbacks = ["codex-other", "opencode-tertiary"]

[profiles.claude-primary.options]
permission_mode = "bypassPermissions"

[profiles.codex-other]
label = "Codex Other"
cli = "codex"
command = "${codex}"
model = "codex-model"
fallbacks = ["opencode-tertiary"]

[profiles.codex-other.options]
reasoning_effort = "medium"
sandbox = "workspace-write"
auto_approve = "true"

[profiles.opencode-tertiary]
label = "OpenCode Tertiary"
cli = "opencode"
command = "${opencode}"
model = "opencode/tertiary"

[profiles.opencode-tertiary.options]
variant = "medium"
auto_approve = "true"
PROLOG

  set +e
  RUNNER_TEST_CLAUDE_COUNT="$claude_count" \
  RUNNER_TEST_CODEX_COUNT="$codex_count" \
  RUNNER_TEST_OPENCODE_COUNT="$opencode_count" \
  RUNNER_TEST_CODEX_ARGS_FILE="$codex_args" \
  RUNNER_TEST_OPENCODE_ARGS_FILE="$opencode_args" \
  RUNNER_TEST_CODEX_CHECKPOINT="$codex_checkpoint_snapshot" \
  RUNNER_TEST_OPENCODE_CHECKPOINT="$opencode_checkpoint_snapshot" \
  RUNNER_TEST_CHECKPOINT="${repo}/.git/issue-killer.checkpoint" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 0 ]] || \
    fail "multi-profile fallback chain did not finish successfully, got exit ${status}"
  [[ "$(<"$claude_count")" -eq 1 ]] || \
    fail 'Claude primary ran more than once before the first fallback transition'
  [[ "$(<"$codex_count")" -eq 1 ]] || \
    fail 'Codex fallback ran more than once before the second fallback transition'
  [[ "$(<"$opencode_count")" -eq 2 ]] || \
    fail 'OpenCode terminal fallback did not complete the issue and drain the queue'

  # The chain must advance through the documented CLI transitions in
  # the declared order. The Claude→Codex hop logs `Advancing fallback`
  # (mixed CLI); the Codex→OpenCode hop logs `Advancing OpenCode
  # fallback` because both ends are OpenCode-flavored for the message
  # routing. Both hops must appear in operator output with the
  # normalized failure category in parentheses.
  grep -Fq 'Advancing fallback: claude-primary -> codex-other (cli=codex, provider_quota)' "$output" || \
    fail 'Runner did not report the Claude→Codex transition with provider_quota classification'
  grep -Fq 'Advancing OpenCode fallback: codex-other -> opencode-tertiary (provider_model_unavailable)' "$output" || \
    fail 'Runner did not report the Codex→OpenCode transition with provider_model_unavailable classification'

  # The Claude→Codex checkpoint snapshot must carry the failed
  # Claude profile, the Codex destination, and the provider_quota
  # classification that drove the transition.
  [[ -r "$codex_checkpoint_snapshot" ]] || \
    fail 'Codex worker did not snapshot the checkpoint during the fallback transition'
  grep -Eq '^selected_profile=claude-primary$' "$codex_checkpoint_snapshot" || \
    fail 'Claude→Codex snapshot did not retain the selected_profile=claude-primary anchor'
  grep -Eq '^profile=codex-other$' "$codex_checkpoint_snapshot" || \
    fail 'Claude→Codex snapshot did not record the active Codex profile'
  grep -Eq '^cli=codex$' "$codex_checkpoint_snapshot" || \
    fail 'Claude→Codex snapshot did not record the destination CLI'
  grep -Eq '^fallback_position=1$' "$codex_checkpoint_snapshot" || \
    fail 'Claude→Codex snapshot did not advance the fallback position to 1'
  grep -Eq '^fallback_remaining=opencode-tertiary$' "$codex_checkpoint_snapshot" || \
    fail 'Claude→Codex snapshot did not retain the remaining chain head'
  grep -Eq '^failed_profile=claude-primary$' "$codex_checkpoint_snapshot" || \
    fail 'Claude→Codex snapshot did not record the failed Claude profile'
  grep -Eq '^next_profile=codex-other$' "$codex_checkpoint_snapshot" || \
    fail 'Claude→Codex snapshot did not record the destination Codex profile'
  grep -Eq '^fallback_failure=provider_quota$' "$codex_checkpoint_snapshot" || \
    fail 'Claude→Codex snapshot did not record the provider_quota classification'
  grep -Eq '^state=fallback_ready$' "$codex_checkpoint_snapshot" || \
    fail 'Claude→Codex snapshot did not carry the fallback_ready lifecycle state'

  # The Codex→OpenCode checkpoint snapshot must advance the chain
  # position, swap the failed profile to Codex, swap the active
  # profile to OpenCode, and carry the provider_model_unavailable
  # classification.
  [[ -r "$opencode_checkpoint_snapshot" ]] || \
    fail 'OpenCode worker did not snapshot the checkpoint during the second fallback transition'
  grep -Eq '^profile=opencode-tertiary$' "$opencode_checkpoint_snapshot" || \
    fail 'Codex→OpenCode snapshot did not record the active OpenCode profile'
  grep -Eq '^cli=opencode$' "$opencode_checkpoint_snapshot" || \
    fail 'Codex→OpenCode snapshot did not record the destination CLI'
  grep -Eq '^fallback_position=2$' "$opencode_checkpoint_snapshot" || \
    fail 'Codex→OpenCode snapshot did not advance the fallback position to 2'
  grep -Eq '^failed_profile=codex-other$' "$opencode_checkpoint_snapshot" || \
    fail 'Codex→OpenCode snapshot did not record the failed Codex profile'
  grep -Eq '^fallback_failure=provider_model_unavailable$' "$opencode_checkpoint_snapshot" || \
    fail 'Codex→OpenCode snapshot did not record the provider_model_unavailable classification'

  # Cross-CLI leaks: no captured Claude or Codex session id may reach
  # the destination CLI; no --resume may be passed across CLIs.
  grep -Fxq -- 'claude-multi-48-secret' "$codex_args" && \
    fail 'Codex fallback received the Claude session id (cross-CLI leak)'
  grep -Fxq -- 'codex-multi-48-secret' "$opencode_args" && \
    fail 'OpenCode fallback received the Codex thread id (cross-CLI leak)'
  grep -Fxq -- '--resume' "$codex_args" && \
    fail 'Codex fallback was invoked with --resume despite the CLI mismatch'
  grep -Fxq -- '--session' "$opencode_args" && \
    fail 'OpenCode fallback was invoked with --session despite the CLI mismatch'

  # Order of events: the Claude→Codex transition must precede the
  # Codex→OpenCode transition, and both must precede the final
  # completion. Without ordering, the chain could be consumed in the
  # wrong order.
  local claude_hop codex_hop completion_line
  claude_hop="$(grep -n 'Advancing fallback: claude-primary -> codex-other' "$output" | head -n 1 | cut -d: -f1)"
  codex_hop="$(grep -n 'Advancing OpenCode fallback: codex-other -> opencode-tertiary' "$output" | head -n 1 | cut -d: -f1)"
  completion_line="$(grep -n 'Worker .* completed one issue' "$output" | head -n 1 | cut -d: -f1)"
  [[ -n "$claude_hop" && -n "$codex_hop" && -n "$completion_line" ]] || \
    fail 'Could not locate chain transition lines in operator output'
  [[ "$claude_hop" -lt "$codex_hop" ]] || \
    fail 'Codex→OpenCode transition appeared before Claude→Codex transition'
  [[ "$codex_hop" -lt "$completion_line" ]] || \
    fail 'Terminal completion was reported before the chain finished advancing'

  pass 'mixed-provider fallback chain persists order, active profile, remaining chain, and normalized failure category across multiple transitions'
}

test_black_box_status_marker_takes_precedence_over_provider_diagnostics() {
  # Issue #48 — status-marker precedence. A worker that emits
  # `ISSUE_KILLER_STATUS=BLOCKED` (or any other terminal marker)
  # alongside a recognizable provider-quota signature must be
  # classified as `blocked`, not `provider_quota`. The orchestrator
  # must stop on the marker and never advance the fallback chain.
  local repo="${TEST_ROOT}/marker-precedence-repo"
  local primary="${TEST_ROOT}/marker-precedence-primary"
  local backup="${TEST_ROOT}/marker-precedence-backup"
  local primary_count="${TEST_ROOT}/marker-precedence-primary-count"
  local backup_marker="${TEST_ROOT}/marker-precedence-backup-marker"
  local config_path="${TEST_ROOT}/marker-precedence-config.toml"
  local output="${TEST_ROOT}/marker-precedence-output.log"
  local status

  new_repo "$repo"
  cat > "$primary" <<'PROLOG'
#!/usr/bin/env bash
count=0
[[ -r "$RUNNER_TEST_PRIMARY_COUNT" ]] && count="$(<"$RUNNER_TEST_PRIMARY_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$RUNNER_TEST_PRIMARY_COUNT"
# Emit a tool invocation so the runner identifies the issue, then
# surface a BLOCKED marker that must take precedence over the
# provider-quota signature that follows.
printf '%s\n' '{"type":"session","sessionID":""}'
printf '%s\n' '{"type":"step_start","part":{"type":"tool","tool":"bash","input":{"command":"gh issue view 48"}}}'
printf '%s\n' '{"type":"text","part":{"text":"ISSUE_KILLER_STATUS=BLOCKED\n"}}'
# A provider-quota signature in the SAME worker output must NOT
# trigger a fallback advance — the marker wins.
printf '%s\n' 'subscription quota exhausted for primary' >&2
exit 0
PROLOG
  printf '%s\n' '#!/usr/bin/env bash' "touch '${backup_marker}'" > "$backup"
  chmod +x "$primary" "$backup"

  printf 'default_profile = "opencode-primary"\n' > "$config_path"
  cat >> "$config_path" <<PROLOG

[profiles.opencode-primary]
label = "OpenCode Primary"
cli = "opencode"
command = "${primary}"
model = "provider/primary"
fallbacks = ["opencode-backup"]

[profiles.opencode-primary.options]
variant = "high"
auto_approve = "true"

[profiles.opencode-backup]
label = "OpenCode Backup"
cli = "opencode"
command = "${backup}"
model = "provider/backup"

[profiles.opencode-backup.options]
variant = "medium"
auto_approve = "true"
PROLOG

  set +e
  RUNNER_TEST_PRIMARY_COUNT="$primary_count" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  # BLOCKED must surface as the runner's exit code (2) and the
  # backup profile must not have run, proving the marker
  # prevented a fallback advance.
  [[ "$status" -eq 2 ]] || \
    fail "BLOCKED marker should yield exit 2, got ${status}"
  [[ "$(<"$primary_count")" -eq 1 ]] || \
    fail 'Primary profile ran more than once despite BLOCKED outcome'
  [[ ! -e "$backup_marker" ]] || \
    fail 'Provider-quota signature overrode BLOCKED marker and consumed a fallback'
  grep -Fq 'pending work requires human input' "$output" || \
    fail 'BLOCKED diagnostic did not surface in operator output'

  pass 'explicit worker status marker takes precedence over provider failure diagnostics'
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
  RUNNER_TEST_CHECKPOINT="${repo}/.git/issue-killer.checkpoint" \
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
  checkpoint="${repo}/.git/issue-killer.checkpoint"
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

test_black_box_opencode_stream_preserves_provider_native_json() {
  local repo="${TEST_ROOT}/opencode-native-stream-repo"
  local fake="${TEST_ROOT}/opencode-native-stream-worker"
  local counter="${TEST_ROOT}/opencode-native-stream-counter"
  local events="${TEST_ROOT}/opencode-native-stream-events.jsonl"
  local config_path="${TEST_ROOT}/opencode-native-stream-config.toml"
  local output="${TEST_ROOT}/opencode-native-stream-output.log"

  new_repo "$repo"
  cat > "$events" <<'JSONL'
{"type":"step_start","provider_sequence":1,"sessionID":"opencode-session-23","part":{"id":"opencode-1","type":"tool","tool":"bash","input":{"command":"gh issue list --state open","provider_secret":"opencode-secret-1","nested":{"flags":["one","two"]}}}}
{"type":"step_start","provider_sequence":2,"sessionID":"opencode-session-23","part":{"id":"opencode-2","type":"tool","tool":"todowrite","input":{"todos":[{"content":"plan issue 23","status":"in_progress"}]}}}
{"type":"step_start","provider_sequence":3,"sessionID":"opencode-session-23","part":{"id":"opencode-3","type":"tool","tool":"bash","input":{"command":"printf shell-command","timeout":19}}}
{"type":"step_start","provider_sequence":4,"sessionID":"opencode-session-23","part":{"id":"opencode-4","type":"tool","tool":"bash","input":{"command":"git push origin issue-23","git":{"remote":"origin"}}}}
{"type":"step_start","provider_sequence":5,"sessionID":"opencode-session-23","part":{"id":"opencode-5","type":"tool","tool":"bash","input":{"command":"git commit -m 'test: provider native'","git":{"sign":false}}}}
{"type":"step_start","provider_sequence":6,"sessionID":"opencode-session-23","part":{"id":"opencode-6","type":"tool","tool":"bash","input":{"command":"git rebase main","git":{"onto":"main"}}}}
{"type":"step_start","provider_sequence":7,"sessionID":"opencode-session-23","part":{"id":"opencode-7","type":"tool","tool":"bash","input":{"command":"gh pr create --title native --body json","pull_request":{"draft":false}}}}
{"type":"step_start","provider_sequence":8,"sessionID":"opencode-session-23","part":{"id":"opencode-8","type":"tool","tool":"bash","input":{"command":"gh pr merge 23 --squash","pull_request":{"number":23}}}}
{"type":"step_start","provider_sequence":9,"sessionID":"opencode-session-23","part":{"id":"opencode-9","type":"tool","tool":"bash","input":{"command":"gh issue close 23","issue":{"number":23}}}}
{"type":"step_start","provider_sequence":10,"sessionID":"opencode-session-23","part":{"id":"opencode-10","type":"tool","tool":"bash","input":{"command":"/code-review","review":{"mode":"full"}}}}
{"type":"text","provider_sequence":11,"sessionID":"opencode-session-23","part":{"id":"opencode-11","type":"text","text":"completed with provider payload\nISSUE_KILLER_STATUS=ISSUE_COMPLETED\n","timing":{"start":10,"end":20}},"provider_metadata":{"model":"provider/model"}}
JSONL
  write_provider_native_stream_fixture "$fake"

  write_opencode_profile_config "$config_path" "opencode-luna" \
    "opencode-luna=OpenCode Luna|opencode|${fake}|openai/gpt-5-luna|||medium|false"

  RUNNER_TEST_COUNTER_FILE="$counter" \
  RUNNER_TEST_EVENTS_FILE="$events" \
  RUNNER_TEST_EMPTY_EVENT='{"type":"text","sessionID":"","part":{"type":"text","text":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}}' \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$config_path" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'OpenCode provider-native stream fixture did not drain the queue'

  assert_provider_native_progress "$output" "opencode" "$events"
  grep -Fq 'Worker 1 completed one issue.' "$output" || \
    fail 'OpenCode final generic status did not complete the issue'

  pass 'opencode stream preserves exact provider events, public categories, order, fields, and final status'
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
  checkpoint="${repo}/.git/issue-killer.checkpoint"
  grep -Eq '^session_id=sess-opencode-capture' "$checkpoint" || \
    fail 'OpenCode adapter did not capture the session id from the session event'
  grep -Eq '^cli=opencode' "$checkpoint" || \
    fail 'OpenCode checkpoint did not record the opencode CLI identity'

  pass 'opencode adapter captures the session id and records it on the checkpoint'
}

test_opencode_profile_validation_rejects_unknown_options() {
  local adapter="${ROOT_DIR}/agent/issue-killer/runtime/opencode-adapter.sh"

  set +e
  RUNNER_NAME="issue-killer" \
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
  local adapter="${ROOT_DIR}/agent/issue-killer/runtime/opencode-adapter.sh"

  set +e
  RUNNER_NAME="issue-killer" \
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
  local adapter="${ROOT_DIR}/agent/issue-killer/runtime/opencode-adapter.sh"

  set +e
  RUNNER_NAME="issue-killer" \
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

test_github_tracker_supplement_is_delivered_to_worker() {
  local repo="${TEST_ROOT}/github-supplement-repo"
  local fake="${TEST_ROOT}/claude-minimax-github-supplement"
  local output="${TEST_ROOT}/github-supplement-output.log"
  local args="${TEST_ROOT}/github-supplement-args"
  local prompt="${TEST_ROOT}/github-supplement-prompt"

  new_repo "$repo"

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'for arg in "$@"; do printf "%s\\n" "$arg" >> "$RUNNER_TEST_ARGS_FILE"; done' \
    'last_arg="${@: -1}"' \
    'printf "%s\\n" "$last_arg" > "$RUNNER_TEST_PROMPT_FILE"' \
    'printf "%s\\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' \
    > "$fake"
  chmod +x "$fake"

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
  RUNNER_TEST_ARGS_FILE="$args" \
  RUNNER_TEST_PROMPT_FILE="$prompt" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Runner did not deliver the GitHub tracker supplement'

  grep -Fq 'GitHub tracker supplement:' "$prompt" || \
    fail 'Effective worker prompt did not include the GitHub tracker supplement'
  grep -Fq 'single delivery unit' "$prompt" || \
    fail 'GitHub supplement did not declare the single-issue delivery unit'
  grep -Fq 'configured base branch' "$prompt" || \
    fail 'GitHub supplement did not name the configured base branch target'

  pass 'github tracker supplement is composed into the worker prompt'
}

test_runtime_config_section_follows_supplement() {
  local repo="${TEST_ROOT}/prompt-order-repo"
  local fake="${TEST_ROOT}/claude-minimax-prompt-order"
  local output="${TEST_ROOT}/prompt-order-output.log"
  local prompt="${TEST_ROOT}/prompt-order-prompt"

  new_repo "$repo"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'last_arg="${@: -1}"' \
    'printf "%s\\n" "$last_arg" > "$RUNNER_TEST_PROMPT_FILE"' \
    'printf "%s\\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' \
    > "$fake"
  chmod +x "$fake"

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
  RUNNER_TEST_PROMPT_FILE="$prompt" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Runner did not deliver the composed worker prompt'

  local supplement_at config_at shared_at
  shared_at="$(grep -n 'ISSUE_KILLER_STATUS=ISSUE_COMPLETED' "$prompt" | head -n 1 | cut -d: -f1)"
  supplement_at="$(grep -n 'GitHub tracker supplement:' "$prompt" | head -n 1 | cut -d: -f1)"
  config_at="$(grep -n 'Runtime configuration:' "$prompt" | head -n 1 | cut -d: -f1)"

  [[ -n "$shared_at" && -n "$supplement_at" && -n "$config_at" ]] || \
    fail 'Effective worker prompt is missing the shared contract, supplement, or runtime section'

  if (( supplement_at <= shared_at )); then
    fail 'Tracker supplement appeared before the shared contract'
  fi
  if (( config_at <= supplement_at )); then
    fail 'Runtime configuration appeared before the tracker supplement'
  fi

  pass 'worker prompt orders shared contract, tracker supplement, then runtime configuration'
}

test_tracker_supplement_excluded_from_checkpoint_and_status() {
  local repo="${TEST_ROOT}/checkpoint-redaction-repo"
  local fake="${TEST_ROOT}/claude-minimax-checkpoint-redaction"
  local output="${TEST_ROOT}/checkpoint-redaction-output.log"
  local checkpoint lock_status

  new_repo "$repo"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\\n" "ISSUE_KILLER_STATUS=FAILED"' \
    > "$fake"
  chmod +x "$fake"

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo" >"$output" 2>&1 || true

  checkpoint="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"
  lock_status="$(checkpoint_path "$repo")/${RUNNER_NAME}.lock/status"

  [[ -r "$checkpoint" ]] || fail 'Failed worker did not retain its checkpoint'
  if grep -F 'tracker supplement' "$checkpoint"; then
    fail 'Tracker supplement leaked into the persisted checkpoint'
  fi
  if grep -F 'tracker supplement' "$lock_status" 2>/dev/null; then
    fail 'Tracker supplement leaked into the lock status snapshot'
  fi

  pass 'tracker supplement stays out of checkpoint and lock-status files'
}

test_azure_tracker_supplement_is_loaded_from_adapter() {
  local adapter="${ROOT_DIR}/agent/issue-killer/tracker/azure-devops-adapter.sh"
  local captured tmp

  tmp="$(mktemp)"
  # Source the adapter with minimal globals so the supplement function
  # is available without invoking full tracker initialization.
  (
    export RUNNER_NAME=tracker-test
    source "$adapter"
    tracker_worker_supplement
  ) > "$tmp"
  captured="$(<"$tmp")"
  rm -f "$tmp"

  grep -Fq 'Azure DevOps tracker supplement:' <<<"$captured" || \
    fail 'Azure adapter did not expose a tracker worker supplement'
  grep -Fq 'integration container' <<<"$captured" || \
    fail 'Azure supplement did not declare the HU integration container'
  grep -Fq 'pinned Azure delivery HU' <<<"$captured" || \
    fail 'Azure supplement did not name the pinned HU delivery model'
  grep -Fq 'direct hierarchical child Task or Bug' <<<"$captured" || \
    fail 'Azure supplement did not scope the worker unit to direct hierarchical children'

  pass 'azure adapter exposes a tracker worker supplement'
}

test_github_tracker_supplement_is_loaded_from_adapter() {
  local adapter="${ROOT_DIR}/agent/issue-killer/tracker/github-adapter.sh"
  local captured tmp

  tmp="$(mktemp)"
  (
    export RUNNER_NAME=tracker-test
    source "$adapter"
    tracker_worker_supplement
  ) > "$tmp"
  captured="$(<"$tmp")"
  rm -f "$tmp"

  grep -Fq 'GitHub tracker supplement:' <<<"$captured" || \
    fail 'GitHub adapter did not expose a tracker worker supplement'
  grep -Fq 'single delivery unit' <<<"$captured" || \
    fail 'GitHub supplement did not declare the single-issue delivery unit'

  pass 'github adapter exposes a tracker worker supplement'
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
test_black_box_codex_stream_preserves_provider_native_json
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
test_black_box_mixed_provider_fallback_chain_validates
test_black_box_claude_to_codex_handoff_preserves_partial_work
test_black_box_multi_profile_fallback_chain_persists_state
test_black_box_status_marker_takes_precedence_over_provider_diagnostics
test_black_box_opencode_quota_failure_advances_fallback_with_same_session
test_black_box_opencode_rate_limit_retries_before_fallback
test_black_box_opencode_model_unavailable_launches_constrained_fresh_fallback
test_black_box_opencode_excluded_failures_never_consume_fallbacks
test_black_box_opencode_fallback_exhaustion_retains_recovery_checkpoint
test_black_box_opencode_restart_restores_active_fallback_position
test_black_box_opencode_prior_provider_error_does_not_reclassify_fallback_failure
test_black_box_opencode_profile_invokes_opencode_run_with_expected_args
test_black_box_opencode_stream_preserves_provider_native_json
test_black_box_opencode_profile_captures_session_id
test_opencode_profile_validation_rejects_unknown_options
test_opencode_profile_validation_rejects_invalid_variant
test_opencode_profile_validation_rejects_invalid_model_format
test_black_box_opencode_profile_rejects_invalid_options_before_launch
test_black_box_opencode_profile_resumes_session_when_captured
test_black_box_opencode_profile_drains_queue_through_status_marker

test_github_tracker_supplement_is_delivered_to_worker() {
  local repo="${TEST_ROOT}/github-supplement-repo"
  local fake="${TEST_ROOT}/claude-minimax-github-supplement"
  local output="${TEST_ROOT}/github-supplement-output.log"
  local args="${TEST_ROOT}/github-supplement-args"
  local prompt="${TEST_ROOT}/github-supplement-prompt"

  new_repo "$repo"

  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'for arg in "$@"; do printf "%s\\n" "$arg" >> "$RUNNER_TEST_ARGS_FILE"; done' \
    'last_arg="${@: -1}"' \
    'printf "%s\\n" "$last_arg" > "$RUNNER_TEST_PROMPT_FILE"' \
    'printf "%s\\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' \
    > "$fake"
  chmod +x "$fake"

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
  RUNNER_TEST_ARGS_FILE="$args" \
  RUNNER_TEST_PROMPT_FILE="$prompt" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Runner did not deliver the GitHub tracker supplement'

  grep -Fq 'GitHub tracker supplement:' "$prompt" || \
    fail 'Effective worker prompt did not include the GitHub tracker supplement'
  grep -Fq 'single delivery unit' "$prompt" || \
    fail 'GitHub supplement did not declare the single-issue delivery unit'
  grep -Fq 'configured base branch' "$prompt" || \
    fail 'GitHub supplement did not name the configured base branch target'

  pass 'github tracker supplement is composed into the worker prompt'
}

test_runtime_config_section_follows_supplement() {
  local repo="${TEST_ROOT}/prompt-order-repo"
  local fake="${TEST_ROOT}/claude-minimax-prompt-order"
  local output="${TEST_ROOT}/prompt-order-output.log"
  local prompt="${TEST_ROOT}/prompt-order-prompt"

  new_repo "$repo"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'last_arg="${@: -1}"' \
    'printf "%s\\n" "$last_arg" > "$RUNNER_TEST_PROMPT_FILE"' \
    'printf "%s\\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' \
    > "$fake"
  chmod +x "$fake"

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
  RUNNER_TEST_PROMPT_FILE="$prompt" \
    "$RUNNER" "$repo" >"$output" 2>&1 || \
      fail 'Runner did not deliver the composed worker prompt'

  local supplement_at config_at shared_at
  shared_at="$(grep -n 'ISSUE_KILLER_STATUS=ISSUE_COMPLETED' "$prompt" | head -n 1 | cut -d: -f1)"
  supplement_at="$(grep -n 'GitHub tracker supplement:' "$prompt" | head -n 1 | cut -d: -f1)"
  config_at="$(grep -n 'Runtime configuration:' "$prompt" | head -n 1 | cut -d: -f1)"

  [[ -n "$shared_at" && -n "$supplement_at" && -n "$config_at" ]] || \
    fail 'Effective worker prompt is missing the shared contract, supplement, or runtime section'

  if (( supplement_at <= shared_at )); then
    fail 'Tracker supplement appeared before the shared contract'
  fi
  if (( config_at <= supplement_at )); then
    fail 'Runtime configuration appeared before the tracker supplement'
  fi

  pass 'worker prompt orders shared contract, tracker supplement, then runtime configuration'
}

test_tracker_supplement_excluded_from_checkpoint_and_status() {
  local repo="${TEST_ROOT}/checkpoint-redaction-repo"
  local fake="${TEST_ROOT}/claude-minimax-checkpoint-redaction"
  local output="${TEST_ROOT}/checkpoint-redaction-output.log"
  local checkpoint lock_status

  new_repo "$repo"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "%s\\n" "ISSUE_KILLER_STATUS=FAILED"' \
    > "$fake"
  chmod +x "$fake"

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$(use_config_for_command "$fake")" \
    "$RUNNER" "$repo" >"$output" 2>&1 || true

  checkpoint="$(checkpoint_path "$repo")/${RUNNER_NAME}.checkpoint"
  lock_status="$(checkpoint_path "$repo")/${RUNNER_NAME}.lock/status"

  [[ -r "$checkpoint" ]] || fail 'Failed worker did not retain its checkpoint'
  if grep -F 'tracker supplement' "$checkpoint"; then
    fail 'Tracker supplement leaked into the persisted checkpoint'
  fi
  if grep -F 'tracker supplement' "$lock_status" 2>/dev/null; then
    fail 'Tracker supplement leaked into the lock status snapshot'
  fi

  pass 'tracker supplement stays out of checkpoint and lock-status files'
}

test_azure_tracker_supplement_is_loaded_from_adapter() {
  local adapter="${ROOT_DIR}/agent/issue-killer/tracker/azure-devops-adapter.sh"
  local captured tmp

  tmp="$(mktemp)"
  # Source the adapter with minimal globals so the supplement function
  # is available without invoking full tracker initialization.
  (
    export RUNNER_NAME=tracker-test
    source "$adapter"
    tracker_worker_supplement
  ) > "$tmp"
  captured="$(<"$tmp")"
  rm -f "$tmp"

  grep -Fq 'Azure DevOps tracker supplement:' <<<"$captured" || \
    fail 'Azure adapter did not expose a tracker worker supplement'
  grep -Fq 'integration container' <<<"$captured" || \
    fail 'Azure supplement did not declare the HU integration container'
  grep -Fq 'pinned Azure delivery HU' <<<"$captured" || \
    fail 'Azure supplement did not name the pinned HU delivery model'
  grep -Fq 'direct hierarchical child Task or Bug' <<<"$captured" || \
    fail 'Azure supplement did not scope the worker unit to direct hierarchical children'

  pass 'azure adapter exposes a tracker worker supplement'
}

test_github_tracker_supplement_is_loaded_from_adapter() {
  local adapter="${ROOT_DIR}/agent/issue-killer/tracker/github-adapter.sh"
  local captured tmp

  tmp="$(mktemp)"
  (
    export RUNNER_NAME=tracker-test
    source "$adapter"
    tracker_worker_supplement
  ) > "$tmp"
  captured="$(<"$tmp")"
  rm -f "$tmp"

  grep -Fq 'GitHub tracker supplement:' <<<"$captured" || \
    fail 'GitHub adapter did not expose a tracker worker supplement'
  grep -Fq 'single delivery unit' <<<"$captured" || \
    fail 'GitHub supplement did not declare the single-issue delivery unit'

  pass 'github adapter exposes a tracker worker supplement'
}

test_github_tracker_supplement_is_delivered_to_worker
test_runtime_config_section_follows_supplement
test_tracker_supplement_excluded_from_checkpoint_and_status
test_github_tracker_supplement_is_loaded_from_adapter
test_azure_tracker_supplement_is_loaded_from_adapter
test_transcript_removed_on_issue_completed
test_transcript_removed_on_queue_empty
test_transcript_retained_on_blocked_outcome
test_transcript_retained_on_failed_outcome
test_transcript_retained_on_recovery_required_outcome
test_transcript_removal_failure_does_not_fail_run

printf '%s issue-killer tests passed.\n' "$TESTS_RUN"
