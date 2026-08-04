#!/usr/bin/env bash
# Azure DevOps HU integration branch bootstrap.
#
# The runner owns the HU integration branch so workers can rely on a
# deterministic, persistent target for every ticket pull request. This module
# infers the HU delivery category, normalizes the title, computes the branch
# name, asks the operator for the origin on first use, validates the resulting
# branch, and reconciles the branch identity on recovery.
#
# The module is intentionally pure: it reads the HU work item, validates
# branches, and writes interactive prompts only through the canonical operator
# helpers. It never invokes the `az` CLI directly.

AZURE_HU_BRANCH_NAME=""
AZURE_HU_BRANCH_CATEGORY=""
AZURE_HU_BRANCH_ORIGIN=""
AZURE_HU_BRANCH_CREATED=false
AZURE_HU_BRANCH_REUSED=false

# Allowed category values. The set is closed: the worker, the
# checkpoint, and the recovery guard all reject unknown categories before
# any persistent effect is produced.
azure_hu_branch_categories() {
  printf '%s\n' 'feature' 'hotfix' 'refactor'
}

azure_hu_branch_category_is_known() {
  local candidate="$1"
  local known
  while IFS= read -r known; do
    [[ -n "$known" ]] || continue
    [[ "$known" == "$candidate" ]] && return 0
  done < <(azure_hu_branch_categories)
  return 1
}

# Original branches that the bootstrap may target. The validated enum
# keeps the runner from guessing an alternative origin such as the
# configured base branch, which would silently bypass the repository
# mainline requested by the operator.
azure_hu_branch_origin_branches() {
  printf '%s\n' 'master' 'develop'
}

# Returns 0 when the supplied branch name is one of the allowed origin
# branches. The validation is closed: any other value is rejected so
# the supervisor never creates an HU integration branch from a
# misconfigured oracular input.
azure_hu_branch_origin_is_allowed() {
  local origin="$1"
  local known
  while IFS= read -r known; do
    [[ -n "$known" ]] || continue
    [[ "$known" == "$origin" ]] && return 0
  done < <(azure_hu_branch_origin_branches)
  return 1
}

# Infers the HU delivery category from the HU type, title, and
# description. The heuristic is deterministic and closed:
#   - A Bug type is always a hotfix because the work item itself was
#     authored as a defect.
#   - A title that begins with "Refactor" (case-insensitive) or a
#     description that mentions "refactor" takes precedence over the
#     hotfix default.
#   - A title that begins with "Fix", "Hotfix", or "Bug" (case-
#     insensitive) selects the hotfix category.
#   - Everything else falls back to a feature.
# The function expects a fully-read Azure work-item JSON document and
# returns the categorized name on stdout. Empty inputs are rejected as
# ambiguous so the worker can never silently fall back to a default
# category. Lower-casing uses `tr` to remain compatible with Bash 3.2.
tracker_infer_hu_category() {
  local item_json="$1"
  local hu_type hu_title hu_description hu_type_lower hu_title_lower text

  [[ -n "$item_json" ]] || return 1
  hu_type="$(jq -r '.fields["System.WorkItemType"] // empty' <<<"$item_json")"
  hu_title="$(jq -r '.fields["System.Title"] // empty' <<<"$item_json")"
  hu_description="$(jq -r '.fields["System.Description"] // empty' <<<"$item_json")"
  [[ -n "$hu_type" ]] || return 1
  hu_title="${hu_title:-Untitled HU}"

  hu_type_lower="$(printf '%s' "$hu_type" | tr '[:upper:]' '[:lower:]')"
  hu_title_lower="$(printf '%s' "$hu_title" | tr '[:upper:]' '[:lower:]')"
  text="$(printf '%s\n%s' "$hu_title" "$hu_description" | tr '[:upper:]' '[:lower:]')"

  if [[ "$hu_type_lower" == "bug" ]]; then
    printf 'hotfix\n'
    return 0
  fi

  case "$hu_title_lower" in
    refactor*|cleanup*|restructure*)
      printf 'refactor\n'
      return 0
      ;;
  esac
  if grep -Fqi 'refactor' <<<"$text" || \
     grep -Fqi 'restructure' <<<"$text" || grep -Fqi 'cleanup' <<<"$text"; then
    printf 'refactor\n'
    return 0
  fi

  case "$hu_title_lower" in
    fix*|hotfix*|bug*)
      printf 'hotfix\n'
      return 0
      ;;
  esac
  if grep -Fqi 'defect' <<<"$text" || grep -Fqi 'outage' <<<"$text"; then
    printf 'hotfix\n'
    return 0
  fi

  printf 'feature\n'
}

# Normalizes an HU title into a branch-friendly slug. The slug keeps
# ASCII letters, digits, and dashes; everything else is collapsed into a
# single dash. Leading and trailing dashes are stripped; runs of dashes
# are merged. The result is truncated to 48 characters to keep the
# branch name inside the safe length for both Git and Azure DevOps.
azure_hu_branch_slug_from_title() {
  local title="$1"
  local slug

  slug="$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]')"
  slug="$(printf '%s' "$slug" | tr -cs '[:alnum:]' '-')"
  slug="$(printf '%s' "$slug" | sed -E 's/-+/-/g; s/^-+//; s/-+$//')"
  if [[ "${#slug}" -gt 48 ]]; then
    slug="${slug:0:48}"
    slug="$(printf '%s' "$slug" | sed -E 's/-+$//')"
  fi
  [[ -n "$slug" ]] || slug="hu"
  printf '%s\n' "$slug"
}

# Computes the deterministic HU integration branch name from the
# inferred category, the HU identifier, and the normalized title. The
# function is pure: it never reads from the worktree or the tracker.
# Callers use it to detect whether the existing branch already exists
# and to validate the persisted branch on recovery.
tracker_compute_hu_branch() {
  local hu_id="$1"
  local category="$2"
  local slug="$3"

  [[ "$hu_id" =~ ^[1-9][0-9]*$ ]] || {
    printf '%s: AZURE_HU_BRANCH: invalid HU identifier for branch naming: %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$hu_id" >&2
    return 1
  }
  azure_hu_branch_category_is_known "$category" || {
    printf '%s: AZURE_HU_BRANCH: unknown HU delivery category: %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$category" >&2
    return 1
  }
  [[ -n "$slug" ]] || {
    printf '%s: AZURE_HU_BRANCH: empty HU slug for branch naming\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  }

  printf '%s/%s-%s\n' "$category" "$hu_id" "$slug"
}

# Returns 0 when the configured base branch is allowed to act as the
# HU integration branch origin. The runner never asks the operator
# about the configured base branch because it is the global mainline
# target; the operator chooses between master and develop when the
# repository still maintains both.
azure_hu_branch_origin_is_known_branch() {
  local origin="$1"
  [[ -n "$origin" ]] || return 1
  if git show-ref --verify --quiet "refs/heads/${origin}"; then
    return 0
  fi
  if git show-ref --verify --quiet "refs/remotes/origin/${origin}"; then
    return 0
  fi
  return 1
}

# Returns the resolved SHA of the chosen origin branch. The function
# refuses to silently fall back to a different branch: any missing
# origin produces a non-zero exit so the supervisor stops safely.
azure_hu_branch_origin_sha() {
  local origin="$1"
  local sha
  if sha="$(git rev-parse --verify --quiet "refs/heads/${origin}^{commit}" 2>/dev/null)"; then
    printf '%s\n' "$sha"
    return 0
  fi
  if sha="$(git rev-parse --verify --quiet "refs/remotes/origin/${origin}^{commit}" 2>/dev/null)"; then
    printf '%s\n' "$sha"
    return 0
  fi
  printf '%s: AZURE_HU_BRANCH: origin branch %s is not available locally or at origin\n' \
    "${RUNNER_NAME:-issue-killer}" "$origin" >&2
  return 1
}

# Asks the operator whether the new HU integration branch should
# originate from master or develop. The function is interactive; the
# non-interactive first-run caller must short-circuit before invoking
# it. The prompt accepts only the exact branch names; any other input
# is rejected and re-prompted until the operator chooses one of the
# allowed values or the question is left empty, which preserves the
# last retry instead of guessing.
azure_hu_branch_prompt_origin() {
  local prompt_default="${1:-}"
  local answer option index

  if ! operator_session_available; then
    printf '%s: AZURE_HU_BRANCH: operator session is required to choose the HU origin branch\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  fi

  while true; do
    operator_prompt 'Azure delivery HU %s needs a new integration branch %s.\n' \
      "${AZURE_SCOPE_HU:-?}" "${AZURE_HU_BRANCH_NAME:-?}"
    operator_prompt 'Which repository branch should it originate from? [master/develop] '
    if [[ -n "$prompt_default" ]]; then
      operator_prompt '[%s] ' "$prompt_default"
    fi
    operator_read_answer || {
      printf '%s: AZURE_HU_BRANCH: unable to read HU origin branch from operator session\n' \
        "${RUNNER_NAME:-issue-killer}" >&2
      return 1
    }
    answer="$OPERATOR_ANSWER"
    if [[ -z "$answer" && -n "$prompt_default" ]]; then
      answer="$prompt_default"
    fi
    if [[ "$answer" == "master" || "$answer" == "develop" ]]; then
      printf '%s\n' "$answer"
      return 0
    fi
    printf '%s: invalid HU origin branch: %s (expected master or develop)\n' \
      "${RUNNER_NAME:-issue-killer}" "${answer:-empty}" >&2
  done
}

# Creates the HU integration branch from the verified origin commit.
# The branch is created locally so the worker can push it as part of
# the first ticket PR. The function refuses to overwrite an existing
# branch with the same name; reuse is the caller's responsibility.
azure_hu_branch_create() {
  local branch="$1"
  local origin="$2"
  local origin_sha

  [[ -n "$branch" && -n "$origin" ]] || return 1
  git show-ref --verify --quiet "refs/heads/${branch}" && {
    printf '%s: AZURE_HU_BRANCH: branch %s already exists; refusing to overwrite\n' \
      "${RUNNER_NAME:-issue-killer}" "$branch" >&2
    return 1
  }
  origin_sha="$(azure_hu_branch_origin_sha "$origin")" || return 1
  git branch "$branch" "$origin_sha" >/dev/null 2>&1 || {
    printf '%s: AZURE_HU_BRANCH: failed to create branch %s from %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$branch" "$origin_sha" >&2
    return 1
  }
  printf '%s: AZURE_HU_BRANCH: created %s from %s (%s)\n' \
    "${RUNNER_NAME:-issue-killer}" "$branch" "$origin" "$origin_sha"
}

# Validates that the existing branch ancestry matches the persisted
# origin SHA. The check fails closed when the branch is missing, when
# the persisted origin is unknown, or when the branch commit differs
# from the persisted origin; in each case the recovery must surface
# the conflict to the operator rather than silently forging ahead.
azure_hu_branch_verify_ancestry() {
  local branch="$1"
  local origin="$2"
  local origin_sha="$3"
  local branch_sha

  [[ -n "$branch" && -n "$origin" && -n "$origin_sha" ]] || return 1
  git show-ref --verify --quiet "refs/heads/${branch}" || {
    printf '%s: AZURE_HU_BRANCH: persisted branch %s is missing from the worktree\n' \
      "${RUNNER_NAME:-issue-killer}" "$branch" >&2
    return 1
  }
  if ! azure_hu_branch_origin_is_known_branch "$origin"; then
    printf '%s: AZURE_HU_BRANCH: persisted origin branch %s is unavailable\n' \
      "${RUNNER_NAME:-issue-killer}" "$origin" >&2
    return 1
  fi
  if ! git merge-base --is-ancestor "$origin_sha" "$branch" 2>/dev/null; then
    printf '%s: AZURE_HU_BRANCH: persisted branch %s does not descend from %s (%s)\n' \
      "${RUNNER_NAME:-issue-killer}" "$branch" "$origin" "$origin_sha" >&2
    return 1
  fi
  branch_sha="$(git rev-parse --verify --quiet "refs/heads/${branch}^{commit}" 2>/dev/null || true)"
  [[ -n "$branch_sha" ]] || return 1
  return 0
}

# Prepares the HU integration branch for the pinned HU. The function
# is read-only when the branch already exists: it does not create a
# new branch, does not ask the operator, and does not modify the
# branch ancestry. When the branch is absent, the function asks the
# operator for the origin branch (interactive) or stops safely
# (non-interactive). All persistent state is mirrored to the
# caller-visible globals so the supervisor can persist the values in
# the checkpoint and the lock status.
tracker_prepare_hu_branch() {
  local hu_id="$1"
  local hu_json="${2:-}"
  local allow_assigned="${3:-false}"
  local item_json slug category branch origin origin_sha

  AZURE_HU_BRANCH_NAME=""
  AZURE_HU_BRANCH_CATEGORY=""
  AZURE_HU_BRANCH_ORIGIN=""
  AZURE_HU_BRANCH_CREATED=false
  AZURE_HU_BRANCH_REUSED=false

  [[ "$hu_id" =~ ^[1-9][0-9]*$ ]] || {
    printf '%s: AZURE_HU_BRANCH: invalid HU identifier: %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$hu_id" >&2
    return 1
  }
  [[ "${TRACKER_KIND:-}" == "azure-devops" ]] || {
    printf '%s: AZURE_HU_BRANCH: called for a non-Azure tracker\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  }

  if [[ -z "$hu_json" ]]; then
    item_json="$(tracker_item_read "$hu_id" 2>/dev/null)" || {
      printf '%s: AZURE_HU_BRANCH: unable to read HU %s for branch bootstrap\n' \
        "${RUNNER_NAME:-issue-killer}" "$hu_id" >&2
      return 1
    }
  else
    item_json="$hu_json"
  fi

  category="$(tracker_infer_hu_category "$item_json")" || {
    printf '%s: AZURE_HU_BRANCH: unable to infer category for HU %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$hu_id" >&2
    return 1
  }
  slug="$(azure_hu_branch_slug_from_title \
    "$(jq -r '.fields["System.Title"] // empty' <<<"$item_json")")"
  branch="$(tracker_compute_hu_branch "$hu_id" "$category" "$slug")" || return 1

  AZURE_HU_BRANCH_NAME="$branch"
  AZURE_HU_BRANCH_CATEGORY="$category"

  if git show-ref --verify --quiet "refs/heads/${branch}"; then
    AZURE_HU_BRANCH_REUSED=true
    printf '%s: AZURE_HU_BRANCH: reusing existing branch %s for HU %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$branch" "$hu_id"
    return 0
  fi

  # When recovery is replaying a checkpoint, the HU branch must
  # already exist; the bootstrap never re-prompts the operator and
  # never guesses an origin for a checkpointed HU. The recovery
  # reconciliation guard (tracker_reconcile_hu_branch) is the
  # authoritative source of identity validation.
  if [[ "$allow_assigned" == "true" ]]; then
    printf '%s: AZURE_HU_BRANCH: persisted HU integration branch %s is missing during recovery\n' \
      "${RUNNER_NAME:-issue-killer}" "$branch" >&2
    return 1
  fi

  if ! operator_session_available; then
    printf '%s: AZURE_HU_BRANCH: non-interactive first run cannot guess the HU origin branch for %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$branch" >&2
    return 1
  fi

  origin="$(azure_hu_branch_prompt_origin "develop")" || return 1
  azure_hu_branch_origin_is_known_branch "$origin" || {
    printf '%s: AZURE_HU_BRANCH: origin branch %s is not available locally or at origin\n' \
      "${RUNNER_NAME:-issue-killer}" "$origin" >&2
    return 1
  }
  azure_hu_branch_create "$branch" "$origin" || return 1
  origin_sha="$(azure_hu_branch_origin_sha "$origin")" || return 1

  AZURE_HU_BRANCH_ORIGIN="$origin"
  AZURE_HU_BRANCH_CREATED=true
  return 0
}

# Reconciles the persisted HU branch identity with the live state.
# Called by the recovery guards before any worker is launched on an
# existing checkpoint. The function refuses ambiguous category,
# conflicting branch identity, or incompatible ancestry by emitting
# RECOVERY_REQUIRED though the supplied callback.
tracker_reconcile_hu_branch() {
  local persisted_branch="$1"
  local persisted_origin="$2"
  local persisted_origin_sha="$3"
  local persisted_category="$4"
  local hu_id="$5"
  local item_json category slug recomputed
  local emit_callback="${6:-emit_recovery_required}"

  [[ -n "$persisted_branch" ]] || {
    "$emit_callback" "Azure checkpoint is missing the HU integration branch name"
    return 1
  }
  [[ "$persisted_category" =~ ^[a-z]+$ ]] || {
    "$emit_callback" "Azure checkpoint is missing the HU delivery category"
    return 1
  }
  azure_hu_branch_category_is_known "$persisted_category" || {
    "$emit_callback" "Azure checkpoint HU category is unknown: ${persisted_category}"
    return 1
  }

  if [[ -n "$hu_id" ]]; then
    item_json="$(tracker_item_read "$hu_id" 2>/dev/null)" || {
      "$emit_callback" "unable to reconcile Azure HU ${hu_id} for branch recovery"
      return 1
    }
    category="$(tracker_infer_hu_category "$item_json")" || {
      "$emit_callback" "unable to infer Azure HU category for ${hu_id} during recovery"
      return 1
    }
    slug="$(azure_hu_branch_slug_from_title \
      "$(jq -r '.fields["System.Title"] // empty' <<<"$item_json")")"
    recomputed="$(tracker_compute_hu_branch "$hu_id" "$category" "$slug")" || {
      "$emit_callback" "unable to recompute Azure HU branch for ${hu_id} during recovery"
      return 1
    }
    [[ "$recomputed" == "$persisted_branch" ]] || {
      "$emit_callback" "Azure HU branch ${persisted_branch} does not match the recomputed ${recomputed}"
      return 1
    }
    [[ "$category" == "$persisted_category" ]] || {
      "$emit_callback" "Azure HU category ${persisted_category} does not match the inferred ${category}"
      return 1
    }
  fi

  if [[ -n "$persisted_origin" && -n "$persisted_origin_sha" ]]; then
    azure_hu_branch_origin_is_allowed "$persisted_origin" || {
      "$emit_callback" "Azure HU origin branch ${persisted_origin} is not an allowed origin"
      return 1
    }
    azure_hu_branch_verify_ancestry "$persisted_branch" "$persisted_origin" "$persisted_origin_sha" || {
      "$emit_callback" "Azure HU branch ${persisted_branch} ancestry does not match persisted origin"
      return 1
    }
  fi

  return 0
}
