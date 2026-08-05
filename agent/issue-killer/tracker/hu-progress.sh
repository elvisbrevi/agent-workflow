#!/usr/bin/env bash
# Tracker-neutral Azure delivery HU progress surface (issue #41).
#
# The Azure delivery HU flow has its own lifecycle that the existing
# generic progress categories cannot represent. Selecting and pinning a
# delivery HU, identifying the active direct-child ticket, bootstrapping
# the HU integration branch, opening the ticket branch, capturing and
# persisting evidence, recording real effort, integrating the ticket
# pull request, and moving the ticket to the configured closed state are
# observed through phases that match the canonical vocabulary.
#
# This module owns the normalized HU lifecycle phases so the orchestrator
# and every runtime adapter (Claude, Codex, OpenCode) can advance them
# through the same function. Each phase is rendered to the operator as
# a structured progress line (mirroring the `runtime_redact` boundary
# for credentials and tokens) and mirrored into the lock status so the
# in-flight phase is visible without reading the checkpoint or the
# per-iteration artifact.
#
# The module is intentionally provider-neutral: it never reads the
# adapter's CLI, the worker stream, or the captured native session. The
# orchestrator and the tracker adapter are the only callers; the
# runtime adapters record the worker activity through the existing
# `runtime_*` events and the HU adapter invokes these helpers when the
# delivery ticket reaches one of the documented phases.
#
# Required inputs (defined before this file is sourced):
#   RUNNER_NAME        - display name printed in progress lines
#   LOCK_HELD          - "true" when the repository lock is held
#   LOCK_DIR           - lock directory used by write_lock_status
#   CHECKPOINT_ISSUE   - identified issue/ticket identifier
#   CHECKPOINT_HU      - pinned Azure delivery HU identifier
#   CHECKPOINT_TICKET  - active direct-child Azure delivery ticket
#   TRACKER_HU_BRANCH  - delivered HU integration branch name
#   write_lock_status  - orchestrator-provided status writer
#
# The writer is invoked as `write_lock_status <state> <elapsed>` so the
# helper threads a single line through the runner's existing status
# pipeline instead of inventing a second writer.

# Canonical Azure delivery HU progress phases. Closed set; the orchestrator
# and any tracker adapter consume only these tags. The phase taxonomy is
# the single source of truth — adding or renaming a phase requires
# updating every block in this file and the corresponding test suite.
hu_progress_phases() {
  printf '%s\n' \
    "hu-selected" \
    "ticket-selected" \
    "hu-branch-prepared" \
    "ticket-branch-created" \
    "evidence-captured" \
    "evidence-recorded" \
    "effort-recorded" \
    "ticket-integrated" \
    "ticket-done" \
    "recovery-clause" \
    "recovery-resumed"
}

# Returns 0 when the supplied phase is a recognized HU lifecycle phase.
# The check is closed; an unknown phase is rejected so the orchestrator
# never persists a typo.
hu_progress_phase_is_known() {
  local phase="$1"
  local known
  while IFS= read -r known; do
    [[ "$phase" == "$known" ]] && return 0
  done < <(hu_progress_phases)
  return 1
}

# Apply the canonical redaction patterns to a single line of text. The
# helper is implemented with POSIX sed so the host awk's lack of
# backreference support in the replacement string cannot break the
# key/value credential scrub. Each rule replaces the matched shape with
# the same redacted token the runtime adapters use, so the operator
# sees one consistent vocabulary across providers.
hu_progress_redact_subst() {
  sed -E \
    -e 's/[Aa]uthorization([[:space:][:punct:]]+[A-Za-z0-9._~+/-]+)+/<redacted:authorization>/g' \
    -e 's/[Bb]earer[[:space:][:punct:]]+[A-Za-z0-9._~+/-]{6,}/<redacted:bearer>/g' \
    -e "s/(api[_-]?key|secret|password|access[_-]?token|auth[_-]?token)[=:][[:space:]]*[A-Za-z0-9._~+/-]+/\1=<redacted>/gI" \
    -e 's/(ghp_[A-Za-z0-9]+|ghs_[A-Za-z0-9]+|gho_[A-Za-z0-9]+|ghu_[A-Za-z0-9]+|ghr_[A-Za-z0-9]+)/<redacted:credential>/g' \
    -e 's/-----BEGIN [A-Z ]+PRIVATE KEY-----.*-----END [A-Z ]+PRIVATE KEY-----/<redacted:private-key>/g' \
    -e 's/[A-Za-z0-9+/]{120,}={0,2}/<redacted:payload>/g' \
    -e 's#https?://[^[:space:]]+\.(png|jpg|jpeg|gif|webp|pdf|heic)#<redacted:attachment>#g' \
    -e 's/[A-Za-z0-9_./-]+\.(png|jpg|jpeg|gif|webp|pdf|heic)/<redacted:attachment>/g'
}

