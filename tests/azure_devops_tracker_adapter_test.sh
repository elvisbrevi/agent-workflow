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
          printf '%s\n' '{"id":1,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent"},"relations":[]}'
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
          printf '%s\n' '{"id":10,"fields":{"System.WorkItemType":"User Story","System.State":"Done","System.Tags":"ready-for-agent"},"relations":[]}'
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
