#!/usr/bin/env bash
# Runtime adapter for the OpenAI Codex CLI.
#
# This file owns every Codex-specific concern of the worker runtime:
#   - profile field validation (model, reasoning effort, sandbox, autonomy)
#   - non-interactive `codex exec` invocation construction
#   - Codex JSONL event decoding into normalized lifecycle events
#   - thread (session) identity capture and resume
#   - command-output secret redaction
#
# The orchestrator and tracker adapter consume only the generic
# `runtime_*` interface declared at the bottom of this file. The
# `codex_runtime_*` definitions above are the authoritative
# implementation; the orchestrator never reaches inside Codex-specific
# logic. Sibling adapters (Claude, OpenCode) expose the same generic
# interface so the supervisor remains CLI-agnostic.
#
# Required inputs from the orchestrator (defined before this file is
# sourced):
#   RUNNER_NAME              - display name printed in progress lines
#   ITERATION                - worker iteration counter
#   STREAM_OUTPUT            - "true" to use stream-json, "false" for plain
#   ISSUE_KILLER_PROFILE_COMMAND - executable or shell-function name
#   ISSUE_KILLER_PROFILE_MODEL   - model identifier passed via --model
#   ISSUE_KILLER_PROFILE_SHELL   - shell used to load the function
#   ISSUE_KILLER_PROFILE_INIT_FILE - rc file consulted when the command is a function
#   ISSUE_KILLER_PROFILE_OPTIONS  - newline-separated `key=value` adapter options
#
# Adapter-specific options consumed here (validated strictly):
#   reasoning_effort         - "low" | "medium" | "high" (or unset)
#   sandbox                  - "read-only" | "workspace-write" | "danger-full-access"
#   auto_approve             - "true" to pass --full-auto
#
# Orchestrator-provided callbacks invoked while decoding events:
#   record_identified_issue <issue_number> <output_file>
#   advance_checkpoint_state <next_state> <output_file>
#   write_checkpoint <state>
#   write_lock_status <state> <elapsed>
#
# Required side-channel files for cross-subshell state:
#   <output_file>.issue      - last identified issue number
#   <output_file>.session    - captured Codex thread id
#   <output_file>.touch      - heartbeat suppression flag while events flow

# Returns 0 (success) when the input line is a JSON object. The
# orchestrator is intentionally kept out of the JSONL shape; this
# helper is the only place that knows the envelope.
codex_runtime_is_event_object() {
  jq -e 'type == "object"' >/dev/null 2>&1 <<<"$1"
}

# Extracts a dotted field path from a Codex JSONL event. Returns the
# empty string when the path is absent. Kept private to the adapter so
# the orchestrator never imports jq and stays portable across adapters.
codex_runtime_event_field() {
  local field="$1"
  local line="$2"
  jq -r --arg f "$field" 'try (getpath($f | split(".")) // empty) catch empty' 2>/dev/null <<<"$line"
}

# Redact common credential shapes from arbitrary assistant text. The
# redactor is pure string substitution so the orchestration layer can
# apply it to any captured text without re-entering the adapter. The
# patterns are shared with the Claude adapter; both adapters must
# reject the same shapes so the operator view is consistent across
# providers.
codex_runtime_redact() {
  sed -E \
    -e 's/[Aa]uthorization([[:space:][:punct:]]+[A-Za-z0-9._~+/-]+)+/<redacted:authorization>/g' \
    -e 's/[Bb]earer[[:space:][:punct:]]+[A-Za-z0-9._~+/-]{6,}/<redacted:bearer>/g' \
    -e "s/(api[_-]?key|secret|password|access[_-]?token|auth[_-]?token)['\"[:space:]]*[:=]['\"[:space:]]*[A-Za-z0-9._~+/-]+/\1=<redacted>/gI" \
    -e 's/(ghp_[A-Za-z0-9]+|ghs_[A-Za-z0-9]+|gho_[A-Za-z0-9]+|ghu_[A-Za-z0-9]+|ghr_[A-Za-z0-9]+)/<redacted:credential>/g' \
    -e 's/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/<redacted:private-key>/g'
}

