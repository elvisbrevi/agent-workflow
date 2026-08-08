#!/usr/bin/env bash
# Black-box tests for the Azure delivery HU progress module added for
# issue #41. The fixtures drive the module directly so the test stays
# independent of the runtime adapter and the Azure tracker adapter.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HU_PROGRESS="${ROOT_DIR}/agent/issue-killer/tracker/hu-progress.sh"
LOCK_MODULE="${ROOT_DIR}/agent/issue-killer/state/repository-lock.sh"
CHECKPOINT_MODULE="${ROOT_DIR}/agent/issue-killer/state/checkpoint.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/hu-progress.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

if [[ ! -r "$HU_PROGRESS" ]]; then
  fail "hu-progress module not found: ${HU_PROGRESS}"
fi

# Build a sandbox repository so checkpoint_file() can resolve a
# Git-common directory without leaking state into the host repository.
sandbox="${TEST_ROOT}/sandbox"
mkdir -p "$sandbox"
git -C "$sandbox" init -b main --quiet
git -C "$sandbox" -c init.defaultBranch=main commit --allow-empty -m seed --quiet
GIT_COMMON_DIR="$(git -C "$sandbox" rev-parse --git-common-dir)"
export GIT_COMMON_DIR
export RUNNER_NAME="issue-killer"
export ITERATION=1
export BASE_BRANCH="main"
export LOCK_HELD=false
export LOCK_DIR=""
export CHECKPOINT_ISSUE=""
export CHECKPOINT_HU=""
export CHECKPOINT_TICKET=""

# Source the module and the supporting helpers so write_lock_status and
# checkpoint_file resolve to the sandbox. The HU progress module is
# written to be safe to source without the full runtime adapter set.
timestamp() { date '+%Y-%m-%d %H:%M:%S %z'; }
source "$CHECKPOINT_MODULE"
source "$LOCK_MODULE"
source "$HU_PROGRESS"

# --- Phase taxonomy ---------------------------------------------------

phases="$(hu_progress_phases)"
expected="hu-selected
ticket-selected
hu-branch-prepared
ticket-branch-created
evidence-captured
evidence-recorded
effort-recorded
ticket-integrated
ticket-done
recovery-clause
recovery-resumed"
if [[ "$phases" != "$expected" ]]; then
  fail "phase taxonomy drifted:
expected:
$expected
actual:
$phases"
fi
pass 'phase taxonomy exposes the canonical 11 HU lifecycle phases'

# --- Phase validation -------------------------------------------------

known=0
while IFS= read -r phase; do
  hu_progress_phase_is_known "$phase" || fail "phase must be known: $phase"
  known=$((known + 1))
done < <(hu_progress_phases)
if (( known != 11 )); then
  fail "expected 11 known phases, got $known"
fi
hu_progress_phase_is_known "ticket-done" || fail 'ticket-done must be known'
hu_progress_phase_is_known "not-a-phase" && fail 'unknown phase must fail' || true
hu_progress_phase_is_known "" && fail 'empty phase must fail' || true
pass 'phase validation accepts canonical phases and rejects unknown or empty input'

# --- Sanitization -----------------------------------------------------

sanitized="$(hu_progress_sanitize_detail 'ghp_deadbeefcafebabedeadbeefcafebabe')"
[[ "$sanitized" == "<redacted:credential>" ]] || \
  fail "GitHub credential not redacted: $sanitized"
sanitized="$(hu_progress_sanitize_detail 'api_key=sk-1234567890abcdefg')"
[[ "$sanitized" == "api_key=<redacted>" ]] || \
  fail "key/value credential not redacted: $sanitized"
sanitized="$(hu_progress_sanitize_detail 'Authorization: Bearer abcdef1234567890')"
case "$sanitized" in
  *"<redacted:authorization>"*|*"<redacted:bearer>"*) ;;
  *) fail "Authorization header not redacted: $sanitized" ;;
esac
sanitized="$(hu_progress_sanitize_detail '-----BEGIN RSA PRIVATE KEY----- guard -----END RSA PRIVATE KEY-----')"
[[ "$sanitized" == "<redacted:private-key>" ]] || \
  fail "PEM block not redacted: $sanitized"
sanitized="$(hu_progress_sanitize_detail 'shot=/tmp/capture.png')"
[[ "$sanitized" == "shot=<redacted:attachment>" ]] || \
  fail "PNG attachment path not redacted: $sanitized"
# Long base64 payload (>= 120 chars, base64 alphabet)
b64="$(printf 'A%.0s' {1..140})"
sanitized="$(hu_progress_sanitize_detail "$b64")"
[[ "$sanitized" == "<redacted:payload>" ]] || \
  fail "base64 payload not redacted: $sanitized"
# Empty detail returns empty
sanitized="$(hu_progress_sanitize_detail '')"
[[ -z "$sanitized" ]] || fail "empty detail must produce empty output: $sanitized"
# Length cap is 240 characters (use a value that doesn't trigger the
# base64 payload scrub so the truncation branch is exercised)
long=""
for i in $(seq 1 50); do long+="row-$i-"; done
sanitized="$(hu_progress_sanitize_detail "$long")"
[[ "${#sanitized}" -le 240 ]] || \
  fail "sanitized detail exceeds 240 char cap: ${#sanitized}"
[[ "$sanitized" == *"..." ]] || fail "long detail must be ellipsis-truncated"
pass 'sanitization redacts credentials, PEM blocks, attachments, and base64 payloads'

# --- Lock status mirror ----------------------------------------------

LOCK_DIR="${GIT_COMMON_DIR}/issue-killer.lock"
mkdir -p "$LOCK_DIR"
LOCK_TOKEN="t-$$"
printf 'pid=%s\ntoken=%s\n' "$$" "$LOCK_TOKEN" > "${LOCK_DIR}/owner"
LOCK_HELD=true
TRACKER_HU_TICKET_BRANCH=""
TRACKER_HU_EVIDENCE_URL=""
TRACKER_HU_REAL_EFFORT_HOURS=""
TRACKER_HU_PHASE=""

hu_progress_event "hu-selected" "HU 100" "issue-42-ticket" "https://example.com/file.png" "1.5"

[[ "$TRACKER_HU_PHASE" == "hu-selected" ]] || \
  fail "lock status did not capture hu_phase: $TRACKER_HU_PHASE"
[[ "$TRACKER_HU_TICKET_BRANCH" == "issue-42-ticket" ]] || \
  fail "ticket branch not captured: $TRACKER_HU_TICKET_BRANCH"
[[ "$TRACKER_HU_EVIDENCE_URL" == "<redacted:attachment>" ]] || \
  fail "evidence URL not redacted: $TRACKER_HU_EVIDENCE_URL"
[[ "$TRACKER_HU_REAL_EFFORT_HOURS" == "1.5" ]] || \
  fail "real effort hours not captured: $TRACKER_HU_REAL_EFFORT_HOURS"
grep -Fq 'hu_phase=hu-selected' "${LOCK_DIR}/status" || \
  fail "lock status file missing hu_phase"
grep -Fq 'ticket_branch=issue-42-ticket' "${LOCK_DIR}/status" || \
  fail "lock status file missing ticket_branch"
grep -Fq 'real_effort_hours=1.5' "${LOCK_DIR}/status" || \
  fail "lock status file missing real_effort_hours"
grep -q 'evidence_url=https://example.com/file.png' "${LOCK_DIR}/status" && \
  fail "lock status leaked raw evidence URL" || true
pass 'lock status mirrors the HU phase and support metadata with redaction'

# --- Phase transition updates ----------------------------------------

hu_progress_event "evidence-captured" "capture-1" "issue-42-ticket" "https://example.com/shot.png" ""
[[ "$TRACKER_HU_PHASE" == "evidence-captured" ]] || \
  fail "phase transition not recorded: $TRACKER_HU_PHASE"
grep -Fq 'hu_phase=evidence-captured' "${LOCK_DIR}/status" || \
  fail "lock status did not update the phase"
hu_progress_event "ticket-done" "Done" "" "" ""
[[ "$TRACKER_HU_PHASE" == "ticket-done" ]] || \
  fail "ticket-done phase not recorded"
[[ "$TRACKER_HU_TICKET_BRANCH" == "issue-42-ticket" ]] || \
  fail "ticket branch should remain when not retouched: $TRACKER_HU_TICKET_BRANCH"
grep -Fq 'hu_phase=ticket-done' "${LOCK_DIR}/status" || \
  fail "lock status did not record ticket-done"
pass 'phase transitions advance the lock status with the latest phase'

# --- Operator-visible progress line ---------------------------------

output="$(
  LOCK_HELD=true
  LOCK_TOKEN="t-$$"
  TRACKER_HU_PHASE=""
  TRACKER_HU_TICKET_BRANCH=""
  TRACKER_HU_EVIDENCE_URL=""
  TRACKER_HU_REAL_EFFORT_HOURS=""
  hu_progress_event "ticket-branch-created" "issue-42-ticket" "issue-42-ticket" "" ""
)"
[[ "$output" == *"[issue-killer] Opened ticket branch: issue-42-ticket"* ]] || \
  fail "progress line missing: $output"

# Without an active lock, the helper still emits the progress line and
# stays safe to invoke from migration tests.
LOCK_HELD=false
output="$(hu_progress_event "recovery-clause" "fresh-2" "" "" "")"
[[ "$output" == *"[issue-killer] Prepared transport recovery: fresh-2"* ]] || \
  fail "recovery-clause progress line missing: $output"
pass 'progress lines are emitted through the canonical helper with and without an active lock'

# --- Unknown phase is rejected ---------------------------------------

set +e
output="$(hu_progress_event "unknown-phase" 2>&1)"
status=$?
set -e
[[ "$status" -ne 0 ]] || fail "unknown phase must fail"
[[ "$output" == *"unknown phase"* ]] || \
  fail "unknown phase must report unknown phase: $output"
pass 'unknown phase is rejected with an actionable diagnostic'

# --- Checkpoint append ----------------------------------------------

target="${GIT_COMMON_DIR}/issue-killer.checkpoint"
: > "$target"
hu_progress_event "effort-recorded" "2.0" "issue-42-ticket" "" "2.0"
grep -Fq 'hu_phase=effort-recorded' "$target" || \
  fail "checkpoint missing hu_phase"
grep -Fq 'ticket_branch=issue-42-ticket' "$target" || \
  fail "checkpoint missing ticket_branch"
grep -Fq 'real_effort_hours=2.0' "$target" || \
  fail "checkpoint missing real_effort_hours"
# Evidence URL is empty so the field must be omitted
grep -q 'evidence_url=' "$target" && \
  fail "checkpoint persists empty evidence_url field" || true
pass 'checkpoint persistence mirrors the support metadata and skips empty fields'

# --- Cleanup ---------------------------------------------------------

LOCK_HELD=false
rm -f "${LOCK_DIR}/status" "${LOCK_DIR}/status.$$" "${LOCK_DIR}/owner"
rmdir "${LOCK_DIR}" 2>/dev/null || true

printf '%s HU progress module tests passed.\n' 8
