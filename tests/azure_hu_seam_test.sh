#!/usr/bin/env bash
# Black-box Azure HU workflow seam tests.
#
# These tests verify the approved Azure HU delivery specification is anchored
# in the repository's user-facing artifacts. The runner must expose the
# operator guide, the documented prerequisites, the destructive
# authorization, the status protocol, and the opt-in DEV/sandbox contract
# that the operator guide mandates. The tests read the repository files
# directly so they stay agnostic to the runner's internal naming.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TESTS_RUN=0

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; TESTS_RUN=$((TESTS_RUN + 1)); }
assert_contains() {
  local file="$1" needle="$2" description="$3"
  if ! grep -Fq "$needle" "$file"; then
    fail "${description} (missing '${needle}' in ${file#$ROOT_DIR/})"
  fi
}

OPERATOR_GUIDE="${ROOT_DIR}/docs/agents/azure-hu-operator-guide.md"
AGENT_METADATA="${ROOT_DIR}/agent/issue-killer/AGENT.md"
AGENT_REFERENCE="${ROOT_DIR}/agent/issue-killer/REFERENCE.md"
INSTALLER="${ROOT_DIR}/install.sh"
DEV_SANDBOX="${ROOT_DIR}/agent/issue-killer/scripts/azure-dev-sandbox.sh"

# The operator guide must exist and document every dimension the issue
# requires: explicit and automatic HU selection, first-run origin choice,
# branch naming, ticket sequencing, evidence requirements, field mappings,
# Real Effort, recovery, and the prohibition on HU closure or mainline
# promotion.
[[ -f "$OPERATOR_GUIDE" ]] || fail "Missing operator guide: ${OPERATOR_GUIDE}"
assert_contains "$OPERATOR_GUIDE" "Selecting A Delivery HU" \
  "operator guide did not document HU selection"
assert_contains "$OPERATOR_GUIDE" "First-Run Origin Choice" \
  "operator guide did not document first-run origin choice"
assert_contains "$OPERATOR_GUIDE" "Branch Naming" \
  "operator guide did not document branch naming"
assert_contains "$OPERATOR_GUIDE" "Ticket Sequencing" \
  "operator guide did not document ticket sequencing"
assert_contains "$OPERATOR_GUIDE" "Evidence Requirements" \
  "operator guide did not document evidence requirements"
assert_contains "$OPERATOR_GUIDE" "Field Mappings" \
  "operator guide did not document field mappings"
assert_contains "$OPERATOR_GUIDE" "Real Effort" \
  "operator guide did not document Real Effort"
assert_contains "$OPERATOR_GUIDE" "Recovery" \
  "operator guide did not document recovery"
assert_contains "$OPERATOR_GUIDE" "Prohibited Behaviors" \
  "operator guide did not document prohibited behaviors"
assert_contains "$OPERATOR_GUIDE" "mainline" \
  "operator guide did not mention the mainline prohibition"
assert_contains "$OPERATOR_GUIDE" "DEV/sandbox" \
  "operator guide did not reference the DEV/sandbox contract"
assert_contains "$OPERATOR_GUIDE" "skipped live contracts" \
  "operator guide did not commit to reporting skipped live contracts"
pass 'operator guide documents every required dimension'

# The agent metadata must describe destructive authorization, Chrome
# prerequisites, the checkpoint, the status protocol, and recovery.
assert_contains "$AGENT_METADATA" "destructive" \
  "agent metadata did not describe destructive authorization"
assert_contains "$AGENT_METADATA" "Chrome" \
  "agent metadata did not reference Chrome prerequisites"
assert_contains "$AGENT_METADATA" "Checkpoint and Status" \
  "agent metadata did not document the checkpoint"
assert_contains "$AGENT_METADATA" "BLOCKED" \
  "agent metadata did not document the BLOCKED status"
assert_contains "$AGENT_METADATA" "FAILED" \
  "agent metadata did not document the FAILED status"
assert_contains "$AGENT_METADATA" "RECOVERY_REQUIRED" \
  "agent metadata did not document the RECOVERY_REQUIRED status"
assert_contains "$AGENT_METADATA" "Recovery" \
  "agent metadata did not document recovery"
pass 'agent metadata documents destructive authorization, Chrome, and recovery'

# The agent reference must link the operator to the operator guide and
# describe the Azure prerequisites.
assert_contains "$AGENT_REFERENCE" "azure-hu-operator-guide.md" \
  "agent reference did not link to the Azure HU operator guide"
assert_contains "$AGENT_REFERENCE" "Azure prerequisites" \
  "agent reference did not document Azure prerequisites"
assert_contains "$AGENT_REFERENCE" "Chrome" \
  "agent reference did not document Chrome prerequisites"
assert_contains "$AGENT_REFERENCE" "claim_identity" \
  "agent reference did not document the claim_identity prerequisite"
assert_contains "$AGENT_REFERENCE" "master" \
  "agent reference did not document the first-run origin choice"
assert_contains "$AGENT_REFERENCE" "develop" \
  "agent reference did not document the first-run origin choice"
pass 'agent reference links the operator guide and prerequisites'

# The installer must continue to discover the existing agent namespace and
# must not promote any non-agent artifact into the agent namespaces.
assert_contains "$INSTALLER" "AGENT_CATEGORIES" \
  "installer does not declare the agent namespace"
assert_contains "$INSTALLER" "discover_agents" \
  "installer does not discover agents"
assert_contains "$INSTALLER" "remove_managed_links" \
  "installer does not reconcile stale managed links"
if grep -Fq 'docs/agents' "$INSTALLER"; then
  fail "installer should not promote docs/agents into the agent namespace"
fi
pass 'installer preserves the agent namespace without polluting it'

# The DEV/sandbox contract must exist and refuse to run against a target
# that looks like production.
[[ -x "$DEV_SANDBOX" ]] || fail "DEV/sandbox script is not executable: ${DEV_SANDBOX}"
assert_contains "$DEV_SANDBOX" "production" \
  "DEV/sandbox script does not check for production-shaped targets"
assert_contains "$DEV_SANDBOX" "Chrome" \
  "DEV/sandbox script does not probe Chrome availability"
assert_contains "$DEV_SANDBOX" "field" \
  "DEV/sandbox script does not verify the field catalog"
assert_contains "$DEV_SANDBOX" "attachment" \
  "DEV/sandbox script does not mention attachment upload"
assert_contains "$DEV_SANDBOX" "manifest" \
  "DEV/sandbox script does not mention a manifest"
pass 'DEV/sandbox contract exists, is executable, and forbids production runs'

# The README must declare the new test catalog so operators can run the
# approved suite without reading the agent files.
README="${ROOT_DIR}/README.md"
AGENTS="${ROOT_DIR}/AGENTS.md"
assert_contains "$README" "tests/azure_dev_sandbox_test.sh" \
  "README did not declare the DEV/sandbox test"
assert_contains "$AGENTS" "tests/azure_dev_sandbox_test.sh" \
  "AGENTS.md did not declare the DEV/sandbox test"
assert_contains "$README" "docs/agents/azure-hu-operator-guide.md" \
  "README did not reference the Azure HU operator guide"
pass 'repository documentation declares the new test catalog and operator guide'

printf '%s Azure HU seam tests passed.\n' "$TESTS_RUN"
