#!/usr/bin/env bash
# Shared runtime adapter activation path. The orchestrator and every
# recovery flow (fallback staging, restart checkpoint adoption) reach
# the `runtime_*` interface exclusively through this module so the
# CLI-specific adapter is sourced exactly once and validated against
# the active profile's options before any worker is launched.
# Sourced by run.sh; intentionally has no source-time side effects.

# Activates the runtime adapter that matches the active profile CLI
# and validates its profile options. Returns 0 when the adapter is
# loaded and the options pass the adapter's own validation; returns 1
# on an unsupported CLI, a missing adapter file, or invalid options.
# After this call succeeds, the generic `runtime_*` interface is
# bound to the correct adapter. The function is idempotent within a
# single shell invocation: sourcing the same adapter file twice does
# not redefine the functions, and CLI transitions re-source only when
# the destination CLI differs from the currently sourced adapter.
activate_runtime_for_profile() {
  local cli="$ISSUE_KILLER_PROFILE_CLI"
  local options="${ISSUE_KILLER_PROFILE_OPTIONS:-}"
  local adapter="${RUNTIME_ADAPTER_DIR}/${cli}-adapter.sh"

  if [[ -z "$cli" ]]; then
    printf '%s: cannot activate a runtime adapter without an active profile CLI\n' \
      "$RUNNER_NAME" >&2
    return 1
  fi
  case "$cli" in
    claude|codex|opencode) ;;
    *)
      printf '%s: runtime adapter is not available for CLI: %s\n' \
        "$RUNNER_NAME" "$cli" >&2
      return 1
      ;;
  esac
  if [[ ! -r "$adapter" ]]; then
    printf '%s: runtime adapter not found: %s\n' "$RUNNER_NAME" "$adapter" >&2
    return 1
  fi

  if [[ "${RUNTIME_ADAPTER_LOADED:-}" != "$adapter" ]]; then
    # shellcheck source=agent/issue-killer/runtime/codex-adapter.sh
    source "$adapter"
    RUNTIME_ADAPTER="$adapter"
    RUNTIME_ADAPTER_LOADED="$adapter"
  fi

  if [[ "$cli" == "claude" ]]; then
    CLAUDE_COMMAND="$ISSUE_KILLER_PROFILE_COMMAND"
    CLAUDE_SHELL="${ISSUE_KILLER_PROFILE_SHELL:-bash}"
    CLAUDE_RC_FILE="${ISSUE_KILLER_PROFILE_INIT_FILE:-${HOME}/.bashrc}"
  fi

  runtime_validate_profile "$options" || {
    printf '%s: %s profile %s has invalid options\n' \
      "$RUNNER_NAME" "$cli" "$ISSUE_KILLER_PROFILE_NAME" >&2
    return 1
  }
}
