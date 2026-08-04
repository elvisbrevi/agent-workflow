#!/usr/bin/env bash
# All operator interaction for profile selection and destructive/recovery
# confirmation. Sourced by run.sh; intentionally has no source-time effects.

operator_session_uses_stdio() {
  [[ -t 0 && -t 2 ]]
}

operator_session_available() {
  if operator_session_uses_stdio; then
    return 0
  fi
  [[ -r /dev/tty && -w /dev/tty ]] || return 1
  { : >/dev/tty; } 2>/dev/null
}

operator_prompt() {
  if operator_session_uses_stdio; then
    printf "$@" >&2
  else
    printf "$@" >/dev/tty
  fi
}

operator_read_answer() {
  OPERATOR_ANSWER=""
  if operator_session_uses_stdio; then
    IFS= read -r OPERATOR_ANSWER
  else
    IFS= read -r OPERATOR_ANSWER </dev/tty
  fi
}

# Selects one configured execution profile and prints its name.
operator_select_profile() {
  local state_file="${ISSUE_KILLER_CONFIG_STATE_FILE:-}"
  local default_name="$1"
  local -a names=()
  local -a labels=()
  local -a clis=()
  local -a models=()
  local -a variants=()
  local entry index=0 option_value variant_effort answer choice default_index=""

  [[ -r "$state_file" ]] || {
    printf '%s: configuration was not loaded\n' "$RUNNER_NAME" >&2
    return 1
  }

  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    names+=("$entry")
    labels+=("$(issue_killer_config_lookup "profiles.${entry}.label")")
    clis+=("$(issue_killer_config_lookup "profiles.${entry}.cli")")
    models+=("$(issue_killer_config_lookup "profiles.${entry}.model")")
    variant_effort=""
    case "$(issue_killer_config_lookup "profiles.${entry}.cli")" in
      claude)
        option_value="$(issue_killer_config_lookup "profiles.${entry}.options.permission_mode")"
        if [[ -n "$option_value" ]]; then
          variant_effort="permission=${option_value}"
        fi
        ;;
      codex)
        option_value="$(issue_killer_config_lookup "profiles.${entry}.options.reasoning_effort")"
        if [[ -n "$option_value" ]]; then
          variant_effort="effort=${option_value}"
        fi
        ;;
      opencode)
        option_value="$(issue_killer_config_lookup "profiles.${entry}.options.variant")"
        if [[ -n "$option_value" ]]; then
          variant_effort="variant=${option_value}"
        fi
        ;;
    esac
    variants+=("$variant_effort")
  done < <(issue_killer_config_profile_names)

  [[ "${#names[@]}" -gt 0 ]] || {
    printf '%s: no profiles are configured in %s\n' \
      "$RUNNER_NAME" "$ISSUE_KILLER_CONFIG_PATH" >&2
    return 1
  }

  operator_prompt 'Select an execution profile:\n'
  index=0
  while [[ $index -lt ${#names[@]} ]]; do
    operator_prompt '  %d) %s  cli=%s model=%s%s\n' \
      $((index + 1)) "${labels[$index]}" "${clis[$index]}" \
      "${models[$index]}" "${variants[$index]:+ ${variants[$index]}}"
    if [[ "${names[$index]}" == "$default_name" ]]; then
      default_index=$((index + 1))
    fi
    index=$((index + 1))
  done
  operator_prompt 'Edit %s to add or change profiles.\n' \
    "$ISSUE_KILLER_CONFIG_PATH"
  if [[ -n "$default_index" ]]; then
    operator_prompt 'Profile [%d]: ' "$default_index"
  else
    operator_prompt 'Profile: '
  fi
  operator_read_answer || {
    printf '%s: unable to read profile selection from operator session\n' \
      "$RUNNER_NAME" >&2
    return 1
  }
  answer="$OPERATOR_ANSWER"
  if [[ -z "$answer" && -n "$default_index" ]]; then
    answer="$default_index"
  fi
  if [[ ! "$answer" =~ ^[0-9]+$ ]]; then
    printf '%s: invalid profile selection: %s\n' "$RUNNER_NAME" "$answer" >&2
    return 1
  fi
  choice=$((answer - 1))
  if (( choice < 0 )) || (( choice >= ${#names[@]} )); then
    printf '%s: profile selection out of range: %s\n' "$RUNNER_NAME" "$answer" >&2
    return 1
  fi
  printf '%s\n' "${names[$choice]}"
}

# Builds an ordered OpenCode fallback chain and prints one profile per line.
operator_select_fallbacks() {
  local selected_profile="$1"
  local chosen=""
  local entry answer choice index
  local -a names=()
  local -a labels=()
  local -a models=()

  while true; do
    names=()
    labels=()
    models=()
    while IFS= read -r entry; do
      [[ -n "$entry" && "$entry" != "$selected_profile" ]] || continue
      [[ "$(issue_killer_config_lookup "profiles.${entry}.cli")" == "opencode" ]] || continue
      if [[ -n "$chosen" ]] && grep -Fqx -- "$entry" <<<"$chosen"; then
        continue
      fi
      names+=("$entry")
      labels+=("$(issue_killer_config_lookup "profiles.${entry}.label")")
      models+=("$(issue_killer_config_lookup "profiles.${entry}.model")")
    done < <(issue_killer_config_profile_names)

    [[ "${#names[@]}" -gt 0 ]] || break

    operator_prompt 'Select the next OpenCode fallback profile:\n'
    operator_prompt '  0) None\n'
    index=0
    while [[ $index -lt ${#names[@]} ]]; do
      operator_prompt '  %d) %s  cli=opencode model=%s\n' \
        $((index + 1)) "${labels[$index]}" "${models[$index]}"
      index=$((index + 1))
    done
    operator_prompt 'Fallback [0]: '
    operator_read_answer || {
      printf '%s: unable to read fallback selection from operator session\n' \
        "$RUNNER_NAME" >&2
      return 1
    }
    answer="$OPERATOR_ANSWER"
    [[ -n "$answer" ]] || answer=0
    if [[ "$answer" == "0" ]]; then
      break
    fi
    if [[ ! "$answer" =~ ^[0-9]+$ ]]; then
      printf '%s: invalid fallback selection: %s\n' "$RUNNER_NAME" "$answer" >&2
      return 1
    fi
    choice=$((answer - 1))
    if (( choice < 0 )) || (( choice >= ${#names[@]} )); then
      printf '%s: fallback selection out of range: %s\n' "$RUNNER_NAME" "$answer" >&2
      return 1
    fi
    if [[ -z "$chosen" ]]; then
      chosen="${names[$choice]}"
    else
      chosen+=$'\n'"${names[$choice]}"
    fi
  done

  [[ -n "$chosen" ]] && printf '%s\n' "$chosen"
}

# Confirms the initial autonomous, destructive run.
operator_confirm_destructive_run() {
  local answer

  if [[ "${ISSUE_RUNNER_ASSUME_YES:-false}" == "true" ]]; then
    return
  fi

  if ! operator_session_available; then
    die "confirmation requires a TTY; set ISSUE_RUNNER_ASSUME_YES=true only after explicit authorization"
  fi

  operator_prompt 'About to launch issue-killer repeatedly against %s with these settings:\n' "$REPO_ROOT"
  operator_prompt '  profile:      %s (%s)\n' \
    "$ISSUE_KILLER_PROFILE_NAME" "$ISSUE_KILLER_PROFILE_LABEL"
  operator_prompt '  cli:          %s\n' "$ISSUE_KILLER_PROFILE_CLI"
  operator_prompt '  model:        %s\n' "$ISSUE_KILLER_PROFILE_MODEL"
  operator_prompt '  autonomy:     permission_mode=%s\n' "$PERMISSION_MODE"
  operator_prompt '  tracker:      %s\n' "${TRACKER_KIND:-unknown}"
  operator_prompt '  base branch:  %s\n' "$BASE_BRANCH"
  if [[ -n "$ISSUE_KILLER_PROFILE_FALLBACKS" ]]; then
    operator_prompt '  fallbacks:    %s\n' \
      "$(printf '%s, ' $ISSUE_KILLER_PROFILE_FALLBACKS | sed 's/, $//')"
  fi
  operator_prompt 'This will repeatedly merge PRs into %s and close issues. Continue? [y/N] ' \
    "$BASE_BRANCH"
  operator_read_answer || die "unable to read confirmation"
  answer="$OPERATOR_ANSWER"
  [[ "$answer" =~ ^[Yy]$ ]] || die "cancelled"
}

# Confirms recovery of an existing dirty worktree.
operator_confirm_recovery() {
  local prompt="$1"
  local answer

  if ! operator_session_available; then
    emit_recovery_required "TTY confirmation is required before recovery can continue"
  fi
  operator_prompt '%s Continue? [y/N] ' "$prompt" || \
    emit_recovery_required "TTY confirmation is required before recovery can continue"
  operator_read_answer || \
    emit_recovery_required "unable to read TTY confirmation for recovery"
  answer="$OPERATOR_ANSWER"

  [[ "$answer" =~ ^[Yy]$ ]] || \
    emit_recovery_required "operator declined recovery confirmation"
}
