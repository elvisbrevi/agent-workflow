#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="${ROOT_DIR}/agent/issue-killer/run.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/issue-killer-migration.XXXXXX")"
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
  mkdir -p "$path/docs/agents"
  git -C "$path" init -b main --quiet
  git -C "$path" config user.name "Migration Test"
  git -C "$path" config user.email "migration@example.test"
  printf '%s\n' '# fixture' > "${path}/README.md"
  printf '%s\n' '# Issue Tracker: GitHub' '' 'Use the `gh` CLI for all operations.' \
    > "${path}/docs/agents/issue-tracker.md"
  git -C "$path" add README.md docs/agents/issue-tracker.md
  git -C "$path" commit --quiet -m 'test: seed'
  git -C "$path" remote add origin https://github.com/example/migration-fixture.git
}

common_config() {
  local target="$1"
  local command_name="$2"
  {
    printf '%s\n' 'default_profile = "claude-main"'
    printf '%s\n' '' '[profiles.claude-main]'
    printf 'label = "Claude main"\n'
    printf 'cli = "claude"\n'
    printf 'command = "%s"\n' "$command_name"
    printf 'model = "claude-test-model"\n'
    printf '%s\n' '' '[profiles.claude-main.options]'
    printf '%s\n' 'permission_mode = "bypassPermissions"'
  } > "$target"
}

fake_gh() {
  local target="$1"
  cat > "$target" <<'FIXTURE'
#!/usr/bin/env bash
case "$1 $2" in
  "auth status")
    printf '%s\n' 'Logged in to github.com'
    ;;
  "api repos/"*)
    printf '%s\n' '0'
    ;;
  "issue view")
    printf '%s\n' '{"state":"OPEN","labels":[{"name":"ready-for-agent"}],"assignees":[]}'
    ;;
  "pr list")
    printf '%s\n' '[]'
    ;;
  *)
    printf 'unexpected gh call: %s\n' "$*" >&2
    exit 1
    ;;
esac
FIXTURE
  chmod +x "$target"
}

checkpoint_path() {
  local repo="$1"
  printf '%s\n' "$(git -C "$repo" rev-parse --git-common-dir)/$2"
}

test_stale_legacy_lock_is_recovered_before_new_lock() {
  local repo="${TEST_ROOT}/stale-lock-repo"
  local fake_worker="${TEST_ROOT}/stale-lock-worker"
  local config="${TEST_ROOT}/stale-lock-config.toml"
  local bin_dir="${TEST_ROOT}/stale-lock-bin"
  local output="${TEST_ROOT}/stale-lock-output.log"
  local common legacy_lock

  mkdir -p "$repo" "$bin_dir"
  new_repo "$repo"
  fake_gh "${bin_dir}/gh"
  printf '%s\n' '#!/usr/bin/env bash' \
    'printf "%s\\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' > "$fake_worker"
  chmod +x "$fake_worker"
  common="$(cd "$repo" && common=$(git rev-parse --git-common-dir) && cd "$common" && pwd -P)"
  legacy_lock="${common}/claude-minimax-issue-runner.lock"
  mkdir "$legacy_lock"
  {
    printf '%s\n' 'pid=999999'
    printf '%s\n' 'token=legacy-stale-token'
    printf 'repository=%s\n' "$repo"
    printf '%s\n' 'started_at=2026-08-03 20:00:00 -0400'
  } > "${legacy_lock}/owner"
  common_config "$config" "$fake_worker"

  PATH="${bin_dir}:$PATH" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_PROGRESS_INTERVAL=0 \
  ISSUE_KILLER_CONFIG_PATH="$config" \
    "$RUNNER" "$repo" >"$output" 2>&1
  runner_status=$?
  if [[ "$runner_status" -ne 0 ]]; then
    cat "$output" >&2
    fail "Canonical runner failed (status $runner_status) recovering a stale legacy lock"
  fi

  if ! grep -Fq 'No pending, available, non-epic issues remain.' "$output"; then
    cat "$output" >&2
    fail 'Canonical runner did not finish after stale lock recovery'
  fi

  [[ ! -e "$legacy_lock" ]] || fail 'Stale legacy lock remains after recovery'
  if ! grep -Fq 'Legacy namespace resolved before canonical lock acquisition' "$output"; then
    cat "$output" >&2
    fail 'Missing legacy namespace resolution diagnostic'
  fi
  if grep -Fq 'Recovered stale legacy repository lock' "$output"; then
    :
  else
    if grep -Fq 'Quarantined legacy lock' "$output"; then
      fail 'Stale legacy lock was quarantined instead of being recovered cleanly'
    else
      cat "$output" >&2
      fail 'Missing stale legacy lock recovery diagnostic'
    fi
  fi
  grep -Fq 'No pending, available, non-epic issues remain.' "$output" || \
    fail 'Canonical runner did not finish after stale lock recovery'

  pass 'stale legacy lock is recovered before the canonical lock is acquired'
}

test_legacy_lock_quarantines_unreadable_owner() {
  local repo="${TEST_ROOT}/bad-owner-repo"
  local fake_worker="${TEST_ROOT}/bad-owner-worker"
  local config="${TEST_ROOT}/bad-owner-config.toml"
  local bin_dir="${TEST_ROOT}/bad-owner-bin"
  local output="${TEST_ROOT}/bad-owner-output.log"
  local common legacy_lock
  local status

  mkdir -p "$repo" "$bin_dir"
  new_repo "$repo"
  fake_gh "${bin_dir}/gh"
  printf '%s\n' '#!/usr/bin/env bash' \
    'printf "%s\\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' > "$fake_worker"
  chmod +x "$fake_worker"
  common="$(cd "$repo" && common=$(git rev-parse --git-common-dir) && cd "$common" && pwd -P)"
  legacy_lock="${common}/claude-minimax-issue-runner.lock"
  mkdir "$legacy_lock"
  printf 'not an owner file' > "${legacy_lock}/owner"
  common_config "$config" "$fake_worker"

  set +e
  PATH="${bin_dir}:$PATH" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_PROGRESS_INTERVAL=0 \
  ISSUE_KILLER_CONFIG_PATH="$config" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  if [[ "$status" -eq 1 ]]; then
    grep -Fq 'legacy runner state could not be migrated safely' "$output" || \
      fail 'Closed-failure diagnostic missing for partial legacy owner'
  else
    grep -Fq 'Quarantined legacy lock' "$output" || {
      cat "$output" >&2
      fail 'Partial legacy owner must be quarantined or fail closed'
    }
    [[ ! -e "$legacy_lock" ]] || \
      fail 'Partial legacy lock was not quarantined away'
  fi

  pass 'partial legacy owner metadata is quarantined and fails closed'
}

test_legacy_lock_rejects_live_owner() {
  local repo="${TEST_ROOT}/live-owner-repo"
  local fake_worker="${TEST_ROOT}/live-owner-worker"
  local config="${TEST_ROOT}/live-owner-config.toml"
  local bin_dir="${TEST_ROOT}/live-owner-bin"
  local output="${TEST_ROOT}/live-owner-output.log"
  local common legacy_lock status

  mkdir -p "$repo" "$bin_dir"
  new_repo "$repo"
  fake_gh "${bin_dir}/gh"
  printf '%s\n' '#!/usr/bin/env bash' \
    'printf "%s\\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' > "$fake_worker"
  chmod +x "$fake_worker"
  common="$(cd "$repo" && common=$(git rev-parse --git-common-dir) && cd "$common" && pwd -P)"
  legacy_lock="${common}/claude-minimax-issue-runner.lock"
  mkdir "$legacy_lock"
  {
    printf 'pid=%s\n' "$$"
    printf 'token=legacy-live-token\n'
    printf 'repository=%s\n' "$repo"
    printf 'started_at=2026-08-03 20:00:00 -0400\n'
  } > "${legacy_lock}/owner"
  common_config "$config" "$fake_worker"

  set +e
  PATH="${bin_dir}:$PATH" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_PROGRESS_INTERVAL=0 \
  ISSUE_KILLER_CONFIG_PATH="$config" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 1 ]] || {
    cat "$output" >&2
    fail "Live legacy owner must block new runner, got status $status"
  }
  [[ -d "$legacy_lock" ]] || fail 'Live legacy lock was removed despite an active owner'
  [[ ! -d "${common}/issue-killer.lock" ]] || \
    fail 'New canonical lock was acquired while legacy owner is alive'
  grep -Fq 'legacy runner is active for this repository' "$output" || \
    fail 'Missing live-legacy-owner diagnostic'

  rm -rf "$legacy_lock"
  pass 'live legacy owner blocks the new runner and is preserved'
}

test_legacy_checkpoint_migrates_atomically_once() {
  local repo="${TEST_ROOT}/migrate-repo"
  local fake_worker="${TEST_ROOT}/migrate-worker"
  local config="${TEST_ROOT}/migrate-config.toml"
  local bin_dir="${TEST_ROOT}/migrate-bin"
  local output="${TEST_ROOT}/migrate-output.log"
  local common legacy_checkpoint canonical_checkpoint
  local status
  local snapshot_path

  mkdir -p "$repo" "$bin_dir"
  new_repo "$repo"
  fake_gh "${bin_dir}/gh"
  printf '%s\n' '#!/usr/bin/env bash' \
    'printf "%s\\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' > "$fake_worker"
  chmod +x "$fake_worker"
  common="$(cd "$repo" && common=$(git rev-parse --git-common-dir) && cd "$common" && pwd -P)"
  legacy_checkpoint="${common}/claude-minimax-issue-runner.checkpoint"
  base_sha="$(git -C "$repo" rev-parse main)"
  cat > "$legacy_checkpoint" <<EOF
pid=$$
iteration=2
issue=170
branch=main
base_branch=main
base_sha=${base_sha}
session_id=sess-legacy
state=mutating
updated_at=2026-08-03 21:00:00 -0400
profile=claude-minimax
cli=claude
model=claude-test-model
command=${fake_worker}
EOF
  common_config "$config" "$fake_worker"
  canonical_checkpoint="$(cd "$repo" && git rev-parse --git-common-dir)/issue-killer.checkpoint"
  if [[ "${canonical_checkpoint#${repo}}" == "$canonical_checkpoint" ]]; then
    canonical_checkpoint="${repo}/.git/issue-killer.checkpoint"
  fi

  PATH="${bin_dir}:$PATH" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_PROGRESS_INTERVAL=0 \
  ISSUE_KILLER_CONFIG_PATH="$config" \
    "$RUNNER" "$repo" >"$output" 2>&1 || {
      cat "$output" >&2
      fail 'Canonical runner failed while migrating legacy checkpoint'
    }

  if [[ ! -e "$canonical_checkpoint" ]]; then
    cat "$output" >&2
    fail 'Canonical checkpoint was not written during migration'
  fi
  [[ ! -e "$legacy_checkpoint" ]] || \
    fail 'Legacy checkpoint was not moved aside after migration'
  snapshot_path="${canonical_checkpoint}.migrated-*"
  ! ls ${canonical_checkpoint}.migrated-* >/dev/null 2>&1 || \
    fail 'Migration left a stale .migrated snapshot behind'
  [[ ! -e "${canonical_checkpoint}.tmp."* ]] || \
    fail 'Migration left a stray temp file behind'
  grep -Eq '^issue=170$' "$canonical_checkpoint" || \
    fail 'Migrated checkpoint lost the original issue number'
  grep -Eq '^branch=main$' "$canonical_checkpoint" || \
    fail 'Migrated checkpoint lost the original branch'
  grep -Eq '^base_branch=main$' "$canonical_checkpoint" || \
    fail 'Migrated checkpoint lost the configured base branch'
  grep -Eq '^base_sha=[0-9a-f]{40}$' "$canonical_checkpoint" || \
    fail 'Migrated checkpoint lost its base SHA'
  grep -Eq '^state=mutating$' "$canonical_checkpoint" || \
    fail 'Migrated checkpoint lost its lifecycle state'
  grep -Eq '^session_id=sess-legacy$' "$canonical_checkpoint" || \
    fail 'Migrated checkpoint lost its session id'
  grep -Eq '^profile=claude-main$' "$canonical_checkpoint" || \
    fail 'Migrated checkpoint did not record the Claude profile'
  grep -Eq '^cli=claude$' "$canonical_checkpoint" || \
    fail 'Migrated checkpoint did not record the Claude CLI'
  grep -Eq '^model=claude-test-model$' "$canonical_checkpoint" || \
    fail 'Migrated checkpoint did not record the Claude model'
  grep -Eq "^command=${fake_worker}\$" "$canonical_checkpoint" || \
    fail 'Migrated checkpoint did not record the Claude command'
  grep -Fq 'Quarantined legacy lock' "$output" && fail 'Migration unexpectedly quarantined a missing lock'
  grep -Fq 'Migrated legacy checkpoint' "$output" || \
    fail 'Missing migration diagnostic'

  PATH="${bin_dir}:$PATH" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_PROGRESS_INTERVAL=0 \
  ISSUE_KILLER_CONFIG_PATH="$config" \
    "$RUNNER" "$repo" >"${output}.repeat" 2>&1 || {
      cat "${output}.repeat" >&2
      fail 'Canonical runner failed on repeat startup after migration'
    }
  grep -Fq 'Migrated legacy checkpoint' "${output}.repeat" && \
    fail 'Repeat startup re-migrated an already-migrated checkpoint'
  grep -Fq 'Legacy namespace resolved before canonical lock acquisition' "${output}.repeat" || \
    fail 'Repeat startup did not announce the legacy namespace check'

  pass 'legacy checkpoint is migrated atomically and is not re-migrated'
}

test_legacy_checkpoint_with_partial_fields_fails_closed() {
  local repo="${TEST_ROOT}/partial-repo"
  local fake_worker="${TEST_ROOT}/partial-worker"
  local config="${TEST_ROOT}/partial-config.toml"
  local bin_dir="${TEST_ROOT}/partial-bin"
  local output="${TEST_ROOT}/partial-output.log"
  local common legacy_checkpoint status base_sha

  mkdir -p "$repo" "$bin_dir"
  new_repo "$repo"
  fake_gh "${bin_dir}/gh"
  printf '%s\n' '#!/usr/bin/env bash' \
    'printf "%s\\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' > "$fake_worker"
  chmod +x "$fake_worker"
  common="$(cd "$repo" && common=$(git rev-parse --git-common-dir) && cd "$common" && pwd -P)"
  legacy_checkpoint="${common}/claude-minimax-issue-runner.checkpoint"
  base_sha="$(git -C "$repo" rev-parse main)"
  cat > "$legacy_checkpoint" <<EOF
pid=$$
iteration=1
issue=170
branch=issue-17-legacy-state-migration
base_branch=
base_sha=${base_sha}
session_id=unavailable
state=mutating
updated_at=2026-08-03 21:00:00 -0400
EOF
  common_config "$config" "$fake_worker"

  set +e
  PATH="${bin_dir}:$PATH" \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_PROGRESS_INTERVAL=0 \
  ISSUE_KILLER_CONFIG_PATH="$config" \
    "$RUNNER" "$repo" >"$output" 2>&1
  status=$?
  set -e

  [[ "$status" -eq 1 ]] || {
    cat "$output" >&2
    fail "Partial legacy checkpoint must fail closed, got status $status"
  }
  [[ -e "$legacy_checkpoint" ]] || \
    fail 'Partial legacy checkpoint was unexpectedly consumed'
  grep -Fq 'legacy runner state could not be migrated safely' "$output" || \
    fail 'Missing closed-failure diagnostic for partial legacy checkpoint'

  pass 'partial legacy checkpoint fails closed and is preserved'
}

test_migration_does_not_run_when_legacy_state_absent() {
  local repo="${TEST_ROOT}/clean-repo"
  local fake_worker="${TEST_ROOT}/clean-worker"
  local config="${TEST_ROOT}/clean-config.toml"
  local bin_dir="${TEST_ROOT}/clean-bin"
  local output="${TEST_ROOT}/clean-output.log"
  local common canonical_lock_dir

  mkdir -p "$repo" "$bin_dir"
  new_repo "$repo"
  fake_gh "${bin_dir}/gh"
  printf '%s\n' '#!/usr/bin/env bash' \
    'printf "%s\\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' > "$fake_worker"
  chmod +x "$fake_worker"
  common="$(cd "$repo" && common=$(git rev-parse --git-common-dir) && cd "$common" && pwd -P)"
  canonical_lock_dir="${common}/issue-killer.lock"
  common_config "$config" "$fake_worker"

  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_RUNNER_PROGRESS_INTERVAL=0 \
  ISSUE_KILLER_CONFIG_PATH="$config" \
    "$RUNNER" "$repo" >"$output" 2>&1 || {
      cat "$output" >&2
      fail 'Canonical runner failed on a clean repository'
    }

  [[ -d "$canonical_lock_dir" ]] || \
    fail 'Canonical lock was not acquired on a clean repository'
  if grep -Fq 'Legacy namespace resolved' "$output"; then
    fail 'Migration diagnostic appeared when no legacy state was present'
  fi

  pass 'canonical runner leaves a clean repository untouched'
}

test_stale_legacy_lock_is_recovered_before_new_lock
test_legacy_lock_quarantines_unreadable_owner
test_legacy_lock_rejects_live_owner
test_legacy_checkpoint_migrates_atomically_once
test_legacy_checkpoint_with_partial_fields_fails_closed
test_migration_does_not_run_when_legacy_state_absent

printf 'Ran %s migration tests.\n' "$TESTS_RUN"
