#!/usr/bin/env bash
# Runtime adapter for the OpenCode CLI.
#
# This file owns every OpenCode-specific concern of the worker runtime:
#   - profile field validation (provider/model, variant, autonomy)
#   - non-interactive `opencode run --format json` invocation construction
#   - OpenCode JSON event decoding into normalized lifecycle events
#   - session identity capture and resume
#   - command-output secret redaction
#
# The orchestrator and tracker adapter consume only the generic
# `runtime_*` interface declared at the bottom of this file. The
# `opencode_runtime_*` definitions above are the authoritative
# implementation; the orchestrator never reaches inside OpenCode-specific
# logic. Sibling adapters (Claude, Codex) expose the same generic
# interface so the supervisor remains CLI-agnostic.
#
# Required inputs from the orchestrator (defined before this file is
# sourced):
#   RUNNER_NAME                       - display name printed in progress lines
#   ITERATION                         - worker iteration counter
#   STREAM_OUTPUT                     - "true" to use JSON stream, "false" for plain
#   ISSUE_KILLER_PROFILE_COMMAND      - executable or shell-function name
#   ISSUE_KILLER_PROFILE_MODEL        - provider/model identifier
#   ISSUE_KILLER_PROFILE_SHELL        - shell used to load the function
#   ISSUE_KILLER_PROFILE_INIT_FILE    - rc file consulted when the command is a function
#   ISSUE_KILLER_PROFILE_OPTIONS      - newline-separated `key=value` adapter options
#
# Adapter-specific options consumed here (validated strictly):
#   variant                - "low" | "medium" | "high" (or unset)
#   auto_approve           - "true" to pass --auto-approve
#
# Orchestrator-provided callbacks invoked while decoding events:
#   record_identified_issue <issue_number> <output_file>
#   advance_checkpoint_state <next_state> <output_file>
#   write_checkpoint <state>
#   write_lock_status <state> <elapsed>
#
# Required side-channel files for cross-subshell state:
#   <output_file>.issue      - last identified issue number
#   <output_file>.session    - captured OpenCode session id
#   <output_file>.touch      - heartbeat suppression flag while events flow

# Returns 0 (success) when the input line is a JSON object. The
# orchestrator is intentionally kept out of the JSON event shape; this
# helper is the only place that knows the envelope.
opencode_runtime_is_event_object() {
  jq -e 'type == "object"' >/dev/null 2>&1 <<<"$1"
}

# Extracts a dotted field path from an OpenCode JSON event. Returns the
# empty string when the path is absent. Kept private to the adapter so
# the orchestrator never imports jq and stays portable across adapters.
opencode_runtime_event_field() {
  local field="$1"
  local line="$2"
  jq -r --arg f "$field" 'try (getpath($f | split(".")) // empty) catch empty' 2>/dev/null <<<"$line"
}

# Redact common credential shapes from arbitrary assistant text. The
# redactor is pure string substitution so the orchestration layer can
# apply it to any captured text without re-entering the adapter. The
# patterns are shared with the Claude and Codex adapters; all adapters
# must reject the same shapes so the operator view is consistent
# across providers.
opencode_runtime_redact() {
  sed -E \
    -e 's/[Aa]uthorization([[:space:][:punct:]]+[A-Za-z0-9._~+/-]+)+/<redacted:authorization>/g' \
    -e 's/[Bb]earer[[:space:][:punct:]]+[A-Za-z0-9._~+/-]{6,}/<redacted:bearer>/g' \
    -e "s/(api[_-]?key|secret|password|access[_-]?token|auth[_-]?token)['\"[:space:]]*[:=]['\"[:space:]]*[A-Za-z0-9._~+/-]+/\1=<redacted>/gI" \
    -e 's/(ghp_[A-Za-z0-9]+|ghs_[A-Za-z0-9]+|gho_[A-Za-z0-9]+|ghu_[A-Za-z0-9]+|ghr_[A-Za-z0-9]+)/<redacted:credential>/g' \
    -e 's/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/<redacted:private-key>/g'
}

# Validates the OpenCode provider/model identifier. OpenCode expects
# a `<provider>/<model>` string (for example `openai/gpt-5-luna`).
# Bare model names without a provider prefix are not portable across
# providers and the adapter fails closed when the format is wrong.
opencode_runtime_validate_model() {
  local model="${1:-}"
  if [[ -z "$model" ]]; then
    printf '%s: opencode profile is missing a model identifier\n' \
      "$RUNNER_NAME" >&2
    return 1
  fi
  case "$model" in
    */*)
      local provider="${model%%/*}"
      local rest="${model#*/}"
      [[ -n "$provider" && "$provider" != "$model" ]] || {
        printf '%s: opencode profile has invalid model: %s\n' \
          "$RUNNER_NAME" "$model" >&2
        return 1
      }
      [[ -n "$rest" && "$rest" != "$model" ]] || {
        printf '%s: opencode profile has invalid model: %s\n' \
          "$RUNNER_NAME" "$model" >&2
        return 1
      }
      case "$provider" in
        *[!A-Za-z0-9._-]*)
          printf '%s: opencode profile has invalid model provider: %s\n' \
            "$RUNNER_NAME" "$provider" >&2
          return 1
          ;;
      esac
      ;;
    *)
      printf '%s: opencode profile has invalid model: %s\n' \
        "$RUNNER_NAME" "$model" >&2
      return 1
      ;;
  esac
}

# Strictly validates the OpenCode profile fields captured in
# ISSUE_KILLER_PROFILE_OPTIONS. Returns 0 on success and prints an
# actionable diagnostic on failure. The orchestrator calls this before
# launching any worker; unknown or malformed options fail closed so a
# misspelled safety setting is never silently ignored.
opencode_runtime_validate_profile() {
  local options="$1"
  local line key value

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      variant)
        case "$value" in
          low|medium|high) ;;
          *)
            printf '%s: opencode profile has invalid variant: %s\n' \
              "$RUNNER_NAME" "$value" >&2
            return 1
            ;;
        esac
        ;;
      auto_approve)
        case "$value" in
          true|false) ;;
          *)
            printf '%s: opencode profile has invalid auto_approve: %s\n' \
              "$RUNNER_NAME" "$value" >&2
            return 1
            ;;
        esac
        ;;
      *)
        printf '%s: opencode profile has unknown option: %s\n' \
          "$RUNNER_NAME" "$key" >&2
        return 1
        ;;
    esac
  done <<<"$options"

  opencode_runtime_validate_model "${ISSUE_KILLER_PROFILE_MODEL:-}" || return 1

  return 0
}

# Decodes an OpenCode JSON event into a normalized event tag and
# detail. The orchestrator dispatches the tag to checkpoint/progress
# helpers. Output is a single line of the form `<tag>\t<detail>`; the
# orchestrator splits it on the tab. OpenCode event types map onto the
# same normalized tags the Claude and Codex adapters use so the
# operator view is uniform across providers.
opencode_runtime_decode_event() {
  local raw_line="$1"
  local output_file="${2:-}"

  local event_type
  event_type="$(opencode_runtime_event_field 'type' "$raw_line")"
  case "$event_type" in
    step_start|step_finish)
      local tool_name tool_input
      tool_name="$(opencode_runtime_event_field 'part.tool' "$raw_line")"
      tool_input="$(opencode_runtime_event_field 'part.input' "$raw_line")"
      case "$tool_name" in
        read|glob|grep|list|webfetch|websearch|ls)
          printf 'inspect\t\n'
          ;;
        edit|write|patch|multiedit)
          local file_path
          file_path="$(opencode_runtime_event_field 'filePath' "$tool_input")"
          if [[ -z "$file_path" || "$file_path" == "null" ]]; then
            file_path="$(opencode_runtime_event_field 'path' "$tool_input")"
          fi
          if [[ -n "$file_path" && "$file_path" != "null" ]]; then
            printf 'mutate\t%s\n' "$file_path"
          else
            printf 'mutate\tfiles\n'
          fi
          ;;
        bash|shell)
          local cmd
          cmd="$(opencode_runtime_event_field 'command' "$tool_input")"
          opencode_runtime_decode_command "$cmd"
          ;;
        todowrite|todo)
          printf 'plan\t\n'
          ;;
        *)
          printf 'unknown_tool\t%s\n' "${tool_name:-unknown}"
          ;;
      esac
      ;;
    text)
      # OpenCode emits the final assistant text through `text` events
      # that may carry the status marker. Recognize a bare issue
      # number anywhere in the text and emit an `identify` event so
      # the orchestrator records it before the worker mutates the
      # repository.
      local text issue_number
      text="$(opencode_runtime_event_field 'part.text' "$raw_line")"
      if [[ -n "$text" && "$text" != "null" ]]; then
        issue_number="$(printf '%s\n' "$text" | sed -nE 's/.*[^0-9]([0-9]+)[^0-9]*$/\1/p' | head -n 1)"
        if [[ -n "$issue_number" ]]; then
          printf 'identify\t%s\n' "$issue_number"
        else
          printf 'plan\t\n'
        fi
      fi
      ;;
    session)
      # Session identity is captured through the dedicated helper; the
      # orchestrator reads the session id from the side-channel file
      # rather than dispatching a normalized event here. Surface a
      # generic `plan` event so progress output reflects that the
      # worker has begun its session.
      printf 'plan\t\n'
      ;;
    *)
      return 0
      ;;
  esac
}

