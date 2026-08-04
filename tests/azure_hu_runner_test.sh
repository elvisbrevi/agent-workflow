#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="${ROOT_DIR}/agent/issue-killer/run.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/azure-hu-runner.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

make_azure_repo() {
  local repo="$1"
  local bin_dir="$2"
  local calls="$3"
  mkdir -p "${repo}/docs/agents" "$bin_dir"
  git -C "$repo" init -b main --quiet
  git -C "$repo" config user.name Fixture
  git -C "$repo" config user.email fixture@example.test
  printf '%s\n' '# fixture' > "${repo}/README.md"
  cat > "${repo}/docs/agents/issue-tracker.md" <<'DOC'
# Issue Tracker: Azure DevOps

Use the `az` CLI for all operations.

## Azure DevOps configuration

organization = "example-org"
project = "example-project"
repository = "example-repo"
eligible_work_item_types = ["User Story", "Bug", "Task"]
epic_work_item_types = ["Epic"]
delivery_hu_work_item_types = ["User Story"]
delivery_ticket_work_item_types = ["Task", "Bug"]
open_states = ["New", "Active"]
closed_states = ["Closed", "Done"]
ready_tag = "ready-for-agent"
claim_identity = "operator@example.com"
predecessor_relation = "System.LinkTypes.Dependency-Reverse"
closed_state = "Done"
DOC
  git -C "$repo" add .
  git -C "$repo" commit --quiet -m 'test: seed'
  git -C "$repo" remote add origin \
    https://dev.azure.com/example-org/example-project/_git/example-repo

  cat > "${bin_dir}/az" <<'AZ'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$AZURE_TEST_CALLS"
case "$1 $2 $3" in
  "extension show --name") printf '%s\n' '{"name":"azure-devops"}' ;;
  "devops project show") printf '%s\n' '{"id":"project-id","name":"example-project"}' ;;
  "devops user show") printf '%s\n' '{"user":{"mail":"operator@example.com"}}' ;;
  "devops invoke --area")
    if [[ "$*" == *'type='* ]]; then
      printf '%s\n' '{"states":[{"name":"New","category":"Proposed"},{"name":"Active","category":"InProgress"},{"name":"Closed","category":"Completed"},{"name":"Done","category":"Completed"}]}'
    else
      printf '%s\n' '{"value":[{"name":"User Story"},{"name":"Bug"},{"name":"Task"},{"name":"Epic"}]}'
    fi
    ;;
  "repos show --repository") printf '%s\n' '{"id":"repository-id","name":"example-repo"}' ;;
  "boards work-item relation") printf '%s\n' '[{"referenceName":"System.LinkTypes.Dependency-Reverse"}]' ;;
  "boards query --wiql") printf '%s\n' '[{"id":100}]' ;;
  "boards work-item show")
    id=""
    previous=""
    for arg in "$@"; do
      if [[ "$previous" == "--id" ]]; then id="$arg"; fi
      previous="$arg"
    done
    case "$id" in
      100) printf '%s\n' '{"id":100,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent","System.Title":"Payments HU","System.CreatedDate":"2026-08-01T09:00:00Z"},"relations":[{"rel":"System.LinkTypes.Hierarchy-Forward","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/103"}]}' ;;
      103) printf '%s\n' '{"id":103,"fields":{"System.WorkItemType":"Task","System.State":"Active","System.CreatedDate":"2026-08-01T12:00:00Z"},"relations":[]}' ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
AZ
  chmod +x "${bin_dir}/az"
  export AZURE_TEST_CALLS="$calls"
}

write_config() {
  local config="$1"
  local worker="$2"
  cat > "$config" <<CONFIG
 default_profile = "fixture"

[profiles.fixture]
label = "Azure fixture"
cli = "claude"
command = "$worker"
model = "fixture-model"

[profiles.fixture.options]
permission_mode = "bypassPermissions"
CONFIG
}

azure_repo="${TEST_ROOT}/azure-repo"
azure_bin="${TEST_ROOT}/azure-bin"
azure_calls="${TEST_ROOT}/azure-calls"
mkdir -p "$azure_repo"
make_azure_repo "$azure_repo" "$azure_bin" "$azure_calls"

# Most runner tests run without a TTY, so the HU integration branch
# must already exist for the bootstrap to reuse it instead of asking
# the operator for an origin. The fixture seeds HU 100 ("Payments HU"),
# so the deterministic branch is feature/100-payments-hu.
git -C "$azure_repo" branch feature/100-payments-hu main >/dev/null 2>&1 || true

malformed_worker="${TEST_ROOT}/malformed-worker"
printf '%s\n' '#!/usr/bin/env bash' "touch '${TEST_ROOT}/malformed-ran'" > "$malformed_worker"
chmod +x "$malformed_worker"
malformed_config="${TEST_ROOT}/malformed.toml"
write_config "$malformed_config" "$malformed_worker"
if PATH="$azure_bin:$PATH" ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$malformed_config" "$RUNNER" --hu nope "$azure_repo" \
  >"${TEST_ROOT}/malformed.log" 2>&1; then
  fail 'Malformed --hu option was accepted'
fi
[[ ! -e "${TEST_ROOT}/malformed-ran" ]] || fail 'Worker launched for malformed --hu option'
grep -Fq 'positive numeric ID' "${TEST_ROOT}/malformed.log" || fail 'Malformed --hu diagnostic was not actionable'
pass 'runner rejects malformed --hu before launching a worker'

scope_worker="${TEST_ROOT}/scope-worker"
cat > "$scope_worker" <<'WORKER'
#!/usr/bin/env bash
last=''
for argument in "$@"; do last="$argument"; done
printf '%s\n' "$last" > "$RUNNER_TEST_PROMPT"
printf '%s\n' 'ISSUE_KILLER_STATUS=QUEUE_EMPTY'
WORKER
chmod +x "$scope_worker"
scope_config="${TEST_ROOT}/scope.toml"
write_config "$scope_config" "$scope_worker"
PATH="$azure_bin:$PATH" \
ISSUE_RUNNER_ASSUME_YES=true \
ISSUE_KILLER_CONFIG_PATH="$scope_config" \
RUNNER_TEST_PROMPT="${TEST_ROOT}/scope-prompt" \
  "$RUNNER" --hu 100 "$azure_repo" >"${TEST_ROOT}/scope.log" 2>&1 || \
  fail 'Runner did not complete the pinned Azure scope fixture'
grep -Fq 'The pinned delivery HU is 100' "${TEST_ROOT}/scope-prompt" || fail 'Prompt omitted HU identity'
grep -Fq 'active delivery ticket is 103' "${TEST_ROOT}/scope-prompt" || fail 'Prompt omitted ticket identity'
grep -Fq 'do not select or inspect another' "${TEST_ROOT}/scope-prompt" || fail 'Prompt did not pin queue scope'
pass 'runner delivers a worker prompt pinned to one HU and ticket'

identity_worker="${TEST_ROOT}/identity-worker"
cat > "$identity_worker" <<'WORKER'
#!/usr/bin/env bash
touch "$RUNNER_TEST_STARTED"
while [[ ! -e "$RUNNER_TEST_RELEASE" ]]; do sleep 0.1; done
printf '%s\n' 'ISSUE_KILLER_STATUS=FAILED'
WORKER
chmod +x "$identity_worker"
identity_config="${TEST_ROOT}/identity.toml"
write_config "$identity_config" "$identity_worker"
identity_started="${TEST_ROOT}/identity-started"
identity_release="${TEST_ROOT}/identity-release"
identity_output="${TEST_ROOT}/identity.log"
PATH="$azure_bin:$PATH" \
ISSUE_RUNNER_ASSUME_YES=true \
ISSUE_KILLER_CONFIG_PATH="$identity_config" \
RUNNER_TEST_STARTED="$identity_started" \
RUNNER_TEST_RELEASE="$identity_release" \
  "$RUNNER" --hu 100 "$azure_repo" >"$identity_output" 2>&1 &
identity_pid=$!
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [[ -e "$identity_started" ]] && break
  sleep 0.1
done
[[ -e "$identity_started" ]] || fail 'Pinned identity worker did not start'
lock_status="${azure_repo}/.git/issue-killer.lock/status"
grep -Eq '^hu=100$' "$lock_status" || fail 'Lock status omitted the pinned HU identity'
grep -Eq '^ticket=103$' "$lock_status" || fail 'Lock status omitted the pinned ticket identity'
grep -Eq '^issue=103$' "$lock_status" || fail 'Lock status did not identify the ticket as the worker unit'
touch "$identity_release"
set +e
wait "$identity_pid"
identity_status=$?
set -e
[[ "$identity_status" -eq 1 ]] || fail "Failed identity worker returned $identity_status"
checkpoint="${azure_repo}/.git/issue-killer.checkpoint"
grep -Eq '^hu=100$' "$checkpoint" || fail 'Checkpoint omitted the pinned HU identity'
grep -Eq '^ticket=103$' "$checkpoint" || fail 'Checkpoint omitted the pinned ticket identity'
grep -Eq '^issue=103$' "$checkpoint" || fail 'Checkpoint did not preserve the active ticket identity'
rm -f "$checkpoint"
pass 'checkpoint and lock status pin both HU and ticket identity'

# GitHub must reject the Azure-only option before launching its worker.
github_repo="${TEST_ROOT}/github-repo"
github_bin="${TEST_ROOT}/github-bin"
mkdir -p "$github_repo/docs/agents" "$github_bin"
git -C "$github_repo" init -b main --quiet
git -C "$github_repo" config user.name Fixture
git -C "$github_repo" config user.email fixture@example.test
printf '%s\n' '# fixture' > "$github_repo/README.md"
printf '%s\n' '# Issue Tracker: GitHub' '' 'Use the `gh` CLI for all operations.' > "$github_repo/docs/agents/issue-tracker.md"
git -C "$github_repo" add .
git -C "$github_repo" commit --quiet -m 'test: seed'
git -C "$github_repo" remote add origin https://github.com/example/example.git
cat > "$github_bin/gh" <<'GH'
#!/usr/bin/env bash
case "$1 $2" in
  "auth status") printf '%s\n' 'Logged in to github.com' ;;
  *) exit 1 ;;
esac
GH
chmod +x "$github_bin/gh"
github_worker="${TEST_ROOT}/github-worker"
printf '%s\n' '#!/usr/bin/env bash' "touch '${TEST_ROOT}/github-ran'" > "$github_worker"
chmod +x "$github_worker"
github_config="${TEST_ROOT}/github.toml"
write_config "$github_config" "$github_worker"
if PATH="$github_bin:$PATH" ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$github_config" "$RUNNER" --hu 100 "$github_repo" \
  >"${TEST_ROOT}/github.log" 2>&1; then
  fail 'GitHub accepted an Azure-only --hu option'
fi
[[ ! -e "${TEST_ROOT}/github-ran" ]] || fail 'GitHub worker launched with --hu'
grep -Fq 'only supported for Azure DevOps' "${TEST_ROOT}/github.log" || fail 'GitHub --hu diagnostic was not actionable'
pass 'GitHub rejects the Azure-only --hu option'

printf '%s Azure HU runner tests passed.\n' 4
