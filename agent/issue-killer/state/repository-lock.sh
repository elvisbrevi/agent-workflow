#!/usr/bin/env bash
# Repository-wide lock ownership and observable lock status.
# Sourced by run.sh; intentionally has no source-time side effects.

write_lock_status() {
  local state="$1"
  local elapsed="${2:-0}"
  local status_tmp

  [[ "$LOCK_HELD" == "true" ]] || return
  status_tmp="${LOCK_DIR}/status.$$"
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
        printf 'failed_profile=%s\n' "$ISSUE_KILLER_FAILED_PROFILE"
      fi
      if [[ -n "${ISSUE_KILLER_NEXT_PROFILE:-}" ]]; then
        printf 'next_profile=%s\n' "$ISSUE_KILLER_NEXT_PROFILE"
      fi
    fi
  } > "$status_tmp"
  mv -f "$status_tmp" "${LOCK_DIR}/status"
}

release_repository_lock() {
  local current_token

  if [[ "$LOCK_HELD" == "true" ]]; then
    current_token="$(
      sed -n 's/^token=//p' "${LOCK_DIR}/owner" 2>/dev/null | head -n 1
    )"
    if [[ "$current_token" == "$LOCK_TOKEN" ]]; then
      rm -f "${LOCK_DIR}/status" "${LOCK_DIR}/status.$$" "${LOCK_DIR}/owner"
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
  local owner_file owner_pid owner_snapshot current_snapshot

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
    if is_non_negative_integer "${owner_pid:-}" &&
       kill -0 "$owner_pid" 2>/dev/null; then
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

  {
    printf 'pid=%s\n' "$$"
    printf 'token=%s\n' "$LOCK_TOKEN"
    printf 'repository=%s\n' "$REPO_ROOT"
    printf 'started_at=%s\n' "$(timestamp)"
  } > "$owner_file"
  LOCK_HELD=true
  trap runner_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  write_lock_status "starting" 0
  printf '[%s] Repository lock acquired: %s (pid %s)\n' \
    "$RUNNER_NAME" "$LOCK_DIR" "$$"
}
