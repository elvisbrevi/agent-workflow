#!/usr/bin/env bash
set -euo pipefail

# The canonical runner name. The historical binary was known as
# Claude-MiniMax Issue Runner; legacy lock/checkpoint namespaces still
# use that name so that active in-flight work can be detected and
# migrated across linked worktrees. The orchestrator never depends on
# the legacy name as a runtime identifier.
RUNNER_NAME="issue-killer"
LEGACY_RUNNER_NAME="claude-minimax-issue-runner"
# The status marker is the generic ISSUE_KILLER_STATUS namespace. Every
# worker exposes one of ISSUE_COMPLETED, QUEUE_EMPTY, BLOCKED, FAILED,
# or RECOVERY_REQUIRED so the orchestrator can advance the queue
# without parsing CLI-specific JSON.
STATUS_PREFIX="ISSUE_KILLER_STATUS="
LOCK_HELD=false
LOCK_TOKEN=""

die() {
  printf '%s: %s\n' "$RUNNER_NAME" "$*" >&2
  exit 1
}

resolve_script_dir() {
  local source_path="${BASH_SOURCE[0]}"
  local source_dir link_target

  while [[ -L "$source_path" ]]; do
    source_dir="$(cd -P "$(dirname "$source_path")" && pwd)"
    link_target="$(readlink "$source_path")"
    if [[ "$link_target" == /* ]]; then
      source_path="$link_target"
    else
      source_path="${source_dir}/${link_target}"
    fi
  done

  cd -P "$(dirname "$source_path")" && pwd
}

is_non_negative_integer() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

timestamp() {
  date '+%Y-%m-%d %H:%M:%S %z'
}

SCRIPT_DIR="$(resolve_script_dir)"
# Orchestration modules expose functions only; sourcing them does not mutate
# repository, tracker, or worker state.
# shellcheck source=agent/issue-killer/state/checkpoint.sh
source "${SCRIPT_DIR}/state/checkpoint.sh"
# shellcheck source=agent/issue-killer/state/repository-lock.sh
source "${SCRIPT_DIR}/state/repository-lock.sh"
# shellcheck source=agent/issue-killer/recovery/legacy-migration.sh
source "${SCRIPT_DIR}/recovery/legacy-migration.sh"
# shellcheck source=agent/issue-killer/recovery/startup.sh
source "${SCRIPT_DIR}/recovery/startup.sh"
# shellcheck source=agent/issue-killer/recovery/retry.sh
source "${SCRIPT_DIR}/recovery/retry.sh"
# shellcheck source=agent/issue-killer/runtime/supervisor.sh
source "${SCRIPT_DIR}/runtime/supervisor.sh"
# shellcheck source=agent/issue-killer/runtime/runtime-activation.sh
source "${SCRIPT_DIR}/runtime/runtime-activation.sh"
# shellcheck source=agent/issue-killer/operator/session.sh
source "${SCRIPT_DIR}/operator/session.sh"

runner_cleanup() {
  release_repository_lock
  if declare -F tracker_cleanup_worker_environment >/dev/null 2>&1; then
    tracker_cleanup_worker_environment
  fi
  if declare -F issue_killer_config_cleanup >/dev/null 2>&1; then
    issue_killer_config_cleanup
  fi
}

# Source the tracker selector and config adapter before entering orchestration.
# The runtime adapter is sourced later, after the active profile is
# known, so the orchestrator picks the right adapter (claude, codex,
# ...) without depending on a single hardcoded path. The supervisor
# consumes normalized tracker operations and lifecycle events only;
# provider-specific command construction remains inside the adapters.

TRACKER_SELECTOR="${SCRIPT_DIR}/tracker/selector.sh"
RUNTIME_ADAPTER_DIR="${SCRIPT_DIR}/runtime"
CONFIG_ADAPTER="${SCRIPT_DIR}/config/issue-killer-config.sh"
# shellcheck source=agent/issue-killer/config/issue-killer-config.sh
source "$CONFIG_ADAPTER"
# shellcheck source=agent/issue-killer/tracker/selector.sh
source "$TRACKER_SELECTOR"
PROMPT_FILE="${SCRIPT_DIR}/PROMPT.md"

# Parse the optional positional repository argument together with the
# optional `--config <path>` flag. The legacy positional form is
# preserved so existing shell invocations keep working.
CONFIG_PATH_OVERRIDE=""
HU_ID_OVERRIDE=""
HU_OPTION_SET=false
REPOSITORY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      [[ $# -ge 2 ]] || die "--config requires a path argument"
      CONFIG_PATH_OVERRIDE="$2"
      shift 2
      ;;
    --config=*)
      CONFIG_PATH_OVERRIDE="${1#--config=}"
      shift
      ;;
    --help|-h)
      printf 'usage: %s [--config <path>] [--hu <id>] [repository]\n' "$RUNNER_NAME"
      exit 0
      ;;
    --hu)
      [[ $# -ge 2 ]] || die "--hu requires a numeric Azure delivery HU ID"
      [[ "$2" =~ ^[1-9][0-9]*$ ]] || \
        die "Azure HU identifier must be a positive numeric ID: $2"
      [[ "$HU_OPTION_SET" == "false" ]] || die "--hu may be specified only once"
      HU_ID_OVERRIDE="$2"
      HU_OPTION_SET=true
      shift 2
      ;;
    --hu=*)
      hu_value="${1#--hu=}"
      [[ "$hu_value" =~ ^[1-9][0-9]*$ ]] || \
        die "Azure HU identifier must be a positive numeric ID: ${hu_value:-empty}"
      [[ "$HU_OPTION_SET" == "false" ]] || die "--hu may be specified only once"
      HU_ID_OVERRIDE="$hu_value"
      HU_OPTION_SET=true
      shift
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      [[ -z "$REPOSITORY" ]] || die "only one repository argument is accepted"
      REPOSITORY="$1"
      shift
      ;;
  esac
done
REPOSITORY="${REPOSITORY:-.}"

BASE_BRANCH="${ISSUE_RUNNER_BASE_BRANCH:-main}"
MAX_ITERATIONS="${ISSUE_RUNNER_MAX_ITERATIONS:-0}"
PROGRESS_INTERVAL="${ISSUE_RUNNER_PROGRESS_INTERVAL:-30}"
STREAM_OUTPUT="${ISSUE_RUNNER_STREAM_OUTPUT:-true}"
RETRY_DELAY_VALUES=()
TRANSIENT_PATTERN_VALUES=()
UNRESUMABLE_PATTERN_VALUES=()
RECOVERY_ATTEMPT=0
RECOVERY_CATEGORY=""
RECOVERY_DELAY=""
ITERATION=0
ISSUE_KILLER_PROFILE_NAME=""
ISSUE_KILLER_PROFILE_LABEL=""
ISSUE_KILLER_PROFILE_CLI=""
ISSUE_KILLER_PROFILE_COMMAND=""
ISSUE_KILLER_PROFILE_MODEL=""
ISSUE_KILLER_PROFILE_SHELL=""
ISSUE_KILLER_PROFILE_INIT_FILE=""
ISSUE_KILLER_PROFILE_OPTIONS=""
ISSUE_KILLER_PROFILE_FALLBACKS=""
ISSUE_KILLER_SELECTED_PROFILE_NAME=""
ISSUE_KILLER_FALLBACK_CHAIN=""
ISSUE_KILLER_FALLBACK_REMAINING=""
ISSUE_KILLER_FALLBACK_POSITION=0
ISSUE_KILLER_FAILED_PROFILE=""
ISSUE_KILLER_NEXT_PROFILE=""
ISSUE_KILLER_FALLBACK_FAILURE=""
TRACKER_SCOPE_STATUS=""
TRACKER_SCOPE_HU=""
TRACKER_SCOPE_ITEM=""
CHECKPOINT_HU=""
CHECKPOINT_TICKET=""

# Resolve and load the operator's TOML configuration. The runner
# refuses to launch without a profile: the destructive confirmation,
# checkpoint persistence, and recovery enforcement all rely on the
# canonical profile identity the loader establishes.
ISSUE_KILLER_CONFIG_PATH="$(issue_killer_config_resolve_path ${CONFIG_PATH_OVERRIDE:+--config "$CONFIG_PATH_OVERRIDE"})"
trap runner_cleanup EXIT
issue_killer_config_load "$ISSUE_KILLER_CONFIG_PATH" || \
  die "issue-killer configuration is invalid; edit ${ISSUE_KILLER_CONFIG_PATH} and retry"

# Select a profile: the operator chooses interactively when a TTY is
# available, otherwise the configured `default_profile` is used
# deterministically. The runner never picks a CLI/model outside the
# declared profile set. Any primary CLI may declare an ordered fallback
# chain; the picker preserves the operator's selections exactly as
# entered.
if [[ -t 0 && -t 1 ]] && operator_session_available; then
  SELECTED_PROFILE="$(
    operator_select_profile \
      "$(issue_killer_config_lookup top.default_profile)"
  )" || die "unable to select an execution profile"
  issue_killer_config_apply_profile "$SELECTED_PROFILE" || \
    die "profile ${SELECTED_PROFILE} is invalid"
  ISSUE_KILLER_PROFILE_FALLBACKS="$(
    operator_select_fallbacks "$SELECTED_PROFILE"
  )" || die "unable to select a fallback chain"
else
  SELECTED_PROFILE=""
  issue_killer_config_select_default_profile || \
    die "non-interactive launch requires a valid default_profile in ${ISSUE_KILLER_CONFIG_PATH}"
  SELECTED_PROFILE="$ISSUE_KILLER_PROFILE_NAME"
fi

# Keep the operator-selected profile separate from the active profile. The
# active profile changes as the chain advances, while this immutable chain
# identity is persisted for restart validation and ordered recovery.
ISSUE_KILLER_SELECTED_PROFILE_NAME="$SELECTED_PROFILE"
ISSUE_KILLER_FALLBACK_CHAIN="$ISSUE_KILLER_PROFILE_FALLBACKS"
ISSUE_KILLER_FALLBACK_REMAINING="$ISSUE_KILLER_PROFILE_FALLBACKS"
ISSUE_KILLER_FALLBACK_POSITION=0

# Project the selected profile onto the legacy runtime variables the
# adapter consumes. The adapter treats these as the single source of
# truth for the worker invocation. `PERMISSION_MODE` is only relevant
# for the Claude adapter; other adapters ignore it. The Claude-only
# projection stays here so existing test fixtures and out-of-tree
# consumers that read CLAUDE_COMMAND / CLAUDE_RC_FILE keep working.
CLAUDE_COMMAND="$ISSUE_KILLER_PROFILE_COMMAND"
CLAUDE_SHELL="${ISSUE_KILLER_PROFILE_SHELL:-bash}"
CLAUDE_RC_FILE="${ISSUE_KILLER_PROFILE_INIT_FILE:-${HOME}/.bashrc}"
PERMISSION_MODE="bypassPermissions"
ISSUE_KILLER_DISABLE_SESSION_PERSISTENCE="false"
if [[ -n "$ISSUE_KILLER_PROFILE_OPTIONS" ]]; then
  option_line=""
  option_key=""
  option_value=""
  while IFS= read -r option_line; do
    [[ -z "$option_line" ]] && continue
    option_key="${option_line%%=*}"
    option_value="${option_line#*=}"
    case "$option_key" in
      permission_mode) PERMISSION_MODE="$option_value" ;;
      disable_session_persistence) ISSUE_KILLER_DISABLE_SESSION_PERSISTENCE="$option_value" ;;
    esac
  done <<<"$ISSUE_KILLER_PROFILE_OPTIONS"
fi

# Source the runtime adapter that matches the selected profile's CLI
# through the shared activation path. The orchestrator calls only the
# generic `runtime_*` interface, so the adapter file selected here is
# the sole place that knows the CLI's invocation flags, JSON event
# shape, and session identity. The activation path is reused by every
# recovery flow (fallback staging, restart checkpoint adoption) so the
# CLI-specific options are validated through the same entry point
# before any worker is launched.
activate_runtime_for_profile || \
  die "${ISSUE_KILLER_PROFILE_CLI} profile ${ISSUE_KILLER_PROFILE_NAME} could not be activated"

[[ -f "$PROMPT_FILE" ]] || die "worker prompt not found: ${PROMPT_FILE}"
[[ "$BASE_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid base branch: ${BASE_BRANCH}"
[[ "$STREAM_OUTPUT" =~ ^(true|false)$ ]] || \
  die "ISSUE_RUNNER_STREAM_OUTPUT must be 'true' or 'false'"
is_non_negative_integer "$MAX_ITERATIONS" || \
  die "ISSUE_RUNNER_MAX_ITERATIONS must be a non-negative integer"
is_non_negative_integer "$PROGRESS_INTERVAL" || \
  die "ISSUE_RUNNER_PROGRESS_INTERVAL must be a non-negative integer"
parse_retry_delays "${ISSUE_RUNNER_RETRY_DELAYS:-15,30,60}" || \
  die "ISSUE_RUNNER_RETRY_DELAYS must be a comma-separated list of positive integers (seconds)"
parse_transient_patterns "${ISSUE_RUNNER_TRANSIENT_PATTERNS:-}"
parse_unresumable_patterns "${ISSUE_RUNNER_UNRESUMABLE_PATTERNS:-}"
if [[ -n "${ISSUE_RUNNER_RETRY_LIMIT:-}" ]]; then
  is_non_negative_integer "${ISSUE_RUNNER_RETRY_LIMIT}" || \
    die "ISSUE_RUNNER_RETRY_LIMIT must be a non-negative integer"
fi
command -v "$CLAUDE_SHELL" >/dev/null 2>&1 || die "shell not found: ${CLAUDE_SHELL}"
if [[ "$STREAM_OUTPUT" == "true" ]]; then
  command -v jq >/dev/null 2>&1 || \
    die "jq is required for stream-json output rendering"
fi

cd "$REPOSITORY" 2>/dev/null || die "repository not found: ${REPOSITORY}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a Git repository"
cd "$REPO_ROOT"
GIT_COMMON_DIR_RAW="$(git rev-parse --git-common-dir 2>/dev/null)" || \
  die "unable to resolve Git common directory"
GIT_COMMON_DIR="$(cd "$GIT_COMMON_DIR_RAW" 2>/dev/null && pwd -P)" || \
  die "Git common directory not found: ${GIT_COMMON_DIR_RAW}"

if ! git show-ref --verify --quiet "refs/heads/${BASE_BRANCH}" &&
   ! git show-ref --verify --quiet "refs/remotes/origin/${BASE_BRANCH}"; then
  die "base branch not found locally or at origin: ${BASE_BRANCH}"
fi

TRACKER_ADAPTER="$(tracker_select_adapter "$REPO_ROOT")" || \
  die "unable to select a tracker adapter"
[[ -r "$TRACKER_ADAPTER" ]] || die "tracker adapter not found: ${TRACKER_ADAPTER}"
# shellcheck source=agent/issue-killer/tracker/github-adapter.sh
source "$TRACKER_ADAPTER"
tracker_initialize "$REPO_ROOT" || die "tracker validation failed; run setup-elvis-brevi-skills and retry"
tracker_validate_run_options "$HU_ID_OVERRIDE" || die "invalid tracker-specific run options"
tracker_prepare_worker_environment || die "unable to prepare the selected tracker runtime environment"

prepare_legacy_state || die "issue-killer cannot start: legacy runner state could not be migrated safely"
restore_fallback_checkpoint || \
  emit_recovery_required "fallback checkpoint does not match the selected profile chain or current config"

acquire_repository_lock
operator_confirm_destructive_run
adopt_startup_checkpoint

if [[ -z "${STARTUP_RECOVERY_MODE:-}" ]]; then
  if [[ -e "$(checkpoint_file)" ]]; then
    : # Migrated checkpoints may be adopted before the worktree is
      # touched. Adopt the migration instead of asserting a clean
      # worktree, then fall through to the normal assert.
  else
    assert_clean_worktree
  fi
fi

# Azure selects and pins one HU plus its first eligible direct child before a
# worker is launched. GitHub leaves selection to the worker, preserving its
# existing queue lifecycle. Selection is read-only and occurs while the
# repository-wide lock is held, so concurrent runs cannot choose the same
# delivery scope independently.
tracker_prepare_worker_scope "$HU_ID_OVERRIDE" || \
  die "unable to select a safe tracker delivery scope"
case "${TRACKER_SCOPE_STATUS:-worker_selects}" in
  worker_selects)
    ;;
  queue_empty)
    clear_checkpoint
    printf '[%s] No prepared Azure delivery HU is available.\n' "$RUNNER_NAME"
    exit 0
    ;;
  empty)
    clear_checkpoint
    printf '[%s] Azure delivery HU %s has no pending direct child tickets.\n' \
      "$RUNNER_NAME" "$TRACKER_SCOPE_HU"
    printf '[%s] No pending, available, non-epic issues remain.\n' "$RUNNER_NAME"
    exit 0
    ;;
  blocked)
    CHECKPOINT_HU="$TRACKER_SCOPE_HU"
    write_lock_status "blocked" 0
    printf '%s: Azure delivery HU %s has pending child tickets, but all are blocked by open predecessors\n' \
      "$RUNNER_NAME" "$TRACKER_SCOPE_HU" >&2
    exit 2
    ;;
  ready)
    [[ "$TRACKER_SCOPE_HU" =~ ^[1-9][0-9]*$ && \
       "$TRACKER_SCOPE_ITEM" =~ ^[1-9][0-9]*$ ]] || \
      die "tracker returned an invalid Azure HU/ticket scope"
    CHECKPOINT_HU="$TRACKER_SCOPE_HU"
    CHECKPOINT_TICKET="$TRACKER_SCOPE_ITEM"
    CHECKPOINT_ISSUE="$TRACKER_SCOPE_ITEM"
    # Bootstrap the HU integration branch before the worker is launched.
    # The HU branch is the only integration target for ticket pull
    # requests; without it the worker cannot complete the ticket
    # lifecycle. The bootstrap fails closed on missing origin, ambiguous
    # category, or refusing operator session so the runner never
    # guesses a branch.
    tracker_prepare_hu_branch "$TRACKER_SCOPE_HU" "" "${STARTUP_RECOVERY_MODE:-false}" || {
      if [[ -n "${STARTUP_RECOVERY_MODE:-}" ]]; then
        printf '%s: Azure HU integration branch bootstrap failed during recovery\n' \
          "$RUNNER_NAME" >&2
        exit 4
      fi
      printf '%s: Azure HU integration branch bootstrap failed; refusing to guess the HU origin branch\n' \
        "$RUNNER_NAME" >&2
      write_lock_status "blocked" 0
      exit 2
    }
    tracker_publish_hu_branch
    write_lock_status "scope_selected" 0
    ;;
  *)
    die "tracker returned an unknown delivery scope status: ${TRACKER_SCOPE_STATUS:-unknown}"
    ;;
esac

BASE_PROMPT="$(<"$PROMPT_FILE")"
TRACKER_SCOPE_PROMPT="$(tracker_worker_scope_prompt)"
# Compose the tracker-specific supplement by delegating to the
# selected adapter. The shared PROMPT.md remains the source of
# truth for safety, status reporting, and recovery semantics; the
# supplement only contributes tracker-specific lifecycle rules
# (issue vs. HU+child unit, branch target, merge verification,
# closure semantics). The supplement is intentionally excluded
# from checkpoints and lock status so secret-bearing or sensitive
# wording can never leak through persistent recovery state.
TRACKER_SUPPLEMENT="$(tracker_worker_supplement)" || \
  die "tracker adapter did not provide a worker supplement"

while true; do
  ITERATION=$((ITERATION + 1))
  if [[ -n "${STARTUP_RECOVERY_MODE:-}" ]]; then
    CHECKPOINT_ISSUE="$STARTUP_RECOVERY_ISSUE"
    CHECKPOINT_STATE="$(checkpoint_value state "$(checkpoint_file)")"
    CHECKPOINT_SESSION_ID="$(checkpoint_value session_id "$(checkpoint_file)")"
    CHECKPOINT_SESSION_CLI="$(checkpoint_value session_cli "$(checkpoint_file)")"
    CHECKPOINT_HU="$(checkpoint_value hu "$(checkpoint_file)")"
    CHECKPOINT_TICKET="$(checkpoint_value ticket "$(checkpoint_file)")"
  else
    CHECKPOINT_ISSUE="${TRACKER_SCOPE_ITEM:-}"
    CHECKPOINT_HU="${TRACKER_SCOPE_HU:-}"
    CHECKPOINT_TICKET="${TRACKER_SCOPE_ITEM:-}"
    CHECKPOINT_SESSION_CLI=""
    CHECKPOINT_STATE="starting"
    CHECKPOINT_SESSION_ID=""
  fi
  RECOVERY_ATTEMPT=0
  RECOVERY_CATEGORY=""
  RECOVERY_DELAY=""
  if [[ -z "${STARTUP_RECOVERY_MODE:-}" ]]; then
    assert_clean_worktree
  fi

  if [[ -z "${STARTUP_RECOVERY_MODE:-}" ]]; then
    # Record an initial checkpoint for this attempt before any worker process
    # runs. The runner fills in `issue`, `state`, and (when available)
    # `session_id` as the worker emits identifying events. A migrated
    # checkpoint already carries the previous iteration's identity; keep
    # it intact so the restart recovery can re-adopt the original issue
    # exactly once.
    write_checkpoint "starting"
    write_lock_status "starting" 0
  else
    write_lock_status "recovery_starting" 0
  fi

  if [[ -n "${STARTUP_RECOVERY_MODE:-}" ]]; then
    WORKER_PROMPT="${BASE_PROMPT}

${TRACKER_SUPPLEMENT}

${TRACKER_SCOPE_PROMPT}

${STARTUP_RECOVERY_PROMPT}

Runtime configuration:
- Repository root: ${REPO_ROOT}
- Base branch: ${BASE_BRANCH}
- This is restart recovery iteration ${ITERATION}.

Do not inspect the queue for another issue. Continue only the recovery target."
  else
    WORKER_PROMPT="${BASE_PROMPT}

${TRACKER_SUPPLEMENT}

${TRACKER_SCOPE_PROMPT}

Runtime configuration:
- Repository root: ${REPO_ROOT}
- Base branch: ${BASE_BRANCH}
- This is worker iteration ${ITERATION}.

Begin by inspecting the live tracker and repository state. Remember: exactly one
non-epic issue in this session."
  fi

  OUTPUT_FILE="$(mktemp "${TMPDIR:-/tmp}/${RUNNER_NAME}.XXXXXX")"
  if [[ -n "${STARTUP_RECOVERY_MODE:-}" ]]; then
    printf '\n[%s] Starting recovery worker for issue %s at %s\n' \
      "$RUNNER_NAME" "$STARTUP_RECOVERY_ISSUE" "$(timestamp)"
  else
    printf '\n[%s] Starting fresh worker %s at %s\n' \
      "$RUNNER_NAME" "$ITERATION" "$(timestamp)"
  fi

  RECOVERY_REQUIRED_REACHED=false
  attempt_with_recovery "$WORKER_PROMPT" "$OUTPUT_FILE" "${STARTUP_RECOVERY_SESSION:-}" || \
    RECOVERY_REQUIRED_REACHED=true

  # The renderer subshell carries the identified issue in a side-channel
  # file so the supervisor can adopt it before writing the final
  # checkpoint for this attempt.
  ISSUE_FILE="${OUTPUT_FILE}.issue"
  if [[ -s "$ISSUE_FILE" ]]; then
    CHECKPOINT_ISSUE="$(<"$ISSUE_FILE")"
  fi

  WORKER_STATUS="$(
    sed -n "s/^${STATUS_PREFIX}//p" "$OUTPUT_FILE" | tail -n 1
  )"

  if [[ "$RECOVERY_REQUIRED_REACHED" == "true" ]]; then
    finalize_attempt_state "recovery_required"
    RECOVERY_CATEGORY="recovery_required"
    write_lock_status "recovery_required" 0
    printf '%s%s\n' "$STATUS_PREFIX" "RECOVERY_REQUIRED" >> "$OUTPUT_FILE"
    printf '%s: RECOVERY_REQUIRED for issue %s after %s attempt(s); output retained at %s\n' \
      "$RUNNER_NAME" "${CHECKPOINT_ISSUE:-unknown}" "$RECOVERY_ATTEMPT" "$OUTPUT_FILE" >&2
    exit 4
  fi

  if [[ "$WORKER_EXIT" -ne 0 ]]; then
    finalize_attempt_state "failed"
    printf '%s: worker %s exited with code %s; output retained at %s\n' \
      "$RUNNER_NAME" "$ITERATION" "$WORKER_EXIT" "$OUTPUT_FILE" >&2
    exit 1
  fi

  case "$WORKER_STATUS" in
    ISSUE_COMPLETED)
      if [[ "$TRACKER_KIND" == "azure-devops" ]]; then
        if [[ ! "${CHECKPOINT_ISSUE:-}" =~ ^[0-9]+$ ]]; then
          finalize_attempt_state "recovery_required"
          write_lock_status "recovery_required" 0
          printf '%s%s\n' "$STATUS_PREFIX" "RECOVERY_REQUIRED" >> "$OUTPUT_FILE"
          printf '%s: Azure completion marker did not identify a numeric work item; output retained at %s\n' \
            "$RUNNER_NAME" "$OUTPUT_FILE" >&2
          exit 4
        fi
        completion_branch="$(current_branch)"
        if [[ "$completion_branch" == "$BASE_BRANCH" || "$completion_branch" == "unknown" ]]; then
          completion_branch="$(checkpoint_value branch "$(checkpoint_file)")"
        fi
        if ! tracker_item_completion_verified "$CHECKPOINT_ISSUE" "$completion_branch"; then
          finalize_attempt_state "recovery_required"
          write_lock_status "recovery_required" 0
          printf '%s%s\n' "$STATUS_PREFIX" "RECOVERY_REQUIRED" >> "$OUTPUT_FILE"
          printf '%s: Azure completion marker was not confirmed by live work-item and PR state; output retained at %s\n' \
            "$RUNNER_NAME" "$OUTPUT_FILE" >&2
          exit 4
        fi
        advance_checkpoint_state "pr_merged" "$OUTPUT_FILE"
        advance_checkpoint_state "issue_closed" "$OUTPUT_FILE"
      fi
      rm -f "$OUTPUT_FILE" "${OUTPUT_FILE}.issue" "${OUTPUT_FILE}.touch" 2>/dev/null || true
      clear_checkpoint
      # Remove the worker session transcript alongside the checkpoint
      # (issue #57). Verified ISSUE_COMPLETED is one of the two
      # terminal outcomes that bound transcript accumulation; removal
      # failure must not abort a run that has already cleared its
      # checkpoint and verified the live tracker state.
      runtime_remove_session_transcript "${CHECKPOINT_SESSION_ID:-}" || true
      printf '[%s] Worker %s completed one issue.\n' "$RUNNER_NAME" "$ITERATION"
      if [[ -n "${STARTUP_RECOVERY_MODE:-}" ]]; then
        printf '[%s] Restart recovery completed; returning to normal queue loop.\n' "$RUNNER_NAME"
        STARTUP_RECOVERY_MODE=""
        STARTUP_RECOVERY_ISSUE=""
        STARTUP_RECOVERY_SESSION=""
        STARTUP_RECOVERY_PROMPT=""
      fi
      if [[ "$MAX_ITERATIONS" -gt 0 && "$ITERATION" -ge "$MAX_ITERATIONS" ]]; then
        printf '%s: iteration limit reached after %s completed issue(s)\n' \
          "$RUNNER_NAME" "$ITERATION"
        exit 3
      fi
      if [[ "$TRACKER_KIND" == "azure-devops" && \
            "${TRACKER_SCOPE_STATUS:-}" == "ready" ]]; then
        completed_hu="$TRACKER_SCOPE_HU"
        tracker_prepare_worker_scope "$completed_hu" true || \
          die "unable to re-evaluate pinned Azure delivery HU ${completed_hu} after ticket completion"
        case "$TRACKER_SCOPE_STATUS" in
          ready)
            CHECKPOINT_HU="$TRACKER_SCOPE_HU"
            CHECKPOINT_TICKET="$TRACKER_SCOPE_ITEM"
            CHECKPOINT_ISSUE="$TRACKER_SCOPE_ITEM"
            TRACKER_SCOPE_PROMPT="$(tracker_worker_scope_prompt)"
            printf '[%s] Azure delivery HU %s advanced to ticket %s.\n' \
              "$RUNNER_NAME" "$TRACKER_SCOPE_HU" "$TRACKER_SCOPE_ITEM"
            ;;
          empty|queue_empty)
            printf '[%s] Azure delivery HU %s has no pending direct child tickets.\n' \
              "$RUNNER_NAME" "$completed_hu"
            printf '[%s] No pending, available, non-epic issues remain.\n' "$RUNNER_NAME"
            exit 0
            ;;
          blocked)
            printf '%s: Azure delivery HU %s has pending child tickets, but all are blocked by open predecessors\n' \
              "$RUNNER_NAME" "$completed_hu" >&2
            exit 2
            ;;
          *)
            die "tracker returned an invalid Azure scope after ticket completion: ${TRACKER_SCOPE_STATUS:-unknown}"
            ;;
        esac
      fi
      ;;
    QUEUE_EMPTY)
      rm -f "$OUTPUT_FILE" "${OUTPUT_FILE}.issue" "${OUTPUT_FILE}.touch" 2>/dev/null || true
      if [[ -z "${STARTUP_RECOVERY_MODE:-}" ]]; then
        clear_checkpoint
        # Remove the worker session transcript alongside the checkpoint
        # (issue #57). Verified QUEUE_EMPTY is the other terminal
        # outcome that bounds transcript accumulation; removal failure
        # must not abort a run that has already cleared its checkpoint.
        runtime_remove_session_transcript "${CHECKPOINT_SESSION_ID:-}" || true
      fi
      printf '[%s] No pending, available, non-epic issues remain.\n' "$RUNNER_NAME"
      exit 0
      ;;
    BLOCKED)
      finalize_attempt_state "blocked"
      printf '%s: pending work requires human input; output retained at %s\n' \
        "$RUNNER_NAME" "$OUTPUT_FILE" >&2
      exit 2
      ;;
    FAILED)
      finalize_attempt_state "failed"
      printf '%s: worker failed to finish its issue; output retained at %s\n' \
        "$RUNNER_NAME" "$OUTPUT_FILE" >&2
      exit 1
      ;;
    *)
      finalize_attempt_state "malformed"
      printf '%s: worker returned no recognized status; output retained at %s\n' \
        "$RUNNER_NAME" "$OUTPUT_FILE" >&2
      exit 1
      ;;
  esac
done
