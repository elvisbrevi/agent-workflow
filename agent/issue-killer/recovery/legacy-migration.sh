#!/usr/bin/env bash
# One-way migration of legacy runner locks and checkpoints.
# Sourced by run.sh; intentionally has no source-time side effects.

# Returns the absolute path to the legacy runner lock. The canonical
# issue-killer checks this namespace before acquiring its own lock so an old
# worker cannot race a migration across linked worktrees.
legacy_lock_dir() {
  printf '%s/%s.lock\n' "$GIT_COMMON_DIR" "$LEGACY_RUNNER_NAME"
}

# Reads a single `field=value` line from a metadata blob. Trailing
# newlines are tolerated; anything else fails closed. The helper is used
# to inspect the legacy lock and checkpoint content without sed's
# edge-case quirks.
legacy_metadata_value() {
  local field="$1"
  local metadata="$2"
  local line

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "${field}="*)
        printf '%s\n' "${line#"${field}="}"
        return 0
        ;;
    esac
  done <<<"$metadata"
  return 1
}

# Reads the legacy lock owner file, returning 0 when the snapshot is
# stable. Returns 2 when the directory or owner file is missing, and 3
# when the owner file is being concurrently rewritten.
legacy_owner_snapshot() {
  local lock_dir="$1"
  local owner_file="${lock_dir}/owner"
  local first second

  [[ -d "$lock_dir" && -r "$owner_file" && -f "$owner_file" ]] || return 2
  first="$(<"$owner_file")"
  second="$(<"$owner_file")"
  [[ "$first" == "$second" ]] || return 3
  printf '%s\n' "$first"
}

# Validates the four required owner fields without allowing free-form
# shell evaluation. Numeric pid, single-line token, non-empty repository,
# and non-empty started_at are required; anything else fails closed.
legacy_owner_is_valid() {
  local metadata="$1"
  local pid token repository started_at

  pid="$(legacy_metadata_value pid "$metadata" || true)"
  token="$(legacy_metadata_value token "$metadata" || true)"
  repository="$(legacy_metadata_value repository "$metadata" || true)"
  started_at="$(legacy_metadata_value started_at "$metadata" || true)"

  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -n "$token" && "$token" != *$'\n'* ]] || return 1
  [[ -n "$repository" && -n "$started_at" ]] || return 1
  return 0
}

# True when the recorded `repository=` line points at the same directory
# (after symlink resolution) the runner is operating on. The migration
# refuses a cross-repository recovery so a stolen lock cannot pretend
# to belong to a different worktree.
legacy_repository_matches() {
  local recorded="$1"
  local recorded_absolute current_absolute

  recorded_absolute="$(cd "$recorded" 2>/dev/null && pwd -P)" || return 1
  current_absolute="$(cd "$REPO_ROOT" 2>/dev/null && pwd -P)" || return 1
  [[ "$recorded_absolute" == "$current_absolute" ]]
}

# Confirms the legacy lock directory only contains the documented owner
# and optional status files. Unrecognized siblings are quarantined
# rather than deleted so an operator can audit unexpected artifacts.
legacy_lock_has_only_known_files() {
  local lock_dir="$1"
  local entry
  local status_path="${lock_dir}/status"
  local status_metadata=""

  for entry in "$lock_dir"/*; do
    [[ -e "$entry" ]] || continue
    case "$entry" in
      "$lock_dir/owner") continue ;;
      "$lock_dir/status")
        if [[ -f "$status_path" ]]; then
          status_metadata="$(<"$status_path")"
        fi
        continue
        ;;
      *)
        return 1
        ;;
    esac
  done
  for entry in "$lock_dir"/.*; do
    [[ -e "$entry" ]] || continue
    case "$entry" in
      "$lock_dir/."|"$lock_dir/..") continue ;;
      *) return 1 ;;
    esac
  done

  [[ -n "$status_metadata" ]] || return 0
  if ! legacy_owner_is_valid "$status_metadata"; then
    return 2
  fi
  if [[ "$(legacy_metadata_value pid "$status_metadata" || true)" \
        != "$(legacy_metadata_value pid "$(legacy_owner_snapshot "$lock_dir" 2>/dev/null || true)" || true)" ]]; then
    return 3
  fi
  return 0
}

# Returns the path of the legacy checkpoint file. The legacy namespace
# lives next to the canonical checkpoint so the migration can rewrite it
# in place with a single rename.
legacy_checkpoint_file() {
  printf '%s/%s.checkpoint\n' "$GIT_COMMON_DIR" "$LEGACY_RUNNER_NAME"
}

# Resolves the one configured Claude profile compatible with the legacy
# checkpoint identity. Missing legacy identity fields act as wildcards, but
# migration remains safe only when exactly one configured profile matches.
legacy_checkpoint_matching_profile() {
  local checkpoint="$1"
  local metadata legacy_profile legacy_cli legacy_model legacy_command
  local candidate candidate_cli candidate_model candidate_command
  local match="" matches=0

  metadata="$(<"$checkpoint")"
  legacy_profile="$(legacy_metadata_value profile "$metadata" || true)"
  legacy_cli="$(legacy_metadata_value cli "$metadata" || true)"
  legacy_model="$(legacy_metadata_value model "$metadata" || true)"
  legacy_command="$(legacy_metadata_value command "$metadata" || true)"

  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    candidate_cli="$(issue_killer_config_lookup "profiles.${candidate}.cli")"
    [[ "$candidate_cli" == "claude" ]] || continue
    if [[ -n "$legacy_profile" ]] &&
       issue_killer_config_profile_exists "$legacy_profile" &&
       [[ "$candidate" != "$legacy_profile" ]]; then
      continue
    fi
    [[ -z "$legacy_cli" || "$legacy_cli" == "$candidate_cli" ]] || continue
    candidate_model="$(issue_killer_config_lookup "profiles.${candidate}.model")"
    [[ -z "$legacy_model" || "$legacy_model" == "$candidate_model" ]] || continue
    candidate_command="$(issue_killer_config_lookup "profiles.${candidate}.command")"
    [[ -z "$legacy_command" || "$legacy_command" == "$candidate_command" ]] || continue
    match="$candidate"
    matches=$((matches + 1))
  done < <(issue_killer_config_profile_names)

  [[ "$matches" -eq 1 ]] || return 1
  printf '%s\n' "$match"
}

# Validates a legacy checkpoint for migration. The legacy checkpoint must
# carry a numeric issue, a base branch matching the configured base, a
# base SHA that resolves in the current repository, and a known lifecycle
# state. Profile/CLI/model/command are tolerated but not required; they must
# resolve to exactly one configured Claude execution profile.
legacy_checkpoint_is_migratable() {
  local checkpoint="$1"
  local issue branch base_branch base_sha state current_sha matching_profile

  [[ -r "$checkpoint" ]] || return 1
  issue="$(legacy_metadata_value issue "$(<"$checkpoint")" || true)"
  branch="$(legacy_metadata_value branch "$(<"$checkpoint")" || true)"
  base_branch="$(legacy_metadata_value base_branch "$(<"$checkpoint")" || true)"
  base_sha="$(legacy_metadata_value base_sha "$(<"$checkpoint")" || true)"
  state="$(legacy_metadata_value state "$(<"$checkpoint")" || true)"
  current_sha="$(current_base_sha)"
  matching_profile="$(legacy_checkpoint_matching_profile "$checkpoint")" || return 1

  [[ "$issue" =~ ^[0-9]+$ ]] || return 1
  [[ -n "$branch" && "$branch" != "unknown" ]] || return 1
  [[ "$base_branch" == "$BASE_BRANCH" ]] || return 1
  [[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$base_sha" == "$current_sha" ]] || return 1
  [[ "$matching_profile" == "$ISSUE_KILLER_PROFILE_NAME" ]] || return 1
  case "$state" in
    starting|issue_selected|mutating|branch_pushed|pr_created|pr_merged|issue_closed|blocked|failed|malformed|legacy_adopted) return 0 ;;
    *) return 1 ;;
  esac
}

# Captures the legacy checkpoint into a string. The migration
# re-emits every validated field into the canonical namespace so the
# supervisor never depends on a hidden mapping.
legacy_checkpoint_snapshot() {
  local checkpoint="$1"
  local issue iteration branch base_branch base_sha state session_id
  local metadata

  metadata="$(<"$checkpoint")"
  issue="$(legacy_metadata_value issue "$metadata" || true)"
  iteration="$(legacy_metadata_value iteration "$metadata" || true)"
  branch="$(legacy_metadata_value branch "$metadata" || true)"
  base_branch="$(legacy_metadata_value base_branch "$metadata" || true)"
  base_sha="$(legacy_metadata_value base_sha "$metadata" || true)"
  state="$(legacy_metadata_value state "$metadata" || true)"
  session_id="$(legacy_metadata_value session_id "$metadata" || true)"

  printf 'pid=%s\niteration=%s\n' "$$" "${iteration:-1}"
  printf 'issue=%s\nbranch=%s\nbase_branch=%s\nbase_sha=%s\nstate=%s\n' \
    "$issue" "$branch" "$base_branch" "$base_sha" "$state"
  if [[ -n "$session_id" ]]; then
    printf 'session_id=%s\n' "$session_id"
  else
    printf 'session_id=unavailable\n'
  fi
  printf 'profile=%s\n' "$ISSUE_KILLER_PROFILE_NAME"
  printf 'cli=%s\n' "$ISSUE_KILLER_PROFILE_CLI"
  printf 'model=%s\n' "$ISSUE_KILLER_PROFILE_MODEL"
  printf 'command=%s\n' "$ISSUE_KILLER_PROFILE_COMMAND"
}

# Quarantines a legacy lock whose metadata is corrupt, partial, or
# refers to a different repository. The directory is renamed to
# `<lock>.migrated-orphan-<ts>` so the next startup can still inspect
# the original artifacts if needed. Returns 0 on success, 1 on failure.
quarantine_legacy_lock() {
  local lock_dir="$1"
  local reason="$2"
  local target ts

  ts="$(date +%s)"
  target="${lock_dir}.migrated-orphan-${ts}"
  if ! mv "$lock_dir" "$target" 2>/dev/null; then
    if ! cp -R "$lock_dir" "$target" 2>/dev/null; then
      return 1
    fi
    rm -rf "$lock_dir" 2>/dev/null || true
  fi
  printf '[%s] Quarantined legacy lock %s -> %s (reason: %s)\n' \
    "$RUNNER_NAME" "$lock_dir" "$target" "$reason" >&2
  return 0
}

# Recovers a stale legacy lock by removing the directory after
# confirming the owner process is absent and the metadata is well
# formed. Returns 0 on success, 1 on failure to remove, 2 when the
# owner process is still alive, 3 when the metadata fails validation.
recover_stale_legacy_lock() {
  local lock_dir="$1"
  local metadata pid
  local status_path="${lock_dir}/status"

  if ! metadata="$(legacy_owner_snapshot "$lock_dir" 2>/dev/null)"; then
    if [[ $? -eq 2 ]]; then
      return 4
    fi
    return 3
  fi
  pid="$(legacy_metadata_value pid "$metadata" || true)"
  if [[ -z "$pid" ]]; then
    return 3
  fi
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    return 2
  fi
  if ! legacy_owner_is_valid "$metadata"; then
    return 3
  fi
  if ! legacy_lock_has_only_known_files "$lock_dir"; then
    return 5
  fi
  rm -f "${lock_dir}/owner" "${lock_dir}/status" "${status_path}"
  rmdir "$lock_dir" 2>/dev/null || return 1
  printf '[%s] Recovered stale legacy repository lock (previous pid %s).\n' \
    "$RUNNER_NAME" "$pid"
  return 0
}

# Migrates the legacy checkpoint into the canonical namespace. The
# migration is atomic: the legacy file is renamed first, the canonical
# file is written through a temp file, and the canonical lock is left
# untouched so a concurrent operator can audit both. Returns 0 on
# success, 1 on validation failure, 2 on filesystem failure.
migrate_legacy_checkpoint() {
  local canonical="$1"
  local legacy="$2"
  local target ts
  local snapshot_file

  if ! legacy_checkpoint_is_migratable "$legacy"; then
    return 1
  fi

  target="${legacy}.migrated-${ts:-$(date +%s)}"
  snapshot_file="${canonical}.migrating.$$"
  if ! legacy_checkpoint_snapshot "$legacy" > "$snapshot_file"; then
    rm -f "$snapshot_file" 2>/dev/null || true
    return 2
  fi
  if ! mv -f "$legacy" "$target" 2>/dev/null; then
    if ! cp "$legacy" "$target" 2>/dev/null; then
      rm -f "$snapshot_file" 2>/dev/null || true
      return 2
    fi
    rm -f "$legacy" 2>/dev/null || true
  fi
  if ! mv -f "$snapshot_file" "$canonical" 2>/dev/null; then
    rm -f "$target" "$snapshot_file" 2>/dev/null || true
    return 2
  fi
  printf '[%s] Migrated legacy checkpoint to canonical namespace: %s -> %s\n' \
    "$RUNNER_NAME" "$legacy" "$canonical" >&2
  return 0
}

# Validates the legacy namespace before any migration step. Returns 0 when
# there is nothing to migrate, 1 when the namespace is contested, 2 when
# legacy state is quarantined, 3 when a quarantine is required but
# cannot be performed, and 4 when legacy state is preserved for
# recovery. The caller is expected to fail closed on every non-zero
# status other than 0 and 4.
prepare_legacy_state() {
  local lock_dir checkpoint
  local recovered=0

  # Legacy migration runs unconditionally: every issue-killer startup
  # inspects the namespace occupied by the historical binary so any
  # in-flight work can be adopted safely across linked worktrees.
  lock_dir="$(legacy_lock_dir)"
  checkpoint="$(legacy_checkpoint_file)"

  if [[ -d "$lock_dir" ]]; then
    if ! legacy_owner_snapshot "$lock_dir" >/dev/null 2>&1; then
      case $? in
        2)
          quarantine_legacy_lock "$lock_dir" \
            "missing or unreadable owner metadata" || return 3
          recovered=1
          ;;
        3)
          printf '%s: legacy lock owner file is changing; refusing to migrate without stable metadata.\n' \
            "$RUNNER_NAME" >&2
          return 1
          ;;
        *)
          return 1
          ;;
      esac
    fi
    if [[ -d "$lock_dir" ]]; then
      local owner_status=0
      local owner_metadata=""
      if ! owner_metadata="$(legacy_owner_snapshot "$lock_dir" 2>/dev/null)"; then
        owner_status=$?
      fi
      if [[ "$owner_status" -eq 0 ]]; then
        if ! legacy_owner_is_valid "$owner_metadata"; then
          quarantine_legacy_lock "$lock_dir" \
            "partial or invalid owner metadata" || return 3
          recovered=1
        elif ! legacy_repository_matches \
            "$(legacy_metadata_value repository "$owner_metadata" || true)"; then
          quarantine_legacy_lock "$lock_dir" \
            "owner metadata references a different repository" || return 3
          recovered=1
        else
          local owner_pid
          owner_pid="$(legacy_metadata_value pid "$owner_metadata" || true)"
          if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
            printf '%s: another legacy runner is active for this repository (pid %s)\n' \
              "$RUNNER_NAME" "$owner_pid" >&2
            if [[ -r "${lock_dir}/status" ]]; then
              sed 's/^/  /' "${lock_dir}/status" >&2
            fi
            return 1
          fi
          local recover_status=0
          recover_stale_legacy_lock "$lock_dir" || recover_status=$?
          case "$recover_status" in
            0)
              recovered=1
              ;;
            1)
              printf '%s: unable to remove stale legacy lock at %s\n' \
                "$RUNNER_NAME" "$lock_dir" >&2
              return 3
              ;;
            2)
              printf '%s: another legacy runner is active for this repository (pid %s)\n' \
                "$RUNNER_NAME" "$owner_pid" >&2
              if [[ -r "${lock_dir}/status" ]]; then
                sed 's/^/  /' "${lock_dir}/status" >&2
              fi
              return 1
              ;;
            3)
              quarantine_legacy_lock "$lock_dir" \
                "stale lock owner metadata is invalid" || return 3
              recovered=1
              ;;
            4)
              quarantine_legacy_lock "$lock_dir" \
                "stale lock directory contents are unrecognized" || return 3
              recovered=1
              ;;
            5)
              quarantine_legacy_lock "$lock_dir" \
                "stale lock directory contains unknown files" || return 3
              recovered=1
              ;;
            *)
              return 1
              ;;
          esac
        fi
      else
        case "$owner_status" in
          2)
            quarantine_legacy_lock "$lock_dir" \
              "legacy lock owner metadata is missing" || return 3
            recovered=1
            ;;
          3)
            printf '%s: legacy lock owner file is changing; refusing to migrate without stable metadata.\n' \
              "$RUNNER_NAME" >&2
            return 1
            ;;
          *)
            return 1
            ;;
        esac
      fi
    fi
  fi

  if [[ -e "$checkpoint" ]]; then
    local canonical_checkpoint
    canonical_checkpoint="$(checkpoint_file)"
    if [[ -e "$canonical_checkpoint" ]]; then
      printf '%s: both legacy and canonical checkpoint files exist; refusing to migrate ambiguous state.\n' \
        "$RUNNER_NAME" >&2
      return 1
    fi
    if ! migrate_legacy_checkpoint "$canonical_checkpoint" "$checkpoint"; then
      printf '%s: legacy checkpoint migration failed; leaving original state untouched.\n' \
        "$RUNNER_NAME" >&2
      return 1
    fi
  fi

  if [[ "$recovered" -ne 0 ]] ||
     compgen -G "${GIT_COMMON_DIR}/${LEGACY_RUNNER_NAME}.checkpoint.migrated-*" >/dev/null; then
    printf '[%s] Legacy namespace resolved before canonical lock acquisition.\n' \
      "$RUNNER_NAME" >&2
  fi
  return 0
}
