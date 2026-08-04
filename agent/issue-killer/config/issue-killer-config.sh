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


ISSUE_KILLER_CONFIG_MODULE_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=agent/issue-killer/config/toml-parser.sh
source "${ISSUE_KILLER_CONFIG_MODULE_DIR}/toml-parser.sh"
# shellcheck source=agent/issue-killer/config/profile-catalog.sh
source "${ISSUE_KILLER_CONFIG_MODULE_DIR}/profile-catalog.sh"
unset ISSUE_KILLER_CONFIG_MODULE_DIR

# Sourcing this facade only defines configuration functions and defaults.
:
