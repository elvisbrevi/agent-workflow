#!/usr/bin/env bash
# Runtime adapter for the Claude agent CLI.
#
# This file owns every Claude-specific concern of the worker runtime:
#   - non-interactive invocation construction
#   - Claude stream-json event decoding
#   - normalized lifecycle event translation
#   - session identity capture and resume
#   - command-output secret redaction
#   - failure classification for retry/fallback decisions
#
# The orchestration layer (run.sh) must not parse Claude stream JSON or
# construct the configured command directly. It calls the named
# functions below to operate the worker uniformly regardless of the
# underlying CLI. The orchestrator consumes the `runtime_*` aliases
# declared at the bottom of this file; the `claude_runtime_*` names
# remain for backwards compatibility with existing test fixtures and
# third-party callers. Sibling adapters (Codex, OpenCode) expose the
# same `runtime_*` surface so the orchestrator never branches on the
# selected CLI.
#
# Required inputs from the orchestrator (defined before this file is
# sourced):
#   RUNNER_NAME              - display name printed in progress lines
#   ITERATION                - worker iteration counter
#   PERMISSION_MODE          - Claude permission mode (e.g. bypassPermissions)
#   STREAM_OUTPUT            - "true" to use stream-json, "false" for plain
#   CLAUDE_COMMAND           - executable or shell-function name
#   CLAUDE_SHELL             - shell used to load the function
#   CLAUDE_RC_FILE           - rc file consulted when the command is a function
#
# Orchestrator-provided callbacks invoked while decoding events:
#   record_identified_issue <issue_number> <output_file>
#   advance_checkpoint_state <next_state> <output_file>
#   write_checkpoint <state>
#   write_lock_status <state> <elapsed>
#
# Required side-channel files for cross-subshell state:
#   <output_file>.issue      - last identified issue number
#   <output_file>.session    - captured Claude session id
#   <output_file>.touch      - heartbeat suppression flag while events flow
#
# The orchestrator consumes normalized events by reading the output file
# for the generic ISSUE_KILLER_STATUS line and the .issue / .session
# side-channel files for cross-subshell state.

# Returns 0 (success) when the input line is a JSON object. The orchestrator
# is intentionally kept out of the Claude stream shape; this helper is the
# only place that knows the JSON envelope.
claude_runtime_is_event_object() {
  jq -e 'type == "object"' >/dev/null 2>&1 <<<"$1"
}

# Extracts a dotted field path from a Claude stream-json event. Returns the
# empty string when the path is absent. Kept private to the adapter so the
# orchestrator never imports jq and stays portable across adapters.
claude_runtime_event_field() {
  local field="$1"
  local line="$2"
  jq -r --arg f "$field" 'try (getpath($f | split(".")) // empty) catch empty' 2>/dev/null <<<"$line"
}

# Redact common credential shapes from arbitrary assistant text. The redactor
# is pure string substitution so the orchestration layer can apply it to
# any captured text without re-entering the adapter.
claude_runtime_redact() {
  sed -E \
    -e 's/[Aa]uthorization([[:space:][:punct:]]+[A-Za-z0-9._~+/-]+)+/<redacted:authorization>/g' \
    -e 's/[Bb]earer[[:space:][:punct:]]+[A-Za-z0-9._~+/-]{6,}/<redacted:bearer>/g' \
    -e "s/(api[_-]?key|secret|password|access[_-]?token|auth[_-]?token)['\"[:space:]]*[:=]['\"[:space:]]*[A-Za-z0-9._~+/-]+/\1=<redacted>/gI" \
    -e 's/(ghp_[A-Za-z0-9]+|ghs_[A-Za-z0-9]+|gho_[A-Za-z0-9]+|ghu_[A-Za-z0-9]+|ghr_[A-Za-z0-9]+)/<redacted:credential>/g' \
    -e 's/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/<redacted:private-key>/g'
}

