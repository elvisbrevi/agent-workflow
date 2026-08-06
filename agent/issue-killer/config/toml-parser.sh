#!/usr/bin/env bash
# Strict parser for the supported issue-killer TOML subset.
# Sourced by issue-killer-config.sh; no source-time side effects.

# Resolves the path of the active configuration file. Honors
# `--config <path>` from the calling command line when present,
# otherwise falls back to `${HOME}/.config/issue-killer/config.toml`.
# Echoes the absolute path of the file that should be loaded. The
# caller is responsible for verifying that the returned file exists
# and is readable.
issue_killer_config_resolve_path() {
  local candidate=""
  local arg

  while [[ $# -gt 0 ]]; do
    arg="$1"
    case "$arg" in
      --config)
        [[ $# -ge 2 ]] || die "--config requires a path argument"
        candidate="$2"
        shift 2
        ;;
      --config=*)
        candidate="${arg#--config=}"
        shift
        ;;
      *)
        shift
        ;;
    esac
  done

  if [[ -z "$candidate" ]]; then
    candidate="${ISSUE_KILLER_CONFIG_PATH:-${HOME}/.config/issue-killer/config.toml}"
  fi

  if [[ "$candidate" != /* ]]; then
    local dir
    dir="$(cd "$(dirname "$candidate")" 2>/dev/null && pwd)"
    candidate="${dir}/$(basename "$candidate")"
  fi
  printf '%s\n' "$candidate"
}

# Strips an inline `# ...` comment from a TOML line. Comment
# characters inside basic strings are preserved.
issue_killer_config_strip_comment() {
  local line="$1"
  local in_single=false in_double=false index=0 char output=""

  while (( index < ${#line} )); do
    char="${line:index:1}"
    if [[ "$in_single" == "true" ]]; then
      output+="$char"
      [[ "$char" == "'" ]] && in_single=false
    elif [[ "$in_double" == "true" ]]; then
      output+="$char"
      if [[ "$char" == "\\" ]]; then
        index=$((index + 1))
        if (( index < ${#line} )); then
          output+="${line:index:1}"
        fi
      elif [[ "$char" == '"' ]]; then
        in_double=false
      fi
    else
      case "$char" in
        '#') break ;;
        "'") in_single=true; output+="$char" ;;
        '"') in_double=true; output+="$char" ;;
        *) output+="$char" ;;
      esac
    fi
    index=$((index + 1))
  done

  printf '%s' "${output%"${output##*[![:space:]]}"}"
}

# Decodes a TOML basic-string fragment (without the surrounding
# quotes) and echoes the result. Supports `\n`, `\t`, `\r`, `\b`,
# `\f`, `\"`, `\\`, and `\uXXXX` (Basic Multilingual Plane only).
# Parses the value side of a TOML `key = value` line. Sets
# `ISSUE_KILLER_CONFIG_PARSE_VALUE` to the decoded value (arrays
# are joined with newline characters as a separator so the state
# file can record them losslessly without binary data). Returns 0 on
# success and 1 on a malformed value.
issue_killer_config_parse_value() {
  local rest="$1"
  # Trim leading whitespace; the key/value splitter only trims the
  # key, so the value side may still carry spaces before the literal.
  rest="${rest#"${rest%%[![:space:]]*}"}"
  local first="${rest:0:1}"

  case "$first" in
    '"')
      local body="${rest:1}"
      local index=0 char out=""
      while (( index < ${#body} )); do
        char="${body:index:1}"
        if [[ "$char" == "\\" ]]; then
          index=$((index + 1))
          if (( index >= ${#body} )); then
            out+='\\'
            break
          fi
          char="${body:index:1}"
          case "$char" in
            '"') out+='"' ;;
            '\\') out+='\\' ;;
            'n') out+=$'\n' ;;
            't') out+=$'\t' ;;
            'r') out+=$'\r' ;;
            'b') out+=$'\b' ;;
            'f') out+=$'\f' ;;
            'u')
              if (( index + 4 < ${#body} )); then
                local hex="${body:index+1:4}"
                if [[ "$hex" =~ ^[0-9A-Fa-f]{4}$ ]]; then
                  local code=$((16#${hex}))
                  if (( code < 128 )); then
                    out+="$(printf '%b' "\\$(printf '%03o' "$code")")"
                  else
                    out+='?'
                  fi
                  index=$((index + 4))
                else
                  out+='?'
                fi
              else
                out+='?'
              fi
              ;;
            *) out+="$char" ;;
          esac
          index=$((index + 1))
          continue
        fi
        if [[ "$char" == '"' ]]; then
          ISSUE_KILLER_CONFIG_PARSE_VALUE="$out"
          return 0
        fi
        out+="$char"
        index=$((index + 1))
      done
      return 1
      ;;
    '[')
      local index=1 depth=1 result_array="" body=""
      local char
      while (( index < ${#rest} )); do
        char="${rest:index:1}"
        if [[ "$char" == "[" ]]; then
          depth=$((depth + 1))
        elif [[ "$char" == "]" ]]; then
          depth=$((depth - 1))
          if (( depth == 0 )); then
            break
          fi
        fi
        body+="$char"
        index=$((index + 1))
      done
      if (( depth != 0 )); then
        return 1
      fi
      local pos=0
      while (( pos < ${#body} )); do
        local c="${body:pos:1}"
        case "$c" in
          [[:space:]]|',') pos=$((pos + 1)); continue ;;
        esac
        if [[ "$c" == '"' ]]; then
          pos=$((pos + 1))
          local elem=""
          while (( pos < ${#body} )); do
            local d="${body:pos:1}"
            if [[ "$d" == "\\" ]]; then
              pos=$((pos + 1))
              if (( pos < ${#body} )); then
                elem+="${body:pos:1}"
              fi
              pos=$((pos + 1))
              continue
            fi
            if [[ "$d" == '"' ]]; then
              break
            fi
            elem+="$d"
            pos=$((pos + 1))
          done
          if (( pos >= ${#body} )); then
            return 1
          fi
          pos=$((pos + 1))
          [[ -z "$result_array" ]] && result_array="$elem" || \
            result_array+=$'\n'"$elem"
        else
          return 1
        fi
      done
      ISSUE_KILLER_CONFIG_PARSE_VALUE="$result_array"
      return 0
      ;;
    *)
      # Bare TOML booleans. Trim trailing whitespace; any other junk is
      # malformed. Store as the literal "true"/"false" strings the
      # adapters already compare against.
      local bare="${rest%"${rest##*[![:space:]]}"}"
      case "$bare" in
        true|false)
          ISSUE_KILLER_CONFIG_PARSE_VALUE="$bare"
          return 0
          ;;
      esac
      return 1
      ;;
  esac
}

# Splits the supplied key by the first `=`, returning the trimmed key
# and the trimmed value side via `ISSUE_KILLER_CONFIG_PARSE_KEY` and
# `ISSUE_KILLER_CONFIG_PARSE_REST`. Returns 0 on success and 1 when
# no `=` is present.
issue_killer_config_split_kv() {
  local line="$1"
  local index=0 char key="" rest=""

  while (( index < ${#line} )); do
    char="${line:index:1}"
    [[ "$char" == "=" ]] && break
    key+="$char"
    index=$((index + 1))
  done
  if (( index >= ${#line} )); then
    return 1
  fi
  rest="${line:$((index + 1))}"
  key="${key//[[:space:]]/}"
  [[ -n "$key" ]] || return 1
  ISSUE_KILLER_CONFIG_PARSE_KEY="$key"
  ISSUE_KILLER_CONFIG_PARSE_REST="$rest"
  return 0
}

# Returns 0 when the supplied key is composed only of identifier-safe
# characters and is not empty. The loader rejects keys with spaces
# or punctuation so it cannot silently accept misspelled fields.
# Hyphens are allowed because profile names such as `claude-main`
# follow shell-identifier conventions.
issue_killer_config_valid_key() {
  local key="$1"
  [[ -n "$key" ]] || return 1
  case "$key" in
    *[!A-Za-z0-9_-]*) return 1 ;;
  esac
  return 0
}

# Records a parsed field onto the state file. The caller supplies the
# section path (e.g. `top`, `profiles.<name>`, `profiles.<name>.options`)
# and the key. Unknown sections or keys cause the function to fail
# closed; the loader surfaces a precise diagnostic.
issue_killer_config_record_field() {
  local section="$1"
  local key="$2"
  local value="$3"
  local state_file="${ISSUE_KILLER_CONFIG_STATE_FILE:-}"

  [[ -n "$state_file" ]] || return 0
  issue_killer_config_valid_key "$key" || {
    printf '%s: invalid key in section [%s]: %s\n' "$RUNNER_NAME" "$section" "$key" >&2
    return 1
  }

  case "$section" in
    top)
      case "$key" in
        default_profile)
          printf 'top.default_profile=%s\n' "$value" >> "$state_file"
          ;;
        *)
          printf '%s: unknown top-level key: %s\n' "$RUNNER_NAME" "$key" >&2
          return 1
          ;;
      esac
      ;;
    profiles.*.options)
      local profile="${section#profiles.}"
      profile="${profile%.options}"
      case "$key" in
        permission_mode|reasoning_effort|sandbox|variant|auto_approve|disable_session_persistence)
          printf 'profiles.%s.options.%s=%s\n' "$profile" "$key" "$value" >> "$state_file"
          ;;
        *)
          printf '%s: unknown option in profiles.%s.options: %s\n' \
            "$RUNNER_NAME" "$profile" "$key" >&2
          return 1
          ;;
      esac
      ;;
    profiles.*)
      local profile="${section#profiles.}"
      case "$key" in
        label|cli|command|model|shell|init_file)
          printf 'profiles.%s.%s=%s\n' "$profile" "$key" "$value" >> "$state_file"
          ;;
        fallbacks)
          while IFS= read -r fallback; do
            [[ -n "$fallback" ]] || continue
            printf 'profiles.%s.fallbacks=%s\n' "$profile" "$fallback" >> "$state_file"
          done <<<"$value"
          ;;
        *)
          printf '%s: unknown profile field: %s\n' "$RUNNER_NAME" "$key" >&2
          return 1
          ;;
      esac
      ;;
    *)
      printf '%s: unknown section: %s\n' "$RUNNER_NAME" "$section" >&2
      return 1
      ;;
  esac
  return 0
}

# Reads the configuration file into the temporary state file. The
# orchestrator reads that file later to extract the selected profile
# fields. This function only parses and validates the schema; profile
# selection is performed by `issue_killer_config_apply_profile` or
# `operator_select_profile` so the same library can be
# reused for the non-TTY default and the TTY prompt.
issue_killer_config_load() {
  local path="$1"
  local tmp_state=""
  local line cleaned current_section=""
  local rest key value

  [[ -e "$path" ]] || {
    printf '%s: configuration not found: %s\n' "$RUNNER_NAME" "$path" >&2
    return 1
  }
  [[ -r "$path" ]] || {
    printf '%s: configuration is not readable: %s\n' "$RUNNER_NAME" "$path" >&2
    return 1
  }
  [[ -f "$path" ]] || {
    printf '%s: configuration is not a regular file: %s\n' "$RUNNER_NAME" "$path" >&2
    return 1
  }

  tmp_state="$(mktemp "${TMPDIR:-/tmp}/issue-killer-config.XXXXXX")"
  ISSUE_KILLER_CONFIG_STATE_FILE="$tmp_state"
  ISSUE_KILLER_CONFIG_PATH="$path"

  exec 3<"$path"
  while IFS= read -r line <&3; do
    cleaned="$(issue_killer_config_strip_comment "$line")"
    [[ -z "${cleaned//[[:space:]]/}" ]] && continue
    case "${cleaned:0:1}" in
      '[')
        if [[ "${cleaned: -1}" != "]" ]]; then
          printf '%s: malformed section header: %s\n' "$RUNNER_NAME" "$line" >&2
          exec 3<&-
          return 1
        fi
        local header="${cleaned:1:${#cleaned}-2}"
        local first="${header%%.*}"
        local rest_header="${header#*.}"
        case "$first" in
          profiles)
            case "$rest_header" in
              *.options)
                local profile="${rest_header%.options}"
                issue_killer_config_valid_key "$profile" || {
                  printf '%s: malformed profile name in section header: [%s]\n' \
                    "$RUNNER_NAME" "$header" >&2
                  exec 3<&-
                  return 1
                }
                current_section="profiles.${profile}.options"
                ;;
              *.*)
                printf '%s: unsupported section header: [%s]\n' \
                  "$RUNNER_NAME" "$header" >&2
                exec 3<&-
                return 1
                ;;
              *)
                issue_killer_config_valid_key "$rest_header" || {
                  printf '%s: malformed profile name in section header: [%s]\n' \
                    "$RUNNER_NAME" "$header" >&2
                  exec 3<&-
                  return 1
                }
                current_section="profiles.${rest_header}"
                ;;
            esac
            ;;
          *)
            printf '%s: unknown section: [%s]\n' "$RUNNER_NAME" "$header" >&2
            exec 3<&-
            return 1
            ;;
        esac
        continue
        ;;
    esac

    issue_killer_config_split_kv "$cleaned" || {
      printf '%s: expected '\''='\'' in line: %s\n' "$RUNNER_NAME" "$line" >&2
      exec 3<&-
      return 1
    }
    key="$ISSUE_KILLER_CONFIG_PARSE_KEY"
    rest="$ISSUE_KILLER_CONFIG_PARSE_REST"

    issue_killer_config_parse_value "$rest" || {
      printf '%s: malformed value for %s\n' \
        "$RUNNER_NAME" "${current_section:-top}.${key}" >&2
      exec 3<&-
      return 1
    }

    if [[ -z "$current_section" ]]; then
      issue_killer_config_record_field "top" "$key" \
        "$ISSUE_KILLER_CONFIG_PARSE_VALUE" || {
        exec 3<&-
        return 1
      }
    else
      issue_killer_config_record_field "$current_section" "$key" \
        "$ISSUE_KILLER_CONFIG_PARSE_VALUE" || {
        exec 3<&-
        return 1
      }
    fi
  done
  exec 3<&-

  # Each profile must declare cli, command, and model.
  local profile
  for profile in $(issue_killer_config_profile_names); do
    for required in cli command model; do
      if ! grep -Eq "^profiles\\.${profile}\\.${required}=" "$tmp_state"; then
        printf '%s: profile %s missing required field: %s\n' \
          "$RUNNER_NAME" "$profile" "$required" >&2
        return 1
      fi
    done
  done

  # Fallback declarations form a validated OpenCode-only graph. Validate
  # every profile at load time so interactive and non-interactive launches
  # fail before the tracker, repository, or worker can be mutated.
  issue_killer_config_validate_fallbacks || return 1
}
