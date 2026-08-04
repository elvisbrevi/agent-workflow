#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELECTOR="${ROOT_DIR}/agent/issue-killer/tracker/selector.sh"
ADAPTER="${ROOT_DIR}/agent/issue-killer/tracker/azure-devops-adapter.sh"
BRANCH_MODULE="${ROOT_DIR}/agent/issue-killer/tracker/azure-hu-branch.sh"
CHECKPOINT_MODULE="${ROOT_DIR}/agent/issue-killer/state/checkpoint.sh"
LOCK_MODULE="${ROOT_DIR}/agent/issue-killer/state/repository-lock.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/azure-hu-branch.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

make_test_repo() {
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
case "$1 $2 $3" in
  "extension show --name") printf '%s\n' '{"name":"azure-devops"}' ;;
  "devops project show") printf '%s\n' '{"id":"project-id"}' ;;
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
  "boards work-item show")
    id=""
    previous=""
    for arg in "$@"; do
      if [[ "$previous" == "--id" ]]; then id="$arg"; fi
      previous="$arg"
    done
    case "$id" in
      100) printf '%s\n' '{"id":100,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent","System.Title":"Payments HU","System.CreatedDate":"2026-08-01T09:00:00Z"},"relations":[]}' ;;
      101) printf '%s\n' '{"id":101,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent","System.Title":"Fix checkout crash"},"relations":[]}' ;;
      102) printf '%s\n' '{"id":102,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent","System.Title":"Refactor billing module"},"relations":[]}' ;;
      103) printf '%s\n' '{"id":103,"fields":{"System.WorkItemType":"Bug","System.State":"Active","System.Tags":"ready-for-agent","System.Title":"Hotfix data race"},"relations":[]}' ;;
      104) printf '%s\n' '{"id":104,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent","System.Title":"Cleanup dashboard"},"relations":[]}' ;;
      105) printf '%s\n' '{"id":105,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent","System.Title":"Untitled","System.Description":"A refactor work item"},"relations":[]}' ;;
      110) printf '%s\n' '{"id":110,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent"},"relations":[]}' ;;
      *) exit 1 ;;
    esac
    ;;
  "boards query --wiql") printf '%s\n' '[]' ;;
  *) exit 1 ;;
esac
AZ
  chmod +x "${bin_dir}/az"
  export PATH="${bin_dir}:$PATH"
  export AZURE_TEST_CALLS="$calls"
  export RUNNER_NAME=tracker-test
}

# Directly test the category inference and branch naming helpers in
# isolation. The module is sourced directly so the tests do not need
# the full Azure adapter to run.
source "$BRANCH_MODULE"

# Helper: run a subshell that imports the branch module and asserts
# the inferred category for a given HU title snippet.
assert_category() {
  local hu_id="$1"
  local expected_category="$2"
  local got
  got="$(tracker_infer_hu_category \
    "$(cat "${TEST_ROOT}/hu-${hu_id}.json" 2>/dev/null || printf '' "")")"
  [[ "$got" == "$expected_category" ]] || \
    fail "HU ${hu_id} expected category ${expected_category}, got ${got}"
}

cat > "${TEST_ROOT}/hu-100.json" <<'JSON'
{"id":100,"fields":{"System.WorkItemType":"User Story","System.Title":"Payments HU"}}
JSON
cat > "${TEST_ROOT}/hu-101.json" <<'JSON'
{"id":101,"fields":{"System.WorkItemType":"User Story","System.Title":"Fix checkout crash"}}
JSON
cat > "${TEST_ROOT}/hu-102.json" <<'JSON'
{"id":102,"fields":{"System.WorkItemType":"User Story","System.Title":"Refactor billing module"}}
JSON
cat > "${TEST_ROOT}/hu-103.json" <<'JSON'
{"id":103,"fields":{"System.WorkItemType":"Bug","System.Title":"Hotfix data race"}}
JSON
cat > "${TEST_ROOT}/hu-104.json" <<'JSON'
{"id":104,"fields":{"System.WorkItemType":"User Story","System.Title":"Cleanup dashboard"}}
JSON
cat > "${TEST_ROOT}/hu-105.json" <<'JSON'
{"id":105,"fields":{"System.WorkItemType":"User Story","System.Title":"Untitled","System.Description":"A refactor work item"}}
JSON
cat > "${TEST_ROOT}/hu-110.json" <<'JSON'
{"id":110,"fields":{"System.WorkItemType":"User Story","System.Title":""}}
JSON

assert_category 100 feature
pass 'User Story with neutral title infers feature category'
assert_category 101 hotfix
pass 'User Story with fix-prefixed title infers hotfix category'
assert_category 102 refactor
pass 'User Story with refactor-prefixed title infers refactor category'
assert_category 103 hotfix
pass 'Bug work-item type always infers hotfix category'
assert_category 104 refactor
pass 'User Story with cleanup-prefixed title infers refactor category'
assert_category 105 refactor
pass 'Description keyword refactor infers refactor category'
assert_category 110 feature
pass 'Empty title falls back to a feature category'

if [[ "$(azure_hu_branch_slug_from_title 'Payments HU')" == "payments-hu" ]]; then
  pass 'title slug keeps lowercase letters and dashes'
else
  fail "payments-hu slug unexpected: $(azure_hu_branch_slug_from_title 'Payments HU')"
fi
if [[ "$(azure_hu_branch_slug_from_title '  Refactor / billing: module  ')" == "refactor-billing-module" ]]; then
  pass 'title slug collapses repeats and trims surrounding punctuation'
else
  fail "slug normalization failed: $(azure_hu_branch_slug_from_title '  Refactor / billing: module  ')"
fi
if [[ "$(azure_hu_branch_slug_from_title '')" == "hu" ]]; then
  pass 'empty title falls back to a stable slug'
else
  fail "empty title did not fall back: $(azure_hu_branch_slug_from_title '')"
fi

if [[ "$(tracker_compute_hu_branch 100 feature payments-hu)" == "feature/100-payments-hu" ]]; then
  pass 'branch name combines category, HU ID, and slug'
else
  fail 'branch name composition failed'
fi
if set +o pipefail; tracker_compute_hu_branch 100 plans payments-hu 2>&1 | grep -Fq 'unknown HU delivery category'; then
  pass 'branch composition rejects unknown categories'
else
  fail 'branch composition accepted unknown category'
fi

# End-to-end tests driven through the adapter ensure the bootstrap is
# actually wired into the tracker interface.
repo="${TEST_ROOT}/repo"
bin_dir="${TEST_ROOT}/bin"
calls="${TEST_ROOT}/calls"
make_test_repo "$repo" "$bin_dir" "$calls"

source "$SELECTOR"
adapter_path="$(tracker_select_adapter "$repo")" || \
  fail 'Azure remote was not selected'
source "$adapter_path"
# cd into the repo so tracker_item_read can locate the worktree and
# the Git commands can resolve branches with relative refs.
cd "$repo"

# Source the checkpoint and lock modules so the persistence helpers
# used by the bootstrap are available in the test scope.
# shellcheck source=agent/issue-killer/state/checkpoint.sh
source "$CHECKPOINT_MODULE"
# shellcheck source=agent/issue-killer/state/repository-lock.sh
source "$LOCK_MODULE"
GIT_COMMON_DIR="$(git rev-parse --git-common-dir)"
ITERATION=1
BASE_BRANCH="main"
timestamp() { date '+%Y-%m-%d %H:%M:%S %z'; }

# The bootstrap module is sourced by the adapter; the helper functions
# must be available to the same scope. We stub operator prompts so the
# non-interactive path can be exercised without a TTY.
TRACKER_KIND="azure-devops"
operator_session_available() { return 1; }

# Without a TTY, the bootstrap must refuse to guess the origin branch.
if tracker_prepare_hu_branch 100 >/dev/null 2>&1; then
  fail 'non-interactive bootstrap accepted an absent HU branch'
fi
pass 'non-interactive bootstrap refuses to guess the origin branch'

# Preseeding the HU branch lets the bootstrap succeed (reusing mode).
git -C "$repo" branch feature/100-payments-hu main >/dev/null
tracker_prepare_hu_branch 100 >/dev/null || \
  fail 'bootstrap did not reuse the existing HU branch'
[[ "$AZURE_HU_BRANCH_NAME" == "feature/100-payments-hu" ]] || \
  fail "expected feature/100-payments-hu, got ${AZURE_HU_BRANCH_NAME}"
[[ "$AZURE_HU_BRANCH_CATEGORY" == "feature" ]] || \
  fail "expected feature category, got ${AZURE_HU_BRANCH_CATEGORY}"
[[ "$AZURE_HU_BRANCH_REUSED" == "true" ]] || \
  fail 'bootstrap did not mark the branch as reused'
pass 'bootstrap reuses an existing HU branch with matching ancestry'

# The publish helper mirrors the bootstrap state into the worker-visible
# globals so the checkpoint and the lock status can persist it.
tracker_publish_hu_branch
[[ "$TRACKER_HU_BRANCH" == "feature/100-payments-hu" ]] || \
  fail "publish helper did not mirror hu branch: ${TRACKER_HU_BRANCH}"
[[ "$TRACKER_HU_BRANCH_CATEGORY" == "feature" ]] || \
  fail "publish helper did not mirror category: ${TRACKER_HU_BRANCH_CATEGORY}"
pass 'publish helper mirrors the HU branch into worker-visible globals'

# After publishing, the checkpoint must include the HU branch metadata.
write_checkpoint "scope_selected"
checkpoint="${repo}/.git/${RUNNER_NAME}.checkpoint"
[[ -r "$checkpoint" ]] || fail "checkpoint file is missing: $checkpoint"
grep -Fq 'hu_branch=feature/100-payments-hu' "$checkpoint" || \
  fail 'checkpoint did not persist the HU branch'
grep -Fq 'hu_category=feature' "$checkpoint" || \
  fail 'checkpoint did not persist the HU category'
pass 'checkpoint persists the HU branch and category'

# The reconciliation must reject a category that differs from the
# inferred one for the same HU.
if tracker_reconcile_hu_branch 'feature/100-payments-hu' 'main' \
      "$(git -C "$repo" rev-parse main)" 'hotfix' 100 \
      "$(cat "${TEST_ROOT}/hu-100.json")" \
      'echo ERR:' >/dev/null 2>&1; then
  fail 'reconciliation accepted a category that does not match the inferred one'
fi
pass 'reconciliation rejects a category that no longer matches the HU'

# And it must reject a branch identity that does not match the
# recomputed one for the same HU.
if tracker_reconcile_hu_branch 'feature/100-other-hu' 'main' \
      "$(git -C "$repo" rev-parse main)" 'feature' 100 \
      "$(cat "${TEST_ROOT}/hu-100.json")" \
      'echo ERR:' >/dev/null 2>&1; then
  fail 'reconciliation accepted a branch that does not match the recomputed name'
fi
pass 'reconciliation rejects a branch identity that conflicts with the recomputed name'

# An Azure-only Bug work item must still bootstrap into a hotfix
# category branch, exercising the type-based inference path.
git -C "$repo" branch hotfix/103-hotfix-data-race main >/dev/null
tracker_prepare_hu_branch 103 >/dev/null || \
  fail 'bootstrap did not reuse the hotfix HU branch for a Bug work item'
[[ "$AZURE_HU_BRANCH_CATEGORY" == "hotfix" ]] || \
  fail "expected hotfix category, got ${AZURE_HU_BRANCH_CATEGORY}"
pass 'bootstrap honours the Bug-type hotfix inference'

# During recovery, the bootstrap must stop safely if the persisted
# branch is missing, instead of re-prompting the operator.
if tracker_prepare_hu_branch 101 'true' >/dev/null 2>&1; then
  fail 'recovery bootstrap accepted a missing HU branch'
fi
pass 'recovery bootstrap refuses to guess when the persisted branch is missing'

# Reconciliation must reject an unknown persisted category even when
# the branch identity is sane.
if tracker_reconcile_hu_branch 'feature/100-payments-hu' 'main' \
      "$(git -C "$repo" rev-parse main)" 'mistake' 100 \
      "$(cat "${TEST_ROOT}/hu-100.json")" \
      'echo ERR:' >/dev/null 2>&1; then
  fail 'reconciliation accepted an unknown category'
fi
pass 'reconciliation rejects an unknown persisted category'

# Reconciliation must reject a persisted origin that is not in the
# closed allow-list (master, develop).
if tracker_reconcile_hu_branch 'feature/100-payments-hu' 'main' \
      "$(git -C "$repo" rev-parse main)" 'feature' 100 \
      "$(cat "${TEST_ROOT}/hu-100.json")" \
      'echo ERR:' >/dev/null 2>&1; then
  fail 'reconciliation accepted a disallowed origin branch'
fi
pass 'reconciliation rejects a persisted origin outside the allowed enum'

# The locked-down category set must reject values outside the enum.
if azure_hu_branch_category_is_known 'feature'; then
  pass 'feature is a known category'
else
  fail 'feature is not a known category'
fi
if azure_hu_branch_category_is_known 'experiment'; then
  fail 'experiment was accepted as a category'
fi
pass 'experiments are not a valid HU delivery category'

# The prompt helper must reject bogus input and only accept the two
# allowed origin branches. The stub below drives the prompt through
# an invalid origin first, then accepts the next value.
read_answers=('main' 'develop')
read_index=0
operator_session_available() { return 0; }
operator_prompt() { :; }
operator_read_answer() { OPERATOR_ANSWER="${read_answers[$((read_index++))]}"; }
prompt_response="$(azure_hu_branch_prompt_origin)"
if [[ "$prompt_response" == "develop" ]]; then
  pass 'prompt helper rejects an invalid origin and accepts develop'
else
  fail "prompt helper did not accept develop: '$prompt_response'"
fi

# The default origin is honoured when the operator leaves the answer
# blank. The stub answers empty for the first prompt, then the
# next stub returns a deliberate value to confirm the helper
# re-prompts.
read_answers=('' 'master')
read_index=0
operator_read_answer() { OPERATOR_ANSWER="${read_answers[$((read_index++))]}"; }
prompt_response="$(azure_hu_branch_prompt_origin 'master')"
if [[ "$prompt_response" == "master" ]]; then
  pass 'prompt helper honours the default origin'
else
  fail "prompt helper did not honour the default origin: '$prompt_response'"
fi

# The default origin is also honoured when the helper is asked for
# develop specifically.
read_answers=('' 'develop')
read_index=0
operator_read_answer() { OPERATOR_ANSWER="${read_answers[$((read_index++))]}"; }
prompt_response="$(azure_hu_branch_prompt_origin 'develop')"
if [[ "$prompt_response" == "develop" ]]; then
  pass 'prompt helper honours develop as the default'
else
  fail "prompt helper did not accept develop: '$prompt_response'"
fi

# The branch creation helper must fail when the origin is missing, and
# succeed when the origin is present.
git -C "$repo" branch develop main >/dev/null
if azure_hu_branch_create 'feature/100-payments-hu' 'missing' 2>/dev/null; then
  fail 'origin creation accepted a missing origin branch'
fi
git -C "$repo" branch -D develop 2>/dev/null || true
pass 'origin creation refuses a missing origin branch'

# The persisted checkpoint and lock status must both expose the HU
# branch, category, and origin metadata. The mocks above populated the
# TRACKER_HU_BRANCH variables; the lock status helper writes them out
# through the canonical helper.
TRACKER_HU_BRANCH="feature/100-payments-hu"
TRACKER_HU_BRANCH_CATEGORY="feature"
TRACKER_HU_BRANCH_ORIGIN="main"
checksum_repo="${TEST_ROOT}/checksum-repo"
mkdir -p "$checksum_repo"
git -C "$checksum_repo" init -b main --quiet >/dev/null
git -C "$checksum_repo" -c init.defaultBranch=main commit --allow-empty -m seed >/dev/null
GIT_COMMON_DIR="$(git -C "$checksum_repo" rev-parse --git-common-dir)"
LOCK_DIR="${GIT_COMMON_DIR}/issue-killer.lock"
mkdir "$LOCK_DIR"
LOCK_HELD=true
ITERATION=1
write_lock_status "scope_selected" 0
grep -Fq 'hu_branch=feature/100-payments-hu' "${LOCK_DIR}/status" || \
  fail 'lock status did not persist the HU branch'
grep -Fq 'hu_category=feature' "${LOCK_DIR}/status" || \
  fail 'lock status did not persist the HU category'
grep -Fq 'hu_origin=main' "${LOCK_DIR}/status" || \
  fail 'lock status did not persist the HU origin'
pass 'lock status mirrors the HU branch metadata'

# The category must round-trip through the persistence layer so
# repeated runs always see the same branch name for the same HU.
write_checkpoint "scope_selected"
grep -Fq 'hu_branch=feature/100-payments-hu' "${repo}/.git/${RUNNER_NAME}.checkpoint" || \
  fail 'checkpoint did not persist the HU branch after second write'
pass 'checkpoint updates reflect the persisted HU branch on subsequent writes'

unset TRACKER_HU_BRANCH TRACKER_HU_BRANCH_CATEGORY TRACKER_HU_BRANCH_ORIGIN TRACKER_HU_BRANCH_ORIGIN_SHA
write_checkpoint "scope_selected"
grep -q 'hu_branch=' "${repo}/.git/${RUNNER_NAME}.checkpoint" && \
  fail 'checkpoint persists hu_branch even when the variable is unset'
pass 'checkpoint omits hu_branch fields when the integration branch is unset'

printf '%s Azure HU integration branch tests passed.\n' 20
