#!/usr/bin/env bash
# Black-box tests for the opt-in Azure DEV/sandbox contract.
#
# The DEV/sandbox contract is opt-in. It must refuse to run without the
# required environment variables, refuse to run against what looks like a
# production target, and surface every step the orchestrator relies on so
# operators can record skipped live contracts explicitly.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT_DIR}/agent/issue-killer/scripts/azure-dev-sandbox.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }
TESTS_RUN=0

need_bash() {
  if [[ -z "${BASH_BIN:-}" ]]; then
    BASH_BIN="$(command -v bash)"
  fi
  command -v "$BASH_BIN" >/dev/null 2>&1 || \
    fail "no bash interpreter available for tests"
}

need_bash
pass 'bash interpreter resolved'

TESTS_RUN_RUN=0

[[ -x "$SCRIPT" ]] || fail "DEV/sandbox script is not executable: ${SCRIPT}"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/azure-dev-sandbox.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

# The script must exit with a non-zero status when any required environment
# variable is missing. The diagnostic must name the missing variable so an
# operator can resolve it without reading the script source.
unset AZURE_DEV_SANDBOX_ORG AZURE_DEV_SANDBOX_PROJECT \
      AZURE_DEV_SANDBOX_REPO AZURE_DEV_SANDBOX_HU_ID \
      AZURE_DEV_SANDBOX_TICKET_ID AZURE_DEV_SANDBOX_BRANCH
set +e
missing_log="${TMP_ROOT}/missing.log"
RESULT_FILE="${TMP_ROOT}/missing.json" \
  "$BASH_BIN" "$SCRIPT" >"$missing_log" 2>&1
missing_status=$?
set -e
[[ "$missing_status" -ne 0 ]] || \
  fail 'DEV/sandbox script accepted a run with no environment variables'
grep -Fq 'AZURE_DEV_SANDBOX_ORG' "$missing_log" || \
  fail 'DEV/sandbox error did not name the missing organization variable'
pass 'script exits non-zero when required environment variables are missing'

# The script must refuse to run against a value that looks like a production
# target. Operators must use a non-production organization, project, repository,
# and branch.
export AZURE_DEV_SANDBOX_ORG="example-prod-org"
export AZURE_DEV_SANDBOX_PROJECT="example-project"
export AZURE_DEV_SANDBOX_REPO="example-repo"
export AZURE_DEV_SANDBOX_HU_ID="100"
export AZURE_DEV_SANDBOX_TICKET_ID="103"
export AZURE_DEV_SANDBOX_BRANCH="main"
set +e
prod_log="${TMP_ROOT}/prod.log"
AZURE_DEV_SANDBOX_RESULT_FILE="${TMP_ROOT}/prod.json" \
  "$BASH_BIN" "$SCRIPT" >"$prod_log" 2>&1
prod_status=$?
set -e
[[ "$prod_status" -ne 0 ]] || \
  fail 'DEV/sandbox script accepted a production-shaped organization'
grep -Fq 'production' "$prod_log" || \
  fail 'DEV/sandbox error did not mention production refusal'
unset AZURE_DEV_SANDBOX_ORG

# The script must also refuse a production-shaped branch.
export AZURE_DEV_SANDBOX_ORG="example-sandbox-org"
export AZURE_DEV_SANDBOX_BRANCH="production-test-branch"
set +e
prod_branch_log="${TMP_ROOT}/prod-branch.log"
AZURE_DEV_SANDBOX_RESULT_FILE="${TMP_ROOT}/prod-branch.json" \
  "$BASH_BIN" "$SCRIPT" >"$prod_branch_log" 2>&1
prod_branch_status=$?
set -e
[[ "$prod_branch_status" -ne 0 ]] || \
  fail 'DEV/sandbox script accepted a production-shaped branch'
grep -Fq 'branch' "$prod_branch_log" || \
  fail 'DEV/sandbox error did not mention the production branch'
pass 'script refuses to run against a production-shaped target'

# When the prerequisites are met but the live Azure tooling is unavailable,
# the script must still execute, skip the live steps, and write a result
# manifest that names the skipped steps. Operators publish the manifest so
# skipped live contracts are reported explicitly.
export AZURE_DEV_SANDBOX_ORG="example-sandbox-org"
export AZURE_DEV_SANDBOX_PROJECT="example-project"
export AZURE_DEV_SANDBOX_REPO="example-repo"
export AZURE_DEV_SANDBOX_HU_ID="100"
export AZURE_DEV_SANDBOX_TICKET_ID="103"
export AZURE_DEV_SANDBOX_BRANCH="feature/sandbox"
result_manifest="${TMP_ROOT}/sandbox.json"
run_log="${TMP_ROOT}/sandbox.log"
PATH="${TMP_ROOT}/empty-bin:${PATH}" \
AZURE_DEV_SANDBOX_RESULT_FILE="$result_manifest" \
  "$BASH_BIN" "$SCRIPT" >"$run_log" 2>&1 || \
  fail 'DEV/sandbox script failed to emit the manifest when live tooling is missing'
[[ -f "$result_manifest" ]] || \
  fail 'DEV/sandbox script did not write the result manifest'
grep -Fq '"contract": "azure-dev-sandbox"' "$result_manifest" || \
  fail 'Result manifest did not declare the contract name'
grep -Fq '"steps":' "$result_manifest" || \
  fail 'Result manifest did not declare the steps list'
grep -Fq '"step":"project_show"' "$result_manifest" || \
  fail 'Result manifest did not record the project_show step'
grep -Fq '"step":"chrome_evidence"' "$result_manifest" || \
  fail 'Result manifest did not record the chrome_evidence step'
pass 'script records every step and surfaces skipped live contracts'

printf '%s Azure DEV/sandbox tests passed.\n' 4
TESTS_RUN=4
printf '%s total\n' "$TESTS_RUN"
