#!/usr/bin/env bash
# GitHub implementation of the normalized tracker boundary.
#
# The supervisor and runtime adapter call the tracker_* functions below rather
# than constructing GitHub commands or interpreting GitHub state themselves.
# A future tracker adapter can provide the same operations for another host.

TRACKER_KIND=""
TRACKER_REPO_SLUG=""

tracker_prepare_worker_environment() { :; }
tracker_cleanup_worker_environment() { :; }

tracker_validate_run_options() {
  local hu_id="${1:-}"

  if [[ -n "$hu_id" ]]; then
    printf '%s: --hu is only supported for Azure DevOps repositories\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  fi
}

tracker_prepare_worker_scope() {
  TRACKER_SCOPE_STATUS="worker_selects"
  TRACKER_SCOPE_HU=""
  TRACKER_SCOPE_ITEM=""
}

tracker_worker_scope_prompt() { :; }

tracker_slug_from_url() {
  local url="$1"
  local slug

  case "$url" in
    git@github.com:*) slug="${url#git@github.com:}" ;;
    ssh://git@github.com/*) slug="${url#ssh://git@github.com/}" ;;
    https://github.com/*) slug="${url#https://github.com/}" ;;
    http://github.com/*) slug="${url#http://github.com/}" ;;
    *) return 1 ;;
  esac

  slug="${slug%.git}"
  [[ "$slug" == */* && "$slug" != */*/* ]] || return 1
  printf '%s\n' "$slug"
}

tracker_initialize() {
  local repo_root="$1"
  local docs remote url slug discovered="" count=0

  command -v gh >/dev/null 2>&1 || {
    printf '%s: gh is required for the GitHub tracker; install GitHub CLI and authenticate with `gh auth login`.\n' \
      "$RUNNER_NAME" >&2
    return 1
  }

  while IFS= read -r remote; do
    [[ -n "$remote" ]] || continue
    url="$(git -C "$repo_root" config --get "remote.${remote}.url" 2>/dev/null || true)"
    slug="$(tracker_slug_from_url "$url" 2>/dev/null || true)"
    [[ -n "$slug" ]] || {
      printf '%s: unsupported or ambiguous tracker remote: %s (%s)\n' \
        "$RUNNER_NAME" "$remote" "${url:-missing URL}" >&2
      return 1
    }
    if [[ -n "$discovered" && "$slug" != "$discovered" ]]; then
      printf '%s: ambiguous GitHub remotes resolve to %s and %s\n' \
        "$RUNNER_NAME" "$discovered" "$slug" >&2
      return 1
    fi
    discovered="$slug"
    count=$((count + 1))
  done < <(git -C "$repo_root" remote 2>/dev/null)

  [[ "$count" -gt 0 && -n "$discovered" ]] || {
    printf '%s: unable to determine a GitHub tracker remote\n' "$RUNNER_NAME" >&2
    return 1
  }

  docs="${repo_root}/docs/agents/issue-tracker.md"
  [[ -r "$docs" ]] || {
    printf '%s: tracker documentation is missing: %s\n' "$RUNNER_NAME" "$docs" >&2
    return 1
  }
  grep -Fqx '# Issue Tracker: GitHub' "$docs" || {
    printf '%s: tracker documentation conflicts with the GitHub remote: %s\n' \
      "$RUNNER_NAME" "$docs" >&2
    return 1
  }
  grep -Fq 'gh' "$docs" || {
    printf '%s: tracker documentation does not declare the gh CLI: %s\n' \
      "$RUNNER_NAME" "$docs" >&2
    return 1
  }

  if ! gh auth status --hostname github.com >/dev/null 2>&1; then
    printf '%s: GitHub CLI authentication is unavailable; run `gh auth login` before starting a worker\n' \
      "$RUNNER_NAME" >&2
    return 1
  fi

  TRACKER_KIND="github"
  TRACKER_REPO_SLUG="$discovered"
  printf '[%s] Tracker validated: GitHub (%s)\n' "$RUNNER_NAME" "$TRACKER_REPO_SLUG"
}

tracker_item_read() {
  gh issue view "$1" --json state,labels,assignees,issueType,number,title,url,body
}

tracker_item_state() {
  local item_json="$1"
  jq -r '.state // empty' <<<"$item_json"
}

# Returns 0 when the issue is in a closed state, 1 otherwise (open, missing,
# or unreadable). The migrated-checkpoint adoption path uses this to detect
# a stale checkpoint whose work was already merged and closed; it must not
# rely on tracker_reconcile_startup_state, which emits RECOVERY_REQUIRED on
# the same condition. Failure to read the issue is treated as "not closed"
# so the adoption path falls through to the full reconciliation, where the
# ambiguous read will fail closed with an explicit diagnostic.
tracker_item_is_closed() {
  local issue_number="$1"
  local issue_json state
  [[ "$issue_number" =~ ^[0-9]+$ ]] || return 1
  issue_json="$(tracker_item_read "$issue_number" 2>/dev/null)" || return 1
  state="$(tracker_item_state "$issue_json")"
  [[ "$state" == "CLOSED" ]]
}

tracker_item_dependencies() {
  local issue_number="$1"
  gh api "repos/${TRACKER_REPO_SLUG}/issues/${issue_number}" \
    --jq '.issue_dependencies_summary.blocked_by // 0'
}

tracker_item_claim() {
  gh issue edit "$1" --add-assignee @me
}

tracker_item_close() {
  gh issue close "$1"
}

tracker_prs_for_branch() {
  gh pr list --state all --head "$1" --json state,number,mergedAt
}

tracker_pr_is_merged() {
  local pr_json="$1"
  jq -r 'if length == 1 then ((.[0].mergedAt // null) != null) else "ambiguous" end' \
    <<<"$pr_json"
}

tracker_list_eligible_items() {
  local issue_json item number blocked

  issue_json="$(gh issue list --state open --limit 100 \
    --json number,title,labels,assignees,issueType)" || return 1
  while IFS= read -r item; do
    number="$(jq -r '.number // empty' <<<"$item")"
    [[ "$number" =~ ^[0-9]+$ ]] || continue
    blocked="$(tracker_item_dependencies "$number" 2>/dev/null || printf 'unknown')"
    [[ "$blocked" == "0" ]] || continue
    printf '%s\n' "$number"
  done < <(
    jq -c '.[]
      | (.issueType.name // .issueType // "") as $type
      | select($type != "Epic")
      | select((.title // "") | startswith("[Epic]") | not)
      | select(([.labels[]?.name] | map(ascii_downcase) | index("epic")) == null)
      | select((.assignees // []) | length == 0)
      | select(([.labels[]?.name] | index("ready-for-agent")) != null)' \
      <<<"$issue_json"
  )
}

# Reconcile an interrupted item without mutating Git, the PR, or the item.
# Returns completed, merged_no_issue, pr_open, branch_only, no_work, unknown.
tracker_reconcile_recovery_state() {
  local issue_number="$1"
  local branch="$(current_branch)"
  local pr_json pr_count merged issue_json state

  [[ "$branch" != "unknown" ]] || { printf 'unknown\n'; return 0; }
  if [[ -z "$issue_number" || ! "$issue_number" =~ ^[0-9]+$ ]]; then
    if git show-ref --verify --quiet "refs/heads/${branch}"; then
      printf 'branch_only\n'
    else
      printf 'no_work\n'
    fi
    return 0
  fi

  pr_json="$(tracker_prs_for_branch "$branch" 2>/dev/null)" || {
    printf 'unknown\n'
    return 0
  }
  pr_count="$(jq -r 'length' <<<"$pr_json" 2>/dev/null || printf 'unknown')"
  [[ "$pr_count" =~ ^[0-9]+$ ]] || { printf 'unknown\n'; return 0; }
  if [[ "$pr_count" -eq 0 ]]; then
    if git show-ref --verify --quiet "refs/heads/${branch}"; then
      printf 'branch_only\n'
    else
      printf 'no_work\n'
    fi
    return 0
  fi
  [[ "$pr_count" -eq 1 ]] || { printf 'unknown\n'; return 0; }

  merged="$(tracker_pr_is_merged "$pr_json" 2>/dev/null || printf 'ambiguous')"
  [[ "$merged" == "true" || "$merged" == "false" ]] || {
    printf 'unknown\n'
    return 0
  }
  if [[ "$merged" == "true" ]]; then
    issue_json="$(tracker_item_read "$issue_number" 2>/dev/null)" || {
      printf 'unknown\n'
      return 0
    }
    state="$(tracker_item_state "$issue_json")"
    if [[ "$state" == "CLOSED" ]]; then
      printf 'completed\n'
    else
      printf 'merged_no_issue\n'
    fi
  else
    printf 'pr_open\n'
  fi
}

tracker_reconcile_startup_state() {
  local issue_number="$1"
  local branch="$2"
  local issue_json issue_state pr_json pr_count blocked_by merged

  issue_json="$(tracker_item_read "$issue_number" 2>/dev/null)" || {
    emit_recovery_required "unable to reconcile issue ${issue_number} before recovery"
  }
  issue_state="$(tracker_item_state "$issue_json")"
  [[ -n "$issue_state" ]] || \
    emit_recovery_required "unable to determine issue ${issue_number} state before recovery"

  blocked_by="$(tracker_item_dependencies "$issue_number" 2>/dev/null || true)"
  [[ "$blocked_by" =~ ^[0-9]+$ ]] || \
    emit_recovery_required "ambiguous dependency state for issue ${issue_number}"
  [[ "$blocked_by" -eq 0 ]] || \
    emit_recovery_required "issue ${issue_number} is blocked by ${blocked_by} open issue(s)"

  pr_json="$(tracker_prs_for_branch "$branch" 2>/dev/null)" || \
    emit_recovery_required "unable to reconcile PR state for branch ${branch} before recovery"
  pr_count="$(jq -r 'length' <<<"$pr_json" 2>/dev/null || true)"
  [[ "$pr_count" =~ ^[0-9]+$ ]] || \
    emit_recovery_required "ambiguous PR state for branch ${branch}"
  [[ "$pr_count" -le 1 ]] || \
    emit_recovery_required "ambiguous PR state for branch ${branch}: ${pr_count} PRs found"
  [[ "$issue_state" != "CLOSED" ]] || \
    emit_recovery_required "issue ${issue_number} is already closed; refusing to launch a recovery worker over dirty files"
  if [[ "$pr_count" -eq 1 ]]; then
    merged="$(tracker_pr_is_merged "$pr_json" 2>/dev/null || true)"
    [[ "$merged" == "true" || "$merged" == "false" ]] || \
      emit_recovery_required "ambiguous merged state for PR on branch ${branch}"
    [[ "$merged" != "true" ]] || \
      emit_recovery_required "PR for branch ${branch} is already merged; refusing to duplicate recovery effects over dirty files"
  fi

  printf '[%s] Reconciled recovery target: issue %s is %s; open blockers: %s; PRs for %s: %s\n' \
    "$RUNNER_NAME" "$issue_number" "$issue_state" "$blocked_by" "$branch" "$pr_count"
}

# Returns the tracker-specific portion of the worker contract. The
# orchestrator concatenates this supplement with the shared
# PROMPT.md and the runtime configuration section before invoking
# any runtime adapter. GitHub treats the eligible issue as the
# single delivery unit: one branch, one pull request targeting the
# configured base branch, a verified merge, and issue closure.
# The supplement is intentionally restricted to lifecycle rules so
# the shared contract remains the source of truth for safety,
# status reporting, and recovery semantics.
tracker_worker_supplement() {
  printf '%s\n' \
    'GitHub tracker supplement:' \
    '- Treat the next `ready-for-agent` GitHub issue as the single delivery unit for this worker.' \
    '- Open exactly one ticket branch and exactly one pull request targeting the configured base branch.' \
    '- Confirm exactly one pull request exists for the source branch, that it is merged into the configured base branch, and only then close the issue.' \
    '- Do not target any other branch, do not open duplicate pull requests, and do not close the issue before the pull request merge is verified.'
}

# Translate tracker-specific worker commands into normalized runtime events.
# This is the only layer that knows GitHub's gh command vocabulary.
tracker_runtime_decode_command() {
  local cmd="$1"
  local issue_number

  case "$cmd" in
    "gh issue view "*)
      issue_number="$(printf '%s\n' "$cmd" | sed -nE 's/^gh issue view[[:space:]]+([0-9]+).*/\1/p')"
      if [[ -n "$issue_number" ]]; then
        printf 'identify\t%s\n' "$issue_number"
      else
        printf 'tracker\t\n'
      fi
      ;;
    "gh pr create"*) printf 'pr_create\t\n' ;;
    "gh pr merge"*|"gh pr close"*) printf 'pr_close\t\n' ;;
    "gh issue close"*) printf 'close\t\n' ;;
    "gh issue"*) printf 'tracker\t\n' ;;
    *) return 1 ;;
  esac
}
