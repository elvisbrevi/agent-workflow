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
#   auto_approve           - "true" to pass --auto
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

# Classifies only explicit provider failures that are eligible for an
# OpenCode fallback. The orchestrator handles status markers first, so a
# worker-reported BLOCKED or FAILED outcome can never be reclassified here.
# Returns quota, rate_limit, model_unavailable, or none.
opencode_runtime_classify_provider_failure() {
  local output_file="$1"

  [[ -r "$output_file" ]] || {
    printf 'none\n'
    return 0
  }

  if grep -Eqi -- \
    'insufficient[_ -]?quota|(quota|credits?|usage allowance).*(exhaust|exceed|deplet|used up|limit reached)|(subscription|billing plan).*(exhaust|expired|inactive|quota|credits?|usage allowance)' \
    "$output_file" 2>/dev/null; then
    printf 'quota\n'
  elif grep -Eqi -- \
    '(^|[^0-9])429([^0-9]|$)|rate[ _-]?limit|too many requests' \
    "$output_file" 2>/dev/null; then
    printf 'rate_limit\n'
  elif grep -Eqi -- \
    '(subscription|billing plan).*(limit.*reached|allowance.*used)' \
    "$output_file" 2>/dev/null; then
    printf 'quota\n'
  elif grep -Eqi -- \
    'model.*(unavailable|not available|not found|does not exist|unsupported)|(unavailable|not available).*model' \
    "$output_file" 2>/dev/null; then
    printf 'model_unavailable\n'
  else
    printf 'none\n'
  fi
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
    printf '%s\n' "--auto"
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
opencode_runtime_emit_json() {
  local category="$1" raw_line="$2" status
  status="$(jq -r '[paths(scalars) as $p | getpath($p) | strings | (try capture("ISSUE_KILLER_STATUS=(?<s>[A-Z_]+)").s catch empty)] | first // empty' <<<"$raw_line")"
  jq -cn --arg category "$category" --arg cli "opencode" --arg iteration "${ITERATION:-0}" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg status "$status" --argjson event "$raw_line" \
    '{category:$category,cli:$cli,iteration:($iteration|tonumber),timestamp:$timestamp,event:$event} + (if $status != "" then {status:$status} else {} end)'
}

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
      step_start|step_finish)
        decoded="$(opencode_runtime_decode_event "$raw_line" "$output_file" || true)"
        if [[ -n "$decoded" ]]; then
          tag="${decoded%%$'\t'*}"
          detail="${decoded#*$'\t'*}"
          case "$tag" in
            inspect|tracker) opencode_runtime_emit_json "Inspecting issue tracker" "$raw_line" ;;
            plan|mutate) opencode_runtime_emit_json "Planning the next worker step" "$raw_line" ;;
            shell|test) opencode_runtime_emit_json "Running shell command" "$raw_line" ;;
            push) opencode_runtime_emit_json "Pushing branch" "$raw_line" ;;
            commit) opencode_runtime_emit_json "Committing changes" "$raw_line" ;;
            merge_rebase) opencode_runtime_emit_json "Merging or rebasing branch" "$raw_line" ;;
            pr_create) opencode_runtime_emit_json "Creating pull request" "$raw_line" ;;
            pr_close) opencode_runtime_emit_json "Merging or closing pull request" "$raw_line" ;;
            close) opencode_runtime_emit_json "Closing issue" "$raw_line" ;;
            review) opencode_runtime_emit_json "Reviewing changes" "$raw_line" ;;
          esac
          opencode_runtime_dispatch_event "$tag" "$detail" "$output_file" >/dev/null
        fi
        : > "$touch_file"
        ;;
      text)
        # Text events are the complete final OpenCode worker event. Decode them
        # only for internal issue-identification side effects; exposing the
        # decoder's generic `plan` tag here would duplicate the provider event
        # and put a non-final category immediately before `Worker finished`.
        decoded="$(opencode_runtime_decode_event "$raw_line" "$output_file" || true)"
        if [[ -n "$decoded" ]]; then
          tag="${decoded%%$'\t'*}"
          detail="${decoded#*$'\t'*}"
          opencode_runtime_dispatch_event "$tag" "$detail" "$output_file" >/dev/null
        fi
        # Surface the assistant's final text so existing status-marker
        # extraction (sed -n s/^PREFIX/p) still finds the line.
        agent_text="$(opencode_runtime_event_field 'part.text' "$raw_line")"
        if [[ -n "$agent_text" && "$agent_text" != "null" ]]; then
          printf '%s\n' "$agent_text" >> "$output_file"
          opencode_runtime_emit_json "Worker finished" "$raw_line"
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
runtime_redact()          { opencode_runtime_redact; }
runtime_validate_profile() { opencode_runtime_validate_profile "$@"; }
runtime_invoke()          { opencode_runtime_invoke "$@"; }
runtime_render_stream()   { opencode_runtime_render_stream "$@"; }
runtime_classify_provider_failure() { opencode_runtime_classify_provider_failure "$@"; }

# Resolve the on-disk path of an OpenCode session's transcript.
# OpenCode does not currently expose a stable transcript layout that
# the runner can predict; this function returns the empty path so any
# later cleanup operation has a single, no-op target. The companion
# `opencode_runtime_session_exists` answers truthfully to keep today's
# observable behaviour: OpenCode resumes a captured session when its
# own store has the conversation, and the CLI's "session id ... not
# found" message routes through the unresumable_session classification.
opencode_runtime_session_transcript_path() {
  printf ''
  return 1
}

# OpenCode resumes a captured session through its own CLI; the runner
# defers to that answer rather than guessing. Returning 0 here keeps
# today's behaviour: when the captured session id is non-empty and
# the branch/base guards pass, the orchestrator passes --resume to
# the CLI. A CLI rejection still surfaces as unresumable_session and
# triggers the same fresh-worker degradation as for Claude.
opencode_runtime_session_exists() {
  return 0
}

# Generic session-existence contract. Adapters that can answer the
# question for their own store implement `runtime_session_exists`; the
# orchestrator calls this name without knowing the CLI.
runtime_session_transcript_path() { opencode_runtime_session_transcript_path "$@"; }
runtime_session_exists()          { opencode_runtime_session_exists "$@"; }

# OpenCode does not expose a stable transcript layout the runner can
# predict, so there is nothing to remove. Returning 0 preserves
# today's behaviour: non-Claude profiles that have no transcript path
# to clean up never report a removal failure, and the orchestrator's
# verified-completion path stays a no-op for this adapter.
opencode_runtime_remove_session_transcript() {
  return 0
}

# Generic session-cleanup contract. Adapters that resolve to a
# transcript path delete it; adapters whose transcript layout the
# runner cannot predict (Codex, OpenCode today) report success without
# touching any file.
runtime_remove_session_transcript() { opencode_runtime_remove_session_transcript "$@"; }

# Echo empty output when sourced directly so the orchestrator's `source`
# always succeeds. The orchestrator depends on this file having no side
# effects at source time.
:
