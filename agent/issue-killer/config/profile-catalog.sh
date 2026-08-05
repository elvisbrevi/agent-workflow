#!/usr/bin/env bash
# Execution-profile catalog, validation, lookup, and lifecycle.
# Sourced by issue-killer-config.sh; no source-time side effects.

# Returns the profile names defined in the loaded configuration, one
# per line. Empty when no profile was found.
issue_killer_config_profile_names() {
  local state_file="${ISSUE_KILLER_CONFIG_STATE_FILE:-}"
  [[ -r "$state_file" ]] || return 0
  awk -F. '/^profiles\./ && $2 !~ /\.options$/ {print $2}' "$state_file" | sort -u
}

# Returns the value of the requested key for the named profile. The
# caller passes `top.default_profile`, `profiles.<name>.label`, etc.
issue_killer_config_lookup() {
  local key="$1"
  local state_file="${ISSUE_KILLER_CONFIG_STATE_FILE:-}"
  [[ -r "$state_file" ]] || return 1
  grep -E "^${key}=" "$state_file" | head -n 1 | sed -e "s/^${key}=//"
}

# Returns the option values for the named profile, one `key=value`
# per line.
issue_killer_config_profile_options() {
  local profile="$1"
  local state_file="${ISSUE_KILLER_CONFIG_STATE_FILE:-}"
  [[ -r "$state_file" ]] || return 0
  grep -E "^profiles\\.${profile}\\.options\\." "$state_file" | \
    sed -e "s/^profiles\\.${profile}\\.options\\.//"
}

# Returns the fallback names declared by the named profile, one per
# line. Empty when none are declared.
issue_killer_config_profile_fallbacks() {
  local profile="$1"
  local state_file="${ISSUE_KILLER_CONFIG_STATE_FILE:-}"
  [[ -r "$state_file" ]] || return 0
  { grep -E "^profiles\\.${profile}\\.fallbacks=" "$state_file" || true; } | \
    sed -e "s/^profiles\\.${profile}\\.fallbacks=//"
  return 0
}

# Returns 0 when a profile exists in the loaded state.
issue_killer_config_profile_exists() {
  local profile="$1"
  local state_file="${ISSUE_KILLER_CONFIG_STATE_FILE:-}"
  [[ -r "$state_file" ]] || return 1
  grep -Eq "^profiles\\.${profile}\\.cli=" "$state_file"
}

# Walks fallback edges from one profile and rejects cycles. The path is a
# newline-separated list so profile names are compared exactly without
# relying on Bash 4 associative arrays.
issue_killer_config_validate_fallback_path() {
  local profile="$1"
  local path="$2"
  local fallback

  while IFS= read -r fallback; do
    [[ -n "$fallback" ]] || continue
    if grep -Fqx -- "$fallback" <<<"$path"; then
      printf '%s: fallback chain contains a cycle through profile %s\n' \
        "$RUNNER_NAME" "$fallback" >&2
      return 1
    fi
    issue_killer_config_validate_fallback_path \
      "$fallback" "${path}"$'\n'"${fallback}" || return 1
  done < <(issue_killer_config_profile_fallbacks "$profile")
}

# Validates all declared fallback chains before profile selection. References
# must exist, every profile in the chain must use a supported CLI, entries
# must be unique within each ordered chain, and the complete graph must be
# acyclic. Mixed-provider chains (Claude, Codex, and OpenCode profiles in
# the same ordered fallback list) are accepted once every entry passes
# these checks.
issue_killer_config_validate_fallbacks() {
  local profile cli fallback fallback_cli seen

  while IFS= read -r profile; do
    [[ -n "$profile" ]] || continue
    seen=""
    cli="$(issue_killer_config_lookup "profiles.${profile}.cli")"
    while IFS= read -r fallback; do
      [[ -n "$fallback" ]] || continue
      if ! issue_killer_config_profile_exists "$fallback"; then
        printf '%s: fallback profile %s is not configured\n' \
          "$RUNNER_NAME" "$fallback" >&2
        return 1
      fi
      fallback_cli="$(issue_killer_config_lookup "profiles.${fallback}.cli")"
      case "$fallback_cli" in
        claude|codex|opencode) ;;
        *)
          printf '%s: fallback profile %s uses unsupported cli: %s\n' \
            "$RUNNER_NAME" "$fallback" "${fallback_cli:-unset}" >&2
          return 1
          ;;
      esac
      if [[ -n "$seen" ]] && grep -Fqx -- "$fallback" <<<"$seen"; then
        printf '%s: profile %s contains duplicate fallback %s\n' \
          "$RUNNER_NAME" "$profile" "$fallback" >&2
        return 1
      fi
      if [[ -z "$seen" ]]; then
        seen="$fallback"
      else
        seen+=$'\n'"$fallback"
      fi
    done < <(issue_killer_config_profile_fallbacks "$profile")
  done < <(issue_killer_config_profile_names)

  while IFS= read -r profile; do
    [[ -n "$profile" ]] || continue
    issue_killer_config_validate_fallback_path "$profile" "$profile" || return 1
  done < <(issue_killer_config_profile_names)
}

issue_killer_config_validate_profile_cli() {
  local profile="$1"
  local cli
  cli="$(issue_killer_config_lookup "profiles.${profile}.cli")"
  case "$cli" in
    claude|codex|opencode) return 0 ;;
    *)
      printf '%s: profile %s has unsupported cli: %s\n' \
        "$RUNNER_NAME" "$profile" "${cli:-unset}" >&2
      return 1
      ;;
  esac
}

# Validates the named profile and copies its fields into the
# `ISSUE_KILLER_PROFILE_*` globals. The CLI is validated by the
# caller; this helper enforces that the remaining required fields are
# present, the command name is safe to invoke as either an executable
# or a shell function, and the shell/init_file pairing is consistent.
issue_killer_config_apply_profile() {
  local profile="$1"
  local label cli command model shell init_file

  issue_killer_config_validate_profile_cli "$profile" || return 1

  for required in label cli command model; do
    local value
    value="$(issue_killer_config_lookup "profiles.${profile}.${required}")"
    if [[ -z "$value" ]]; then
      printf '%s: profile %s is missing required field: %s\n' \
        "$RUNNER_NAME" "$profile" "$required" >&2
      return 1
    fi
    case "$required" in
      label) label="$value" ;;
      cli) cli="$value" ;;
      command) command="$value" ;;
      model) model="$value" ;;
    esac
  done

  shell="$(issue_killer_config_lookup "profiles.${profile}.shell")"
  init_file="$(issue_killer_config_lookup "profiles.${profile}.init_file")"

  # The command must be safe to invoke as either a program name or
  # a shell function. The runner refuses free-form shell expressions;
  # the command is invoked either through `command -v` (executable) or
  # as a shell function loaded from the optional init file.
  case "$command" in
    *[!A-Za-z0-9._/-]*)
      printf '%s: profile %s command contains unsafe characters: %s\n' \
        "$RUNNER_NAME" "$profile" "$command" >&2
      return 1
      ;;
  esac
  if [[ -n "$shell" ]]; then
    case "$shell" in
      *[!A-Za-z0-9._/-]*)
        printf '%s: profile %s shell contains unsafe characters: %s\n' \
          "$RUNNER_NAME" "$profile" "$shell" >&2
        return 1
        ;;
    esac
    command -v "$shell" >/dev/null 2>&1 || {
      printf '%s: profile %s declares shell %s which is not on PATH\n' \
        "$RUNNER_NAME" "$profile" "$shell" >&2
      return 1
    }
  fi
  if [[ -n "$shell" && -z "$init_file" ]]; then
    printf '%s: profile %s declares shell %s without init_file\n' \
      "$RUNNER_NAME" "$profile" "$shell" >&2
    return 1
  fi
  if [[ -z "$shell" && -n "$init_file" ]]; then
    printf '%s: profile %s declares init_file without shell\n' \
      "$RUNNER_NAME" "$profile" >&2
    return 1
  fi
  if [[ -n "$init_file" ]]; then
    case "$init_file" in
      *[!A-Za-z0-9._/~-]*)
        printf '%s: profile %s init_file contains unsafe characters: %s\n' \
          "$RUNNER_NAME" "$profile" "$init_file" >&2
        return 1
        ;;
    esac
  fi

  ISSUE_KILLER_PROFILE_NAME="$profile"
  ISSUE_KILLER_PROFILE_LABEL="$label"
  ISSUE_KILLER_PROFILE_CLI="$cli"
  ISSUE_KILLER_PROFILE_COMMAND="$command"
  ISSUE_KILLER_PROFILE_MODEL="$model"
  ISSUE_KILLER_PROFILE_SHELL="$shell"
  ISSUE_KILLER_PROFILE_INIT_FILE="$init_file"
  ISSUE_KILLER_PROFILE_OPTIONS="$(issue_killer_config_profile_options "$profile")"
  ISSUE_KILLER_PROFILE_FALLBACKS="$(issue_killer_config_profile_fallbacks "$profile")"
}

# Selects the default profile without prompting. The caller must have
# already loaded the configuration with `issue_killer_config_load`.
# Returns 0 on success and populates the `ISSUE_KILLER_PROFILE_*`
# globals; returns 1 on any validation failure.
issue_killer_config_select_default_profile() {
  local state_file="${ISSUE_KILLER_CONFIG_STATE_FILE:-}"
  local default_name

  [[ -r "$state_file" ]] || {
    printf '%s: configuration was not loaded\n' "$RUNNER_NAME" >&2
    return 1
  }
  default_name="$(issue_killer_config_lookup top.default_profile)"
  if [[ -z "$default_name" ]]; then
    printf '%s: non-interactive launch requires default_profile in %s\n' \
      "$RUNNER_NAME" "$ISSUE_KILLER_CONFIG_PATH" >&2
    return 1
  fi
  issue_killer_config_apply_profile "$default_name"
}

# Cleans up the temporary state file produced by the parser.
issue_killer_config_cleanup() {
  local state_file="${ISSUE_KILLER_CONFIG_STATE_FILE:-}"
  [[ -n "$state_file" && -e "$state_file" ]] && rm -f "$state_file"
  ISSUE_KILLER_CONFIG_STATE_FILE=""
}