# Translate an OpenCode shell command into a normalized event. The
# orchestrator never pattern-matches shell strings; this helper is the
# only place that knows what shell commands correspond to inspect,
# push, PR, and close events. Mirrors `claude_runtime_decode_bash` and
# `codex_runtime_decode_command` so the operator sees the same
# lifecycle regardless of provider.
opencode_runtime_decode_command() {
  local cmd="$1"

  if [[ -z "$cmd" || "$cmd" == "null" ]]; then
    printf 'shell\t\n'
    return
  fi

  if tracker_runtime_decode_command "$cmd"; then
    return 0
  fi

  case "$cmd" in
    "git push"*)
      printf 'push\t\n'
      ;;
    "git commit"*)
      printf 'commit\t\n'
      ;;
    "git merge"*|"git rebase"*)
      printf 'merge_rebase\t\n'
      ;;
    *code-review*|*"/code-review"*)
      printf 'review\t\n'
      ;;
    *npm*test*|*bats*|*pytest*|*cargo*test*|*swift*test*|*jest*|*mocha*|*bash*tests/*|*"go test"*)
      printf 'test\t\n'
      ;;
    *)
      printf 'shell\t\n'
      ;;
  esac
}

# Capture the OpenCode session id from a `session` event. The id is
# written to <output_file>.session so the orchestrator can resume the
# same session on the next retry or restart without re-deriving it from
# the stream. OpenCode is expected to emit a `session` event at the
# beginning of every run; the orchestrator treats its presence as the
# authoritative "session is resumable" signal.
opencode_runtime_capture_session() {
  local raw_line="$1"
  local session_file="$2"

  [[ "$(opencode_runtime_event_field 'type' "$raw_line")" == "session" ]] || return 0

  local sid
  sid="$(jq -r '.sessionID // ""' 2>/dev/null <<<"$raw_line")"
  if [[ -n "$sid" && "$sid" != "null" ]]; then
    printf '%s' "$sid" > "$session_file"
  fi
}

# Dispatch a normalized event into the orchestrator's
# checkpoint/progress callbacks. The orchestrator provides these
# callbacks; the adapter calls them without knowing their internals.
# Adding a new normalized event tag only requires adding a case here.
opencode_runtime_dispatch_event() {
  local tag="$1"
  local detail="$2"
  local output_file="$3"

  case "$tag" in
    inspect)
      printf '[%s] Inspecting repository or tracker state\n' "$RUNNER_NAME"
      ;;
    mutate)
      advance_checkpoint_state "mutating" "$output_file"
      printf '[%s] Editing %s\n' "$RUNNER_NAME" "${detail:-files}"
      ;;
    test)
      advance_checkpoint_state "mutating" "$output_file"
      printf '[%s] Running tests or verification\n' "$RUNNER_NAME"
      ;;
    push)
      advance_checkpoint_state "branch_pushed" "$output_file"
      printf '[%s] Pushing branch\n' "$RUNNER_NAME"
      ;;
    commit)
      advance_checkpoint_state "mutating" "$output_file"
      printf '[%s] Committing changes\n' "$RUNNER_NAME"
      ;;
    merge_rebase)
      printf '[%s] Merging or rebasing branch\n' "$RUNNER_NAME"
      ;;
    pr_create)
      advance_checkpoint_state "pr_created" "$output_file"
      printf '[%s] Creating pull request\n' "$RUNNER_NAME"
      ;;
    pr_close)
      advance_checkpoint_state "pr_merged" "$output_file"
      printf '[%s] Merging or closing pull request\n' "$RUNNER_NAME"
      ;;
    close)
      advance_checkpoint_state "issue_closed" "$output_file"
      printf '[%s] Closing issue\n' "$RUNNER_NAME"
      ;;
    review)
      printf '[%s] Reviewing changes\n' "$RUNNER_NAME"
      ;;
    plan)
      printf '[%s] Planning the next worker step\n' "$RUNNER_NAME"
      ;;
    identify)
      record_identified_issue "$detail" "$output_file"
      ;;
    tracker)
      printf '[%s] Inspecting issue tracker\n' "$RUNNER_NAME"
      ;;
    shell)
      printf '[%s] Running shell command\n' "$RUNNER_NAME"
      ;;
    unknown_tool)
      printf '[%s] Worker tool: %s\n' "$RUNNER_NAME" "$detail"
      ;;
  esac
}

# Build the argument list that `opencode run` will be invoked with.
# The orchestrator uses this both to launch the worker and to assert
# expected flags in tests; tests must not depend on the orchestrator's
# internal invocation logic.
#
# Outputs one argument per line. The prompt is intentionally excluded
# from this list because prompts may contain newlines; the
# orchestrator appends the prompt verbatim as a single array element.
opencode_runtime_invoke_args() {
  local session_id="${1:-}"
  local line key value variant="" auto_approve=""

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      variant) variant="$value" ;;
      auto_approve) auto_approve="$value" ;;
    esac
  done <<<"${ISSUE_KILLER_PROFILE_OPTIONS:-}"

  printf '%s\n' "run"
  printf '%s\n' "--format"
  printf '%s\n' "json"
  printf '%s\n' "--model"
  printf '%s\n' "$ISSUE_KILLER_PROFILE_MODEL"

  if [[ -n "$variant" ]]; then
    printf '%s\n' "--variant"
    printf '%s\n' "$variant"
  fi

  if [[ "$auto_approve" == "true" ]]; then
    printf '%s\n' "--auto-approve"
  fi

  if [[ -n "$session_id" ]]; then
    printf '%s\n' "--session"
    printf '%s\n' "$session_id"
  fi
}

# Resolve the worker invocation. Two paths are supported, mirroring the
# Claude and Codex adapters: the command is either an executable on
# PATH or a shell function loaded through the optional init file. The
# active path is chosen at runtime to preserve the previous launcher
# behavior; the orchestrator must not assume either form.
#
# The prompt is appended as the final array element so embedded
# newlines remain part of a single argument. Carrying the prompt
# through a line-based tokenizer would split it across multiple
# positional args and leak the prompt into the wrong argv slot for the
# worker.
opencode_runtime_invoke() {
  local prompt="$1"
  local session_id="${2:-}"
  local -a args
  local arg

  while IFS= read -r arg || [[ -n "$arg" ]]; do
    args+=("$arg")
  done < <(opencode_runtime_invoke_args "$session_id")
  args+=("$prompt")

  if command -v "$ISSUE_KILLER_PROFILE_COMMAND" >/dev/null 2>&1; then
    "$ISSUE_KILLER_PROFILE_COMMAND" "${args[@]}"
    return
  fi

  [[ -r "$ISSUE_KILLER_PROFILE_INIT_FILE" ]] || \
    die "shell command not found and init file is not readable: ${ISSUE_KILLER_PROFILE_INIT_FILE:-unset}"

  local shell_cmd="${ISSUE_KILLER_PROFILE_SHELL:-bash}"
  command -v "$shell_cmd" >/dev/null 2>&1 || \
    die "shell not found: ${shell_cmd}"

  "$shell_cmd" --noprofile --norc -c '
    runner_command="$1"
    runner_rc_file="$2"
    shift 2
    source "$runner_rc_file"
    "$runner_command" "$@"
  ' "$RUNNER_NAME" "$ISSUE_KILLER_PROFILE_COMMAND" "$ISSUE_KILLER_PROFILE_INIT_FILE" "${args[@]}"
}

# Drain the worker stdout into the orchestrator's pipeline. This is
# the only place that knows the OpenCode JSON event shape; the
# orchestrator consumes what we write to stdout and the side-channel
# files. Persists raw lines to OUTPUT_FILE so the orchestrator's
# status-marker extraction continues to work unchanged.
opencode_runtime_render_stream() {
  local output_file="$1"
  local touch_file="${output_file}.touch"
  local session_file="${output_file}.session"
  local raw_line decoded tag detail agent_text

  : > "$session_file"

  while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    [[ -z "$raw_line" ]] && continue

    # Persist the raw line so status extraction continues to work.
    printf '%s\n' "$raw_line" >> "$output_file"

    if ! opencode_runtime_is_event_object "$raw_line"; then
      printf '%s\n' "$raw_line"
      continue
    fi

    case "$(opencode_runtime_event_field 'type' "$raw_line")" in
      session)
        opencode_runtime_capture_session "$raw_line" "$session_file"
        : > "$touch_file"
        ;;
      step_start|step_finish|text)
        decoded="$(opencode_runtime_decode_event "$raw_line" "$output_file" || true)"
        if [[ -n "$decoded" ]]; then
          tag="${decoded%%$'\t'*}"
          detail="${decoded#*$'\t'*}"
          opencode_runtime_dispatch_event "$tag" "$detail" "$output_file"
        fi
        # Surface the assistant's final text so existing
        # status-marker extraction (sed -n s/^PREFIX/p) still finds
        # the line. OpenCode typically includes the agent's reply in
        # the `part.text` field of the `text` event.
        agent_text="$(opencode_runtime_event_field 'part.text' "$raw_line")"
        if [[ -n "$agent_text" && "$agent_text" != "null" ]]; then
          printf '%s\n' "$agent_text" >> "$output_file"
          printf '[%s] Worker finished (see %s for full output)\n' \
            "$RUNNER_NAME" "$output_file"
        fi
        : > "$touch_file"
        ;;
    esac
  done
}

# Generic `runtime_*` interface. The orchestrator calls only these
# names so it never imports OpenCode-specific concerns. Each alias is a
# thin forwarder to the OpenCode-specific implementation above; the
# alias layer exists so a future adapter can be selected by sourcing a
# sibling file without touching the orchestrator.
runtime_is_event_object() { opencode_runtime_is_event_object "$@"; }
runtime_event_field()     { opencode_runtime_event_field "$@"; }
runtime_redact()          { opencode_runtime_redact; }
runtime_decode_event()    { opencode_runtime_decode_event "$@"; }
runtime_capture_session() { opencode_runtime_capture_session "$@"; }
runtime_dispatch_event()  { opencode_runtime_dispatch_event "$@"; }
runtime_invoke_args()     { opencode_runtime_invoke_args "$@"; }
runtime_invoke()          { opencode_runtime_invoke "$@"; }
runtime_render_stream()   { opencode_runtime_render_stream "$@"; }

# Echo empty output when sourced directly so the orchestrator's `source`
# always succeeds. The orchestrator depends on this file having no side
# effects at source time.
:
