#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADAPTER="${ROOT_DIR}/agent/claude-minimax-issue-runner/tracker/github-adapter.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/github-tracker-adapter.XXXXXX")"
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
printf '%s\n' '# Issue Tracker: GitHub' '' 'Use the `gh` CLI for all operations.' > "${repo}/docs/agents/issue-tracker.md"
git -C "$repo" add .
git -C "$repo" commit --quiet -m 'test: seed'
git -C "$repo" remote add origin https://github.com/example/fixture.git

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "%s\\n" "$*" >> "'"$calls"'"' \
  'case "$1 $2" in' \
  '  "auth status") printf "%s\\n" "Logged in" ;;' \
  '  "issue list") printf "%s\\n" '\''[{"number":1,"title":"ready","labels":[{"name":"ready-for-agent"}],"assignees":[],"issueType":null},{"number":2,"title":"assigned","labels":[{"name":"ready-for-agent"}],"assignees":[{"login":"someone"}],"issueType":null},{"number":3,"title":"epic label","labels":[{"name":"ready-for-agent"},{"name":"epic"}],"assignees":[],"issueType":null},{"number":4,"title":"[Epic] title","labels":[{"name":"ready-for-agent"}],"assignees":[],"issueType":null},{"number":5,"title":"epic type","labels":[{"name":"ready-for-agent"}],"assignees":[],"issueType":{"name":"Epic"}},{"number":6,"title":"blocked","labels":[{"name":"ready-for-agent"}],"assignees":[],"issueType":null}]'\'' ;;' \
  '  "api repos/example/fixture/issues/6") printf "%s\\n" "1" ;;' \
  '  "api repos/"*) printf "%s\\n" "0" ;;' \
  '  "issue view") printf "%s\\n" '\''{"state":"OPEN","labels":[{"name":"ready-for-agent"}],"assignees":[]}'\'' ;;' \
  '  "issue edit") printf "%s\\n" "claimed" ;;' \
  '  "issue close") printf "%s\\n" "closed" ;;' \
  '  "pr list") printf "%s\\n" '\''[{"state":"MERGED","number":9,"mergedAt":"2026-08-01T00:00:00Z"}]'\'' ;;' \
  '  *) exit 1 ;;' \
  'esac' > "${bin_dir}/gh"
chmod +x "${bin_dir}/gh"

export PATH="${bin_dir}:$PATH"
export RUNNER_NAME=tracker-test
source "$ADAPTER"
tracker_initialize "$repo" >/dev/null || fail 'Tracker initialization failed'

eligible="$(tracker_list_eligible_items)"
[[ "$eligible" == "1" ]] || fail "Expected only issue 1 to be eligible, got: ${eligible}"

tracker_item_claim 1 >/dev/null || fail 'Tracker claim operation failed'
tracker_item_close 1 >/dev/null || fail 'Tracker close operation failed'
pr_json="$(tracker_prs_for_branch main)"
[[ "$(tracker_pr_is_merged "$pr_json")" == true ]] || fail 'Merged PR state was not normalized'
grep -Fq 'issue edit 1 --add-assignee @me' "$calls" || fail 'Claim was not delegated to tracker adapter'
grep -Fq 'issue close 1' "$calls" || fail 'Close was not delegated to tracker adapter'

pass 'GitHub tracker adapter filters queue items and normalizes lifecycle operations'
printf '%s GitHub tracker adapter tests passed.\n' 1
