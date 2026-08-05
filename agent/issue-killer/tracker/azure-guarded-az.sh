#!/usr/bin/env bash
set -euo pipefail

real_az="${AZURE_GUARD_REAL_AZ:-}"
[[ -x "$real_az" ]] || {
  printf '%s: guarded Azure CLI is missing its real az executable\n' \
    "${RUNNER_NAME:-issue-killer}" >&2
  exit 1
}

# Resolves the integration branch the closure guard should compare PR
# targets against. When a delivery HU integration branch is pinned, every
# ticket pull request must target that branch rather than the configured
# repository base branch. Falling back to the configured base branch keeps
# non-HU Azure work items and ad-hoc deliveries behavior-compatible with
# the previous guard.
azure_guard_target_branch() {
  if [[ -n "${AZURE_GUARD_HU_BRANCH:-}" ]]; then
    printf '%s\n' "$AZURE_GUARD_HU_BRANCH"
    return 0
  fi
  printf '%s\n' "${AZURE_GUARD_BASE_BRANCH:-main}"
}

# Reads the value of the configured completion evidence field on a work
# item. Returns the value on stdout and a non-zero exit when the field is
# absent or unreadable; the closure guard uses both signals to refuse
# Done when evidence is missing. The function deliberately avoids
# embedding any helper modules so the guarded CLI stays self-contained
# and can be invoked from any worker process.
azure_guard_read_field() {
  local item_id="$1"
  local field_name="$2"

  [[ -n "$field_name" ]] || return 1
  [[ "$item_id" =~ ^[1-9][0-9]*$ ]] || return 1
  "$real_az" boards work-item show \
    --id "$item_id" \
    --expand all \
    --org "$AZURE_GUARD_ORGANIZATION_URL" \
    --output json 2>/dev/null | \
    jq -r --arg f "$field_name" '.fields[$f] // empty' || return 1
}

# Lists the native development relations (ArtifactLinks) attached to a
# work item. Returns one relation per line in the form
# `<type>\t<url>` and exits non-zero when the work item cannot be read.
azure_guard_list_relations() {
  local item_id="$1"

  [[ "$item_id" =~ ^[1-9][0-9]*$ ]] || return 1
  "$real_az" boards work-item show \
    --id "$item_id" \
    --expand all \
    --org "$AZURE_GUARD_ORGANIZATION_URL" \
    --output json 2>/dev/null | \
    jq -r '.relations[]?
      | select((.rel // "") | ascii_downcase | test("artifactlink"))
      | [(.attributes.name // .attributes."Artifact Link Type" // "Unknown"),
         (.url // empty)]
      | @tsv'
}

# Verifies every Azure ticket completion prerequisite before the closure
# guard accepts `Done`. The function is intentionally minimal: it never
# depends on the tracker adapter module so it stays usable from any
# worker invocation through the guarded CLI symlink. Each prerequisite
# that fails exits non-zero with an actionable diagnostic.
azure_guard_check_prerequisites() {
  local item_id="$1"
  local branch="$2"
  local evidence effort relations pr_relation commit_relation

  [[ -n "$branch" && "$branch" != "unknown" ]] || {
    printf '%s: refusing Azure work-item closure because source branch is unknown\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  }

  evidence="$(azure_guard_read_field "$item_id" "${AZURE_GUARD_EVIDENCE_FIELD:-}")" || evidence=""
  [[ -n "$evidence" ]] || {
    printf '%s: refusing Azure work-item closure %s until completion evidence is published\n' \
      "${RUNNER_NAME:-issue-killer}" "$item_id" >&2
    return 1
  }

  effort="$(azure_guard_read_field "$item_id" "${AZURE_GUARD_EFFORT_FIELD:-}")" || effort=""
  [[ "$effort" =~ ^[0-9]+(\.[0-9]+)?$ ]] || {
    printf '%s: refusing Azure work-item closure %s until Real Effort is recorded\n' \
      "${RUNNER_NAME:-issue-killer}" "$item_id" >&2
    return 1
  }

  relations="$(azure_guard_list_relations "$item_id" 2>/dev/null || true)"
  [[ -n "$relations" ]] || {
    printf '%s: refusing Azure work-item closure %s until development relations are attached\n' \
      "${RUNNER_NAME:-issue-killer}" "$item_id" >&2
    return 1
  }
  pr_relation="$(printf '%s\n' "$relations" | grep -Fi 'pull request' || true)"
  commit_relation="$(printf '%s\n' "$relations" | grep -Fi 'commit' || true)"
  [[ -n "$pr_relation" && -n "$commit_relation" ]] || {
    printf '%s: refusing Azure work-item closure %s until native development relations to the pull request and integrated commit are attached\n' \
      "${RUNNER_NAME:-issue-killer}" "$item_id" >&2
    return 1
  }
  return 0
}

if [[ "${1:-} ${2:-} ${3:-}" == "boards work-item update" ]]; then
  state=""
  item_id=""
  previous=""
  for argument in "$@"; do
    case "$previous" in
      --state) state="$argument" ;;
      --id) item_id="$argument" ;;
    esac
    previous="$argument"
  done

  if [[ "$state" == "${AZURE_GUARD_CLOSED_STATE:-}" ]]; then
    branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
    [[ -n "$branch" && "$branch" != "unknown" ]] || {
      printf '%s: refusing Azure work-item closure without a named source branch\n' \
        "${RUNNER_NAME:-issue-killer}" >&2
      exit 1
    }

    target_branch="$(azure_guard_target_branch)"
    pr_json="$("$real_az" repos pr list \
      --repository "$AZURE_GUARD_REPOSITORY" \
      --source-branch "$branch" \
      --status all \
      --org "$AZURE_GUARD_ORGANIZATION_URL" \
      --project "$AZURE_GUARD_PROJECT" \
      --output json)" || {
        printf '%s: refusing Azure work-item closure because PR state could not be read\n' \
          "${RUNNER_NAME:-issue-killer}" >&2
        exit 1
      }
    jq -e --arg base "refs/heads/${target_branch}" '
      length == 1
      and (.[0].status // "") == "completed"
      and (.[0].mergeStatus // "") == "succeeded"
      and (.[0].targetRefName // "") == $base
    ' <<<"$pr_json" >/dev/null || {
      printf '%s: refusing Azure work-item closure until exactly one PR is merged into %s\n' \
        "${RUNNER_NAME:-issue-killer}" "$target_branch" >&2
      exit 1
    }

    [[ "$item_id" =~ ^[1-9][0-9]*$ ]] || {
      printf '%s: refusing Azure work-item closure because --id is missing\n' \
        "${RUNNER_NAME:-issue-killer}" >&2
      exit 1
    }
    azure_guard_check_prerequisites "$item_id" "$branch" || exit 1
  fi
fi

exec "$real_az" "$@"