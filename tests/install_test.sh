#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="${ROOT_DIR}/install.sh"
BASH_BIN="${BASH_BIN:-bash}"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-workflow-installer.XXXXXX")"
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

assert_contains() {
  local file="$1" expected="$2"
  grep -Fq "$expected" "$file" || fail "Expected '${expected}' in ${file}"
}

assert_symlink() {
  local path="$1"
  [[ -L "$path" ]] || fail "Expected symlink: ${path}"
  [[ -f "${path}/SKILL.md" ]] || fail "Expected linked SKILL.md: ${path}"
}

assert_file_symlink() {
  local path="$1"
  [[ -L "$path" ]] || fail "Expected file symlink: ${path}"
  [[ -f "$path" ]] || fail "Expected linked file: ${path}"
}

seed_cache() {
  local home="$1"
  local cache="${home}/.cache/agent-workflow"

  mkdir -p \
    "${cache}/.git" \
    "${cache}/utility/alpha" \
    "${cache}/design/beta" \
    "${cache}/agent/runner"

  printf '%s\n' '---' 'name: alpha' 'description: Alpha fixture.' '---' > "${cache}/utility/alpha/SKILL.md"
  printf '%s\n' '---' 'name: beta' 'description: Beta fixture.' '---' > "${cache}/design/beta/SKILL.md"
  printf '%s\n' '---' 'name: runner' 'description: Runner fixture.' '---' > "${cache}/agent/runner/AGENT.md"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "${cache}/agent/runner/run.sh"
  chmod +x "${cache}/agent/runner/run.sh"
}

test_no_tty_error() {
  local home="${TEST_ROOT}/no-tty-home"
  local stdout="${TEST_ROOT}/no-tty.stdout"
  local stderr="${TEST_ROOT}/no-tty.stderr"
  local status

  mkdir -p "$home"

  if { : </dev/tty; } 2>/dev/null; then
    printf 'SKIP: no-TTY diagnostic (test process has a controlling TTY)\n'
    return
  fi

  set +e
  HOME="$home" "$BASH_BIN" "$INSTALLER" >"$stdout" 2>"$stderr"
  status=$?
  set -e

  [[ "$status" -ne 0 ]] || fail 'Expected no-argument install without a TTY to fail'
  assert_contains "$stderr" 'Interactive mode requires a TTY'
  if grep -Fq 'Device not configured' "$stderr"; then
    fail 'Raw /dev/tty error leaked to the user'
  fi

  pass 'no-TTY invocation reports an actionable error'
}

test_piped_explicit_mode() {
  local home="${TEST_ROOT}/pipe-home"
  local output="${TEST_ROOT}/pipe.log"

  seed_cache "$home"

  cat "$INSTALLER" | HOME="$home" "$BASH_BIN" -s -- --claude-global --dry-run >"$output" 2>&1 || \
    fail 'Piped Claude Code install failed'

  assert_contains "$output" "${home}/.claude/skills/alpha"
  assert_contains "$output" "${home}/.claude/skills/beta"
  assert_contains "$output" "${home}/.claude/agents/runner.md"
  assert_contains "$output" "${home}/.local/bin/runner"
  assert_contains "$output" '2 skills processed.'
  assert_contains "$output" '1 Claude agents processed.'
  assert_contains "$output" '1 runners processed.'
  [[ ! -e "${home}/.claude/skills" ]] || fail 'Dry-run created a Claude Code skills directory'

  pass 'piped invocation accepts an explicit non-interactive mode'
}

test_shared_global_round_trip() {
  local home="${TEST_ROOT}/shared-home"
  local install_output="${TEST_ROOT}/shared-install.log"
  local uninstall_output="${TEST_ROOT}/shared-uninstall.log"

  seed_cache "$home"
  mkdir -p "${home}/.agents/agents"
  ln -s "${home}/.cache/agent-workflow/agent/afk-issuemerger" \
    "${home}/.agents/agents/afk-issuemerger"

  HOME="$home" "$BASH_BIN" "$INSTALLER" --global --force >"$install_output" 2>&1 || \
    fail 'Shared global install failed'

  assert_symlink "${home}/.agents/skills/alpha"
  assert_symlink "${home}/.agents/skills/beta"
  [[ -L "${home}/.agents/agents/runner" ]] || fail 'Expected runner agent symlink'
  [[ ! -L "${home}/.agents/agents/afk-issuemerger" ]] || \
    fail 'Legacy afk-issuemerger symlink was not removed'
  assert_contains "$install_output" '2 skills processed.'
  assert_contains "$install_output" '1 agents processed.'
  assert_contains "$install_output" 'Removed legacy agent link: afk-issuemerger'

  HOME="$home" "$BASH_BIN" "$INSTALLER" --uninstall --global >"$uninstall_output" 2>&1 || \
    fail 'Shared global uninstall failed'

  [[ ! -e "${home}/.agents/skills/alpha" && ! -L "${home}/.agents/skills/alpha" ]] || \
    fail 'Alpha skill was not uninstalled'
  [[ ! -e "${home}/.agents/skills/beta" && ! -L "${home}/.agents/skills/beta" ]] || \
    fail 'Beta skill was not uninstalled'
  [[ ! -e "${home}/.agents/agents/runner" && ! -L "${home}/.agents/agents/runner" ]] || \
    fail 'Runner agent was not uninstalled'
  assert_contains "$uninstall_output" '2 skills processed.'
  assert_contains "$uninstall_output" '1 agents processed.'

  pass 'shared global install and uninstall process every entry'
}

test_claude_destinations() {
  local home="${TEST_ROOT}/claude-home"
  local project="${TEST_ROOT}/claude-project"
  local global_output="${TEST_ROOT}/claude-global.log"
  local local_output="${TEST_ROOT}/claude-local.log"

  seed_cache "$home"
  mkdir -p "$project"

  HOME="$home" "$BASH_BIN" "$INSTALLER" --claude-global --force >"$global_output" 2>&1 || \
    fail 'Claude Code global install failed'
  assert_symlink "${home}/.claude/skills/alpha"
  assert_symlink "${home}/.claude/skills/beta"
  assert_file_symlink "${home}/.claude/agents/runner.md"
  assert_file_symlink "${home}/.local/bin/runner"
  assert_contains "$global_output" '2 skills processed.'
  assert_contains "$global_output" '1 Claude agents processed.'
  assert_contains "$global_output" '1 runners processed.'

  HOME="$home" "$BASH_BIN" "$INSTALLER" --claude-local --target "$project" --force >"$local_output" 2>&1 || \
    fail 'Claude Code project install failed'
  assert_symlink "${project}/.claude/skills/alpha"
  assert_symlink "${project}/.claude/skills/beta"
  assert_file_symlink "${project}/.claude/agents/runner.md"
  assert_file_symlink "${project}/.claude/bin/runner"
  assert_contains "$local_output" '2 skills processed.'
  assert_contains "$local_output" '1 Claude agents processed.'
  assert_contains "$local_output" '1 runners processed.'

  HOME="$home" "$BASH_BIN" "$INSTALLER" --uninstall --claude-global >/dev/null 2>&1 || \
    fail 'Claude Code global uninstall failed'
  HOME="$home" "$BASH_BIN" "$INSTALLER" --uninstall --claude-local --target "$project" >/dev/null 2>&1 || \
    fail 'Claude Code project uninstall failed'

  [[ ! -e "${home}/.claude/agents/runner.md" && ! -L "${home}/.claude/agents/runner.md" ]] || \
    fail 'Global Claude agent was not uninstalled'
  [[ ! -e "${home}/.local/bin/runner" && ! -L "${home}/.local/bin/runner" ]] || \
    fail 'Global runner was not uninstalled'
  [[ ! -e "${project}/.claude/agents/runner.md" && ! -L "${project}/.claude/agents/runner.md" ]] || \
    fail 'Project Claude agent was not uninstalled'
  [[ ! -e "${project}/.claude/bin/runner" && ! -L "${project}/.claude/bin/runner" ]] || \
    fail 'Project runner was not uninstalled'

  pass 'Claude Code destinations install and uninstall skills, agents, and runners'
}

test_no_tty_error
test_piped_explicit_mode
test_shared_global_round_trip
test_claude_destinations

printf '%s installer tests passed.\n' "$TESTS_RUN"
