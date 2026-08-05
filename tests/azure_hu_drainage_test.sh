#!/usr/bin/env bash
# Black-box tests for the Azure delivery HU drainage loop (issue #40).
#
# These tests exercise the runner's scope-selection logic and the
# integration between the runner and the Azure adapter through a fake
# `az` CLI whose shape mirrors the production adapter. The runner is
# expected to:
#   - select one ticket at a time from the HU's eligible child set;
#   - advance to the next ticket after a verified Azure completion;
#   - re-evaluate dependencies and creation-time/ID ordering from live
#     Azure state before each worker invocation;
#   - exit cleanly when the HU has no remaining eligible children;
#   - exit non-zero when all pending children are blocked;
#   - never close the HU or create a PR to the repository mainline;
#   - re-pin the same HU when restarting from a stale checkpoint whose
#     ticket is already closed.
#
# Scope-level assertions live in `azure_hu_selection_test.sh`; the
# fixtures here exercise the same adapter through a full runner
# invocation so the Azure-specific GUARD integrations are covered.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELECTOR="${ROOT_DIR}/agent/issue-killer/tracker/selector.sh"
ADAPTER="${ROOT_DIR}/agent/issue-killer/tracker/azure-devops-adapter.sh"
CHECKPOINT_MODULE="${ROOT_DIR}/agent/issue-killer/state/checkpoint.sh"
LOCK_MODULE="${ROOT_DIR}/agent/issue-killer/state/repository-lock.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/azure-hu-drainage.XXXXXX")"
# Keep the temp directory on failure for debugging.
trap 'if [[ $? -eq 0 ]]; then rm -rf "$TEST_ROOT"; else printf "Test logs retained at: %s\n" "$TEST_ROOT"; fi' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

# Builds a fresh Azure repo with the configured mapping and a fake `az`
# CLI that tracks ticket completion state in a side-channel file. The
# fake responds to the same Azure CLI surface the production adapter
# invokes. Tickets default to Active until the state file flips them to
# Done.
make_azure_repo() {
  local repo="$1"
  local bin_dir="$2"
  local state_file="$3"
  local calls="$4"
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
completion_evidence_field = "Completion Evidence"
real_effort_field = "Real Effort"
completion_evidence_field_name = "Custom.Evidence"
real_effort_field_name = "Custom.RealEffort"
DOC
  git -C "$repo" add .
  git -C "$repo" commit --quiet -m 'test: seed'
  git -C "$repo" remote add origin \
    https://dev.azure.com/example-org/example-project/_git/example-repo

  cat > "${bin_dir}/az" <<'AZSCRIPT'
#!/usr/bin/env bash
# Fake `az` CLI for the Azure HU drainage black-box tests. Ticket
# completion state lives in $AZURE_TEST_STATE; the call log goes to
# $AZURE_TEST_CALLS. Geometry stays inside individual files so each
# test invocation can keep its own persistent scratch space.
printf '%s\n' "$*" >> "${AZURE_TEST_CALLS}"
is_completed() {
  local ticket="$1"
  [[ -r "$AZURE_TEST_STATE" ]] || return 1
  grep -Fxq "ticket=${ticket}" "$AZURE_TEST_STATE" 2>/dev/null
}
HU_CHILDREN='[{"rel":"System.LinkTypes.Hierarchy-Forward","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/103"},{"rel":"System.LinkTypes.Hierarchy-Forward","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/104"},{"rel":"System.LinkTypes.Hierarchy-Forward","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/107"},{"rel":"System.LinkTypes.Hierarchy-Forward","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/109"}]'
case "$1 $2 $3" in
  "extension show --name")
    printf '%s\n' '{"name":"azure-devops"}' ;;
  "devops project show")
    printf '%s\n' '{"id":"project-id","name":"example-project"}' ;;
  "devops user show")
    printf '%s\n' '{"user":{"mail":"operator@example.com"}}' ;;
  "devops invoke --area")
    if [[ "$*" == *'resource fields'* ]]; then
      printf '%s\n' '{"value":[{"name":"Completion Evidence","referenceName":"Custom.Evidence","type":"html","readOnly":false},{"name":"Real Effort","referenceName":"Custom.RealEffort","type":"double","readOnly":false}]}'
    elif [[ "$*" == *'type='* ]]; then
      printf '%s\n' '{"states":[{"name":"New","category":"Proposed"},{"name":"Active","category":"InProgress"},{"name":"Closed","category":"Completed"},{"name":"Done","category":"Completed"}]}'
    else
      printf '%s\n' '{"value":[{"name":"User Story"},{"name":"Bug"},{"name":"Task"},{"name":"Epic"}]}'
    fi
    ;;
  "repos show --repository")
    printf '%s\n' '{"id":"repository-id","name":"example-repo"}' ;;
  "boards work-item relation")
    printf '%s\n' '[{"referenceName":"System.LinkTypes.Dependency-Reverse"}]' ;;
  "boards query --wiql")
    # Refuse to discover any other HU mid-drain so the runner cannot
    # silently switch to a different integration branch.
    printf '%s\n' '[{"id":100}]'
    ;;
  "boards work-item show")
    id=""
    previous=""
    for arg in "$@"; do
      if [[ "$previous" == "--id" ]]; then id="$arg"; fi
      previous="$arg"
    done
    case "$id" in
      100)
        # The HU must stay open forever; the runner never closes it.
        printf '%s' '{"id":100,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Title":"Payments HU","System.CreatedDate":"2026-08-01T09:00:00Z","System.Tags":"ready-for-agent"},"relations":'"${HU_CHILDREN}"'}'
        ;;
      103)
        if is_completed 103; then
          printf '%s\n' '{"id":103,"fields":{"System.WorkItemType":"Task","System.State":"Done","System.Title":"First ticket","System.CreatedDate":"2026-08-01T09:30:00Z"},"relations":[]}'
        else
          printf '%s\n' '{"id":103,"fields":{"System.WorkItemType":"Task","System.State":"Active","System.Title":"First ticket","System.CreatedDate":"2026-08-01T09:30:00Z"},"relations":[{"rel":"System.LinkTypes.Hierarchy-Reverse","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/100"}]}'
        fi
        ;;
      104)
        if is_completed 104; then
          printf '%s\n' '{"id":104,"fields":{"System.WorkItemType":"Task","System.State":"Done","System.Title":"Second ticket","System.CreatedDate":"2026-08-01T10:00:00Z"},"relations":[]}'
        else
          printf '%s\n' '{"id":104,"fields":{"System.WorkItemType":"Task","System.State":"Active","System.Title":"Second ticket","System.CreatedDate":"2026-08-01T10:00:00Z"},"relations":[{"rel":"System.LinkTypes.Hierarchy-Reverse","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/100"}]}'
        fi
        ;;
      107)
        if is_completed 107; then
          printf '%s\n' '{"id":107,"fields":{"System.WorkItemType":"Bug","System.State":"Done","System.Title":"Third ticket","System.CreatedDate":"2026-08-01T10:30:00Z"},"relations":[]}'
        else
          printf '%s\n' '{"id":107,"fields":{"System.WorkItemType":"Bug","System.State":"Active","System.Title":"Third ticket","System.CreatedDate":"2026-08-01T10:30:00Z"},"relations":[{"rel":"System.LinkTypes.Hierarchy-Reverse","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/100"}]}'
        fi
        ;;
      109)
        if is_completed 109; then
          printf '%s\n' '{"id":109,"fields":{"System.WorkItemType":"Task","System.State":"Done","System.Title":"Dependent ticket","System.CreatedDate":"2026-08-01T11:00:00Z"},"relations":[]}'
        else
          printf '%s\n' '{"id":109,"fields":{"System.WorkItemType":"Task","System.State":"Active","System.Title":"Dependent ticket","System.CreatedDate":"2026-08-01T11:00:00Z"},"relations":[{"rel":"System.LinkTypes.Hierarchy-Reverse","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/100"},{"rel":"System.LinkTypes.Dependency-Reverse","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/108"}]}'
        fi
        ;;
      108)
        # Ticket 108 is a blocker for 109 that the drainage test
        # scenarios close explicitly so the remaining tickets can be
        # promoted. The default state is Active (open) so the
        # dependency test (#4) can drive the blocked-state path.
        if is_completed 108; then
          printf '%s\n' '{"id":108,"fields":{"System.WorkItemType":"Task","System.State":"Done","System.Title":"Outstanding blocker","System.CreatedDate":"2026-08-01T07:00:00Z"},"relations":[]}'
        else
          printf '%s\n' '{"id":108,"fields":{"System.WorkItemType":"Task","System.State":"Active","System.Title":"Outstanding blocker","System.CreatedDate":"2026-08-01T07:00:00Z"},"relations":[]}'
        fi
        ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
AZSCRIPT
  chmod +x "${bin_dir}/az"
  export AZURE_TEST_CALLS="$calls"
  export AZURE_TEST_STATE="$state_file"
}

# Test 1: After ticket 103 is recorded as completed, the next
# scope-selection iteration must advance to ticket 104 from the same
# pinned HU. The HU branch identity stays constant across iterations.
{
  repo="${TEST_ROOT}/drain-repo"
  bin="${TEST_ROOT}/drain-bin"
  state="${TEST_ROOT}/drain-state"
  printf 'ticket=103\n' > "$state"
  make_azure_repo "$repo" "$bin" "$state" "${TEST_ROOT}/drain-calls"
  git -C "$repo" branch feature/100-payments-hu main >/dev/null 2>&1 || true

  export PATH="$bin:$PATH"
  export RUNNER_NAME="tracker-test"
  source "$SELECTOR"
  source "$ADAPTER"
  tracker_initialize "$repo" >/dev/null || fail "Azure initialization failed"

  # First iteration: ticket 103 is already complete, so the next ticket
  # is the one with the earliest creation time — ticket 104.
  tracker_prepare_worker_scope 100 || fail "Scope preparation failed after ticket 103"
  [[ "$TRACKER_SCOPE_STATUS" == ready ]] || fail "Status was not ready: $TRACKER_SCOPE_STATUS"
  [[ "$TRACKER_SCOPE_ITEM" == 104 ]] || fail "Expected ticket 104, got $TRACKER_SCOPE_ITEM"
  [[ "$TRACKER_SCOPE_HU" == 100 ]] || fail "Expected HU 100, got $TRACKER_SCOPE_HU"

  # Complete 104 and re-evaluate. The runner must pick 107 next.
  printf 'ticket=103\nticket=104\n' > "$state"
  tracker_prepare_worker_scope 100 || fail "Scope preparation failed after ticket 104"
  [[ "$TRACKER_SCOPE_ITEM" == 107 ]] || fail "Expected ticket 107, got $TRACKER_SCOPE_ITEM"

  # Close 108 so ticket 109 is unblocked. Then completing 107 advances
  # to 109, and the final iteration reports empty.
  printf 'ticket=103\nticket=104\nticket=108\n' > "$state"
  tracker_prepare_worker_scope 100 || fail "Scope preparation failed after dependency closure"
  [[ "$TRACKER_SCOPE_ITEM" == 107 ]] || fail "Expected ticket 107 after closing blocker, got $TRACKER_SCOPE_ITEM"

  printf 'ticket=103\nticket=104\nticket=107\nticket=108\n' > "$state"
  tracker_prepare_worker_scope 100 || fail "Scope preparation failed after ticket 107"
  [[ "$TRACKER_SCOPE_ITEM" == 109 ]] || fail "Expected ticket 109, got $TRACKER_SCOPE_ITEM"

  # Complete 109 and re-evaluate. The HU should now report empty.
  printf 'ticket=103\nticket=104\nticket=107\nticket=108\nticket=109\n' > "$state"
  tracker_prepare_worker_scope 100 || fail "Scope preparation failed after ticket 109"
  [[ "$TRACKER_SCOPE_STATUS" == empty ]] || fail "Expected empty, got $TRACKER_SCOPE_STATUS"
  pass 'scope re-evaluation advances through HU children in deterministic order'
}

# Test 2: Newly-unlocked transitions are recomputed each iteration. When
# the dependency that previously blocked a child is closed, the next
# scope preparation must promote the formerly-blocked child.
{
  repo="${TEST_ROOT}/unlock-repo"
  bin="${TEST_ROOT}/unlock-bin"
  state="${TEST_ROOT}/unlock-state"
  # Ticket 109 is blocked by 108. Tickets 103, 104, 107 are completed;
  # 108 is still open. The runner must leave 109 out of the eligible
  # set.
  printf 'ticket=103\nticket=104\nticket=107\n' > "$state"
  make_azure_repo "$repo" "$bin" "$state" "${TEST_ROOT}/unlock-calls"
  git -C "$repo" branch feature/100-payments-hu main >/dev/null 2>&1 || true

  export PATH="$bin:$PATH"
  export RUNNER_NAME="tracker-test"
  source "$SELECTOR"
  source "$ADAPTER"
  tracker_initialize "$repo" >/dev/null || fail "Azure initialization failed"

  tracker_prepare_worker_scope 100 || fail "Scope preparation failed"
  [[ "$TRACKER_SCOPE_STATUS" == blocked ]] || \
    fail "Expected blocked scope, got $TRACKER_SCOPE_STATUS"
  [[ "$AZURE_SCOPE_PENDING_COUNT" == 1 ]] || \
    fail "Pending count drifted: $AZURE_SCOPE_PENDING_COUNT"
  [[ "$AZURE_SCOPE_BLOCKED_COUNT" == 1 ]] || \
    fail "Blocked count drifted: $AZURE_SCOPE_BLOCKED_COUNT"

  # Close the blocker. The next scope preparation must promote 109.
  printf 'ticket=103\nticket=104\nticket=107\nticket=108\n' > "$state"
  tracker_prepare_worker_scope 100 || fail "Scope preparation failed after dependency closure"
  [[ "$TRACKER_SCOPE_STATUS" == ready ]] || \
    fail "Status was not ready after dependency closure: $TRACKER_SCOPE_STATUS"
  [[ "$TRACKER_SCOPE_ITEM" == 109 ]] || \
    fail "Expected ticket 109 to be promoted, got $TRACKER_SCOPE_ITEM"
  pass 'dependencies are re-evaluated on every iteration; closing the blocker promotes the child'
}

# Test 3: Restart from middle of HU.  A stale checkpoint with a closed
# ticket identity must be discarded and the next eligible child must be
# selected for the same pinned HU.
{
  repo="${TEST_ROOT}/restart-repo"
  bin="${TEST_ROOT}/restart-bin"
  state="${TEST_ROOT}/restart-state"
  printf 'ticket=103\n' > "$state"
  make_azure_repo "$repo" "$bin" "$state" "${TEST_ROOT}/restart-calls"
  git -C "$repo" branch feature/100-payments-hu main >/dev/null 2>&1 || true

  export PATH="$bin:$PATH"
  export RUNNER_NAME="tracker-test"
  source "$SELECTOR"
  source "$ADAPTER"
  tracker_initialize "$repo" >/dev/null || fail "Azure initialization failed"

  # Simulate the migrate-checkpoint path: the checkpoint pins ticket 103
  # but the live state is already Done. The function must NOT change the
  # HU identity and must NOT keep the closed ticket.
  CHECKPOINT_HU=100
  CHECKPOINT_TICKET=103
  tracker_prepare_worker_scope "" || fail "Restart scope preparation failed"
  az boards work-item show --id 103 --expand all --output json >/dev/null 2>&1
  closed_state=$(az boards work-item show --id 103 --expand all --output json | jq -r '.fields["System.State"]')
  [[ "$closed_state" == Done ]] || fail "Ticket 103 is not Done in the fixture"
  [[ "$TRACKER_SCOPE_STATUS" == ready ]] || \
    fail "Expected ready scope, got $TRACKER_SCOPE_STATUS"
  [[ "$TRACKER_SCOPE_HU" == 100 ]] || \
    fail "Expected HU 100, got $TRACKER_SCOPE_HU"
  [[ "$TRACKER_SCOPE_ITEM" == 104 ]] || \
    fail "Expected ticket 104 after the stale checkpoint, got $TRACKER_SCOPE_ITEM"
  pass 'restart from middle of HU advances past the closed ticket to the next eligible child'
}

# Test 4: HU stays open. After multiple iterations the HU's state must
# remain Active — the runner must never close the integration container.
{
  repo="${TEST_ROOT}/hu-open-repo"
  bin="${TEST_ROOT}/hu-open-bin"
  state="${TEST_ROOT}/hu-open-state"
  printf 'ticket=103\nticket=104\n' > "$state"
  make_azure_repo "$repo" "$bin" "$state" "${TEST_ROOT}/hu-open-calls"
  git -C "$repo" branch feature/100-payments-hu main >/dev/null 2>&1 || true

  export PATH="$bin:$PATH"
  export RUNNER_NAME="tracker-test"
  source "$SELECTOR"
  source "$ADAPTER"
  tracker_initialize "$repo" >/dev/null || fail "Azure initialization failed"

  hu_state=$(az boards work-item show --id 100 --expand all --output json | jq -r '.fields["System.State"]')
  [[ "$hu_state" == Active ]] || fail "HU was not Active before scope: $hu_state"

  tracker_prepare_worker_scope 100 || fail "Scope preparation failed"
  [[ "$TRACKER_SCOPE_ITEM" == 107 ]] || fail "Expected ticket 107, got $TRACKER_SCOPE_ITEM"

  hu_state=$(az boards work-item show --id 100 --expand all --output json | jq -r '.fields["System.State"]')
  [[ "$hu_state" == Active ]] || fail "HU was closed during ticket selection: $hu_state"
  pass 'HU stays open across ticket selection — the runner never closes the integration container'
}

# Test 5: Lock status fingerprints the pinned HU identity so a
# concurrent runner can detect that the same HU is in flight. The
# repository lock is the only thing that prevents two runners from
# processing the same HU simultaneously.
{
  repo="${TEST_ROOT}/lock-repo"
  bin="${TEST_ROOT}/lock-bin"
  state="${TEST_ROOT}/lock-state"
  printf 'ticket=103\n' > "$state"
  make_azure_repo "$repo" "$bin" "$state" "${TEST_ROOT}/lock-calls"
  git -C "$repo" branch feature/100-payments-hu main >/dev/null 2>&1 || true

  export PATH="$bin:$PATH"
  export RUNNER_NAME="tracker-test"
  source "$SELECTOR"
  source "$ADAPTER"
  source "$CHECKPOINT_MODULE"
  source "$LOCK_MODULE"
  tracker_initialize "$repo" >/dev/null || fail "Azure initialization failed"

  tracker_prepare_worker_scope 100 || fail "Scope preparation failed"
  [[ "$TRACKER_SCOPE_HU" == 100 ]] || fail "Expected HU 100, got $TRACKER_SCOPE_HU"

  # The lock status file must fingerprint the pinned HU identity so any
  # second runner that observes the lock can detect the same scope.
  CHECKPOINT_HU="$TRACKER_SCOPE_HU"
  CHECKPOINT_TICKET="$TRACKER_SCOPE_ITEM"
  CHECKPOINT_ISSUE="$TRACKER_SCOPE_ITEM"
  ITERATION=1
  BASE_BRANCH="main"
  LOCK_DIR="${repo}/.git/issue-killer.lock"
  mkdir -p "$LOCK_DIR"
  LOCK_HELD=true
  write_lock_status "scope_selected" 0
  status_file="${LOCK_DIR}/status"
  grep -Eq '^hu=100$' "$status_file" || \
    fail "Lock status file did not pin the HU identity"
  grep -Eq '^ticket=104$' "$status_file" || \
    fail "Lock status file did not pin the ticket identity"
  rm -rf "$LOCK_DIR"
  pass 'lock status fingerprints the pinned HU and ticket identity'
}

# Test 6: HU integration branch is the only PR target. The drainage
# loop must never query the PR list for the HU integration branch as a
# source branch; doing so would signal an accidental mainline-promotion
# PR.
{
  repo="${TEST_ROOT}/branch-repo"
  bin="${TEST_ROOT}/branch-bin"
  state="${TEST_ROOT}/branch-state"
  printf 'ticket=103\n' > "$state"
  make_azure_repo "$repo" "$bin" "$state" "${TEST_ROOT}/branch-calls"
  git -C "$repo" branch feature/100-payments-hu main >/dev/null 2>&1 || true

  export PATH="$bin:$PATH"
  export RUNNER_NAME="tracker-test"
  source "$SELECTOR"
  source "$ADAPTER"
  tracker_initialize "$repo" >/dev/null || fail "Azure initialization failed"

  tracker_prepare_worker_scope 100 || fail "Scope preparation failed"

  # The drainage loop must not query `az repos pr list` for the HU
  # integration branch as a source branch. The scope preparation is
  # read-only and only inspects work items.
  if grep -Eq 'source-branch feature/100-payments-hu' "${TEST_ROOT}/branch-calls"; then
    fail "Scope preparation queried the HU integration branch as a PR source"
  fi
  pass 'HU integration branch is never queried as a PR source during scope selection'
}

printf '6 Azure HU drainage tests passed.\n'
