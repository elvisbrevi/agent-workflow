#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="${ROOT_DIR}/agent/claude-minimax-issue-runner/run.sh"
SELECTOR="${ROOT_DIR}/agent/claude-minimax-issue-runner/tracker/selector.sh"
ADAPTER="${ROOT_DIR}/agent/claude-minimax-issue-runner/tracker/azure-devops-adapter.sh"
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
open_states = ["New", "Active"]
closed_states = ["Closed", "Done"]
ready_tag = "ready-for-agent"
claim_identity = "@me"
predecessor_relation = "System.LinkTypes.Dependency"
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
  "boards query --wiql") printf '%s\n' '[{"id":1},{"id":2},{"id":3},{"id":4},{"id":5},{"id":6},{"id":8}]' ;;
  "boards work-item show")
    id=""
    previous=""
    for arg in "$@"; do
      if [[ "$previous" == "--id" ]]; then id="$arg"; fi
      previous="$arg"
    done
    case "$id" in
      1) printf '%s\n' '{"id":1,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent"},"relations":[]}' ;;
      2) printf '%s\n' '{"id":2,"fields":{"System.WorkItemType":"Bug","System.State":"Active","System.AssignedTo":{"displayName":"Other"},"System.Tags":"ready-for-agent"},"relations":[]}' ;;
      3) printf '%s\n' '{"id":3,"fields":{"System.WorkItemType":"Task","System.State":"Closed","System.Tags":"ready-for-agent"},"relations":[]}' ;;
      4) printf '%s\n' '{"id":4,"fields":{"System.WorkItemType":"Epic","System.State":"Active","System.Tags":"ready-for-agent"},"relations":[]}' ;;
      5) printf '%s\n' '{"id":5,"fields":{"System.WorkItemType":"Bug","System.State":"Active","System.Tags":"other"},"relations":[]}' ;;
      6) printf '%s\n' '{"id":6,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent"},"relations":[{"rel":"System.LinkTypes.Dependency","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/7"}]}' ;;
      7) printf '%s\n' '{"id":7,"fields":{"System.WorkItemType":"Task","System.State":"Active"},"relations":[]}' ;;
      8) printf '%s\n' '{"id":8,"fields":{"System.WorkItemType":"User Story","System.State":"Active","System.Tags":"ready-for-agent"},"relations":[{"rel":"System.LinkTypes.Dependency","url":"https://dev.azure.com/example-org/example-project/_apis/wit/workItems/9"}]}' ;;
      9) printf '%s\n' '{"id":9,"fields":{"System.WorkItemType":"Task","System.State":"Done"},"relations":[]}' ;;
      *) exit 1 ;;
    esac
    ;;
  "boards work-item update") printf '%s\n' '{"id":1,"fields":{"System.State":"Done"}}' ;;
  "repos pr list") printf '%s\n' '[{"pullRequestId":42,"status":"completed","mergeStatus":"succeeded","targetRefName":"refs/heads/main"}]' ;;
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

eligible="$(tracker_list_eligible_items)"
[[ "$eligible" == $'1\n8' ]] || \
  fail "Unexpected Azure queue: ${eligible}"
tracker_item_claim 1 >/dev/null || fail 'Azure claim operation failed'
tracker_item_close 1 >/dev/null || fail 'Azure close operation failed'
pr_json="$(tracker_prs_for_branch feature/issue-16)"
[[ "$(tracker_pr_is_merged "$pr_json")" == true ]] || \
  fail 'Azure merged PR state was not normalized'
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

printf '%s Azure DevOps tracker adapter tests passed.\n' 6