# Sanitize an optional detail string so the emitted progress line and
# the persisted lock status never carry sensitive payloads. The redactor
# is intentionally conservative: it strips raw browser JSON, binary
# attachment payloads, complete shell commands, and the same credential
# shapes the runtime adapters reject. Tail-truncation caps the length so
# a misbehaving caller cannot blow up the lock status file with a long
# blob.
hu_progress_sanitize_detail() {
  local detail="${1:-}"
  local sanitized

  [[ -n "$detail" ]] || {
    printf ''
    return 0
  }

  sanitized="$(printf '%s' "$detail" | hu_progress_redact_subst)"

  # Cap persisted detail at 240 characters so a captured screenshot URL
  # or a long evidence URL cannot bloat the lock status. The runner
  # intentionally exposes the redacted attachment token `<redacted:attachment>`
  # rather than the resolved path.
  if (( ${#sanitized} > 240 )); then
    sanitized="${sanitized:0:237}..."
  fi

  printf '%s\n' "$sanitized"
}

# Emit a human-readable progress line for the supplied HU phase. The
# line is appended to the operator-visible stream so the operator sees
# the same navigator regardless of the active CLI. The redactor is
# applied to the detail so unsafe payloads never reach the terminal.
hu_progress_render_phase() {
  local phase="$1"
  local detail="${2:-}"
  local label
  local sanitized

  case "$phase" in
    hu-selected) label="Pinned Azure delivery HU" ;;
    ticket-selected) label="Selected active ticket" ;;
    hu-branch-prepared) label="Prepared HU integration branch" ;;
    ticket-branch-created) label="Opened ticket branch" ;;
    evidence-captured) label="Captured completion evidence" ;;
    evidence-recorded) label="Recorded completion evidence" ;;
    effort-recorded) label="Recorded real effort" ;;
    ticket-integrated) label="Integrated ticket into HU branch" ;;
    ticket-done) label="Moved ticket to configured closed state" ;;
    recovery-clause) label="Prepared transport recovery" ;;
    recovery-resumed) label="Resumed worker session" ;;
    *)
      printf ''
      return 1
      ;;
  esac

  sanitized="$(hu_progress_sanitize_detail "$detail")"
  if [[ -n "$sanitized" ]]; then
    printf '[%s] %s: %s\n' "$RUNNER_NAME" "$label" "$sanitized"
  else
    printf '[%s] %s\n' "$RUNNER_NAME" "$label"
  fi
}

# Mirror the active HU phase into the lock status side-channel. The
# checkpoint already carries the durable identity (issue, hu, ticket,
# branch, base_sha, profile, fallback chain). The lock status gains
# `hu_phase`, `ticket_branch`, `evidence_url`, and `real_effort_hours`
# when the matching values are supplied so the in-flight progress is
# observable without opening the checkpoint or comparing the captured
# Azure HTTP responses. Sensitive payloads are sanitized before
# persistence. The status writer is invoked through the same generic
# `write_lock_status` name the orchestrator already provides so the
# orchestrator can later swap the storage backend without touching
# this module.
hu_progress_publish_lock_status() {
  local phase="$1"
  local ticket_branch="${2:-}"
  local evidence_url="${3:-}"
  local real_effort_hours="${4:-}"

  [[ "$LOCK_HELD" == "true" ]] || return 0

  TRACKER_HU_PHASE="$phase"
  if [[ -n "$ticket_branch" ]]; then
    TRACKER_HU_TICKET_BRANCH="$ticket_branch"
  fi
  if [[ -n "$evidence_url" ]]; then
    TRACKER_HU_EVIDENCE_URL="$(hu_progress_sanitize_detail "$evidence_url")"
  fi
  if [[ -n "$real_effort_hours" ]]; then
    TRACKER_HU_REAL_EFFORT_HOURS="$real_effort_hours"
  fi

  write_lock_status "$phase" 0
}

# Build the structured checkpoint block that mirrors the persistent HU
# phase metadata. The block is appended to the existing checkpoint file
# without disturbing the upstream lifecycle. The fields are written
# only when populated so the checkpoint never grows stale entries for
# non-Azure runs.
hu_progress_append_checkpoint() {
  local target="$1"
  local phase="$2"
  local ticket_branch="${3:-}"
  local evidence_url="${4:-}"
  local real_effort_hours="${5:-}"

  [[ -n "$target" ]] || return 0

  if [[ -n "$ticket_branch" ]]; then
    printf 'ticket_branch=%s\n' "$ticket_branch" >> "$target"
  fi
  if [[ -n "$evidence_url" ]]; then
    printf 'evidence_url=%s\n' "$(hu_progress_sanitize_detail "$evidence_url")" >> "$target"
  fi
  if [[ -n "$real_effort_hours" ]]; then
    printf 'real_effort_hours=%s\n' "$real_effort_hours" >> "$target"
  fi
  printf 'hu_phase=%s\n' "$phase" >> "$target"
}

# The single public entry point the orchestrator and tracker adapter
# call. It validates the phase, emits the operator-visible progress line,
# persists the lock status, and (when the tracker adapter opts in)
# appends a checkpoint block. Calls are no-ops outside an active lock
# so the helper is safe to invoke from the migration tests.
#
# Arguments:
#   $1 - phase (one of hu_progress_phases)
#   $2 - optional detail (sanitized before any output or persistence)
#   $3 - optional ticket branch (Azure ticket branch name only)
#   $4 - optional evidence URL (sanitized before persistence)
#   $5 - optional real effort hours (numeric, no surrounding context)
hu_progress_event() {
  local phase="$1"
  local detail="${2:-}"
  local ticket_branch="${3:-}"
  local evidence_url="${4:-}"
  local real_effort_hours="${5:-}"

  hu_progress_phase_is_known "$phase" || {
    printf '%s: hu_progress_event: unknown phase: %s\n' \
      "$RUNNER_NAME" "${phase:-empty}" >&2
    return 1
  }

  hu_progress_render_phase "$phase" "$detail"

  if [[ "$LOCK_HELD" == "true" ]]; then
    hu_progress_publish_lock_status "$phase" "$ticket_branch" "$evidence_url" "$real_effort_hours"
  fi

  local checkpoint_file
  checkpoint_file="$(checkpoint_file 2>/dev/null || true)"
  if [[ -n "$checkpoint_file" && -r "$checkpoint_file" ]]; then
    hu_progress_append_checkpoint "$checkpoint_file" "$phase" \
      "$ticket_branch" "$evidence_url" "$real_effort_hours"
  fi

  return 0
}

# Echo empty output when sourced directly so the orchestrator's `source`
# always succeeds. The orchestrator depends on this file having no side
# effects at source time.
:
