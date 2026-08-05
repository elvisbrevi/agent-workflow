#!/usr/bin/env bash
# Restart and dirty-worktree recovery.
# Sourced by run.sh; intentionally has no source-time side effects.

assert_clean_worktree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    die "worktree is not clean; refusing to launch another worker"
  fi
}

# Restores a fallback checkpoint after the operator has selected the same
# primary profile and chain. Persisted profile identity and order must agree
# with the current configuration or startup fails closed. Mixed-provider
# chains are accepted: the active profile can be any configured Claude,
# Codex, or OpenCode profile as long as it survives the same identity
# checks the primary profile already passed.
restore_fallback_checkpoint() {
  local checkpoint="$(checkpoint_file)"
  local selected active cli model command_name position chain remaining
  local failed next failure entry expected_active expected_remaining=""
  local index=0 found=false

  [[ -r "$checkpoint" ]] || return 0
  selected="$(checkpoint_value selected_profile "$checkpoint")"
  position="$(checkpoint_value fallback_position "$checkpoint")"
  chain="$(checkpoint_values fallback_chain "$checkpoint")"
  remaining="$(checkpoint_values fallback_remaining "$checkpoint")"
  failed="$(checkpoint_value failed_profile "$checkpoint")"
  next="$(checkpoint_value next_profile "$checkpoint")"
  failure="$(checkpoint_value fallback_failure "$checkpoint")"

  if [[ -z "$selected" || -z "$position" ]]; then
    return 0
  fi
  if [[ "$position" == "0" && -z "$chain" && -z "$failed" ]]; then
    return 0
  fi
  [[ "$position" =~ ^[0-9]+$ ]] || return 1
  [[ "$selected" == "$ISSUE_KILLER_SELECTED_PROFILE_NAME" ]] || return 1
  [[ "$chain" == "$ISSUE_KILLER_FALLBACK_CHAIN" ]] || return 1

  expected_active="$selected"
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    index=$((index + 1))
    if [[ "$index" -eq "$position" ]]; then
      expected_active="$entry"
      found=true
    elif [[ "$index" -gt "$position" ]]; then
      if [[ -z "$expected_remaining" ]]; then
        expected_remaining="$entry"
      else
        expected_remaining+=$'\n'"$entry"
      fi
    fi
  done <<<"$chain"
  if [[ "$position" -gt 0 && "$found" != "true" ]]; then
    return 1
  fi
  [[ "$remaining" == "$expected_remaining" ]] || return 1

  active="$(checkpoint_value profile "$checkpoint")"
  cli="$(checkpoint_value cli "$checkpoint")"
  model="$(checkpoint_value model "$checkpoint")"
  command_name="$(checkpoint_value command "$checkpoint")"
  [[ "$active" == "$expected_active" ]] || return 1
  issue_killer_config_apply_profile "$active" || return 1
  [[ "$ISSUE_KILLER_PROFILE_CLI" == "$cli" ]] || return 1
  [[ "$ISSUE_KILLER_PROFILE_MODEL" == "$model" ]] || return 1
  [[ "$ISSUE_KILLER_PROFILE_COMMAND" == "$command_name" ]] || return 1
  activate_runtime_for_profile || return 1

  ISSUE_KILLER_FALLBACK_POSITION="$position"
  ISSUE_KILLER_FALLBACK_CHAIN="$chain"
  ISSUE_KILLER_FALLBACK_REMAINING="$remaining"
  ISSUE_KILLER_PROFILE_FALLBACKS="$remaining"
  ISSUE_KILLER_FAILED_PROFILE="$failed"
  ISSUE_KILLER_NEXT_PROFILE="$next"
  ISSUE_KILLER_FALLBACK_FAILURE="$failure"
  if [[ "$ISSUE_KILLER_PROFILE_CLI" == "opencode" ]]; then
    printf '[%s] Restored OpenCode fallback checkpoint at position %s with profile %s\n' \
      "$RUNNER_NAME" "$position" "$active"
  else
    printf '[%s] Restored fallback checkpoint at position %s with profile %s (cli=%s)\n' \
      "$RUNNER_NAME" "$position" "$active" "$ISSUE_KILLER_PROFILE_CLI"
  fi
  return 0
}

# Back-compatibility alias for the historical OpenCode-only entry point
# used by older call sites. The behavior is now provider-neutral and
# reuses the shared runtime activation path; the legacy name is kept
# for compatibility with embedded callers and existing test fixtures.
restore_opencode_fallback_checkpoint() {
  restore_fallback_checkpoint
}

emit_recovery_required() {
  local message="$1"
  local checkpoint="${2:-$(checkpoint_file)}"

  printf '%s: RECOVERY_REQUIRED: %s\n' "$RUNNER_NAME" "$message" >&2
  if [[ -r "$checkpoint" ]]; then
    printf '%s: checkpoint retained at %s\n' "$RUNNER_NAME" "$checkpoint" >&2
  fi
  exit 4
}

validate_checkpoint_for_dirty_recovery() {
  local checkpoint="$1"
  local issue branch base_branch base_sha state
  local current profile cli model command_name selected_profile fallback_position
  local fallback_chain fallback_remaining

  [[ -r "$checkpoint" ]] || \
    emit_recovery_required "dirty worktree requires a readable checkpoint or explicit legacy adoption"

  issue="$(checkpoint_value issue "$checkpoint")"
  branch="$(checkpoint_value branch "$checkpoint")"
  base_branch="$(checkpoint_value base_branch "$checkpoint")"
  base_sha="$(checkpoint_value base_sha "$checkpoint")"
  state="$(checkpoint_value state "$checkpoint")"
  current="$(current_branch)"

  [[ "$issue" =~ ^[0-9]+$ ]] || \
    emit_recovery_required "checkpoint is missing a concrete issue number"
  if [[ "${TRACKER_KIND:-}" == "azure-devops" ]]; then
    local hu ticket
    hu="$(checkpoint_value hu "$checkpoint")"
    ticket="$(checkpoint_value ticket "$checkpoint")"
    [[ "$hu" =~ ^[1-9][0-9]*$ ]] || \
      emit_recovery_required "Azure checkpoint is missing a pinned HU identity"
    [[ "$ticket" =~ ^[1-9][0-9]*$ ]] || \
      emit_recovery_required "Azure checkpoint is missing an active ticket identity"
    [[ "$ticket" == "$issue" ]] || \
      emit_recovery_required "Azure checkpoint issue ${issue} does not match ticket ${ticket}"
  fi
  [[ -n "$branch" && "$branch" != "unknown" ]] || \
    emit_recovery_required "checkpoint is missing a concrete branch"
  [[ "$current" == "$branch" ]] || \
    emit_recovery_required "checkpoint branch ${branch} does not match current branch ${current}"
  [[ "$base_branch" == "$BASE_BRANCH" ]] || \
    emit_recovery_required "checkpoint base branch ${base_branch:-unknown} does not match configured base ${BASE_BRANCH}"
  [[ -n "$base_sha" && "$base_sha" != "unknown" ]] || \
    emit_recovery_required "checkpoint is missing a concrete base SHA"
  git rev-parse --verify --quiet "${base_sha}^{commit}" >/dev/null 2>&1 || \
    emit_recovery_required "checkpoint base SHA ${base_sha} is stale or unavailable"
  [[ -n "$state" ]] || \
    emit_recovery_required "checkpoint is missing a lifecycle state"

  # Checkpoints written before the profile migration may not carry
  # the profile/CLI/model fields. A legacy checkpoint is allowed
  # here only when no profile was selected for the current run; any
  # mismatch between the live profile and the persisted identity
  # fails closed so a restart cannot silently change the runtime.
  profile="$(checkpoint_value profile "$checkpoint")"
  cli="$(checkpoint_value cli "$checkpoint")"
  model="$(checkpoint_value model "$checkpoint")"
  command_name="$(checkpoint_value command "$checkpoint")"
  if [[ -n "$profile" || -n "$cli" || -n "$model" || -n "$command_name" ]]; then
    [[ "$profile" == "$ISSUE_KILLER_PROFILE_NAME" ]] || \
      emit_recovery_required "checkpoint profile ${profile:-unknown} does not match selected profile ${ISSUE_KILLER_PROFILE_NAME:-unknown}"
    [[ "$cli" == "$ISSUE_KILLER_PROFILE_CLI" ]] || \
      emit_recovery_required "checkpoint cli ${cli:-unknown} does not match selected cli ${ISSUE_KILLER_PROFILE_CLI:-unknown}"
    [[ "$model" == "$ISSUE_KILLER_PROFILE_MODEL" ]] || \
      emit_recovery_required "checkpoint model ${model:-unknown} does not match selected model ${ISSUE_KILLER_PROFILE_MODEL:-unknown}"
    [[ "$command_name" == "$ISSUE_KILLER_PROFILE_COMMAND" ]] || \
      emit_recovery_required "checkpoint command ${command_name:-unknown} does not match selected command ${ISSUE_KILLER_PROFILE_COMMAND:-unknown}"
    selected_profile="$(checkpoint_value selected_profile "$checkpoint")"
    fallback_position="$(checkpoint_value fallback_position "$checkpoint")"
    fallback_chain="$(checkpoint_values fallback_chain "$checkpoint")"
    fallback_remaining="$(checkpoint_values fallback_remaining "$checkpoint")"
    if [[ -n "$selected_profile" || -n "$fallback_position" || -n "$fallback_chain" ]]; then
      [[ "$selected_profile" == "$ISSUE_KILLER_SELECTED_PROFILE_NAME" ]] || \
        emit_recovery_required "checkpoint selected profile ${selected_profile:-unknown} does not match ${ISSUE_KILLER_SELECTED_PROFILE_NAME:-unknown}"
      [[ "$fallback_position" == "$ISSUE_KILLER_FALLBACK_POSITION" ]] || \
        emit_recovery_required "checkpoint fallback position ${fallback_position:-unknown} does not match restored position ${ISSUE_KILLER_FALLBACK_POSITION:-unknown}"
      [[ "$fallback_chain" == "$ISSUE_KILLER_FALLBACK_CHAIN" ]] || \
        emit_recovery_required "checkpoint fallback chain does not match the selected chain"
      [[ "$fallback_remaining" == "$ISSUE_KILLER_FALLBACK_REMAINING" ]] || \
        emit_recovery_required "checkpoint remaining fallback order does not match restored state"
    fi
  fi
}

write_legacy_checkpoint() {
  local issue_number="$1"
  local target tmp

  target="$(checkpoint_file)"
  tmp="${target}.tmp.$$"
  mkdir -p "$(dirname "$target")"
  {
    printf 'pid=%s\n' "$$"
    printf 'iteration=1\n'
    printf 'issue=%s\n' "$issue_number"
    printf 'branch=%s\n' "$(current_branch)"
    printf 'base_branch=%s\n' "$BASE_BRANCH"
    printf 'base_sha=%s\n' "$(current_base_sha)"
    printf 'session_id=unavailable\n'
    printf 'state=legacy_adopted\n'
    if [[ -n "${ISSUE_KILLER_PROFILE_NAME:-}" ]]; then
      printf 'profile=%s\n' "$ISSUE_KILLER_PROFILE_NAME"
      printf 'cli=%s\n' "$ISSUE_KILLER_PROFILE_CLI"
      printf 'model=%s\n' "$ISSUE_KILLER_PROFILE_MODEL"
      printf 'command=%s\n' "$ISSUE_KILLER_PROFILE_COMMAND"
    fi
    printf 'updated_at=%s\n' "$(timestamp)"
  } > "$tmp"
  mv -f "$tmp" "$target"
}

prepare_dirty_startup_recovery() {
  local checkpoint
  local dirty_files
  local issue branch base_sha state session_id strategy
  local hu ticket

  dirty_files="$(dirty_worktree_snapshot)"
  [[ -n "$dirty_files" ]] || return 0

  STARTUP_RECOVERY_MODE=""
  STARTUP_RECOVERY_ISSUE=""
  STARTUP_RECOVERY_SESSION=""
  STARTUP_RECOVERY_PROMPT=""

  checkpoint="$(checkpoint_file)"
  if [[ -r "$checkpoint" ]]; then
    validate_checkpoint_for_dirty_recovery "$checkpoint"
    issue="$(checkpoint_value issue "$checkpoint")"
    branch="$(checkpoint_value branch "$checkpoint")"
    base_sha="$(checkpoint_value base_sha "$checkpoint")"
    state="$(checkpoint_value state "$checkpoint")"
    session_id="$(checkpoint_value session_id "$checkpoint")"
    hu="$(checkpoint_value hu "$checkpoint")"
    ticket="$(checkpoint_value ticket "$checkpoint")"
    CHECKPOINT_HU="$hu"
    CHECKPOINT_TICKET="$ticket"
    if is_session_resumable "$session_id" "$branch" "$base_sha"; then
      strategy="resume captured Claude session"
      STARTUP_RECOVERY_SESSION="$session_id"
    else
      strategy="launch fresh recovery worker constrained to checkpointed issue"
      STARTUP_RECOVERY_SESSION=""
    fi

    printf '[%s] Restart recovery target: issue %s, branch %s, base SHA %s, state %s, strategy: %s\n' \
      "$RUNNER_NAME" "$issue" "$branch" "$base_sha" "$state" "$strategy"
    printf '[%s] Dirty files to preserve:\n%s\n' "$RUNNER_NAME" "$dirty_files"
    tracker_reconcile_startup_state "$issue" "$branch"
    operator_confirm_recovery \
      "Recover issue ${issue} on branch ${branch} from checkpoint state ${state} using strategy '${strategy}'."

    STARTUP_RECOVERY_MODE="checkpoint"
    STARTUP_RECOVERY_ISSUE="$issue"
    STARTUP_RECOVERY_PROMPT="Restart recovery:
- Continue exactly issue #${issue}; do not select another issue.
- Preserve and inspect the existing dirty files; do not discard, reset, stash, or overwrite partial work.
- The checkpoint branch is ${branch}, base SHA is ${base_sha}, and last state is ${state}.
- Reconcile live issue and PR state before any mutation, then complete the existing work."
    if [[ "${TRACKER_KIND:-}" == "azure-devops" ]]; then
      STARTUP_RECOVERY_PROMPT="${STARTUP_RECOVERY_PROMPT}
- Continue only Azure delivery ticket ${ticket} under pinned HU ${hu}; do not discover or switch either identity."
    fi
    return 0
  fi

  if [[ -z "${ISSUE_RUNNER_ADOPT_ISSUE:-}" ]]; then
    printf '[%s] Dirty files without checkpoint:\n%s\n' "$RUNNER_NAME" "$dirty_files" >&2
    emit_recovery_required "legacy adoption requires ISSUE_RUNNER_ADOPT_ISSUE; refusing to infer the issue from branch, files, or queue order"
  fi
  [[ "${ISSUE_RUNNER_ADOPT_ISSUE}" =~ ^[0-9]+$ ]] || \
    emit_recovery_required "ISSUE_RUNNER_ADOPT_ISSUE must be a numeric issue number"
  if [[ "${TRACKER_KIND:-}" == "azure-devops" ]]; then
    emit_recovery_required "Azure legacy adoption requires an existing checkpoint with both HU and ticket identity"
  fi

  issue="$ISSUE_RUNNER_ADOPT_ISSUE"
  branch="$(current_branch)"
  [[ "$branch" != "unknown" ]] || \
    emit_recovery_required "legacy adoption requires a named branch"
  printf '[%s] Legacy adoption target: issue %s, branch %s, base SHA %s, strategy: fresh recovery worker\n' \
    "$RUNNER_NAME" "$issue" "$branch" "$(current_base_sha)"
  printf '[%s] Dirty files to preserve:\n%s\n' "$RUNNER_NAME" "$dirty_files"
  tracker_reconcile_startup_state "$issue" "$branch"
  operator_confirm_recovery \
    "Adopt existing dirty work as issue ${issue} on branch ${branch}."
  write_legacy_checkpoint "$issue"

  STARTUP_RECOVERY_MODE="legacy"
  STARTUP_RECOVERY_ISSUE="$issue"
  STARTUP_RECOVERY_SESSION=""
  STARTUP_RECOVERY_PROMPT="Legacy recovery adoption:
- Continue exactly issue #${issue}; do not select another issue.
- Preserve and inspect the existing dirty files; do not discard, reset, stash, or overwrite partial work.
- This is a synthetic checkpoint with no resumable session.
- Reconcile live issue and PR state before any mutation, then complete the existing work."
}

# Single entry point for startup checkpoint adoption. The supervisor
# used to call the migrated-checkpoint path and the dirty-worktree path
# directly, so any change to the recovery decision had to be edited in
# two places. Both paths now go through this function: the migrated
# adoption runs first when no recovery mode is set, and the dirty
# reconciliation runs unconditionally afterwards. Each path keeps its
# existing observable behaviour today — including the migrated path's
# current lack of confirmation and reconciliation — so future tickets
# that add the same safeguards to the migrated path can land here
# once instead of twice.
adopt_startup_checkpoint() {
  if [[ -z "${STARTUP_RECOVERY_MODE:-}" ]]; then
    adopt_migrated_checkpoint || :
  fi
  prepare_dirty_startup_recovery
}

# Adopts the canonical checkpoint produced by one-way legacy migration.
adopt_migrated_checkpoint() {
  local checkpoint issue branch base_branch base_sha state session_id profile cli model command
  local hu ticket

  [[ -r "$(checkpoint_file)" ]] || return 1
  issue="$(checkpoint_value issue "$(checkpoint_file)" || true)"
  [[ "$issue" =~ ^[0-9]+$ ]] || return 1
  if [[ "${TRACKER_KIND:-}" == "azure-devops" ]]; then
    hu="$(checkpoint_value hu "$(checkpoint_file)" || true)"
    ticket="$(checkpoint_value ticket "$(checkpoint_file)" || true)"
    [[ "$hu" =~ ^[1-9][0-9]*$ && "$ticket" =~ ^[1-9][0-9]*$ && "$ticket" == "$issue" ]] || return 1
    CHECKPOINT_HU="$hu"
    CHECKPOINT_TICKET="$ticket"
  fi
  branch="$(checkpoint_value branch "$(checkpoint_file)" || true)"
  base_branch="$(checkpoint_value base_branch "$(checkpoint_file)" || true)"
  base_sha="$(checkpoint_value base_sha "$(checkpoint_file)" || true)"
  state="$(checkpoint_value state "$(checkpoint_file)" || true)"
  session_id="$(checkpoint_value session_id "$(checkpoint_file)" || true)"
  profile="$(checkpoint_value profile "$(checkpoint_file)" || true)"
  cli="$(checkpoint_value cli "$(checkpoint_file)" || true)"
  model="$(checkpoint_value model "$(checkpoint_file)" || true)"
  command="$(checkpoint_value command "$(checkpoint_file)" || true)"

  [[ -n "$branch" && "$branch" != "unknown" ]] || return 1
  [[ "$base_branch" == "$BASE_BRANCH" ]] || return 1
  [[ -n "$base_sha" && "$base_sha" != "unknown" ]] || return 1
  git rev-parse --verify --quiet "${base_sha}^{commit}" >/dev/null 2>&1 || return 1
  [[ -n "$state" ]] || return 1
  [[ "$(current_branch)" == "$branch" ]] || return 1

  if [[ -n "$profile" ]]; then
    [[ "$profile" == "$ISSUE_KILLER_PROFILE_NAME" ]] || return 1
  fi
  if [[ -n "$cli" ]]; then
    [[ "$cli" == "$ISSUE_KILLER_PROFILE_CLI" ]] || return 1
  fi
  if [[ -n "$model" ]]; then
    [[ "$model" == "$ISSUE_KILLER_PROFILE_MODEL" ]] || return 1
  fi
  if [[ -n "$command" ]]; then
    [[ "$command" == "$ISSUE_KILLER_PROFILE_COMMAND" ]] || return 1
  fi

  STARTUP_RECOVERY_MODE="checkpoint"
  STARTUP_RECOVERY_ISSUE="$issue"
  STARTUP_RECOVERY_SESSION=""
  if [[ -n "$session_id" && "$session_id" != "unavailable" ]]; then
    STARTUP_RECOVERY_SESSION="$session_id"
  fi
  STARTUP_RECOVERY_PROMPT="Migrated restart recovery:
- Continue exactly issue #${issue}; do not select another issue.
- This iteration restarts work that was checkpointed by the legacy runner
  and migrated into the canonical namespace. The checkpoint state was
  ${state}, the branch is ${branch}, and the base SHA is ${base_sha}.
- Preserve and inspect the existing dirty files; do not discard, reset,
  stash, or overwrite partial work.
- Reconcile live issue and PR state before any mutation, then complete
  the existing work."
  return 0
}
