#!/usr/bin/env bash
# Repository-wide lock ownership and observable lock status.
# Sourced by run.sh; intentionally has no source-time side effects.

# True only while this process can still prove it owns the lock.
#
# The directory must exist: losing it is the failure this guard exists
# to catch. The ownership token is checked only once LOCK_TOKEN is set,
# which acquire_repository_lock does immediately before LOCK_HELD, so a
# real run always gets the full check; callers that stage lock state
# directly are held only to the directory requirement.
lock_ownership_intact() {
  local current_token

  [[ -n "${LOCK_DIR:-}" ]] || return 1
  [[ -d "$LOCK_DIR" ]] || return 1
  [[ -n "${LOCK_TOKEN:-}" ]] || return 0

  [[ -r "${LOCK_DIR}/owner" ]] || return 1
  current_token="$(
    sed -n 's/^token=//p' "${LOCK_DIR}/owner" 2>/dev/null | head -n 1
  )"
  [[ -n "$current_token" && "$current_token" == "$LOCK_TOKEN" ]]
}

# Forensic detail for a lock that changed underneath a live run. The
# cause has been hard to pin down after the fact, so record everything
# needed to name the culprit at the moment it happens.
report_lock_integrity_diagnostics() {
  local competing

  printf '  lock_dir=%s\n' "${LOCK_DIR:-unset}"
  printf '  our_pid=%s\n' "$$"
  printf '  our_token=%s\n' "${LOCK_TOKEN:-unset}"
  if [[ -n "${LOCK_DIR:-}" && -d "$LOCK_DIR" ]]; then
    printf '  lock_dir_present=true\n'
    if [[ -r "${LOCK_DIR}/owner" ]]; then
      sed 's/^/  owner_/' "${LOCK_DIR}/owner" 2>/dev/null || true
    else
      printf '  owner_file=missing\n'
    fi
  else
    printf '  lock_dir_present=false\n'
  fi
  if command -v pgrep >/dev/null 2>&1; then
    competing="$(pgrep -f "$RUNNER_NAME" 2>/dev/null | grep -v -x "$$" || true)"
    if [[ -n "$competing" ]]; then
      printf '  competing_pid=%s\n' $competing
    fi
  fi
}

# Stop the run when mutual exclusion can no longer be proven.
#
# Continuing without the lock would let a second destructive loop mutate
# the same branches and tracker state, and re-acquiring here would race
# whoever created the replacement. Neither is safe, so this is a clean
# structured abort rather than a raw `set -e` death on a failed redirect.
lock_integrity_failure() {
  local reason="$1"

  # Drop ownership first: every downstream status write then short-circuits
  # on the LOCK_HELD guard instead of re-entering this handler, and the
  # EXIT trap will not try to tear down a lock that is no longer ours.
  LOCK_HELD=false

  printf '%s: RECOVERY_REQUIRED: %s\n' "$RUNNER_NAME" "$reason" >&2
  report_lock_integrity_diagnostics >&2

  # Mark the checkpoint unusable. An abnormal death here otherwise leaves
  # issue=unknown with a stale branch and base sha, which the next run
  # adopts and then fails to reconcile.
  #
  # This is an abort path, so it must never make things worse: only
  # attempt the write when the checkpoint machinery is fully available.
  # A partially staged environment would otherwise strand temp files.
  if [[ -n "${ITERATION:-}" && -n "${BASE_BRANCH:-}" && -n "${GIT_COMMON_DIR:-}" ]] &&
     [[ -d "${GIT_COMMON_DIR}" ]] &&
     declare -F write_checkpoint >/dev/null 2>&1 &&
     declare -F timestamp >/dev/null 2>&1; then
    RECOVERY_CATEGORY="lock_lost"
    write_checkpoint "lock_lost" || true
  fi

  exit 4
}

write_lock_status() {
  local state="$1"
  local elapsed="${2:-0}"
  local status_tmp

  [[ "${LOCK_HELD:-false}" == "true" ]] || return 0
  lock_ownership_intact || \
    lock_integrity_failure "repository lock is no longer held by this run (state=${state})"

  # Random temporary name inside the lock directory. Never $$: concurrent
  # heartbeat and status writes must not be able to collide on one path.
  status_tmp="$(mktemp "${LOCK_DIR}/status.XXXXXXXX" 2>/dev/null)" || \
    lock_integrity_failure "unable to stage a lock status update (state=${state})"
  {
    printf 'pid=%s\n' "$$"
    printf 'state=%s\n' "$state"
    printf 'iteration=%s\n' "$ITERATION"
    printf 'elapsed_seconds=%s\n' "$elapsed"
    printf 'updated_at=%s\n' "$(timestamp)"
    if [[ -n "${CHECKPOINT_ISSUE:-}" ]]; then
      printf 'issue=%s\n' "${CHECKPOINT_ISSUE}"
    fi
    if [[ -n "${CHECKPOINT_HU:-}" ]]; then
      printf 'hu=%s\n' "$CHECKPOINT_HU"
    fi
    if [[ -n "${CHECKPOINT_TICKET:-}" ]]; then
      printf 'ticket=%s\n' "$CHECKPOINT_TICKET"
    fi
    printf 'branch=%s\n' "$(current_branch)"
    printf 'base_branch=%s\n' "$BASE_BRANCH"
    if [[ -n "${TRACKER_HU_BRANCH:-}" ]]; then
      printf 'hu_branch=%s\n' "$TRACKER_HU_BRANCH"
    fi
    if [[ -n "${TRACKER_HU_BRANCH_CATEGORY:-}" ]]; then
      printf 'hu_category=%s\n' "$TRACKER_HU_BRANCH_CATEGORY"
    fi
    if [[ -n "${TRACKER_HU_BRANCH_ORIGIN:-}" ]]; then
      printf 'hu_origin=%s\n' "$TRACKER_HU_BRANCH_ORIGIN"
    fi
    if [[ -n "${RECOVERY_ATTEMPT:-}" && "${RECOVERY_ATTEMPT:-0}" -gt 0 ]]; then
      printf 'recovery_attempt=%s\n' "${RECOVERY_ATTEMPT}"
    fi
    if [[ -n "${RECOVERY_DELAY:-}" ]]; then
      printf 'recovery_delay=%s\n' "${RECOVERY_DELAY}"
    fi
    if [[ -n "${RECOVERY_CATEGORY:-}" ]]; then
      printf 'recovery_category=%s\n' "${RECOVERY_CATEGORY}"
    fi
    if [[ -n "${ISSUE_KILLER_PROFILE_NAME:-}" ]]; then
      printf 'profile=%s\n' "$ISSUE_KILLER_PROFILE_NAME"
      printf 'cli=%s\n' "$ISSUE_KILLER_PROFILE_CLI"
      printf 'model=%s\n' "$ISSUE_KILLER_PROFILE_MODEL"
      printf 'fallback_position=%s\n' "${ISSUE_KILLER_FALLBACK_POSITION:-0}"
      if [[ -n "${ISSUE_KILLER_FALLBACK_REMAINING:-}" ]]; then
        printf 'fallback_remaining=%s\n' "${ISSUE_KILLER_FALLBACK_REMAINING//$'\n'/,}"
      fi
      if [[ -n "${ISSUE_KILLER_FAILED_PROFILE:-}" ]]; then
        printf 'failed_profile=%s\n' "${ISSUE_KILLER_FAILED_PROFILE}"
      fi
      if [[ -n "${ISSUE_KILLER_NEXT_PROFILE:-}" ]]; then
        printf 'next_profile=%s\n' "${ISSUE_KILLER_NEXT_PROFILE}"
      fi
    fi
    # Azure delivery HU phase metadata (issue #41). The lock status
    # exposes the current HU phase and supporting identifiers so the
    # in-flight progress is observable without reading the checkpoint
    # or the per-iteration artifact. The values are sanitized at the
    # call site; only the redacted tokens or short labels reach this
    # snapshot.
    if [[ -n "${TRACKER_HU_TICKET_BRANCH:-}" ]]; then
      printf 'ticket_branch=%s\n' "$TRACKER_HU_TICKET_BRANCH"
    fi
    if [[ -n "${TRACKER_HU_EVIDENCE_URL:-}" ]]; then
      printf 'evidence_url=%s\n' "$TRACKER_HU_EVIDENCE_URL"
    fi
    if [[ -n "${TRACKER_HU_REAL_EFFORT_HOURS:-}" ]]; then
      printf 'real_effort_hours=%s\n' "$TRACKER_HU_REAL_EFFORT_HOURS"
    fi
    if [[ -n "${TRACKER_HU_PHASE:-}" ]]; then
      printf 'hu_phase=%s\n' "$TRACKER_HU_PHASE"
    fi
  } > "$status_tmp" || {
    rm -f "$status_tmp"
    lock_integrity_failure "unable to write the lock status snapshot (state=${state})"
  }
  mv -f "$status_tmp" "${LOCK_DIR}/status" || \
    lock_integrity_failure "unable to publish the lock status snapshot (state=${state})"
}

release_repository_lock() {
  local current_token=""

  if [[ "${LOCK_HELD:-false}" == "true" && -n "${LOCK_DIR:-}" && -d "$LOCK_DIR" ]]; then
    # The owner file may already be gone; reading it must not fail the
    # EXIT trap, which is where this runs.
    if [[ -r "${LOCK_DIR}/owner" ]]; then
      current_token="$(
        sed -n 's/^token=//p' "${LOCK_DIR}/owner" 2>/dev/null | head -n 1
      )" || current_token=""
    fi
    # Only tear down a lock still provably ours. A missing or mismatched
    # token means another run already owns this directory, and removing
    # it here would delete that run's lock.
    if [[ -n "$current_token" && "$current_token" == "${LOCK_TOKEN:-}" ]]; then
      rm -f "${LOCK_DIR}/status" "${LOCK_DIR}"/status.* "${LOCK_DIR}/owner"
      rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
  fi
  LOCK_HELD=false
}

report_active_lock() {
  local owner_pid="$1"

  printf '%s: another runner is active for this repository (pid %s)\n' \
    "$RUNNER_NAME" "${owner_pid:-unknown}" >&2
  if [[ -r "${LOCK_DIR}/status" ]]; then
    sed 's/^/  /' "${LOCK_DIR}/status" >&2
  fi
  exit 1
}

acquire_repository_lock() {
  local owner_file owner_pid owner_snapshot current_snapshot owner_tmp

  LOCK_DIR="${GIT_COMMON_DIR}/${RUNNER_NAME}.lock"
  owner_file="${LOCK_DIR}/owner"
  LOCK_TOKEN="$$-$(date +%s)"

  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if [[ ! -r "$owner_file" ]]; then
      sleep 1
      [[ -r "$owner_file" ]] || \
        die "repository lock exists without readable owner metadata: ${LOCK_DIR}"
    fi

    owner_snapshot="$(<"$owner_file")"
    owner_pid="$(
      sed -n 's/^pid=//p' "$owner_file" 2>/dev/null | head -n 1
    )"
    # An owner file without a parseable pid cannot be proven stale.
    # Falling through to the removal below would delete a live lock --
    # which is exactly how a running drain loop loses the lock it holds
    # and dies on its next status write.
    if ! is_non_negative_integer "${owner_pid:-}"; then
      die "repository lock owner metadata has no readable pid; refusing to treat it as stale: ${LOCK_DIR}"
    fi
    if kill -0 "$owner_pid" 2>/dev/null; then
      report_active_lock "$owner_pid"
    fi

    current_snapshot="$(<"$owner_file")"
    if [[ "$current_snapshot" != "$owner_snapshot" ]]; then
      continue
    fi

    rm -f "${LOCK_DIR}/status" "$owner_file"
    if ! rmdir "$LOCK_DIR" 2>/dev/null; then
      die "unable to recover stale repository lock: ${LOCK_DIR}"
    fi
    printf '[%s] Recovered stale repository lock (previous pid %s).\n' \
      "$RUNNER_NAME" "${owner_pid:-unknown}"
  done

  # Publish the owner metadata atomically. A plain redirect leaves a
  # window where the file exists but is still empty, and a competing
  # runner that reads it during that window sees no pid and would treat
  # this live lock as stale.
  owner_tmp="$(mktemp "${LOCK_DIR}/owner.XXXXXXXX")" || \
    die "unable to stage repository lock owner metadata: ${LOCK_DIR}"
  {
    printf 'pid=%s\n' "$$"
    printf 'token=%s\n' "$LOCK_TOKEN"
    printf 'repository=%s\n' "$REPO_ROOT"
    printf 'started_at=%s\n' "$(timestamp)"
  } > "$owner_tmp"
  mv -f "$owner_tmp" "$owner_file"
  LOCK_HELD=true
  trap runner_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  write_lock_status "starting" 0
  printf '[%s] Repository lock acquired: %s (pid %s)\n' \
    "$RUNNER_NAME" "$LOCK_DIR" "$$"
}