# Strictly validates the Codex profile fields captured in
# ISSUE_KILLER_PROFILE_OPTIONS. Returns 0 on success and prints an
# actionable diagnostic on failure. The orchestrator calls this before
# launching any worker; unknown or malformed options fail closed so a
# misspelled safety setting is never silently ignored.
codex_runtime_validate_profile() {
  local options="$1"
  local line key value
  local reasoning_effort sandbox auto_approve
  local seen_reasoning=0 seen_sandbox=0 seen_approve=0

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      reasoning_effort)
        seen_reasoning=1
        case "$value" in
          low|medium|high) reasoning_effort="$value" ;;
          *)
            printf '%s: codex profile has invalid reasoning_effort: %s\n' \
              "$RUNNER_NAME" "$value" >&2
            return 1
            ;;
        esac
        ;;
      sandbox)
        seen_sandbox=1
        case "$value" in
          read-only|workspace-write|danger-full-access) sandbox="$value" ;;
          *)
            printf '%s: codex profile has invalid sandbox: %s\n' \
              "$RUNNER_NAME" "$value" >&2
            return 1
            ;;
        esac
        ;;
      auto_approve)
        seen_approve=1
        case "$value" in
          true|false) auto_approve="$value" ;;
          *)
            printf '%s: codex profile has invalid auto_approve: %s\n' \
              "$RUNNER_NAME" "$value" >&2
            return 1
            ;;
        esac
        ;;
      *)
        printf '%s: codex profile has unknown option: %s\n' \
          "$RUNNER_NAME" "$key" >&2
        return 1
        ;;
    esac
  done <<<"$options"

  # `auto_approve = true` together with `sandbox = read-only` is the
  # only combination the adapter treats as contradictory: full autonomy
  # requires a writable sandbox or the CLI will refuse to launch.
  if (( seen_approve == 1 )) && (( seen_sandbox == 1 )); then
    if [[ "$auto_approve" == "true" && "$sandbox" == "read-only" ]]; then
      printf '%s: codex profile combines auto_approve=true with sandbox=read-only\n' \
        "$RUNNER_NAME" >&2
      return 1
    fi
  fi

  return 0
}

# Decodes a Codex JSONL event into a normalized event tag and detail.
# The orchestrator dispatches the tag to checkpoint/progress helpers.
# Output is a single line of the form `<tag>\t<detail>`; the
# orchestrator splits it on the tab. Codex item types map onto the
# same normalized tags the Claude adapter uses so the operator view is
# uniform across providers.
codex_runtime_decode_event() {
  local raw_line="$1"
  local output_file="${2:-}"

  [[ "$(codex_runtime_event_field 'type' "$raw_line")" == "item.started" ]] || return 0

  local item_type item_command item_path item_text
  item_type="$(codex_runtime_event_field 'item.type' "$raw_line")"
  case "$item_type" in
    agent_message)
      item_text="$(codex_runtime_event_field 'item.text' "$raw_line")"
      # Codex often surfaces `gh issue view` invocations through the
      # agent message body. Recognize a bare issue number anywhere in
      # the message and emit an `identify` event so the orchestrator
      # records it before the worker mutates the repository.
      local issue_number
      issue_number="$(printf '%s\n' "$item_text" | sed -nE 's/.*[^0-9]([0-9]+)[^0-9]*$/\1/p' | head -n 1)"
      if [[ -n "$issue_number" ]]; then
        printf 'identify\t%s\n' "$issue_number"
      else
        printf 'plan\t\n'
      fi
      ;;
    reasoning)
      printf 'plan\t\n'
      ;;
    command_execution)
      item_command="$(codex_runtime_event_field 'item.command' "$raw_line")"
      codex_runtime_decode_command "$item_command"
      ;;
    file_change)
      item_path="$(codex_runtime_event_field 'item.path' "$raw_line")"
      if [[ -n "$item_path" && "$item_path" != "null" ]]; then
        printf 'mutate\t%s\n' "$item_path"
      else
        printf 'mutate\tfiles\n'
      fi
      ;;
    mcp_tool_call|web_search|web_fetch)
      printf 'inspect\t\n'
      ;;
    todo_update|todo_list)
      printf 'plan\t\n'
      ;;
    *)
      printf 'unknown_tool\t%s\n' "${item_type:-unknown}"
      ;;
  esac
}

# Translate a Codex shell command into a normalized event. The
# orchestrator never pattern-matches shell strings; this helper is the
# only place that knows what shell commands correspond to inspect,
# push, PR, and close events. Mirrors `claude_runtime_decode_bash` so
# the operator sees the same lifecycle regardless of provider.
codex_runtime_decode_command() {
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

# Capture the Codex thread id from a `thread.started` event. The id is
# written to <output_file>.session so the orchestrator can resume the
# same thread on the next retry or restart without re-deriving it from
# the stream. The Codex CLI is expected to emit a `thread.started`
# event at the beginning of every session; the orchestrator treats its
# presence as the authoritative "session is resumable" signal.
codex_runtime_capture_session() {
  local raw_line="$1"
  local session_file="$2"

  [[ "$(codex_runtime_event_field 'type' "$raw_line")" == "thread.started" ]] || return 0

  local tid
  tid="$(jq -r '.thread_id // ""' 2>/dev/null <<<"$raw_line")"
  if [[ -n "$tid" && "$tid" != "null" ]]; then
    printf '%s' "$tid" > "$session_file"
  fi
}

# Dispatch a normalized event into the orchestrator's
# checkpoint/progress callbacks. The orchestrator provides these
# callbacks; the adapter calls them without knowing their internals.
# Adding a new normalized event tag only requires adding a case here.
codex_runtime_dispatch_event() {
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

# Build the argument list that `codex exec` will be invoked with. The
# orchestrator uses this both to launch the worker and to assert
# expected flags in tests; tests must not depend on the orchestrator's
# internal invocation logic. New adapters expose their own equivalent.
#
# Outputs one argument per line. The prompt is intentionally excluded
# from this list because prompts may contain newlines; the
# orchestrator appends the prompt verbatim as a single array element.
codex_runtime_invoke_args() {
  local session_id="${1:-}"
  local line key value reasoning_effort="" sandbox="" auto_approve=""

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    case "$key" in
      reasoning_effort) reasoning_effort="$value" ;;
      sandbox) sandbox="$value" ;;
      auto_approve) auto_approve="$value" ;;
    esac
  done <<<"${ISSUE_KILLER_PROFILE_OPTIONS:-}"

  printf '%s\n' "exec"
  printf '%s\n' "--json"
  printf '%s\n' "--model"
  printf '%s\n' "$ISSUE_KILLER_PROFILE_MODEL"

  if [[ -n "$reasoning_effort" ]]; then
    printf '%s\n' "--reasoning-effort"
    printf '%s\n' "$reasoning_effort"
  fi

  if [[ -n "$sandbox" ]]; then
    printf '%s\n' "--sandbox"
    printf '%s\n' "$sandbox"
  fi

  if [[ "$auto_approve" == "true" ]]; then
    printf '%s\n' "--full-auto"
  fi

  if [[ -n "$session_id" ]]; then
    printf '%s\n' "--resume"
    printf '%s\n' "$session_id"
  fi
}

# Resolve the worker invocation. Two paths are supported, mirroring the
# Claude adapter: the command is either an executable on PATH or a
# shell function loaded through the optional init file. The active
# path is chosen at runtime to preserve the previous launcher
# behavior; the orchestrator must not assume either form.
#
# The prompt is appended as the final array element so embedded
# newlines remain part of a single argument. Carrying the prompt
# through a line-based tokenizer would split it across multiple
# positional args and leak the prompt into the wrong argv slot for
# the worker.
codex_runtime_invoke() {
  local prompt="$1"
  local session_id="${2:-}"
  local -a args
  local arg

  while IFS= read -r arg || [[ -n "$arg" ]]; do
    args+=("$arg")
  done < <(codex_runtime_invoke_args "$session_id")
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
# the only place that knows the Codex JSONL shape; the orchestrator
# consumes what we write to stdout and the side-channel files.
# Persists raw lines to OUTPUT_FILE so the orchestrator's
# status-marker extraction continues to work unchanged.
codex_runtime_emit_json() {
  local category="$1" raw_line="$2" status
  status="$(jq -r '[paths(scalars) as $p | getpath($p) | strings | (try capture("ISSUE_KILLER_STATUS=(?<s>[A-Z_]+)").s catch empty)] | first // empty' <<<"$raw_line")"
  jq -cn --arg category "$category" --arg cli "codex" --arg iteration "${ITERATION:-0}" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg status "$status" --argjson event "$raw_line" \
    '{category:$category,cli:$cli,iteration:($iteration|tonumber),timestamp:$timestamp,event:$event} + (if $status != "" then {status:$status} else {} end)'
}

codex_runtime_render_stream() {
  local output_file="$1"
  local touch_file="${output_file}.touch"
  local session_file="${output_file}.session"
  local raw_line decoded tag detail agent_text

  : > "$session_file"

  while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
    [[ -z "$raw_line" ]] && continue

    # Persist the raw line so status extraction continues to work.
    printf '%s\n' "$raw_line" >> "$output_file"

    if ! codex_runtime_is_event_object "$raw_line"; then
      printf '%s\n' "$raw_line"
      continue
    fi

    case "$(codex_runtime_event_field 'type' "$raw_line")" in
      thread.started)
        codex_runtime_capture_session "$raw_line" "$session_file"
        : > "$touch_file"
        ;;
      item.started)
        decoded="$(codex_runtime_decode_event "$raw_line" "$output_file" || true)"
        if [[ -n "$decoded" ]]; then
          tag="${decoded%%$'\t'*}"
          detail="${decoded#*$'\t'}"
          case "$tag" in
            inspect|tracker) codex_runtime_emit_json "Inspecting issue tracker" "$raw_line" ;;
            plan|mutate) codex_runtime_emit_json "Planning the next worker step" "$raw_line" ;;
            shell|test) codex_runtime_emit_json "Running shell command" "$raw_line" ;;
            push) codex_runtime_emit_json "Pushing branch" "$raw_line" ;;
            commit) codex_runtime_emit_json "Committing changes" "$raw_line" ;;
            merge_rebase) codex_runtime_emit_json "Merging or rebasing branch" "$raw_line" ;;
            pr_create) codex_runtime_emit_json "Creating pull request" "$raw_line" ;;
            pr_close) codex_runtime_emit_json "Merging or closing pull request" "$raw_line" ;;
            close) codex_runtime_emit_json "Closing issue" "$raw_line" ;;
            review) codex_runtime_emit_json "Reviewing changes" "$raw_line" ;;
          esac
          codex_runtime_dispatch_event "$tag" "$detail" "$output_file" >/dev/null
        fi
        : > "$touch_file"
        ;;
      item.completed)
        # Surface the final assistant message text so existing
        # status-marker extraction (sed -n s/^PREFIX/p) still finds
        # the line. Codex typically includes the agent's reply in the
        # `item.text` field of the completed agent_message item.
        agent_text="$(codex_runtime_event_field 'item.text' "$raw_line")"
        if [[ -z "$agent_text" || "$agent_text" == "null" ]]; then
          agent_text="$(codex_runtime_event_field 'item.message' "$raw_line")"
        fi
        if [[ -n "$agent_text" && "$agent_text" != "null" ]]; then
          printf '%s\n' "$agent_text" >> "$output_file"
        fi
        : > "$touch_file"
        ;;
      turn.completed)
        agent_text="$(codex_runtime_event_field 'output_text' "$raw_line")"
        if [[ -z "$agent_text" || "$agent_text" == "null" ]]; then
          agent_text="$(codex_runtime_event_field 'result' "$raw_line")"
        fi
        if [[ -n "$agent_text" && "$agent_text" != "null" ]]; then
          printf '%s\n' "$agent_text" >> "$output_file"
          codex_runtime_emit_json "Worker finished" "$raw_line"
          printf '[%s] Worker finished (see %s for full output)\n' \
            "$RUNNER_NAME" "$output_file"
        fi
        ;;
    esac
  done
}

