#!/usr/bin/env bash
set -euo pipefail

real_az="${AZURE_GUARD_REAL_AZ:-}"
[[ -x "$real_az" ]] || {
  printf '%s: guarded Azure CLI is missing its real az executable\n' \
    "${RUNNER_NAME:-issue-killer}" >&2
  exit 1
}

if [[ "${1:-} ${2:-} ${3:-}" == "boards work-item update" ]]; then
  state=""
  previous=""
  for argument in "$@"; do
    if [[ "$previous" == "--state" ]]; then
      state="$argument"
    fi
    previous="$argument"
  done

  if [[ "$state" == "${AZURE_GUARD_CLOSED_STATE:-}" ]]; then
    branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
    [[ -n "$branch" && "$branch" != "unknown" ]] || {
      printf '%s: refusing Azure work-item closure without a named source branch\n' \
        "${RUNNER_NAME:-issue-killer}" >&2
      exit 1
    }

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
    jq -e --arg base "refs/heads/${AZURE_GUARD_BASE_BRANCH:-main}" '
      length == 1
      and (.[0].status // "") == "completed"
      and (.[0].mergeStatus // "") == "succeeded"
      and (.[0].targetRefName // "") == $base
    ' <<<"$pr_json" >/dev/null || {
      printf '%s: refusing Azure work-item closure until exactly one PR is merged into %s\n' \
        "${RUNNER_NAME:-issue-killer}" "${AZURE_GUARD_BASE_BRANCH:-main}" >&2
      exit 1
    }
  fi
fi

exec "$real_az" "$@"