# Decodes a Claude assistant event into a normalized event tag and
# detail. The orchestrator dispatches the tag to checkpoint/progress
# helpers. The expected tag set is documented at the top of this file.
# Output is a single line of the form `<tag>\t<detail>`; the orchestrator
# splits it on the tab.
claude_runtime_decode_event() {
  local raw_line="$1"
  local output_file="${2:-}"

  [[ "$(claude_runtime_event_field 'type' "$raw_line")" == "assistant" ]] || return 0

  local tool_block tool_name tool_input
  tool_block="$(
    jq -c 'try (.message.content[] | select(.type=="tool_use")) catch empty' \
      2>/dev/null <<<"$raw_line" | head -n 1
  )"
  [[ -z "$tool_block" ]] && return 0
  tool_name="$(jq -r '.name // ""' 2>/dev/null <<<"$tool_block")"
  tool_input="$(jq -c '.input // {}' 2>/dev/null <<<"$tool_block")"
  [[ -z "$tool_name" ]] && return 0

  case "$tool_name" in
    Read|Glob|Grep|NotebookRead|WebFetch|WebSearch|LS|ListMcpResources)
      # Inspection activity is intentionally summarized without the
      # file path so the operator output never echoes raw tool inputs.
      # The orchestrator prints a generic "Inspecting repository or
      # tracker state" line for these events.
      printf 'inspect\t\n'
      ;;
    Edit|Write|MultiEdit|NotebookEdit)
      local detail
      local file_path
      file_path="$(jq -r '.file_path // .notebook_path // ""' 2>/dev/null <<<"$tool_input")"
      if [[ -n "$file_path" && "$file_path" != "null" ]]; then
        detail="$file_path"
      else
        detail="files"
      fi
      printf 'mutate\t%s\n' "$detail"
      ;;
    Bash)
      local cmd
      cmd="$(jq -r '.command // ""' 2>/dev/null <<<"$tool_input")"
      claude_runtime_decode_bash "$cmd"
      ;;
    TodoWrite|Task)
      printf 'plan\t\n'
      ;;
    *)
      printf 'unknown_tool\t%s\n' "$tool_name"
      ;;
  esac
}

# Translate a Bash shell command into a normalized event. The orchestrator
# never pattern-matches shell strings; this helper is the only place that
# knows what shell commands correspond to inspect/push/PR/close events.
# Tracker adapters deliberately emit a generic tracker event for provider
# merge/close commands. The supervisor accepts completion only after the
# selected adapter verifies the resulting live state.
claude_runtime_decode_bash() {
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

# Capture the Claude session id from a system init event. The id is written
# to <output_file>.session so the orchestrator can resume the same session
# on the next retry or restart without re-deriving it from the stream.
claude_runtime_capture_session() {
  local raw_line="$1"
  local session_file="$2"

  [[ "$(claude_runtime_event_field 'type' "$raw_line")" == "system" ]] || return 0
  [[ "$(claude_runtime_event_field 'subtype' "$raw_line")" == "init" ]] || return 0

  local sid
  sid="$(jq -r '.session_id // ""' 2>/dev/null <<<"$raw_line")"
  if [[ -n "$sid" && "$sid" != "null" ]]; then
    printf '%s' "$sid" > "$session_file"
  fi
}

# Dispatch a normalized event into the orchestrator's checkpoint/progress
# callbacks. The orchestrator provides these callbacks; the adapter calls
# them without knowing their internals. Adding a new normalized event
# tag only requires adding a case here.
claude_runtime_dispatch_event() {
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

# Build the argument list that the Claude CLI will be invoked with. The
# orchestrator uses this both to launch the worker and to assert expected
# flags in tests; tests must not depend on the orchestrator's internal
# invocation logic. New adapters expose their own equivalent.
#
# Outputs one argument per line. The prompt is intentionally excluded from
# this list because prompts may contain newlines; the oracle passes the
# prompt verbatim to the worker, so this helper only enumerates the
# flag-style arguments. The training loop comments in `claude_runtime_invoke`
# explain how the prompt is appended as a single array element.
claude_runtime_invoke_args() {
  local session_id="${1:-}"

  printf '%s\n' "--print"
  printf '%s\n' "--permission-mode"
  printf '%s\n' "$PERMISSION_MODE"
  printf '%s\n' "--name"
  printf '%s\n' "${RUNNER_NAME}-${ITERATION}"

  if [[ -n "$session_id" ]]; then
    printf '%s\n' "--resume"
    printf '%s\n' "$session_id"
  else
    printf '%s\n' "--no-session-persistence"
  fi

  if [[ "$STREAM_OUTPUT" == "true" ]]; then
    # `--print` requires `--verbose` whenever `--output-format stream-json`
    # is requested; without it the CLI aborts before producing any output.
    printf '%s\n' "--output-format"
    printf '%s\n' "stream-json"
    printf '%s\n' "--verbose"
  fi
}

# Resolve the worker invocation. Two paths are supported:
#   1. CLAUDE_COMMAND is an executable on PATH -> invoke it directly.
#   2. CLAUDE_COMMAND is a shell function loaded via CLAUDE_RC_FILE -> spawn
#      a non-interactive shell that sources the rc file and runs it.
# The active path is intentionally chosen at runtime to preserve the
# previous launcher behavior; the orchestrator must not assume either form.
#
# The prompt is appended as the final array element so embedded newlines
# remain part of a single argument. Carrying the prompt through a
# line-based tokenizer would split it across multiple positional args and
# leak the prompt into the wrong argv slot for the worker.
claude_runtime_invoke() {
  local prompt="$1"
  local session_id="${2:-}"
  local -a args
  local arg

  # `mapfile` is unavailable on bash 3.2 (the macOS default sh), so an
  # explicit read loop populates the array portably across the supported
  # bash versions. The flag arguments are emitted one per line by the
  # tokenizer above; the prompt is appended as a final element after the
  # loop so its newlines stay inside a single array slot.
  while IFS= read -r arg || [[ -n "$arg" ]]; do
    args+=("$arg")
  done < <(claude_runtime_invoke_args "$session_id")
  args+=("$prompt")

  if command -v "$CLAUDE_COMMAND" >/dev/null 2>&1; then
    "$CLAUDE_COMMAND" "${args[@]}"
    return
  fi

  [[ -r "$CLAUDE_RC_FILE" ]] || \
    die "shell command not found and init file is not readable: ${CLAUDE_RC_FILE}"

  "$CLAUDE_SHELL" --noprofile --norc -c '
    runner_command="$1"
    runner_rc_file="$2"
    shift 2

    enable() {
      if [[ "$*" == *flyline* ]]; then
        return 0
      fi
      builtin enable "$@"
    }

    source "$runner_rc_file"
    "$runner_command" "$@"
  ' "$RUNNER_NAME" "$CLAUDE_COMMAND" "$CLAUDE_RC_FILE" "${args[@]}"
}

# Drain the worker stdout into the orchestrator's pipeline. This is the
# only place that knows the Claude stream shape; the orchestrator consumes
# what we write to stdout and the side-channel files. Persists raw lines to
# OUTPUT_FILE so the orchestrator's status-marker extraction continues to
# work unchanged.
claude_runtime_emit_json() {
  local category="$1" raw_line="$2" status
  status="$(jq -r '[paths(scalars) as $p | getpath($p) | strings | (try capture("ISSUE_KILLER_STATUS=(?<s>[A-Z_]+)").s catch empty)] | first // empty' <<<"$raw_line")"
  jq -cn --arg category "$category" --arg cli "claude" --arg iteration "${ITERATION:-0}" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg status "$status" --argjson event "$raw_line" \
    '{category:$category,cli:$cli,iteration:($iteration|tonumber),timestamp:$timestamp,event:$event} + (if $status != "" then {status:$status} else {} end)'
}

claude_runtime_render_stream() {
  local output_file="$1"
  local touch_file="${output_file}.touch"
  local session_file="${output_file}.session"
  local raw_line decoded tag detail

  : > "$session_file"

  while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    [[ -z "$raw_line" ]] && continue

    # Persist the raw line so status extraction continues to work.
    printf '%s\n' "$raw_line" >> "$output_file"

    if ! claude_runtime_is_event_object "$raw_line"; then
      printf '%s\n' "$raw_line"
      continue
    fi

    case "$(claude_runtime_event_field 'type' "$raw_line")" in
      assistant)
        decoded="$(claude_runtime_decode_event "$raw_line" "$output_file" || true)"
        if [[ -n "$decoded" ]]; then
          tag="${decoded%%$'\t'*}"
          detail="${decoded#*$'\t'}"
          case "$tag" in
            inspect|tracker) claude_runtime_emit_json "Inspecting issue tracker" "$raw_line" ;;
            plan|mutate) claude_runtime_emit_json "Planning the next worker step" "$raw_line" ;;
            shell|test) claude_runtime_emit_json "Running shell command" "$raw_line" ;;
            push) claude_runtime_emit_json "Pushing branch" "$raw_line" ;;
            commit) claude_runtime_emit_json "Committing changes" "$raw_line" ;;
            merge_rebase) claude_runtime_emit_json "Merging or rebasing branch" "$raw_line" ;;
            pr_create) claude_runtime_emit_json "Creating pull request" "$raw_line" ;;
            pr_close) claude_runtime_emit_json "Merging or closing pull request" "$raw_line" ;;
            close) claude_runtime_emit_json "Closing issue" "$raw_line" ;;
            review) claude_runtime_emit_json "Reviewing changes" "$raw_line" ;;
          esac
          claude_runtime_dispatch_event "$tag" "$detail" "$output_file" >/dev/null
        fi
        : > "$touch_file"
        ;;
      system)
        claude_runtime_capture_session "$raw_line" "$session_file"
        ;;
      result)
        local result_text
        result_text="$(jq -r '.result // ""' 2>/dev/null <<<"$raw_line")"
        if [[ -n "$result_text" && "$result_text" != "null" ]]; then
          # Persist the assistant's final text on its own lines so existing
          # status-marker extraction (sed -n s/^PREFIX/p) still finds the line.
          printf '%s\n' "$result_text" >> "$output_file"
          claude_runtime_emit_json "Worker finished" "$raw_line"
          printf '[%s] Worker finished (see %s for full output)\n' \
            "$RUNNER_NAME" "$output_file"
        fi
        ;;
    esac
  done
}

# Generic `runtime_*` aliases. The orchestrator and other adapters call
# these names so the runner remains CLI-agnostic. Each alias is a thin
# forwarder to the Claude-specific implementation above; the alias layer
# exists so a future adapter can be selected by sourcing a sibling file
# without touching the orchestrator. The `claude_runtime_*` definitions
# earlier in this file remain the authoritative implementation; the
# orchestrator's old call sites that still mention them keep working
# through the unchanged originals.
runtime_is_event_object() { claude_runtime_is_event_object "$@"; }
runtime_event_field()     { claude_runtime_event_field "$@"; }
runtime_redact()          { claude_runtime_redact; }
runtime_decode_event()    { claude_runtime_decode_event "$@"; }
runtime_capture_session() { claude_runtime_capture_session "$@"; }
runtime_dispatch_event()  { claude_runtime_dispatch_event "$@"; }
runtime_invoke_args()     { claude_runtime_invoke_args "$@"; }
runtime_invoke()          { claude_runtime_invoke "$@"; }
runtime_render_stream()   { claude_runtime_render_stream "$@"; }
# `runtime_decode_bash` is the private normalization helper used by
# `claude_runtime_decode_event`. Codex has its own shell-event grammar
# so it does not share this name; we still expose it on the Claude
# adapter for any direct caller.
runtime_decode_bash()     { claude_runtime_decode_bash "$@"; }

# Echo empty output when sourced directly so the orchestrator's `source`
# always succeeds. The orchestrator depends on this file having no side
# effects at source time.
:
