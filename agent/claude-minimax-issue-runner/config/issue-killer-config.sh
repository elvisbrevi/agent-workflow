#!/usr/bin/env bash
# issue-killer TOML configuration loader and validator.
#
# Reads the personal configuration file (default
# `${HOME}/.config/issue-killer/config.toml`, override with `--config`),
# strictly validates every supported field, and writes the parsed
# state into a temporary file consumed by the orchestrator. The state
# file is a flat `key=value` list mirroring only the TOML subset the
# runner needs; the parser fails closed on malformed input, unknown
# keys, or unknown sections.
#
# Supported TOML subset:
#   default_profile = "<name>"
#   [profiles.<name>]
#     label = "..."
#     cli = "claude" | "codex" | "opencode"
#     command = "..."
#     model = "..."
#     shell = "..."        # optional, enables shell-function launch
#     init_file = "..."    # optional, required when shell is set
#     fallbacks = ["..."]  # optional, OpenCode profiles only
#   [profiles.<name>.options]
#     permission_mode = "..."     # Claude
#     reasoning_effort = "..."    # Codex
#     sandbox = "..."             # Codex
#     variant = "..."             # OpenCode
#     auto_approve = true|false   # OpenCode
#
# Credentials, free-form commands, and `eval` are forbidden; every
# option that reaches the worker is enumerated above. The loader does
# not call worker code and emits no side effects beyond the temporary
# state file.

# Populated by `issue_killer_config_load`. The orchestrator reads
# these names after a successful load; nothing else exports them.
# These declarations only initialize when the variables are not
# already set (for example, by an orchestrator-provided value) so
# sourcing this file does not clobber caller state.
: "${ISSUE_KILLER_CONFIG_PATH:=}"
: "${ISSUE_KILLER_CONFIG_STATE_FILE:=}"
: "${ISSUE_KILLER_PROFILE_NAME:=}"
: "${ISSUE_KILLER_PROFILE_LABEL:=}"
: "${ISSUE_KILLER_PROFILE_CLI:=}"
: "${ISSUE_KILLER_PROFILE_COMMAND:=}"
: "${ISSUE_KILLER_PROFILE_MODEL:=}"
: "${ISSUE_KILLER_PROFILE_SHELL:=}"
: "${ISSUE_KILLER_PROFILE_INIT_FILE:=}"
: "${ISSUE_KILLER_PROFILE_OPTIONS:=}"
: "${ISSUE_KILLER_PROFILE_FALLBACKS:=}"

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
issue_killer_config_decode_basic() {
  local raw="$1"
  local out="" index=0 char

  while (( index < ${#raw} )); do
    char="${raw:index:1}"
    if [[ "$char" == "\\" ]]; then
      index=$((index + 1))
      if (( index >= ${#raw} )); then
        out+='\\'
        break
      fi
      char="${raw:index:1}"
      case "$char" in
        '"') out+='"' ;;
        '\\') out+='\\' ;;
        'n') out+=$'\n' ;;
        't') out+=$'\t' ;;
        'r') out+=$'\r' ;;
        'b') out+=$'\b' ;;
        'f') out+=$'\f' ;;
        'u')
          if (( index + 4 < ${#raw} )); then
            local hex="${raw:index+1:4}"
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
    else
      out+="$char"
    fi
    index=$((index + 1))
  done

  printf '%s' "$out"
}

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
# Hyphens are allowed because profile names such as `claude-minimax`
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
        permission_mode|reasoning_effort|sandbox|variant|auto_approve)
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
# `issue_killer_config_prompt_profile` so the same library can be
# reused for the non-TTY default and the TTY prompt.
issue_killer_config_load() {
  local path="$1"
  local tmp_state=""
  local line cleaned current_section="" current_profile=""
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
                current_profile="$profile"
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
                current_profile="$rest_header"
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

# Validates all declared fallback chains before profile selection. Sources and
# targets must be OpenCode profiles, references must exist, entries must be
# unique within each ordered chain, and the complete graph must be acyclic.
issue_killer_config_validate_fallbacks() {
  local profile cli fallback fallback_cli seen

  while IFS= read -r profile; do
    [[ -n "$profile" ]] || continue
    seen=""
    cli="$(issue_killer_config_lookup "profiles.${profile}.cli")"
    while IFS= read -r fallback; do
      [[ -n "$fallback" ]] || continue
      if [[ "$cli" != "opencode" ]]; then
        printf '%s: profile %s declares fallbacks but its cli is %s, not opencode\n' \
          "$RUNNER_NAME" "$profile" "${cli:-unset}" >&2
        return 1
      fi
      if ! issue_killer_config_profile_exists "$fallback"; then
        printf '%s: fallback profile %s is not configured\n' \
          "$RUNNER_NAME" "$fallback" >&2
        return 1
      fi
      fallback_cli="$(issue_killer_config_lookup "profiles.${fallback}.cli")"
      if [[ "$fallback_cli" != "opencode" ]]; then
        printf '%s: fallback profile %s uses cli %s; fallbacks must use opencode\n' \
          "$RUNNER_NAME" "$fallback" "${fallback_cli:-unset}" >&2
        return 1
      fi
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

# Renders the TTY profile selector. Lists every profile as
# `<index>) <label>  cli=<cli> model=<model>` (and includes the
# effort/variant/permission option when one is set), then waits for
# an operator selection. The supplied default index (1-based) is
# used as the initial selection; pressing Enter accepts it.
#
# The caller is responsible for verifying a TTY is available. Echoes
# the chosen profile name on stdout.
issue_killer_config_prompt_profile() {
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

  printf 'Select an execution profile:\n' >/dev/tty
  index=0
  while [[ $index -lt ${#names[@]} ]]; do
    printf '  %d) %s  cli=%s model=%s%s\n' \
      $((index + 1)) "${labels[$index]}" "${clis[$index]}" \
      "${models[$index]}" "${variants[$index]:+ ${variants[$index]}}" \
      >/dev/tty
    if [[ "${names[$index]}" == "$default_name" ]]; then
      default_index=$((index + 1))
    fi
    index=$((index + 1))
  done
  printf 'Edit %s to add or change profiles.\n' \
    "$ISSUE_KILLER_CONFIG_PATH" >/dev/tty
  if [[ -n "$default_index" ]]; then
    printf 'Profile [%d]: ' "$default_index" >/dev/tty
  else
    printf 'Profile: ' >/dev/tty
  fi
  IFS= read -r answer </dev/tty || {
    printf '%s: unable to read profile selection from /dev/tty\n' \
      "$RUNNER_NAME" >&2
    return 1
  }
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

# Builds an ordered fallback chain after an interactive OpenCode profile
# selection. Only unused OpenCode profiles are offered; selecting `None`
# finishes the chain. Echoes the chosen profile names one per line.
issue_killer_config_prompt_fallbacks() {
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

    printf 'Select the next OpenCode fallback profile:\n' >/dev/tty
    printf '  0) None\n' >/dev/tty
    index=0
    while [[ $index -lt ${#names[@]} ]]; do
      printf '  %d) %s  cli=opencode model=%s\n' \
        $((index + 1)) "${labels[$index]}" "${models[$index]}" >/dev/tty
      index=$((index + 1))
    done
    printf 'Fallback [0]: ' >/dev/tty
    IFS= read -r answer </dev/tty || {
      printf '%s: unable to read fallback selection from /dev/tty\n' \
        "$RUNNER_NAME" >&2
      return 1
    }
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

# Cleans up the temporary state file produced by the loader. Safe to
# invoke unconditionally; missing files are ignored.
issue_killer_config_cleanup() {
  local state_file="${ISSUE_KILLER_CONFIG_STATE_FILE:-}"
  [[ -n "$state_file" && -e "$state_file" ]] && rm -f "$state_file"
  ISSUE_KILLER_CONFIG_STATE_FILE=""
}

# Returns 0 when the named command is reachable on PATH. The runner
# uses this helper to choose between the executable and shell-function
# launch paths without leaking the choice into the orchestrator.
issue_killer_command_on_path() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1
}

# Echo empty output when sourced directly so the orchestrator's
# `source` always succeeds. The orchestrator depends on this file
# having no side effects at source time.
:
