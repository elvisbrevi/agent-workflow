#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="${ROOT_DIR}/install.sh"
BASH_BIN="${BASH_BIN:-bash}"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-workflow-installer.XXXXXX")"
TESTS_RUN=0
FIXTURE_SOURCE="${TEST_ROOT}/catalog-source"
FIXTURE_REMOTE="${TEST_ROOT}/catalog-remote.git"

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

seed_remote() {
  mkdir -p \
    "${FIXTURE_SOURCE}/utility/alpha" \
    "${FIXTURE_SOURCE}/design/beta" \
    "${FIXTURE_SOURCE}/agent/runner"

  printf '%s\n' '---' 'name: alpha' 'description: Alpha fixture.' '---' \
    > "${FIXTURE_SOURCE}/utility/alpha/SKILL.md"
  printf '%s\n' '---' 'name: beta' 'description: Beta fixture.' '---' \
    > "${FIXTURE_SOURCE}/design/beta/SKILL.md"
  printf '%s\n' '---' 'name: runner' 'description: Runner fixture.' '---' \
    > "${FIXTURE_SOURCE}/agent/runner/AGENT.md"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "${FIXTURE_SOURCE}/agent/runner/run.sh"
  chmod +x "${FIXTURE_SOURCE}/agent/runner/run.sh"

  git -C "$FIXTURE_SOURCE" init --quiet
  git -C "$FIXTURE_SOURCE" config user.name 'Installer Test'
  git -C "$FIXTURE_SOURCE" config user.email 'installer@example.invalid'
  git -C "$FIXTURE_SOURCE" add .
  git -C "$FIXTURE_SOURCE" commit --quiet -m 'fixture catalog'
  git -C "$FIXTURE_SOURCE" branch -M main
  git clone --quiet --bare "$FIXTURE_SOURCE" "$FIXTURE_REMOTE"
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
  assert_contains "$install_output" 'Removed managed link:'

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

test_all_global_round_trip() {
  local home="${TEST_ROOT}/all-global-home"
  local install_output="${TEST_ROOT}/all-global-install.log"
  local uninstall_output="${TEST_ROOT}/all-global-uninstall.log"

  seed_cache "$home"

  HOME="$home" "$BASH_BIN" "$INSTALLER" --all-global >"$install_output" 2>&1 || \
    fail 'Unified global install failed'

  assert_symlink "${home}/.claude/skills/alpha"
  assert_symlink "${home}/.agents/skills/alpha"
  assert_file_symlink "${home}/.claude/agents/runner.md"
  [[ -L "${home}/.agents/agents/runner" ]] || fail 'Expected shared runner agent symlink'
  assert_file_symlink "${home}/.local/bin/runner"
  assert_contains "$install_output" 'Installing skills → all-global'
  assert_contains "$install_output" 'Installing Claude agents → all-global'
  assert_contains "$install_output" 'Installing agents → all-global'
  assert_contains "$install_output" 'Installing runners → all-global'

  HOME="$home" "$BASH_BIN" "$INSTALLER" --uninstall --all-global \
    >"$uninstall_output" 2>&1 || fail 'Unified global uninstall failed'

  [[ ! -L "${home}/.claude/skills/alpha" ]] || fail 'Claude skill survived unified uninstall'
  [[ ! -L "${home}/.agents/skills/alpha" ]] || fail 'Shared skill survived unified uninstall'
  [[ ! -L "${home}/.claude/agents/runner.md" ]] || \
    fail 'Claude agent survived unified uninstall'
  [[ ! -L "${home}/.agents/agents/runner" ]] || \
    fail 'Shared agent survived unified uninstall'
  [[ ! -L "${home}/.local/bin/runner" ]] || fail 'Runner survived unified uninstall'

  pass 'unified global mode installs and uninstalls every global integration'
}

test_install_reconciles_dirty_cache_and_stale_managed_links() {
  local home="${TEST_ROOT}/reconcile-home"
  local source="${TEST_ROOT}/reconcile-source"
  local remote="${TEST_ROOT}/reconcile-remote.git"
  local cache="${home}/.cache/agent-workflow"
  local output="${TEST_ROOT}/reconcile.log"
  local unrelated_target="${TEST_ROOT}/unrelated-agent.md"

  mkdir -p "${source}/utility/current-skill" "${source}/agent/old-runner"
  printf '%s\n' '---' 'name: current-skill' 'description: Current fixture.' '---' \
    > "${source}/utility/current-skill/SKILL.md"
  printf '%s\n' '---' 'name: old-runner' 'description: Old runner fixture.' '---' \
    > "${source}/agent/old-runner/AGENT.md"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "${source}/agent/old-runner/run.sh"
  chmod +x "${source}/agent/old-runner/run.sh"

  git -C "$source" init --quiet
  git -C "$source" config user.name 'Installer Test'
  git -C "$source" config user.email 'installer@example.invalid'
  git -C "$source" add .
  git -C "$source" commit --quiet -m 'old catalog'
  git clone --quiet --bare "$source" "$remote"
  git -C "$source" remote add origin "$remote"

  mkdir -p "$(dirname "$cache")"
  git clone --quiet "$remote" "$cache"

  rm -rf "${source}/agent/old-runner"
  mkdir -p "${source}/agent/issue-killer"
  printf '%s\n' '---' 'name: issue-killer' 'description: Current runner fixture.' '---' \
    > "${source}/agent/issue-killer/AGENT.md"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "${source}/agent/issue-killer/run.sh"
  chmod +x "${source}/agent/issue-killer/run.sh"
  git -C "$source" add -A
  git -C "$source" commit --quiet -m 'rename runner'
  git -C "$source" push --quiet origin HEAD:main

  printf '%s\n' '# local cache modification' >> "${cache}/agent/old-runner/run.sh"
  mkdir -p "${home}/.claude/skills" "${home}/.claude/agents" "${home}/.local/bin"
  ln -s "${cache}/utility/removed-skill" "${home}/.claude/skills/removed-skill"
  ln -s "${cache}/agent/old-runner/AGENT.md" "${home}/.claude/agents/old-runner.md"
  ln -s "${cache}/agent/old-runner/run.sh" "${home}/.local/bin/old-runner"
  printf '%s\n' 'unrelated' > "$unrelated_target"
  ln -s "$unrelated_target" "${home}/.claude/agents/unrelated.md"

  HOME="$home" AGENT_WORKFLOW_REPO_URL="$remote" \
    "$BASH_BIN" "$INSTALLER" --claude-global --force >"$output" 2>&1 || \
    fail 'Reconciled Claude Code install failed'

  assert_file_symlink "${home}/.claude/agents/issue-killer.md"
  assert_file_symlink "${home}/.local/bin/issue-killer"
  [[ ! -e "${home}/.claude/skills/removed-skill" && \
     ! -L "${home}/.claude/skills/removed-skill" ]] || \
    fail 'Removed skill link survived reconciliation'
  [[ ! -e "${home}/.claude/agents/old-runner.md" && \
     ! -L "${home}/.claude/agents/old-runner.md" ]] || \
    fail 'Removed Claude agent link survived reconciliation'
  [[ ! -e "${home}/.local/bin/old-runner" && ! -L "${home}/.local/bin/old-runner" ]] || \
    fail 'Removed runner link survived reconciliation'
  [[ -L "${home}/.claude/agents/unrelated.md" ]] || \
    fail 'Unrelated agent symlink was removed'
  [[ -d "${cache}/agent/issue-killer" ]] || fail 'Cache was not refreshed to the current catalog'
  [[ ! -e "${cache}/agent/old-runner" ]] || fail 'Dirty stale cache content survived refresh'
  assert_contains "$output" 'Removed managed link:'

  pass 'install refreshes dirty cache and reconciles only repository-owned links'
}

seed_remote
export AGENT_WORKFLOW_REPO_URL="$FIXTURE_REMOTE"

test_no_tty_error
test_piped_explicit_mode
test_shared_global_round_trip
test_claude_destinations
test_all_global_round_trip
test_install_reconciles_dirty_cache_and_stale_managed_links

printf '%s installer tests passed.\n' "$TESTS_RUN"
