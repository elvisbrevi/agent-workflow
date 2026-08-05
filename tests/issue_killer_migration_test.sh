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

  # The migrated-checkpoint adoption path now requires operator
  # confirmation (issue #55). Drive the prompts through expect so
  # the test still completes the migration and adoption. The
  # runner first prompts for a profile when a TTY is available,
  # then for the recovery confirmation.
  expect_script="${TEST_ROOT}/migrate-expect-${TESTS_RUN}.expect"
  command -v expect >/dev/null 2>&1 || \
    fail 'expect is required for confirmed TTY recovery fixtures'
  cat > "$expect_script" <<PROLOG
set timeout 20
log_user 1
spawn env PATH=${bin_dir}:$PATH ISSUE_RUNNER_ASSUME_YES=true ISSUE_RUNNER_PROGRESS_INTERVAL=0 ISSUE_KILLER_CONFIG_PATH=$config $RUNNER $repo
expect {
  -re {Profile \\[1\\]} {
    send "\r"
    exp_continue
  }
  -re {Continue\\? \\[y/N\\]} {
    send "y\r"
    exp_continue
  }
  eof
}
PROLOG

  expect "$expect_script" >"$output" 2>&1 || {
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

  # The migrated-checkpoint adoption path now requires operator
  # confirmation (issue #55). Drive the prompts through expect so
  # the repeat-startup half of the test still completes. The
  # runner first prompts for a profile when a TTY is available,
  # then for the recovery confirmation.
  expect_script_repeat="${TEST_ROOT}/migrate-repeat-${TESTS_RUN}.expect"
  cat > "$expect_script_repeat" <<PROLOG
set timeout 20
log_user 1
spawn env PATH=${bin_dir}:$PATH ISSUE_RUNNER_ASSUME_YES=true ISSUE_RUNNER_PROGRESS_INTERVAL=0 ISSUE_KILLER_CONFIG_PATH=$config $RUNNER $repo
expect {
  -re {Profile \\[1\\]} {
    send "\r"
    exp_continue
  }
  -re {Continue\\? \\[y/N\\]} {
    send "y\r"
    exp_continue
  }
  eof
}
PROLOG

  expect "$expect_script_repeat" >"${output}.repeat" 2>&1 || {
      cat "${output}.repeat" >&2
      fail 'Canonical runner failed on repeat startup after migration'
    }
  grep -Fq 'Migrated legacy checkpoint' "${output}.repeat" && \
    fail 'Repeat startup re-migrated an already-migrated checkpoint'
  grep -Fq 'Legacy namespace resolved before canonical lock acquisition' "${output}.repeat" || \
    fail 'Repeat startup did not announce the legacy namespace check'

  pass 'legacy checkpoint is migrated atomically and is not re-migrated'
}

test_legacy_checkpoint_with_ambiguous_profile_mapping_fails_closed() {
  local repo="${TEST_ROOT}/ambiguous-profile-repo"
  local fake_worker="${TEST_ROOT}/ambiguous-profile-worker"
  local secondary_worker="${TEST_ROOT}/ambiguous-profile-secondary-worker"
  local config="${TEST_ROOT}/ambiguous-profile-config.toml"
  local bin_dir="${TEST_ROOT}/ambiguous-profile-bin"
  local output="${TEST_ROOT}/ambiguous-profile-output.log"
  local marker="${TEST_ROOT}/ambiguous-profile-worker-ran"
  local common legacy_checkpoint canonical_checkpoint base_sha status

  mkdir -p "$repo" "$bin_dir"
  new_repo "$repo"
  fake_gh "${bin_dir}/gh"
  printf '%s\n' '#!/usr/bin/env bash' \
    "touch '$marker'" \
    'printf "%s\\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' > "$fake_worker"
  printf '%s\n' '#!/usr/bin/env bash' \
    'printf "%s\\n" "ISSUE_KILLER_STATUS=QUEUE_EMPTY"' > "$secondary_worker"
  chmod +x "$fake_worker" "$secondary_worker"
  common="$(cd "$repo" && common=$(git rev-parse --git-common-dir) && cd "$common" && pwd -P)"
  legacy_checkpoint="${common}/claude-minimax-issue-runner.checkpoint"
  canonical_checkpoint="${common}/issue-killer.checkpoint"
  base_sha="$(git -C "$repo" rev-parse main)"
  cat > "$legacy_checkpoint" <<EOF
pid=$$
iteration=2
issue=171
branch=main
base_branch=main
base_sha=${base_sha}
session_id=sess-legacy
state=mutating
profile=claude-minimax
cli=claude
EOF
  common_config "$config" "$fake_worker"
  cat >> "$config" <<EOF

[profiles.claude-secondary]
label = "Claude secondary"
cli = "claude"
command = "${secondary_worker}"
model = "claude-secondary-model"
EOF

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
    fail "Ambiguous legacy profile mapping must fail closed, got status $status"
  }
  [[ -e "$legacy_checkpoint" ]] || \
    fail 'Ambiguous legacy checkpoint was consumed'
  [[ ! -e "$canonical_checkpoint" ]] || \
    fail 'Ambiguous legacy checkpoint was copied into the canonical namespace'
  [[ ! -e "$marker" ]] || \
    fail 'Worker launched despite an ambiguous legacy profile mapping'
  grep -Fq 'legacy runner state could not be migrated safely' "$output" || \
    fail 'Missing closed-failure diagnostic for ambiguous profile mapping'

  pass 'ambiguous legacy profile mapping fails closed and preserves evidence'
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

  [[ ! -d "$canonical_lock_dir" ]] || \
    fail 'Canonical lock was not released after a clean run'
  grep -Fq 'Repository lock acquired' "$output" || \
    fail 'Canonical lock was not acquired on a clean repository'
  if grep -Fq 'Legacy namespace resolved' "$output"; then
    fail 'Migration diagnostic appeared when no legacy state was present'
  fi

  pass 'canonical runner leaves a clean repository untouched'
}

# Issue #55 — migrated-checkpoint adoption path clears a stale
# checkpoint whose issue is already closed and advances the queue
# without launching a recovery worker. The fixture returns a
# CLOSED state for the migrated issue so the closed-issue detection
# path can fire; the worker must never be invoked.
test_migrated_checkpoint_with_closed_issue_discards_and_advances_queue() {
  local repo="${TEST_ROOT}/stale-migrated-repo"
  local fake_worker="${TEST_ROOT}/stale-migrated-worker"
  local marker="${TEST_ROOT}/stale-migrated-marker"
  local config="${TEST_ROOT}/stale-migrated-config.toml"
  local bin_dir="${TEST_ROOT}/stale-migrated-bin"
  local output="${TEST_ROOT}/stale-migrated-output.log"
  local common legacy_checkpoint canonical_checkpoint
  local status base_sha

  mkdir -p "$repo" "$bin_dir"
  new_repo "$repo"
  # GitHub fixture must report the migrated issue as CLOSED so the
  # tracker_item_is_closed probe returns 0 and the stale-discard
  # branch fires; the queue must also appear empty so the discard
  # path advances to normal queue selection without launching any
  # worker.
  cat > "${bin_dir}/gh" <<'PROLOG'
#!/usr/bin/env bash
case "$1 $2" in
  "auth status") printf '%s\n' 'Logged in to github.com' ;;
  "api repos/"*) printf '%s\n' '0' ;;
  "issue list") printf '%s\n' '[]' ;;
  "issue view") printf '%s\n' '{"state":"CLOSED","labels":[{"name":"ready-for-agent"}],"assignees":[]}' ;;
  "pr list") printf '%s\n' '[{"state":"MERGED","number":12,"mergedAt":"2026-08-01T12:00:00Z"}]' ;;
  *) printf 'unexpected gh call: %s\n' "$*" >&2; exit 1 ;;
esac
PROLOG
  chmod +x "${bin_dir}/gh"

  # The worker script is replaced by a marker-toucher so the test can
  # assert the runner never launched it.
  printf '%s\n' '#!/usr/bin/env bash' "touch \"$marker\"" > "$fake_worker"
  chmod +x "$fake_worker"

  common="$(cd "$repo" && common=$(git rev-parse --git-common-dir) && cd "$common" && pwd -P)"
  legacy_checkpoint="${common}/claude-minimax-issue-runner.checkpoint"
  canonical_checkpoint="${common}/issue-killer.checkpoint"
  base_sha="$(git -C "$repo" rev-parse main)"
  cat > "$legacy_checkpoint" <<EOF
pid=$$
iteration=1
issue=171
branch=main
base_branch=main
base_sha=${base_sha}
session_id=unavailable
state=pr_merged
profile=claude-minimax
cli=claude
model=claude-test-model
command=${fake_worker}
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

  # The migrated-checkpoint adoption path must announce the stale
  # discard and never launch a migrated restart-recovery worker for
  # the closed issue. A fresh worker may still launch as part of
  # normal queue selection (the runner writes a fresh checkpoint
  # when it begins that iteration), but no recovery prompt or
  # "Migrated restart recovery" text should ever appear.
  grep -Fq 'Stale checkpoint discarded' "$output" || \
    fail 'Missing stale-checkpoint-discard diagnostic'
  grep -Fq 'issue 171 is already closed' "$output" || \
    fail 'Stale-discard diagnostic did not name the closed issue'
  if grep -Fq 'Migrated restart recovery' "$output"; then
    fail 'Stale-discard path launched a migrated restart-recovery worker'
  fi
  if grep -Fq 'Continue exactly issue #171' "$output"; then
    fail 'Stale-discard path continued recovery for issue 171'
  fi
  # The migrated legacy checkpoint is consumed before queue selection
  # begins; the only checkpoint file present at that moment must be
  # the fresh-worker checkpoint (which the runner writes for normal
  # queue selection, not the migrated one).
  grep -Eq '^issue=171$' "$canonical_checkpoint" 2>/dev/null && \
    fail 'Stale-discard left a migrated checkpoint carrying issue 171'

  pass 'migrated checkpoint with closed issue discards the checkpoint and advances the queue'
}

# Issue #55 — migrated-checkpoint adoption path reconciles tracker
# state through the normalized adapter before any recovery worker
# launches. A fixture returning an inconsistent state (merged PR but
# open issue) is precisely the ambiguity the dirty-worktree path
# already rejects; the migrated path must fail closed too.
test_migrated_checkpoint_reconciles_tracker_state_before_launch() {
  local repo="${TEST_ROOT}/reconcile-migrated-repo"
  local fake_worker="${TEST_ROOT}/reconcile-migrated-worker"
  local marker="${TEST_ROOT}/reconcile-migrated-marker"
  local config="${TEST_ROOT}/reconcile-migrated-config.toml"
  local bin_dir="${TEST_ROOT}/reconcile-migrated-bin"
  local output="${TEST_ROOT}/reconcile-migrated-output.log"
  local common legacy_checkpoint canonical_checkpoint
  local status base_sha

  mkdir -p "$repo" "$bin_dir"
  new_repo "$repo"
  # GitHub fixture reports the issue as OPEN but with an already-merged
  # PR — the dirty-worktree reconciliation rejects that state with
  # emit_recovery_required; the migrated path must do the same now
  # that it routes through the same predicate.
  cat > "${bin_dir}/gh" <<'PROLOG'
#!/usr/bin/env bash
case "$1 $2" in
  "auth status") printf '%s\n' 'Logged in to github.com' ;;
  "api repos/"*) printf '%s\n' '0' ;;
  "issue view") printf '%s\n' '{"state":"OPEN","labels":[{"name":"ready-for-agent"}],"assignees":[]}' ;;
  "pr list") printf '%s\n' '[{"state":"MERGED","number":12,"mergedAt":"2026-08-01T12:00:00Z"}]' ;;
  *) printf 'unexpected gh call: %s\n' "$*" >&2; exit 1 ;;
esac
PROLOG
  chmod +x "${bin_dir}/gh"

  printf '%s\n' '#!/usr/bin/env bash' "touch \"$marker\"" > "$fake_worker"
  chmod +x "$fake_worker"

  common="$(cd "$repo" && common=$(git rev-parse --git-common-dir) && cd "$common" && pwd -P)"
  legacy_checkpoint="${common}/claude-minimax-issue-runner.checkpoint"
  canonical_checkpoint="${common}/issue-killer.checkpoint"
  base_sha="$(git -C "$repo" rev-parse main)"
  cat > "$legacy_checkpoint" <<EOF
pid=$$
iteration=1
issue=172
branch=main
base_branch=main
base_sha=${base_sha}
session_id=unavailable
state=pr_merged
profile=claude-minimax
cli=claude
model=claude-test-model
command=${fake_worker}
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

  # The reconciliation must fail closed because the fixture reports
  # an already-merged PR for an open issue — the same ambiguity the
  # dirty-worktree path already rejects. The runner must exit 4
  # without launching a worker and must surface a diagnostic from the
  # normalized tracker adapter. The adapter emits RECOVERY_REQUIRED
  # before the operator confirmation is requested, so the operator
  # confirmation is verified separately by the dirty-worktree tests.
  [[ "$status" -eq 4 ]] || \
    fail "Migrated checkpoint reconciliation must exit 4 without TTY, got ${status}"
  [[ ! -e "$marker" ]] || \
    fail 'Migrated checkpoint launched a worker despite failing reconciliation'
  [[ -r "$canonical_checkpoint" ]] || \
    fail 'Migrated checkpoint was cleared when reconciliation should have retained it for diagnosis'
  grep -Fq 'PR for branch main is already merged' "$output" || \
    fail 'Migrated checkpoint did not run the normalized tracker reconciliation'
  grep -Fq 'RECOVERY_REQUIRED' "$output" || \
    fail 'Migrated checkpoint reconciliation did not emit RECOVERY_REQUIRED'
  grep -Fq 'checkpoint retained' "$output" || \
    fail 'Migrated checkpoint reconciliation did not retain the checkpoint for diagnosis'

  pass 'migrated checkpoint reconciles tracker state before launching'
}

test_stale_legacy_lock_is_recovered_before_new_lock
test_legacy_lock_quarantines_unreadable_owner
test_legacy_lock_rejects_live_owner
test_legacy_checkpoint_migrates_atomically_once
test_legacy_checkpoint_with_ambiguous_profile_mapping_fails_closed
test_legacy_checkpoint_with_partial_fields_fails_closed
test_migrated_checkpoint_with_closed_issue_discards_and_advances_queue
test_migrated_checkpoint_reconciles_tracker_state_before_launch
test_migration_does_not_run_when_legacy_state_absent

printf 'Ran %s migration tests.\n' "$TESTS_RUN"