# Generic `runtime_*` interface. The orchestrator calls only these
# names so it never imports Codex-specific concerns. Each alias is a
# thin forwarder to the Codex-specific implementation above; the alias
# layer exists so a future adapter can be selected by sourcing a
# sibling file without touching the orchestrator.
runtime_redact()          { codex_runtime_redact; }
runtime_validate_profile() { codex_runtime_validate_profile "$@"; }
runtime_invoke()          { codex_runtime_invoke "$@"; }
runtime_render_stream()   { codex_runtime_render_stream "$@"; }

# Resolve the on-disk path of a Codex thread's transcript. The Codex
# CLI does not currently expose a stable transcript layout that the
# runner can predict; this function returns the empty path so any
# later cleanup operation has a single, no-op target. The companion
# `codex_runtime_session_exists` answers truthfully to keep today's
# observable behaviour: Codex resumes a captured thread when its own
# store has the conversation, and the CLI's "session id ... not found"
# message routes through the unresumable_session classification.
codex_runtime_session_transcript_path() {
  printf ''
  return 1
}

# Codex resumes a captured thread through its own CLI; the runner
# defers to that answer rather than guessing. Returning 0 here keeps
# today's behaviour: when the captured thread id is non-empty and the
# branch/base guards pass, the orchestrator passes --resume to the
# CLI. A CLI rejection still surfaces as unresumable_session and
# triggers the same fresh-worker degradation as for Claude.
codex_runtime_session_exists() {
  return 0
}

# Generic session-existence contract. Adapters that can answer the
# question for their own store implement `runtime_session_exists`; the
# orchestrator calls this name without knowing the CLI.
runtime_session_transcript_path() { codex_runtime_session_transcript_path "$@"; }
runtime_session_exists()          { codex_runtime_session_exists "$@"; }

# Codex does not expose a stable transcript layout the runner can
# predict, so there is nothing to remove. Returning 0 preserves
# today's behaviour: non-Claude profiles that have no transcript path
# to clean up never report a removal failure, and the orchestrator's
# verified-completion path stays a no-op for this adapter.
codex_runtime_remove_session_transcript() {
  return 0
}

# Generic session-cleanup contract. Adapters that resolve to a
# transcript path delete it; adapters whose transcript layout the
# runner cannot predict (Codex, OpenCode today) report success without
# touching any file.
runtime_remove_session_transcript() { codex_runtime_remove_session_transcript "$@"; }

# Echo empty output when sourced directly so the orchestrator's `source`
# always succeeds. The orchestrator depends on this file having no
# side effects at source time.
:
