#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="${ROOT_DIR}/agent/issue-killer/run.sh"
SELECTOR="${ROOT_DIR}/agent/issue-killer/tracker/selector.sh"
ADAPTER="${ROOT_DIR}/agent/issue-killer/tracker/azure-devops-adapter.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/azure-tracker-adapter.XXXXXX")"
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
completion_evidence_field = "Completion Evidence"
real_effort_field = "Real Effort"
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
    if [[ "$*" == *'resource fields'* ]]; then
      printf '%s\n' '{"value":[{"name":"Completion Evidence","referenceName":"Custom.Evidence","type":"html","readOnly":false},{"name":"Real Effort","referenceName":"Custom.RealEffort","type":"double","readOnly":false}]}'
    elif [[ "$*" == *'type='* ]]; then
      printf '%s\n' '{"states":[{"name":"New","category":"Proposed"},{"name":"Active","category":"InProgress"},{"name":"Closed","category":"Completed"},{"name":"Done","category":"Completed"}]}'
    else
      printf '%s\n' '{"value":[{"name":"User Story"},{"name":"Bug"},{"name":"Task"},{"name":"Epic"}]}'
    fi
    ;;
  "repos show --repository") printf '%s\n' '{"id":"repository-id","name":"example-repo"}' ;;
  "boards work-item relation") printf '%s\n' '[{"referenceName":"System.LinkTypes.Dependency-Reverse"}]' ;;
  "boards query --wiql")
    case "${AZURE_TEST_QUERY_MODE:-normal}" in
      empty) printf '%s\n' '[]' ;;
      blocked) printf '%s\n' '[{"id":6}]' ;;
      *) printf '%s\n' '[{"id":1},{"id":2},{"id":3},{"id":4},{"id":5},{"id":6},{"id":8},{"id":11},{"id":12}]' ;;
    esac
    ;;
  "boards work-item show")
    id=""
    previous=""
    for arg in "$@"; do
      if [[ "$previous" == "--id" ]]; then id="$arg"; fi
      previous="$arg"
    done
    case "$id" in
      1)
        if [[ -n "${AZURE_SCOPE_TEST_MODE:-}" ]]; then
          printf '%s\n' '{"id":1,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent","System.CreatedDate":"2026-08-01T09:00:00Z"},"relations":[{"rel":"System.LinkTypes.Hierarchy-Forward","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/10"}]}'
        else
          printf '%s\n' '{"id":1,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent","Custom.Evidence":"<div class=\"completion-evidence\" data-modality=\"non-interactive\"><h2>Summary</h2><h3>Summary</h3><div class=\"evidence-section\"><p>x</p></div><h3>Delivered changes</h3><div class=\"evidence-section\"><p>x</p></div><h3>Validation</h3><div class=\"evidence-section\"><p>x</p></div><h3>Development references</h3><div class=\"evidence-section\"><p>x</p></div></div>","Custom.RealEffort":0.25},"relations":[{"rel":"ArtifactLink","url":"vstfs:///GitManagement/Ref/pr/42","attributes":{"name":"Pull Request"}},{"rel":"ArtifactLink","url":"vstfs:///GitManagement/Commit/abcd1234","attributes":{"name":"Integrated Commit"}}]}'
        fi
        ;;

      2) printf '%s\n' '{"id":2,"fields":{"System.WorkItemType":"Bug","System.State":"Active","System.AssignedTo":{"displayName":"Other"},"System.Tags":"ready-for-agent"},"relations":[]}' ;;
      3) printf '%s\n' '{"id":3,"fields":{"System.WorkItemType":"Task","System.State":"Closed","System.Tags":"ready-for-agent"},"relations":[]}' ;;
      4) printf '%s\n' '{"id":4,"fields":{"System.WorkItemType":"Epic","System.State":"Active","System.Tags":"ready-for-agent"},"relations":[]}' ;;
      5) printf '%s\n' '{"id":5,"fields":{"System.WorkItemType":"Bug","System.State":"Active","System.Tags":"other"},"relations":[]}' ;;
      6) printf '%s\n' '{"id":6,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent"},"relations":[{"rel":"System.LinkTypes.Dependency-Reverse","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/7"}]}' ;;
      7) printf '%s\n' '{"id":7,"fields":{"System.WorkItemType":"Task","System.State":"Active"},"relations":[]}' ;;
      8) printf '%s\n' '{"id":8,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent"},"relations":[{"rel":"System.LinkTypes.Dependency-Reverse","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/9"}]}' ;;
      9) printf '%s\n' '{"id":9,"fields":{"System.WorkItemType":"Task","System.State":"Done"},"relations":[]}' ;;
      10)
        if [[ -n "${AZURE_SCOPE_TEST_MODE:-}" ]]; then
          item_state="Active"
          [[ -n "${AZURE_SCOPE_STATE_FILE:-}" && -r "${AZURE_SCOPE_STATE_FILE}" ]] && item_state="$(<"${AZURE_SCOPE_STATE_FILE}")"
          printf '%s\n' "{\"id\":10,\"fields\":{\"System.WorkItemType\":\"Task\",\"System.State\":\"${item_state}\",\"System.CreatedDate\":\"2026-08-01T10:00:00Z\"},\"relations\":[]}"
        else
          printf '%s\n' '{"id":10,"fields":{"System.WorkItemType":"User Story","System.State":"Done","System.Tags":"ready-for-agent","Custom.Evidence":"<div class=\"completion-evidence\" data-modality=\"non-interactive\"><h2>Summary</h2><div class=\"evidence-section\"><p>Done</p></div><h3>Summary</h3><div class=\"evidence-section\"><p>Done</p></div><h3>Delivered changes</h3><div class=\"evidence-section\"><p>Done</p></div><h3>Validation</h3><div class=\"evidence-section\"><p>Done</p></div><h3>Development references</h3><div class=\"evidence-section\"><p>Done</p></div></div>","Custom.RealEffort":1.5},"relations":[{"rel":"ArtifactLink","url":"vstfs:///GitManagement/Ref/pr/42","attributes":{"name":"Pull Request"}},{"rel":"ArtifactLink","url":"vstfs:///GitManagement/Commit/abcd1234","attributes":{"name":"Integrated Commit"}}]}'
        fi
        ;;
      11) printf '%s\n' '{"id":11,"fields":{"System.WorkItemType":"Bug","System.State":"Active","System.Tags":"ready-for-agent;epic","System.Title":"Tagged epic"},"relations":[]}' ;;
      12) printf '%s\n' '{"id":12,"fields":{"System.WorkItemType":"Bug","System.State":"Active","System.Tags":"ready-for-agent","System.Title":"[Epic] titled epic"},"relations":[]}' ;;
      *) exit 1 ;;
    esac
    ;;
      "boards work-item update")
        if [[ -n "${AZURE_SCOPE_STATE_FILE:-}" ]]; then
          printf '%s' 'Done' > "$AZURE_SCOPE_STATE_FILE"
        fi
        printf '%s\n' '{"id":1,"fields":{"System.State":"Done"}}'
        ;;
  "repos pr create") printf '%s\n' '{"pullRequestId":42,"status":"active"}' ;;
  "repos pr update") printf '%s\n' '{"pullRequestId":42,"status":"completed","mergeStatus":"succeeded"}' ;;
  "repos pr list")
    case "${AZURE_TEST_PR_MODE:-merged}" in
      ambiguous) printf '%s\n' '[{"pullRequestId":42,"status":"completed","mergeStatus":"succeeded","targetRefName":"refs/heads/main"},{"pullRequestId":43,"status":"completed","mergeStatus":"succeeded","targetRefName":"refs/heads/main"}]' ;;
      active) printf '%s\n' '[{"pullRequestId":42,"status":"active","mergeStatus":"notSet","targetRefName":"refs/heads/main"}]' ;;
      *) printf '%s\n' '[{"pullRequestId":42,"status":"completed","mergeStatus":"succeeded","targetRefName":"refs/heads/main"}]' ;;
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
adapter_path="$(tracker_select_adapter "$repo")" || \
  fail 'Azure remote was not recognized by tracker selection'
[[ "$adapter_path" == "$ADAPTER" ]] || \
  fail "Unexpected tracker adapter: $adapter_path"
source "$adapter_path"
current_branch() { printf '%s\n' 'feature/issue-16'; }
emit_recovery_required() { exit 4; }
[[ "$(tracker_remote_kind 'git@ssh.dev.azure.com:v3/example-org/example-project/example-repo')" == 'azure-devops' ]] || \
  fail 'Azure scp-style SSH remote was not recognized by tracker selection'
[[ "$(azure_remote_parts 'git@ssh.dev.azure.com:v3/example-org/example-project/example-repo')" == $'example-org\texample-project\texample-repo' ]] || \
  fail 'Azure scp-style SSH remote was not parsed into its repository tuple'
tracker_initialize "$repo" >/dev/null || \
  fail 'Azure tracker initialization failed'

[[ "$TRACKER_KIND" == "azure-devops" ]] || \
  fail "Unexpected tracker kind: $TRACKER_KIND"
[[ "$AZURE_ORGANIZATION" == "example-org" ]] || \
  fail 'Organization mapping was not loaded'
[[ "$AZURE_PROJECT" == "example-project" ]] || \
  fail 'Project mapping was not loaded'
[[ "$AZURE_REPOSITORY" == "example-repo" ]] || \
  fail 'Repository mapping was not loaded'
grep -Fq 'devops project show' "$calls" || \
  fail 'Azure project/authentication preflight was not performed'
grep -Fq 'repos show' "$calls" || \
  fail 'Azure repository preflight was not performed'
grep -Fq 'work-item relation list-type' "$calls" || \
  fail 'Azure predecessor relation preflight was not performed'

eligible="$(tracker_list_eligible_items)"
[[ "$eligible" == $'1\n8' ]] || \
  fail "Unexpected Azure queue: ${eligible}"
[[ -z "$(AZURE_TEST_QUERY_MODE=empty tracker_list_eligible_items)" ]] || \
  fail 'Azure adapter did not recognize an actually empty queue'
[[ -z "$(AZURE_TEST_QUERY_MODE=blocked tracker_list_eligible_items)" ]] || \
  fail 'Azure adapter admitted a work item with an open predecessor'
tracker_item_claim 1 >/dev/null || fail 'Azure claim operation failed'
unset -f current_branch
if tracker_item_close 1 >"${TEST_ROOT}/close-without-branch.log" 2>&1; then
  fail 'Azure close operation accepted a missing source branch'
fi
grep -Fq 'source branch is required' "${TEST_ROOT}/close-without-branch.log" || \
  fail 'Azure close guard did not explain the missing source branch'
tracker_item_close 1 feature/issue-16 >/dev/null || fail 'Azure close operation failed'
current_branch() { printf '%s\n' 'feature/issue-16'; }
pr_json="$(tracker_prs_for_branch feature/issue-16)"
[[ "$(tracker_pr_is_merged "$pr_json")" == true ]] || \
  fail 'Azure merged PR state was not normalized'
[[ "$(tracker_pr_is_merged '[{"status":"completed"},{"status":"completed"}]')" == ambiguous ]] || \
  fail 'Azure adapter did not reject ambiguous PR state'
tracker_item_completion_verified 10 feature/issue-16 || \
  fail 'Azure adapter did not verify a closed work item with a merged PR'
tracker_prepare_worker_environment || fail 'Azure guarded CLI environment was not prepared'
if AZURE_TEST_PR_MODE=ambiguous az boards work-item update --id 1 --state Done >/dev/null 2>&1; then
  fail 'Azure guarded CLI allowed closure with an ambiguous PR'
fi
tracker_cleanup_worker_environment
[[ "$(tracker_runtime_decode_command 'az repos pr update --id 42 --status completed')" == $'tracker\t' ]] || \
  fail 'Azure runtime decoder advanced the checkpoint before merge verification'
[[ "$(tracker_runtime_decode_command 'az boards work-item update --id 10 --state Done')" == $'tracker\t' ]] || \
  fail 'Azure runtime decoder classified a direct closure as verified'
[[ "$(tracker_reconcile_recovery_state 10)" == completed ]] || \
  fail 'Azure recovery did not reconcile an already-completed work item'
if (tracker_reconcile_startup_state 10 feature/issue-10) >/dev/null 2>&1; then
  fail 'Azure recovery accepted a dirty branch for an already-closed work item'
fi
grep -Fq 'boards work-item update' "$calls" || \
  fail 'Azure claim/close operations were not delegated to az'
grep -Fq 'repos pr list' "$calls" || \
  fail 'Azure PR lookup was not delegated to az'

pass 'Azure tracker filters work items, blockers, claims, closes, and verifies merged PRs'

# Ticket branch naming for non-visual delivery (issue #37)
[[ "$(tracker_compute_ticket_branch 103 'Bootstrap the HU integration branch')" == 'issue-103-bootstrap-the-hu-integration-branch' ]] || \
  fail 'Azure ticket branch did not match the issue-<id>-<slug> convention'
[[ "$(tracker_compute_ticket_branch 42 '')" == 'issue-42-ticket' ]] || \
  fail 'Azure ticket branch did not fall back to a sensible default slug'
[[ "$(tracker_compute_ticket_branch 42 '!!!')" == 'issue-42-ticket' ]] || \
  fail 'Azure ticket branch did not fall back to a sensible default slug for non-alphanumeric titles'
if tracker_compute_ticket_branch 'not-a-number' 'title' >/dev/null 2>&1; then
  fail 'Azure ticket branch accepted a non-numeric ticket identifier'
fi
pass 'Azure ticket branch naming follows the issue-<id>-<slug> convention'

# Completion evidence HTML formatting for non-visual delivery (issue #37)
evidence="$(tracker_format_completion_evidence 103 'Implemented branch bootstrap' 'Added bootstrap module' 'bash tests/azure_hu_branch_test.sh' 'PR: https://dev.azure.com/example-org/example-project/_git/example-repo/pullRequest/42')"
for section in 'class="completion-evidence"' '<h3>Summary</h3>' '<h3>Delivered changes</h3>' '<h3>Validation</h3>' '<h3>Development references</h3>' 'data-work-item="103"'; do
  grep -Fq "$section" <<<"$evidence" || \
    fail "Azure completion evidence missing required section: $section"
done
grep -Fq 'bash tests/azure_hu_branch_test.sh' <<<"$evidence" || \
  fail 'Azure completion evidence did not embed the validation output'
pass 'Azure completion evidence uses readable HTML sections for non-visual delivery'

# Real Effort calculation for non-visual delivery (issue #37)
# 1 hour of active work rounded upward to the nearest quarter hour.
[[ "$(tracker_calculate_real_effort_hours 3600 0)" == '1' ]] || \
  fail 'Azure effort calculator did not round 1h upward to 0.25h increments'
# 0.5 hour of active work rounded upward to 0.5h.
[[ "$(tracker_calculate_real_effort_hours 1800 0)" == '0.5' ]] || \
  fail 'Azure effort calculator did not round 0.5h upward to 0.5h'
# Existing effort of 1.5h + 0.5h new = 2.0h.
[[ "$(tracker_calculate_real_effort_hours 1800 1.5)" == '2' ]] || \
  fail 'Azure effort calculator did not add new effort to existing value'
# 1 minute of active work rounded upward to 0.25h.
[[ "$(tracker_calculate_real_effort_hours 60 0)" == '0.25' ]] || \
  fail 'Azure effort calculator did not round a sub-quarter-hour increment to 0.25h'
# 15 minutes of active work is exactly 0.25h.
[[ "$(tracker_calculate_real_effort_hours 900 0)" == '0.25' ]] || \
  fail 'Azure effort calculator did not preserve an exact 0.25h increment'
# Negative or non-numeric inputs are rejected.
if tracker_calculate_real_effort_hours -1 0 >/dev/null 2>&1; then
  fail 'Azure effort calculator accepted negative active seconds'
fi
if tracker_calculate_real_effort_hours 60 'abc' >/dev/null 2>&1; then
  fail 'Azure effort calculator accepted a non-numeric existing value'
fi
pass 'Azure effort calculator rounds upward to quarter-hour increments and accumulates'

# Modality classification: backend/frontend/mixed/non-interactive (issue #38)
[[ "$(tracker_classify_ticket_modality 'Add /api/orders endpoint' 'Expose a new HTTP route.' 'Implemented server handler and CLI command for the orders API endpoint')" == 'backend' ]] || \
  fail 'Azure modality classifier did not recognize a backend ticket'
[[ "$(tracker_classify_ticket_modality 'Render profile screen' 'Add a new page with a button to edit profile.' 'Updated component layout and paint theme')" == 'frontend' ]] || \
  fail 'Azure modality classifier did not recognize a frontend ticket'
[[ "$(tracker_classify_ticket_modality 'Profile settings end to end' 'Update the page and the API.' 'Refactored component and added a server route')" == 'mixed' ]] || \
  fail 'Azure modality classifier did not recognize a mixed ticket'
[[ "$(tracker_classify_ticket_modality 'Refactor doc fixture' 'Documentation cleanup only.' 'Renamed comments and reformatted test fixtures')" == 'non-interactive' ]] || \
  fail 'Azure modality classifier did not recognize a non-interactive ticket'
[[ "$(tracker_classify_ticket_modality 'Profile screen end to end' 'backend-only' 'Refactored page rendering and added a server route')" == 'backend' ]] || \
  fail 'Azure modality classifier did not honour the explicit backend override'
if tracker_classify_ticket_modality '' '' '' >/dev/null 2>&1; then
  fail 'Azure modality classifier accepted an empty title, description, and changes tuple'
fi
if tracker_classify_ticket_modality 'Some ticket' 'Some description' 'No recognized signals here' >/dev/null 2>&1; then
  fail 'Azure modality classifier accepted a ticket with no recognized modality signal'
fi
pass 'Azure modality classifier covers backend, frontend, mixed, and non-interactive tickets'

# Modality evidence rendering: backend, frontend, mixed, non-interactive
# (issue #38). Each modality must embed the right capture markers so the
# closure guard can verify the delivery modality without re-classifying.
backend_captures='[{"title":"GET /api/orders","description":"HTTP 200 with empty list","url":"https://attachments.example.com/get-orders.png"}]'
backend_evidence="$(tracker_format_modality_evidence 200 backend 'Implemented GET /api/orders' 'Added orders route' 'curl http://localhost/api/orders -> 200' 'PR: https://example/pull/200' "$backend_captures")"
grep -Fq 'data-modality="backend"' <<<"$backend_evidence" || \
  fail 'Backend evidence did not carry the backend modality marker'
grep -Fq 'data-modality-captures="backend"' <<<"$backend_evidence" || \
  fail 'Backend evidence did not embed the backend capture section'
grep -Fq 'HTTP captures' <<<"$backend_evidence" || \
  fail 'Backend evidence did not label the HTTP capture section'
grep -Fq 'https://attachments.example.com/get-orders.png' <<<"$backend_evidence" || \
  fail 'Backend evidence did not embed the capture URL'
grep -Fqc 'data-modality-captures="frontend"' <<<"$backend_evidence" >/dev/null 2>&1 && \
  fail 'Backend evidence should not carry a frontend capture section'

frontend_captures='[{"title":"Profile page","description":"Updated user profile","url":"https://attachments.example.com/profile.png"}]'
frontend_evidence="$(tracker_format_modality_evidence 201 frontend 'Rendered profile page' 'Updated component' 'chrome MCP screenshot' 'PR: https://example/pull/201' "$frontend_captures")"
grep -Fq 'data-modality="frontend"' <<<"$frontend_evidence" || \
  fail 'Frontend evidence did not carry the frontend modality marker'
grep -Fq 'data-modality-captures="frontend"' <<<"$frontend_evidence" || \
  fail 'Frontend evidence did not embed the frontend capture section'
grep -Fq 'Rendered screen captures' <<<"$frontend_evidence" || \
  fail 'Frontend evidence did not label the screen capture section'

mixed_captures='[{"title":"GET /api/profile","description":"HTTP 200","url":"https://attachments.example.com/get-profile.png","kind":"http"},{"title":"Profile page","description":"Edited profile","url":"https://attachments.example.com/profile.png","kind":"screen"}]'
mixed_evidence="$(tracker_format_modality_evidence 202 mixed 'Profile E2E' 'Backend + frontend' 'chrome MCP + curl' 'PR: https://example/pull/202' "$mixed_captures")"
grep -Fq 'data-modality="mixed"' <<<"$mixed_evidence" || \
  fail 'Mixed evidence did not carry the mixed modality marker'
grep -Fq 'data-modality-captures="backend"' <<<"$mixed_evidence" || \
  fail 'Mixed evidence did not embed the backend capture section'
grep -Fq 'data-modality-captures="frontend"' <<<"$mixed_evidence" || \
  fail 'Mixed evidence did not embed the frontend capture section'

noninteractive_evidence="$(tracker_format_modality_evidence 203 non-interactive 'Refactor fixture' 'Renamed comments' 'bash tests/foo.sh' 'PR: https://example/pull/203')"
grep -Fq 'data-modality="non-interactive"' <<<"$noninteractive_evidence" || \
  fail 'Non-interactive evidence did not carry the non-interactive modality marker'
grep -Fqc 'data-modality-captures' <<<"$noninteractive_evidence" >/dev/null 2>&1 && \
  fail 'Non-interactive evidence must not include a captures section'

if tracker_format_modality_evidence 204 'unknown-modality' 'summary' 'changes' 'validation' 'refs' >/dev/null 2>&1; then
  fail 'Azure modality evidence renderer accepted an unknown modality'
fi
if tracker_format_modality_evidence '' backend 'summary' 'changes' 'validation' 'refs' >/dev/null 2>&1; then
  fail 'Azure modality evidence renderer accepted an empty work item identifier'
fi
pass 'Azure modality evidence renders backend, frontend, mixed, and non-interactive captures correctly'

# Modality attachment upload: the fake az CLI in this fixture does not
# implement `work-item attachment create`, so we install a tailored
# az fixture just for this assertion, capture the call, and revert.
attach_bin="${TEST_ROOT}/attach-bin"
mkdir -p "$attach_bin"
attach_calls="${TEST_ROOT}/attach-calls"
cat > "${attach_bin}/az" <<ATTACHAZ
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$attach_calls"
case "\$1 \$2 \$3 \$4" in
  "boards work-item attachment create")
    printf '%s\n' '{"id":"att-1","url":"https://attachments.example.com/orders.png"}'
    ;;
  *) exit 0 ;;
esac
ATTACHAZ
chmod +x "${attach_bin}/az"
# The fake-az fixture overrides work-item attachment create, so the
# helper reuses the global ATTACH_CALLS handle.
PATH="${attach_bin}:${PATH}" \
  attachment_url="$(tracker_item_upload_attachment 200 /dev/null 'Orders HTTP capture' 'GET /api/orders response')"
[[ "$attachment_url" == 'https://attachments.example.com/orders.png' ]] || \
  fail "Azure attachment upload did not return the expected URL: ${attachment_url}"
grep -Fq 'work-item attachment create' "$attach_calls" || \
  fail 'Azure attachment upload did not invoke az boards work-item attachment create'
if PATH="${attach_bin}:${PATH}" \
  tracker_item_upload_attachment 200 /nonexistent/path 'missing' 'should fail' >/dev/null 2>&1; then
  fail 'Azure attachment upload accepted an unreadable capture file'
fi
if PATH="${attach_bin}:${PATH}" tracker_item_upload_attachment 200 /dev/null '' '' >/dev/null 2>&1; then
  fail 'Azure attachment upload accepted an empty capture title'
fi
if tracker_item_upload_attachment 0 /dev/null 'title' 'desc' >/dev/null 2>&1; then
  fail 'Azure attachment upload accepted an invalid work item identifier'
fi
pass 'Azure attachment upload validates the capture file and returns the attachment URL'

# Closure guard rejects Done when evidence, effort, or relations are missing
# (issue #37). Item 11 is an Epic-marked Bug with no evidence, effort, or
# relations; the guarded CLI must refuse to close it as Done.
tracker_prepare_worker_environment || fail 'Azure guarded CLI environment was not prepared (prereq test)'
if az boards work-item update --id 11 --state Done >/dev/null 2>&1; then
  tracker_cleanup_worker_environment
  fail 'Azure guarded CLI accepted Done without completion prerequisites'
fi
tracker_cleanup_worker_environment
pass 'Azure guarded CLI refuses Done when completion prerequisites are missing'

# Closure guard refuses Done when evidence lacks a recognized modality
# marker (issue #38). The unit-level test for
# `tracker_item_completion_prerequisites` already verifies the
# modality check against the live Azure evidence; this assertion
# double-checks that the closure guard honours the same contract when
# invoked through the guarded CLI. We patch the fake-az fixture
# temporarily to return an evidence payload without a modality marker.
no_modality_bin="${TEST_ROOT}/no-modality-bin"
mkdir -p "$no_modality_bin"
cat > "${no_modality_bin}/az" <<'NOMOD'
#!/usr/bin/env bash
case "$1 $2 $3" in
  "work-item show")
    printf '%s\n' '{"id":1,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent","Custom.Evidence":"<div class=\"completion-evidence\"><h2>Summary</h2><h3>Summary</h3><div class=\"evidence-section\"><p>x</p></div><h3>Delivered changes</h3><div class=\"evidence-section\"><p>x</p></div><h3>Validation</h3><div class=\"evidence-section\"><p>x</p></div><h3>Development references</h3><div class=\"evidence-section\"><p>x</p></div></div>","Custom.RealEffort":0.25},"relations":[{"rel":"ArtifactLink","url":"vstfs:///GitManagement/Ref/pr/42","attributes":{"name":"Pull Request"}},{"rel":"ArtifactLink","url":"vstfs:///GitManagement/Commit/abcd1234","attributes":{"name":"Integrated Commit"}}]}'
    ;;
  *) exit 0 ;;
esac
NOMOD
chmod +x "${no_modality_bin}/az"
tracker_cleanup_worker_environment >/dev/null 2>&1 || true
PATH="${no_modality_bin}:${PATH}" tracker_prepare_worker_environment \
  || fail 'Azure guarded CLI environment was not re-prepared for modality test'
if az boards work-item update --id 1 --state Done >/dev/null 2>&1; then
  tracker_cleanup_worker_environment
  fail 'Azure guarded CLI accepted Done when evidence lacked a modality marker'
fi
tracker_cleanup_worker_environment
# Restore the default fake-az path so subsequent assertions are not
# affected by the override.
PATH="${TEST_ROOT}/bin:${PATH}" tracker_prepare_worker_environment \
  || fail 'Azure guarded CLI environment was not restored after modality test'
tracker_cleanup_worker_environment
pass 'Azure guarded CLI refuses Done when evidence lacks a recognized modality marker'

# PR target validation: HU integration branch is preferred over the configured
# base branch when the adapter is pinned to a delivery HU (issue #37).
TRACKER_HU_BRANCH="feature/100-payments-hu"
if tracker_pr_target_matches_integration_branch "refs/heads/feature/100-payments-hu"; then
  : # expected
else
  fail 'Azure adapter did not accept the HU integration branch as a PR target'
fi
if tracker_pr_target_matches_integration_branch "refs/heads/main"; then
  fail 'Azure adapter accepted the configured base branch while an HU branch is pinned'
fi
TRACKER_HU_BRANCH=""
if tracker_pr_target_matches_integration_branch "refs/heads/main"; then
  : # expected
else
  fail 'Azure adapter did not fall back to the configured base branch without an HU branch'
fi
pass 'Azure adapter matches PR targets against the HU integration branch first, then the configured base branch'

# The PR-is-merged check must prefer the HU integration branch when the
# adapter is pinned to a delivery HU (issue #37). The fake PR targets the
# configured base branch by default; the same PR JSON must be classified
# differently when TRACKER_HU_BRANCH is set.
pr_for_main='[{"status":"completed","mergeStatus":"succeeded","targetRefName":"refs/heads/main"}]'
[[ "$(tracker_pr_is_merged "$pr_for_main")" == "true" ]] || \
  fail 'Azure PR-is-merged check did not recognize a merged PR into the configured base branch'
TRACKER_HU_BRANCH="feature/100-payments-hu"
[[ "$(tracker_pr_is_merged "$pr_for_main")" == "false" ]] || \
  fail 'Azure PR-is-merged check accepted a PR into the configured base branch while an HU branch is pinned'
pr_for_hu='[{"status":"completed","mergeStatus":"succeeded","targetRefName":"refs/heads/feature/100-payments-hu"}]'
[[ "$(tracker_pr_is_merged "$pr_for_hu")" == "true" ]] || \
  fail 'Azure PR-is-merged check did not recognize a merged PR into the HU integration branch'
TRACKER_HU_BRANCH=""
pass 'Azure PR-is-merged check prefers the HU integration branch over the configured base branch'

# Idempotent helpers for restart-safe Azure ticket completion (issue #39).
# The helpers must read live Azure state before mutating so that retries
# preserve accumulated effort, never duplicate relations, never overwrite
# existing evidence, and reuse previously uploaded attachments.

# Snapshot the az call log so we can prove the helpers skip the mutation
# when the live state already reflects it.
calls_before_idempotency="$(wc -l < "$calls")"

# tracker_item_set_real_effort_accumulated: existing 0.25h + new 1800s
# (0.5h) lands on an exact quarter-hour boundary (0.75h = 3 quarters) so
# the round-up rule must not overshoot; the helper produces a single write.
accumulated="$(tracker_item_set_real_effort_accumulated 1 1800)"
[[ "$accumulated" == "0.75" ]] || \
  fail "Azure effort accumulator did not produce 0.75h for 0.25h + 0.5h: ${accumulated}"
# First write is the only update; the helper reads the live value and
# writes the accumulated total once, so two az calls are expected (one
# read for the existing effort, one write for the new total).
calls_after_first_write="$(wc -l < "$calls")"
delta=$((calls_after_first_write - calls_before_idempotency))
[[ "$delta" == "2" ]] || \
  fail "Azure effort accumulator produced ${delta} az calls; expected exactly 2 (read + write)"
# A retry must keep the helper contract: it always reads the live value
# (one call) and writes the accumulated total (one call) without skipping
# the read even when the live value is unchanged.
calls_before_retry="$(wc -l < "$calls")"
second="$(tracker_item_set_real_effort_accumulated 1 1800)"
[[ "$second" =~ ^[0-9]+(\.[0-9]+)?$ ]] || \
  fail "Azure effort accumulator returned a non-numeric value on retry: ${second}"
calls_after_retry="$(wc -l < "$calls")"
delta_retry=$((calls_after_retry - calls_before_retry))
[[ "$delta_retry" == "2" ]] || \
  fail "Azure effort accumulator produced ${delta_retry} az calls on retry; expected exactly 2 (read + write)"
if tracker_item_set_real_effort_accumulated 0 60 >/dev/null 2>&1; then
  fail 'Azure effort accumulator accepted an invalid work item identifier'
fi
if tracker_item_set_real_effort_accumulated 1 'abc' >/dev/null 2>&1; then
  fail 'Azure effort accumulator accepted non-integer active seconds'
fi
pass 'Azure effort accumulator preserves prior Real Effort and writes exactly once per call'

# tracker_item_has_development_relation and add_development_relation_if_absent:
# work item 1 already lists the pull request vstfs:///GitManagement/Ref/pr/42
# and the integrated commit vstfs:///GitManagement/Commit/abcd1234, so adding
# the same relations again must be a no-op while a genuinely new relation
# must be persisted.
tracker_item_has_development_relation 1 'vstfs:///GitManagement/Ref/pr/42' || \
  fail 'Azure relation probe missed the seeded pull request relation'
tracker_item_has_development_relation 1 'vstfs:///GitManagement/Commit/abcd1234' || \
  fail 'Azure relation probe missed the seeded integrated commit relation'
if tracker_item_has_development_relation 1 'vstfs:///GitManagement/Ref/pr/99' 2>/dev/null; then
  fail 'Azure relation probe falsely matched a missing relation'
fi
# The default fake-az fixture is stateless for relation additions, so a
# retry against the same URL still appears "absent" to the probe and the
# helper attempts the write again. To prove the helper is truly
# idempotent we install a stateful az fixture that records relation
# additions and replays them on every subsequent read.
stateful_rel_bin="${TEST_ROOT}/stateful-rel-bin"
stateful_rel_calls="${TEST_ROOT}/stateful-rel-calls"
stateful_rel_state="${TEST_ROOT}/stateful-rel-state"
: > "$stateful_rel_calls"
: > "$stateful_rel_state"
mkdir -p "$stateful_rel_bin"
cat > "${stateful_rel_bin}/az" <<STATEFULAZ
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$stateful_rel_calls"
case "\$1 \$2 \$3" in
  "boards work-item relation")
    target=""
    previous=""
    for arg in "\$@"; do
      if [[ "\$previous" == "--target" ]]; then target="\$arg"; fi
      previous="\$arg"
    done
    printf '%s\n' "\$target" >> "$stateful_rel_state"
    printf '%s\n' '{}'
    ;;
  "boards work-item show")
    relations='[{"rel":"ArtifactLink","url":"vstfs:///GitManagement/Ref/pr/42","attributes":{"name":"Pull Request"}},{"rel":"ArtifactLink","url":"vstfs:///GitManagement/Commit/abcd1234","attributes":{"name":"Integrated Commit"}}'
    while IFS= read -r added; do
      [[ -n "\$added" ]] || continue
      relations="\${relations},{\"rel\":\"ArtifactLink\",\"url\":\"\${added}\",\"attributes\":{\"name\":\"Pull Request\"}}"
    done < "$stateful_rel_state"
    relations="\${relations}]"
    printf '%s\n' "{\"id\":1,\"fields\":{\"System.WorkItemType\":\"User Story\",\"System.State\":\"Active\",\"System.Tags\":\"ready-for-agent\"},\"relations\":\${relations}}"
    ;;
  *) exit 0 ;;
esac
STATEFULAZ
chmod +x "${stateful_rel_bin}/az"
PATH="${stateful_rel_bin}:${PATH}"
tracker_prepare_worker_environment >/dev/null \
  || fail 'Azure guarded CLI environment was not re-prepared for stateful relation test'

calls_before_rel="$(wc -l < "$stateful_rel_calls")"
tracker_item_add_development_relation_if_absent 1 'Pull Request' 'vstfs:///GitManagement/Ref/pr/42' 'already linked' >/dev/null || \
  fail 'Azure idempotent relation helper refused an already-present relation'
calls_after_existing="$(wc -l < "$stateful_rel_calls")"
delta_existing=$((calls_after_existing - calls_before_rel))
# The probe reads once; the helper must NOT issue a write when the
# relation is already present.
[[ "$delta_existing" == "1" ]] || \
  fail "Azure idempotent relation helper issued ${delta_existing} az calls for an existing relation; expected 1 (read only)"
calls_before_new="$(wc -l < "$stateful_rel_calls")"
tracker_item_add_development_relation_if_absent 1 'Pull Request' 'vstfs:///GitManagement/Ref/pr/77' 'fresh link' >/dev/null || \
  fail 'Azure idempotent relation helper failed to add a genuinely new relation'
calls_after_new="$(wc -l < "$stateful_rel_calls")"
delta_new=$((calls_after_new - calls_before_new))
# Probe reads once and the helper writes once.
[[ "$delta_new" == "2" ]] || \
  fail "Azure idempotent relation helper issued ${delta_new} az calls for a new relation; expected 2 (read + write)"
# A second add of the same new relation must remain a probe-only no-op
# now that the stateful fixture records it as already present.
calls_before_dup="$(wc -l < "$stateful_rel_calls")"
tracker_item_add_development_relation_if_absent 1 'Pull Request' 'vstfs:///GitManagement/Ref/pr/77' 'fresh link' >/dev/null || \
  fail 'Azure idempotent relation helper refused a retried new relation'
calls_after_dup="$(wc -l < "$stateful_rel_calls")"
delta_dup=$((calls_after_dup - calls_before_dup))
[[ "$delta_dup" == "1" ]] || \
  fail "Azure idempotent relation helper issued ${delta_dup} az calls on retry; expected 1 (read only)"
# The stateful fixture must contain exactly one entry for the new URL;
# the helper must not have written it twice.
dup_count="$(grep -Fxc 'vstfs:///GitManagement/Ref/pr/77' "$stateful_rel_state" || true)"
[[ "$dup_count" == "1" ]] || \
  fail "Azure idempotent relation helper wrote the same URL ${dup_count} times; expected exactly 1"
tracker_cleanup_worker_environment >/dev/null
# Restore the default fake-az path so subsequent assertions use the
# original fixture.
PATH="${TEST_ROOT}/bin:${PATH}" tracker_prepare_worker_environment \
  >/dev/null || fail 'Azure guarded CLI environment was not restored after relation test'
tracker_cleanup_worker_environment >/dev/null
if tracker_item_add_development_relation_if_absent 0 'Pull Request' 'url' '' >/dev/null 2>&1; then
  fail 'Azure idempotent relation helper accepted an invalid work item identifier'
fi
pass 'Azure development relation helper reuses existing ArtifactLinks and only writes missing ones'

# tracker_item_set_completion_evidence_if_absent: work item 1 already carries
# a complete modality-tagged evidence payload; rewriting it must be a no-op
# so a retry cannot destroy the captured proof. The helper must still write
# when the live field is missing or does not declare a recognized modality.
tracker_item_set_completion_evidence_if_absent 1 '<div class="completion-evidence" data-modality="non-interactive"><h3>Summary</h3><div class="evidence-section"><p>retry</p></div></div>' >/dev/null || \
  fail 'Azure evidence-if-absent refused an existing evidence payload'
calls_before_ev="$(wc -l < "$calls")"
tracker_item_set_completion_evidence_if_absent 1 '<div class="completion-evidence" data-modality="non-interactive"><h3>Summary</h3><div class="evidence-section"><p>retry</p></div></div>' >/dev/null || \
  fail 'Azure evidence-if-absent refused the existing payload on retry'
calls_after_ev="$(wc -l < "$calls")"
delta_ev=$((calls_after_ev - calls_before_ev))
# The helper always reads the live value first; when the live value is
# already complete the helper must not issue a write.
[[ "$delta_ev" == "1" ]] || \
  fail "Azure evidence-if-absent issued ${delta_ev} az calls against complete evidence; expected 1 (read only)"
if tracker_item_set_completion_evidence_if_absent 0 '<div>x</div>' >/dev/null 2>&1; then
  fail 'Azure evidence-if-absent accepted an invalid work item identifier'
fi
if tracker_item_set_completion_evidence_if_absent 1 '' >/dev/null 2>&1; then
  fail 'Azure evidence-if-absent accepted an empty HTML payload'
fi
pass 'Azure completion-evidence-if-absent reuses existing evidence and never overwrites'

# tracker_find_attachment_by_title: with no attachments seeded for item 1,
# the helper must report absent for any title and refuse an invalid item
# identifier. The fixture is then extended with an attachment to prove the
# helper locates the existing URL without re-uploading.
attached_bin="${TEST_ROOT}/attached-bin"
mkdir -p "$attached_bin"
cat > "${attached_bin}/az" <<'ATTACHEDAZ'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$attached_calls"
case "$1 $2 $3" in
  "boards work-item show")
    printf '%s\n' '{"id":1,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent"},"relations":[{"rel":"AttachedFile","url":"https://attachments.example.com/orders.png","attributes":{"name":"Orders HTTP capture","comment":"GET /api/orders"}}]}'
    ;;
  *) exit 0 ;;
esac
ATTACHEDAZ
chmod +x "${attached_bin}/az"
attached_calls="${TEST_ROOT}/attached-calls"
PATH="${attached_bin}:${PATH}" \
  tracker_find_attachment_by_title 1 'Orders HTTP capture' >"${TEST_ROOT}/attached-out" 2>"${TEST_ROOT}/attached-err" || \
  fail "Azure attachment-by-title did not find the seeded attachment: $(<"${TEST_ROOT}/attached-err")"
[[ "$(<"${TEST_ROOT}/attached-out")" == 'https://attachments.example.com/orders.png' ]] || \
  fail "Azure attachment-by-title returned an unexpected URL: $(<"${TEST_ROOT}/attached-out")"
if PATH="${attached_bin}:${PATH}" \
   tracker_find_attachment_by_title 1 'Missing capture' >/dev/null 2>&1; then
  fail 'Azure attachment-by-title falsely matched a missing capture'
fi
if PATH="${attached_bin}:${PATH}" \
   tracker_find_attachment_by_title 0 'any' >/dev/null 2>&1; then
  fail 'Azure attachment-by-title accepted an invalid work item identifier'
fi
# Restore the default fake-az path so the next assertions use the
# original fixture.
PATH="${TEST_ROOT}/bin:${PATH}" tracker_prepare_worker_environment \
  >/dev/null || fail 'Azure guarded CLI environment was not restored after attachment-by-title test'
tracker_cleanup_worker_environment >/dev/null
pass 'Azure attachment-by-title returns the existing attachment URL without re-uploading'

# tracker_recover_ticket_progress must reconcile live Azure state and emit
# the next safe checkpoint lifecycle state. Work item 1 already has a merged
# PR, complete evidence, recorded effort, and development relations, so the
# function must report `issue_closed` readiness without requiring any new
# work. Work item 5 is an unassigned, untagged Bug with no relations, so the
# function must report one of the early lifecycle states because no merged
# PR exists.
calls_before_recover="$(wc -l < "$calls")"
progress="$(tracker_recover_ticket_progress 1 feature/issue-16)"
[[ "$progress" == "issue_closed" ]] || \
  fail "Azure progress recovery did not report issue_closed for a fully completed ticket: ${progress}"
calls_after_recover="$(wc -l < "$calls")"
delta_recover=$((calls_after_recover - calls_before_recover))
[[ "$delta_recover" -ge 1 ]] || \
  fail "Azure progress recovery did not consult live state at least once (${delta_recover} calls)"
progress_open="$(tracker_recover_ticket_progress 5 feature/issue-16)"
case "$progress_open" in
  pr_open|pr_merged|branch_pushed|issue_selected|starting) : ;;
  *) fail "Azure progress recovery emitted an unexpected state for an open ticket: ${progress_open}" ;;
esac
if tracker_recover_ticket_progress 0 'branch' >/dev/null 2>&1; then
  fail 'Azure progress recovery accepted an invalid work item identifier'
fi
# Failure injection: a stateful fixture simulates a merged PR for ticket
# 2 (Bug with no relations or evidence) and proves the recovery helper
# surfaces `pr_merged` so the runner knows the next missing effect is
# evidence. Work item 2 is a fully unassigned Bug with an `Other`
# assignee; the recovery helper must refuse the call rather than
# silently emitting a misleading lifecycle state.
merged_bin="${TEST_ROOT}/merged-bin"
mkdir -p "$merged_bin"
cat > "${merged_bin}/az" <<'MERGEDAZ'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$AZURE_TEST_CALLS"
case "$1 $2 $3" in
  "boards work-item show")
    printf '%s\n' '{"id":2,"fields":{"System.WorkItemType":"Bug","System.State":"Active","System.Tags":"ready-for-agent"},"relations":[]}'
    ;;
  "repos pr list")
    printf '%s\n' '[{"pullRequestId":99,"status":"completed","mergeStatus":"succeeded","targetRefName":"refs/heads/main"}]'
    ;;
  *) exit 0 ;;
esac
MERGEDAZ
chmod +x "${merged_bin}/az"
calls_before_merged="$(wc -l < "$calls")"
PATH="${merged_bin}:${PATH}" \
  progress_merged="$(tracker_recover_ticket_progress 2 feature/issue-2 2>/dev/null)"
[[ "$progress_merged" == "pr_merged" ]] || \
  fail "Azure progress recovery did not report pr_merged for a merged-but-incomplete ticket: ${progress_merged:-empty}"
PATH="${TEST_ROOT}/bin:${PATH}" tracker_prepare_worker_environment \
  >/dev/null || fail 'Azure guarded CLI environment was not restored after merged recovery test'
tracker_cleanup_worker_environment >/dev/null
# Ambiguous PR state must trigger RECOVERY_REQUIRED through a non-zero
# exit so the runner can surface the failure instead of advancing the
# queue.
ambig_bin="${TEST_ROOT}/ambig-bin"
mkdir -p "$ambig_bin"
cat > "${ambig_bin}/az" <<'AMBIGAZ'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$AZURE_TEST_CALLS"
case "$1 $2 $3" in
  "boards work-item show")
    printf '%s\n' '{"id":2,"fields":{"System.WorkItemType":"Bug","System.State":"Active","System.Tags":"ready-for-agent"},"relations":[]}'
    ;;
  "repos pr list")
    printf '%s\n' '[{"pullRequestId":42,"status":"completed","mergeStatus":"succeeded","targetRefName":"refs/heads/main"},{"pullRequestId":43,"status":"completed","mergeStatus":"succeeded","targetRefName":"refs/heads/main"}]'
    ;;
  *) exit 0 ;;
esac
AMBIGAZ
chmod +x "${ambig_bin}/az"
calls_before_ambig="$(wc -l < "$calls")"
if PATH="${ambig_bin}:${PATH}" \
   tracker_recover_ticket_progress 2 feature/issue-2 >/dev/null 2>&1; then
  PATH="${TEST_ROOT}/bin:${PATH}" tracker_prepare_worker_environment \
    >/dev/null || fail 'Azure guarded CLI environment was not restored after ambiguous recovery test'
  tracker_cleanup_worker_environment >/dev/null
  fail 'Azure progress recovery accepted an ambiguous PR state'
fi
PATH="${TEST_ROOT}/bin:${PATH}" tracker_prepare_worker_environment \
  >/dev/null || fail 'Azure guarded CLI environment was not restored after ambiguous recovery test'
tracker_cleanup_worker_environment >/dev/null
pass 'Azure progress recovery surfaces merged-but-incomplete and ambiguous states so the runner can fail closed'

runner_repo="${TEST_ROOT}/runner-repo"
runner_bin="${TEST_ROOT}/runner-bin"
runner_config="${TEST_ROOT}/runner-config.toml"
runner_worker="${TEST_ROOT}/runner-worker"
runner_output="${TEST_ROOT}/runner-output.log"
cp -R "$repo" "$runner_repo"
mkdir -p "$runner_bin"
# Each runner scenario needs the HU integration branch to exist so
# the bootstrap reuses it without prompting the operator. The
# tracker adapter tests cover multiple HUs (1, 8, and 100); without
# seeded titles, the default slug is "hu".
for branch in feature/1-hu feature/8-hu feature/100-payments-hu; do
  git -C "$runner_repo" branch "$branch" main >/dev/null 2>&1 || true
done
cat > "$runner_worker" <<'WORKER'
#!/usr/bin/env bash
printf '%s\n' '{"type":"result","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}'
WORKER
chmod +x "$runner_worker"
cat > "$runner_config" <<CONFIG
default_profile = "azure-test"

[profiles.azure-test]
label = "Claude Azure fixture"
cli = "claude"
command = "$runner_worker"
model = "fixture-model"

[profiles.azure-test.options]
permission_mode = "bypassPermissions"
CONFIG

ISSUE_RUNNER_ASSUME_YES=true \
ISSUE_KILLER_CONFIG_PATH="$runner_config" \
  "$RUNNER" "$runner_repo" >"$runner_output" 2>&1 || \
  fail 'Runner did not launch successfully against an Azure repository'
grep -Fq 'Tracker validated: Azure DevOps' "$runner_output" || \
  fail 'Runner did not select the Azure tracker adapter'
grep -Fq 'No pending, available, non-epic issues remain.' "$runner_output" || \
  fail 'Runner did not complete the Azure queue-empty lifecycle'
pass 'Runner selects Azure DevOps before launching the worker'

completion_worker="${TEST_ROOT}/completion-worker"
completion_counter="${TEST_ROOT}/completion-counter"
completion_config="${TEST_ROOT}/completion-config.toml"
completion_output="${TEST_ROOT}/completion-output.log"
cat > "$completion_worker" <<'WORKER'
#!/usr/bin/env bash
iteration=0
if [[ -r "$AZURE_COMPLETION_COUNTER" ]]; then
  iteration="$(<"$AZURE_COMPLETION_COUNTER")"
fi
iteration=$((iteration + 1))
printf '%s' "$iteration" > "$AZURE_COMPLETION_COUNTER"
if [[ "$iteration" -eq 1 ]]; then
  git switch -c feature/issue-10 >/dev/null
  az repos pr create --repository example-repo --source-branch feature/issue-10 --target-branch main >/dev/null
  az repos pr update --id 42 --status completed >/dev/null
  az boards work-item update --id 10 --state Done >/dev/null
  printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"az boards work-item show --id 10"}}]}}'
  printf '%s\n' '{"type":"result","result":"ISSUE_KILLER_STATUS=ISSUE_COMPLETED\n"}'
else
  printf '%s\n' '{"type":"result","result":"ISSUE_KILLER_STATUS=QUEUE_EMPTY\n"}'
fi
WORKER
chmod +x "$completion_worker"
cat > "$completion_config" <<CONFIG
default_profile = "azure-completion"

[profiles.azure-completion]
label = "Claude Azure completion fixture"
cli = "claude"
command = "$completion_worker"
model = "fixture-model"

[profiles.azure-completion.options]
permission_mode = "bypassPermissions"
CONFIG
AZURE_COMPLETION_COUNTER="$completion_counter" \
AZURE_SCOPE_TEST_MODE=completion \
AZURE_SCOPE_STATE_FILE="${TEST_ROOT}/completion-state" \
ISSUE_RUNNER_ASSUME_YES=true \
ISSUE_KILLER_CONFIG_PATH="$completion_config" \
  "$RUNNER" "$runner_repo" >"$completion_output" 2>&1 || \
  fail 'Runner did not verify an Azure completion end to end'
grep -Fq 'Worker 1 completed one issue.' "$completion_output" || \
  fail 'Runner did not accept the verified Azure completion'
grep -Fq 'No pending, available, non-epic issues remain.' "$completion_output" || \
  fail 'Runner did not drain the verified Azure completion fixture'
pass 'Runner verifies Azure work-item closure and merged PR state before accepting completion'

recovery_repo="${TEST_ROOT}/recovery-repo"
recovery_worker="${TEST_ROOT}/recovery-worker"
recovery_counter="${TEST_ROOT}/recovery-counter"
recovery_config="${TEST_ROOT}/recovery-config.toml"
recovery_output="${TEST_ROOT}/recovery-output.log"
cp -R "$repo" "$recovery_repo"
# The recovery scenario targets HU 1 with no title, so the
# deterministic HU branch is feature/1-hu. Pre-create it so the
# bootstrap reuses it instead of asking the operator.
for branch in feature/1-hu feature/100-payments-hu; do
  git -C "$recovery_repo" branch "$branch" main >/dev/null 2>&1 || true
done
cat > "$recovery_worker" <<'WORKER'
#!/usr/bin/env bash
count=0
if [[ -r "$AZURE_RECOVERY_COUNTER" ]]; then count="$(<"$AZURE_RECOVERY_COUNTER")"; fi
count=$((count + 1))
printf '%s' "$count" > "$AZURE_RECOVERY_COUNTER"
git switch -c feature/recovery-1 >/dev/null
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"az boards work-item show --id 1"}}]}}'
printf '%s\n' 'connection reset by peer' >&2
exit 1
WORKER
chmod +x "$recovery_worker"
cat > "$recovery_config" <<CONFIG
default_profile = "azure-recovery"

[profiles.azure-recovery]
label = "Claude Azure recovery fixture"
cli = "claude"
command = "$recovery_worker"
model = "fixture-model"

[profiles.azure-recovery.options]
permission_mode = "bypassPermissions"
CONFIG
if AZURE_RECOVERY_COUNTER="$recovery_counter" \
AZURE_SCOPE_TEST_MODE=recovery \
AZURE_SCOPE_STATE_FILE="${TEST_ROOT}/recovery-state" \
  ISSUE_RUNNER_RETRY_LIMIT=2 \
  ISSUE_RUNNER_RETRY_DELAYS=1 \
  ISSUE_RUNNER_ASSUME_YES=true \
  ISSUE_KILLER_CONFIG_PATH="$recovery_config" \
  "$RUNNER" "$recovery_repo" >"$recovery_output" 2>&1; then
  fail 'Azure recovery accepted partial work instead of requiring recovery'
else
  recovery_status=$?
fi
[[ "$recovery_status" -eq 4 ]] || \
  fail "Azure partial recovery returned ${recovery_status}, expected 4"
grep -Fq 'RECOVERY_REQUIRED' "$recovery_output" || \
  fail 'Azure partial recovery did not emit RECOVERY_REQUIRED'
[[ "$(<"$recovery_counter")" == 1 ]] || \
  fail 'Azure partial recovery launched a second worker'
pass 'Runner stops Azure partial recovery without selecting another work item'

invalid_mapping_repo="${TEST_ROOT}/invalid-mapping-repo"
invalid_mapping_output="${TEST_ROOT}/invalid-mapping-output.log"
cp -R "$repo" "$invalid_mapping_repo"
awk '$0 !~ /^organization[[:space:]]*=/' \
  "${invalid_mapping_repo}/docs/agents/issue-tracker.md" > \
  "${invalid_mapping_repo}/docs/agents/issue-tracker.md.tmp"
mv "${invalid_mapping_repo}/docs/agents/issue-tracker.md.tmp" \
  "${invalid_mapping_repo}/docs/agents/issue-tracker.md"
if tracker_initialize "$invalid_mapping_repo" >"$invalid_mapping_output" 2>&1; then
  fail 'Azure initialization accepted incomplete mappings'
fi
grep -Fq 'mapping is missing: organization' "$invalid_mapping_output" || \
  fail 'Incomplete Azure mapping diagnostic was not actionable'
pass 'Azure preflight rejects incomplete repository mappings'

mismatched_repo="${TEST_ROOT}/mismatched-repo"
mismatched_output="${TEST_ROOT}/mismatched-output.log"
cp -R "$repo" "$mismatched_repo"
awk '{if ($0 ~ /^repository[[:space:]]*=/) print "repository = \"other-repository\""; else print}' \
  "${mismatched_repo}/docs/agents/issue-tracker.md" > \
  "${mismatched_repo}/docs/agents/issue-tracker.md.tmp"
mv "${mismatched_repo}/docs/agents/issue-tracker.md.tmp" \
  "${mismatched_repo}/docs/agents/issue-tracker.md"
if tracker_initialize "$mismatched_repo" >"$mismatched_output" 2>&1; then
  fail 'Azure initialization accepted a remote/configuration mismatch'
fi
grep -Fq 'does not match the Git remote' "$mismatched_output" || \
  fail 'Azure remote mismatch diagnostic was not actionable'
pass 'Azure preflight rejects repository mapping mismatches'

no_extension_bin="${TEST_ROOT}/no-extension-bin"
mkdir -p "$no_extension_bin"
cat > "${no_extension_bin}/az" <<'NOEXT'
#!/usr/bin/env bash
if [[ "$1 $2 $3" == "extension show --name" ]]; then exit 1; fi
exit 0
NOEXT
chmod +x "${no_extension_bin}/az"
extension_output="${TEST_ROOT}/extension-output.log"
if PATH="$no_extension_bin:/usr/bin:/bin" tracker_initialize "$repo" >"$extension_output" 2>&1; then
  fail 'Azure initialization accepted a missing extension'
fi
grep -Fq 'azure-devops Azure CLI extension is required' "$extension_output" || \
  fail 'Missing Azure extension diagnostic was not actionable'
pass 'Azure preflight rejects a missing azure-devops extension'

printf '%s Azure DevOps tracker adapter tests passed.\n' 8
