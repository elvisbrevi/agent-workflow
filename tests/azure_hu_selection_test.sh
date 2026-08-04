#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELECTOR="${ROOT_DIR}/agent/issue-killer/tracker/selector.sh"
ADAPTER="${ROOT_DIR}/agent/issue-killer/tracker/azure-devops-adapter.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/azure-hu-selection.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

repo="${TEST_ROOT}/repo"
bin_dir="${TEST_ROOT}/bin"
calls="${TEST_ROOT}/calls"
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
  "boards query --wiql") printf '%s\n' '[{"id":200},{"id":100}]' ;;
  "boards work-item show")
    id=""
    previous=""
    for arg in "$@"; do
      if [[ "$previous" == "--id" ]]; then id="$arg"; fi
      previous="$arg"
    done
    case "$id" in
      100) printf '%s\n' '{"id":100,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent","System.Title":"Payments HU","System.CreatedDate":"2026-08-01T09:00:00Z"},"relations":[{"rel":"System.LinkTypes.Hierarchy-Forward","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/101"},{"rel":"System.LinkTypes.Hierarchy-Forward","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/102"},{"rel":"System.LinkTypes.Hierarchy-Forward","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/103"},{"rel":"System.LinkTypes.Hierarchy-Forward","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/107"},{"rel":"System.LinkTypes.Related","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/104"},{"rel":"System.LinkTypes.Hierarchy-Forward","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/105"}]}' ;;
      200) printf '%s\n' '{"id":200,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent","System.Title":"Later HU","System.CreatedDate":"2026-08-02T09:00:00Z"},"relations":[]}' ;;
      300) printf '%s\n' '{"id":300,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent","System.Title":"Blocked HU","System.CreatedDate":"2026-08-03T09:00:00Z"},"relations":[{"rel":"System.LinkTypes.Hierarchy-Forward","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/102"}]}' ;;
      400) printf '%s\n' '{"id":400,"fields":{"System.WorkItemType":"Task","System.State":"Active","System.Tags":"ready-for-agent","System.Title":"Not an HU"},"relations":[]}' ;;
      500) printf '%s\n' '{"id":500,"fields":{"System.WorkItemType":"User Story","System.State":"Done","System.Tags":"ready-for-agent","System.Title":"Closed HU"},"relations":[]}' ;;
      600) printf '%s\n' '{"id":600,"fields":{"System.WorkItemType":"Epic","System.State":"Active","System.Tags":"ready-for-agent","System.Title":"Epic"},"relations":[]}' ;;
      800) printf '%s\n' '{"id":800,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.AssignedTo":{"displayName":"Already claimed"},"System.Tags":"ready-for-agent","System.Title":"Assigned HU"},"relations":[]}' ;;
      101) printf '%s\n' '{"id":101,"fields":{"System.WorkItemType":"Task","System.State":"Closed","System.CreatedDate":"2026-08-01T10:00:00Z"},"relations":[]}' ;;
      102) printf '%s\n' '{"id":102,"fields":{"System.WorkItemType":"Bug","System.State":"Active","System.CreatedDate":"2026-08-01T11:00:00Z"},"relations":[{"rel":"System.LinkTypes.Dependency-Reverse","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/110"}]}' ;;
      103) printf '%s\n' '{"id":103,"fields":{"System.WorkItemType":"Task","System.State":"Active","System.CreatedDate":"2026-08-01T12:00:00Z"},"relations":[{"rel":"System.LinkTypes.Hierarchy-Reverse","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/100"},{"rel":"System.LinkTypes.Hierarchy-Forward","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/106"}]}' ;;
      104) printf '%s\n' '{"id":104,"fields":{"System.WorkItemType":"Task","System.State":"Active","System.CreatedDate":"2026-08-01T09:30:00Z"},"relations":[]}' ;;
      105) printf '%s\n' '{"id":105,"fields":{"System.WorkItemType":"Epic","System.State":"Active","System.CreatedDate":"2026-08-01T08:30:00Z"},"relations":[]}' ;;
      106) printf '%s\n' '{"id":106,"fields":{"System.WorkItemType":"Task","System.State":"Active","System.CreatedDate":"2026-08-01T13:00:00Z"},"relations":[]}' ;;
      107) printf '%s\n' '{"id":107,"fields":{"System.WorkItemType":"Bug","System.State":"Active","System.CreatedDate":"2026-08-01T12:00:00Z"},"relations":[]}' ;;
      110) printf '%s\n' '{"id":110,"fields":{"System.WorkItemType":"Task","System.State":"Active","System.CreatedDate":"2026-08-01T07:00:00Z"},"relations":[]}' ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
AZ
chmod +x "${bin_dir}/az"
export PATH="${bin_dir}:$PATH"
export AZURE_TEST_CALLS="$calls"
export RUNNER_NAME=tracker-test

source "$SELECTOR"
adapter_path="$(tracker_select_adapter "$repo")" || fail 'Azure remote was not selected'
[[ "$adapter_path" == "$ADAPTER" ]] || fail "Unexpected adapter: $adapter_path"
source "$adapter_path"
tracker_initialize "$repo" >/dev/null || fail 'Azure initialization failed'

if tracker_validate_run_options abc; then
  fail 'Malformed HU identifier was accepted'
fi
pass 'malformed HU identifiers fail before tracker mutation'

tracker_prepare_worker_scope 100 || fail 'Explicit HU scope preparation failed'
[[ "$TRACKER_SCOPE_STATUS" == ready ]] || fail "Expected ready scope, got $TRACKER_SCOPE_STATUS"
[[ "$TRACKER_SCOPE_HU" == 100 ]] || fail "Expected HU 100, got $TRACKER_SCOPE_HU"
[[ "$TRACKER_SCOPE_ITEM" == 103 ]] || fail "Expected first unblocked direct child 103, got $TRACKER_SCOPE_ITEM"
pass 'explicit HU pins the first eligible direct child'

scope_prompt="$(tracker_worker_scope_prompt)"
grep -Fq 'HU 100' <<<"$scope_prompt" || fail 'Scope prompt omitted the pinned HU'
grep -Fq 'ticket 103' <<<"$scope_prompt" || fail 'Scope prompt omitted the pinned ticket'
grep -Fq 'do not select or inspect another' <<<"$scope_prompt" || fail 'Scope prompt did not forbid queue switching'
pass 'worker prompt is pinned to one HU and ticket'

tracker_prepare_worker_scope "" || fail 'Automatic HU discovery failed'
[[ "$TRACKER_SCOPE_HU" == 100 && "$TRACKER_SCOPE_ITEM" == 103 ]] || \
  fail "Automatic discovery selected ${TRACKER_SCOPE_HU}/${TRACKER_SCOPE_ITEM}"
pass 'automatic discovery selects the next prepared HU'

tracker_prepare_worker_scope 200 || fail 'Empty HU scope preparation failed'
[[ "$TRACKER_SCOPE_STATUS" == empty ]] || fail "Expected empty scope, got $TRACKER_SCOPE_STATUS"
pass 'completed and absent children produce an empty HU scope'

tracker_prepare_worker_scope 300 || fail 'Blocked HU scope preparation failed'
[[ "$TRACKER_SCOPE_STATUS" == blocked ]] || fail "Expected blocked scope, got $TRACKER_SCOPE_STATUS"
[[ "$AZURE_SCOPE_PENDING_COUNT" == 1 && "$AZURE_SCOPE_BLOCKED_COUNT" == 1 ]] || \
  fail 'Blocked scope did not preserve pending and predecessor counts'
pass 'a HU with only blocked children stops without selecting a ticket'

STARTUP_RECOVERY_MODE=checkpoint
CHECKPOINT_HU=100
CHECKPOINT_TICKET=103
tracker_prepare_worker_scope "" || fail 'Pinned recovery scope preparation failed'
[[ "$TRACKER_SCOPE_STATUS" == ready && "$TRACKER_SCOPE_HU" == 100 && "$TRACKER_SCOPE_ITEM" == 103 ]] || \
  fail 'Recovery scope did not preserve the pinned HU and ticket'
CHECKPOINT_TICKET=106
if tracker_prepare_worker_scope "" >/dev/null 2>&1; then
  fail 'Recovery scope accepted an indirect ticket and changed identity'
fi
unset STARTUP_RECOVERY_MODE CHECKPOINT_HU CHECKPOINT_TICKET
pass 'recovery preserves the pinned HU and rejects identity changes'

for invalid_hu in 400 500 600 800; do
  if tracker_prepare_worker_scope "$invalid_hu" >/dev/null 2>&1; then
    fail "Invalid HU $invalid_hu was accepted"
  fi
done
pass 'tasks, terminal items, and epics cannot become delivery HUs'

if tracker_prepare_worker_scope 999; then
  fail 'Unavailable explicit HU was accepted'
fi
pass 'unavailable explicit HU fails closed'

printf '%s Azure HU selection tests passed.\n' 10
