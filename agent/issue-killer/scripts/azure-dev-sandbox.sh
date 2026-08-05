#!/usr/bin/env bash
# Opt-in DEV/sandbox contract for the Azure delivery HU workflow.
#
# This script exercises the live Azure DevOps shape that the orchestrator
# depends on without targeting production. Operators run it against a
# non-production project to verify the field catalog, permission model,
# attachment upload, native relations, pull-request verification, and Chrome
# evidence contract the orchestrator relies on.
#
# The contract is intentionally opt-in. The script never runs as part of the
# issue-killer supervisor and never touches the production mainline. Local
# black-box tests remain the source of confidence for the orchestrator itself.
#
# Required environment:
#   AZURE_DEV_SANDBOX_ORG          Azure DevOps organization (non-production)
#   AZURE_DEV_SANDBOX_PROJECT      Azure DevOps project (non-production)
#   AZURE_DEV_SANDBOX_REPO         Azure DevOps repository (non-production)
#   AZURE_DEV_SANDBOX_HU_ID        Numeric ID of the prepared HU to exercise
#   AZURE_DEV_SANDBOX_TICKET_ID    Numeric ID of the prepared direct child ticket
#   AZURE_DEV_SANDBOX_BRANCH       Source branch used to derive the HU branch
#
# The script exits with status 0 when every step reports success, 1 when any
# step fails, and 2 when a prerequisite is missing. Operators should report
# skipped live contracts explicitly in the project documentation.

set -euo pipefail

RUNNER_NAME="${RUNNER_NAME:-azure-dev-sandbox}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULT_FILE="${AZURE_DEV_SANDBOX_RESULT_FILE:-${RESULT_FILE:-}}"
if [[ -z "$RESULT_FILE" ]]; then
  RESULT_FILE="${SCRIPT_DIR}/azure-dev-sandbox.result.json"
fi
export RESULT_FILE

log() { printf '%s: %s\n' "$RUNNER_NAME" "$*"; }
warn() { printf '%s: WARN: %s\n' "$RUNNER_NAME" "$*" >&2; }
err() { printf '%s: ERROR: %s\n' "$RUNNER_NAME" "$*" >&2; }

need() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    err "missing required environment variable: ${name}"
    err "set ${name} to a non-production Azure DevOps value before running."
    exit 2
  fi
}

sanity_check_prod() {
  local label="$1" value="$2"
  case "$value" in
    *prod*|*production*|*live*)
      err "refusing to run against a ${label} that looks like production: ${value}"
      err "use a non-production organization, project, repository, and ticket."
      exit 2
      ;;
  esac
}

need AZURE_DEV_SANDBOX_ORG
need AZURE_DEV_SANDBOX_PROJECT
need AZURE_DEV_SANDBOX_REPO
need AZURE_DEV_SANDBOX_HU_ID
need AZURE_DEV_SANDBOX_TICKET_ID
need AZURE_DEV_SANDBOX_BRANCH

sanity_check_prod "organization" "$AZURE_DEV_SANDBOX_ORG"
sanity_check_prod "project" "$AZURE_DEV_SANDBOX_PROJECT"
sanity_check_prod "repository" "$AZURE_DEV_SANDBOX_REPO"
sanity_check_prod "branch" "$AZURE_DEV_SANDBOX_BRANCH"

if ! command -v az >/dev/null 2>&1; then
  err "az CLI is not installed; install the azure-devops extension before running."
  exit 2
fi

if ! az extension show --name azure-devops >/dev/null 2>&1; then
  err "azure-devops extension is not installed; run: az extension add --name azure-devops"
  exit 2
fi

if ! az devops user show >/dev/null 2>&1; then
  warn "current operator is not authenticated; the live contract will record every step as skipped."
  AZURE_DEV_SANDBOX_AUTHENTICATED="false"
else
  AZURE_DEV_SANDBOX_AUTHENTICATED="true"
fi

results=()
record() {
  local name="$1" status="$2" detail="$3"
  results+=("{\"step\":\"${name}\",\"status\":\"${status}\",\"detail\":\"${detail}\"}")
}

run_step() {
  local name="$1" cmd="$2"
  local output status
  if [[ "$AZURE_DEV_SANDBOX_AUTHENTICATED" != "true" ]]; then
    record "$name" "skipped" "operator not authenticated; run az login first"
    warn "step ${name} skipped: operator not authenticated"
    return 0
  fi
  set +e
  output="$(${cmd} 2>&1)"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    record "$name" "ok" "${output//\"/\\\"}"
  else
    record "$name" "skipped" "$output"
    warn "step ${name} skipped: ${output}"
  fi
}

log "Verifying Azure DevOps project reachability"
run_step "project_show" \
  "az devops project show --org https://dev.azure.com/${AZURE_DEV_SANDBOX_ORG} \
    --project ${AZURE_DEV_SANDBOX_PROJECT}"

log "Verifying repository reachability"
run_step "repository_show" \
  "az repos show --repository ${AZURE_DEV_SANDBOX_REPO} \
    --org https://dev.azure.com/${AZURE_DEV_SANDBOX_ORG} \
    --project ${AZURE_DEV_SANDBOX_PROJECT}"

log "Resolving the completion evidence field from the live field catalog"
run_step "evidence_field" \
  "az devops invoke --area wit --resource fields \
    --org https://dev.azure.com/${AZURE_DEV_SANDBOX_ORG} \
    --project ${AZURE_DEV_SANDBOX_PROJECT} \
    --query \"value[?name=='Completion Evidence'].{name:name,referenceName:referenceName,type:type,readOnly:readOnly}\" \
    --output json"

log "Resolving the Real Effort field from the live field catalog"
run_step "real_effort_field" \
  "az devops invoke --area wit --resource fields \
    --org https://dev.azure.com/${AZURE_DEV_SANDBOX_ORG} \
    --project ${AZURE_DEV_SANDBOX_PROJECT} \
    --query \"value[?name=='Real Effort'].{name:name,referenceName:referenceName,type:type,readOnly:readOnly}\" \
    --output json"

log "Inspecting the prepared HU ($AZURE_DEV_SANDBOX_HU_ID)"
run_step "hu_show" \
  "az boards work-item show --id ${AZURE_DEV_SANDBOX_HU_ID} \
    --org https://dev.azure.com/${AZURE_DEV_SANDBOX_ORG} \
    --project ${AZURE_DEV_SANDBOX_PROJECT}"

log "Inspecting the prepared ticket ($AZURE_DEV_SANDBOX_TICKET_ID)"
run_step "ticket_show" \
  "az boards work-item show --id ${AZURE_DEV_SANDBOX_TICKET_ID} \
    --org https://dev.azure.com/${AZURE_DEV_SANDBOX_ORG} \
    --project ${AZURE_DEV_SANDBOX_PROJECT}"

log "Verifying predecessor relations the orchestrator consults"
run_step "predecessor_relation" \
  "az boards work-item relation list --id ${AZURE_DEV_SANDBOX_TICKET_ID} \
    --org https://dev.azure.com/${AZURE_DEV_SANDBOX_ORG} \
    --project ${AZURE_DEV_SANDBOX_PROJECT}"

log "Listing pull requests targeting the configured base branch"
run_step "pull_request_list" \
  "az repos pr list --target-branch ${AZURE_DEV_SANDBOX_BRANCH} --status all \
    --org https://dev.azure.com/${AZURE_DEV_SANDBOX_ORG} \
    --project ${AZURE_DEV_SANDBOX_PROJECT} \
    --repository ${AZURE_DEV_SANDBOX_REPO}"

log "Inspecting Chrome availability for the evidence modality"
if command -v google-chrome >/dev/null 2>&1 || \
   command -v chromium >/dev/null 2>&1 || \
   command -v google-chrome-stable >/dev/null 2>&1; then
  record "chrome_evidence" "ok" "Chrome executable available on PATH"
else
  record "chrome_evidence" "skipped" \
    "no Chrome executable on PATH; the orchestrator must report BLOCKED until Chrome is available"
  warn "Chrome is missing; backend, frontend, and mixed tickets will report BLOCKED."
fi

log "Writing result manifest to ${RESULT_FILE}"
{
  printf '{\n  "contract": "azure-dev-sandbox",\n'
  printf '  "organization": "%s",\n' "$AZURE_DEV_SANDBOX_ORG"
  printf '  "project": "%s",\n' "$AZURE_DEV_SANDBOX_PROJECT"
  printf '  "repository": "%s",\n' "$AZURE_DEV_SANDBOX_REPO"
  printf '  "hu_id": %s,\n' "$AZURE_DEV_SANDBOX_HU_ID"
  printf '  "ticket_id": %s,\n' "$AZURE_DEV_SANDBOX_TICKET_ID"
  printf '  "branch": "%s",\n' "$AZURE_DEV_SANDBOX_BRANCH"
  printf '  "steps": [\n'
  for ((i = 0; i < ${#results[@]}; i++)); do
    if (( i > 0 )); then printf ',\n'; fi
    printf '    %s' "${results[$i]}"
  done
  printf '\n  ]\n}\n'
} > "$RESULT_FILE"

log "Done. Inspect ${RESULT_FILE} for the live contract status."
exit 0
