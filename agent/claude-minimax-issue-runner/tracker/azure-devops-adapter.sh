#!/usr/bin/env bash
# Azure DevOps implementation of the normalized tracker boundary.
#
# The adapter reads repository-owned mappings from docs/agents/issue-tracker.md
# and keeps all Azure-specific CLI, work-item, relation, and pull-request
# details outside the supervisor.

TRACKER_KIND=""
TRACKER_REPO_SLUG=""
AZURE_ORGANIZATION=""
AZURE_PROJECT=""
AZURE_REPOSITORY=""
AZURE_ELIGIBLE_TYPES=""
AZURE_EPIC_TYPES=""
AZURE_OPEN_STATES=""
AZURE_CLOSED_STATES=""
AZURE_READY_TAG=""
AZURE_CLAIM_IDENTITY=""
AZURE_PREDECESSOR_RELATION=""
AZURE_CLOSED_STATE=""
AZURE_GUARD_DIR=""

tracker_prepare_worker_environment() {
  local guard_bin real_az adapter_dir

  real_az="$(command -v az 2>/dev/null || true)"
  [[ -x "$real_az" ]] || return 1
  adapter_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  AZURE_GUARD_DIR="${TMPDIR:-/tmp}/${RUNNER_NAME:-issue-killer}.azure-az.$$"
  mkdir -p "$AZURE_GUARD_DIR" || return 1
  guard_bin="${AZURE_GUARD_DIR}/az"
  ln -s "${adapter_dir}/azure-guarded-az.sh" "$guard_bin" || return 1
  export AZURE_GUARD_REAL_AZ="$real_az"
  export AZURE_GUARD_CLOSED_STATE="$AZURE_CLOSED_STATE"
  export AZURE_GUARD_ORGANIZATION_URL="$(azure_organization_url)"
  export AZURE_GUARD_PROJECT="$AZURE_PROJECT"
  export AZURE_GUARD_REPOSITORY="$AZURE_REPOSITORY"
  export AZURE_GUARD_BASE_BRANCH="${BASE_BRANCH:-main}"
  export PATH="${AZURE_GUARD_DIR}:$PATH"
}

tracker_cleanup_worker_environment() {
  [[ -n "$AZURE_GUARD_DIR" ]] || return 0
  rm -rf "$AZURE_GUARD_DIR"
  AZURE_GUARD_DIR=""
}

azure_config_raw_value() {
  local doc="$1"
  local key="$2"

  awk -v wanted="$key" '
    $0 == "## Azure DevOps configuration" { in_section = 1; next }
    in_section && /^## / { exit }
    in_section && $0 ~ "^[[:space:]]*" wanted "[[:space:]]*=" {
      line = $0
      sub("^[[:space:]]*" wanted "[[:space:]]*=[[:space:]]*", "", line)
      print line
      exit
    }
  ' "$doc"
}

azure_config_string() {
  local raw
  raw="$(azure_config_raw_value "$1" "$2")"
  [[ "$raw" =~ ^\".*\"$ ]] || return 1
  raw="${raw#\"}"
  raw="${raw%\"}"
  [[ -n "$raw" ]] || return 1
  printf '%s\n' "$raw"
}

azure_config_array() {
  local raw item
  raw="$(azure_config_raw_value "$1" "$2")"
  [[ "$raw" =~ ^\[.*\]$ ]] || return 1
  raw="${raw#\[}"
  raw="${raw%\]}"
  [[ -n "${raw//[[:space:]]/}" ]] || return 1
  IFS=',' read -r -a items <<<"$raw"
  for item in "${items[@]}"; do
    item="${item#${item%%[![:space:]]*}}"
    item="${item%${item##*[![:space:]]}}"
    [[ "$item" =~ ^\".*\"$ ]] || return 1
    item="${item#\"}"
    item="${item%\"}"
    [[ -n "$item" ]] || return 1
    printf '%s\n' "$item"
  done
}

azure_list_contains() {
  local wanted="$1"
  local list="$2"
  local item
  while IFS= read -r item; do
    [[ "$item" == "$wanted" ]] && return 0
  done <<<"$list"
  return 1
}

azure_remote_parts() {
  local url="$1"
  local path host org project repository

  case "$url" in
    https://dev.azure.com/*|http://dev.azure.com/*|https://*@dev.azure.com/*|http://*@dev.azure.com/*)
      path="${url#*://}"
      path="${path#*@}"
      path="${path#dev.azure.com/}"
      [[ "$path" == */_git/* ]] || return 1
      org="${path%%/*}"
      path="${path#*/}"
      project="${path%%/_git/*}"
      repository="${path#*/_git/}"
      ;;
    https://*.visualstudio.com/*|http://*.visualstudio.com/*|https://*@*.visualstudio.com/*|http://*@*.visualstudio.com/*)
      host="${url#*://}"
      host="${host#*@}"
      org="${host%%.visualstudio.com/*}"
      path="${host#*.visualstudio.com/}"
      [[ "$path" == */_git/* ]] || return 1
      project="${path%%/_git/*}"
      repository="${path#*/_git/}"
      ;;
    ssh://*@vs-ssh.visualstudio.com/*)
      path="${url#*/v3/}"
      org="${path%%/*}"
      path="${path#*/}"
      project="${path%%/*}"
      repository="${path#*/}"
      ;;
    ssh://git@ssh.dev.azure.com/*)
      path="${url#*/v3/}"
      org="${path%%/*}"
      path="${path#*/}"
      project="${path%%/*}"
      repository="${path#*/}"
      ;;
    *@ssh.dev.azure.com:v3/*|*@vs-ssh.visualstudio.com:v3/*)
      path="${url#*:v3/}"
      org="${path%%/*}"
      path="${path#*/}"
      project="${path%%/*}"
      repository="${path#*/}"
      ;;
    *) return 1 ;;
  esac

  repository="${repository%.git}"
  [[ -n "$org" && -n "$project" && -n "$repository" ]] || return 1
  printf '%s\t%s\t%s\n' "$org" "$project" "$repository"
}

azure_require_mapping() {
  local name="$1"
  local value="$2"
  [[ -n "$value" ]] || {
    printf '%s: Azure mapping is missing: %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$name" >&2
    return 1
  }
}

azure_organization_url() {
  printf 'https://dev.azure.com/%s\n' "$AZURE_ORGANIZATION"
}

azure_validate_process_mappings() {
  local process_types type type_json state
  local configured_types configured_states

  configured_types="$(printf '%s\n%s\n' "$AZURE_ELIGIBLE_TYPES" "$AZURE_EPIC_TYPES" | awk 'NF && !seen[$0]++')"
  configured_states="$(printf '%s\n%s\n' "$AZURE_OPEN_STATES" "$AZURE_CLOSED_STATES" | awk 'NF && !seen[$0]++')"

  process_types="$(az devops invoke \
    --area wit \
    --resource workitemtypes \
    --route-parameters project="$AZURE_PROJECT" \
    --org "$(azure_organization_url)" \
    --api-version 7.1 \
    --output json)" || {
      printf '%s: Azure process work-item type validation failed for %s\n' \
        "${RUNNER_NAME:-issue-killer}" "$AZURE_PROJECT" >&2
      return 1
    }

  while IFS= read -r type; do
    [[ -n "$type" ]] || continue
    jq -e --arg type "$type" \
      'any((.value // .)[]?; (.name // .referenceName // "") == $type)' \
      <<<"$process_types" >/dev/null || {
        printf '%s: configured Azure work-item type is not present in project process: %s\n' \
          "${RUNNER_NAME:-issue-killer}" "$type" >&2
        return 1
      }

    type_json="$(az devops invoke \
      --area wit \
      --resource workitemtypes \
      --route-parameters project="$AZURE_PROJECT" type="$type" \
      --org "$(azure_organization_url)" \
      --api-version 7.1 \
      --output json)" || {
        printf '%s: Azure process state validation failed for work-item type: %s\n' \
          "${RUNNER_NAME:-issue-killer}" "$type" >&2
        return 1
      }
    while IFS= read -r state; do
      [[ -n "$state" ]] || continue
      jq -e --arg state "$state" \
        'any((.states // .value // [])[]?; (.name // "") == $state)' \
        <<<"$type_json" >/dev/null || {
          printf '%s: configured Azure state is not present for work-item type %s: %s\n' \
            "${RUNNER_NAME:-issue-killer}" "$type" "$state" >&2
          return 1
        }
    done <<<"$configured_states"
  done <<<"$configured_types"

}

tracker_initialize() {
  local repo_root="$1"
  local docs="$repo_root/docs/agents/issue-tracker.md"
  local remote url urls parts discovered="" count=0
  local mapped_org mapped_project mapped_repository

  command -v az >/dev/null 2>&1 || {
    printf '%s: az is required for Azure DevOps; install Azure CLI and the azure-devops extension.\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  }
  az extension show --name azure-devops --output json >/dev/null 2>&1 || {
    printf '%s: the azure-devops Azure CLI extension is required; install it with `az extension add --name azure-devops`.\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  }
  [[ -r "$docs" ]] || {
    printf '%s: tracker documentation is missing: %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$docs" >&2
    return 1
  }
  grep -Fqx '# Issue Tracker: Azure DevOps' "$docs" || {
    printf '%s: tracker documentation conflicts with the Azure DevOps remote: %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$docs" >&2
    return 1
  }
  grep -Fq 'az' "$docs" || {
    printf '%s: tracker documentation does not declare the az CLI: %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$docs" >&2
    return 1
  }

  AZURE_ORGANIZATION="$(azure_config_string "$docs" organization 2>/dev/null || true)"
  AZURE_PROJECT="$(azure_config_string "$docs" project 2>/dev/null || true)"
  AZURE_REPOSITORY="$(azure_config_string "$docs" repository 2>/dev/null || true)"
  AZURE_ELIGIBLE_TYPES="$(azure_config_array "$docs" eligible_work_item_types 2>/dev/null || true)"
  AZURE_EPIC_TYPES="$(azure_config_array "$docs" epic_work_item_types 2>/dev/null || true)"
  AZURE_OPEN_STATES="$(azure_config_array "$docs" open_states 2>/dev/null || true)"
  AZURE_CLOSED_STATES="$(azure_config_array "$docs" closed_states 2>/dev/null || true)"
  AZURE_READY_TAG="$(azure_config_string "$docs" ready_tag 2>/dev/null || true)"
  AZURE_CLAIM_IDENTITY="$(azure_config_string "$docs" claim_identity 2>/dev/null || true)"
  AZURE_PREDECESSOR_RELATION="$(azure_config_string "$docs" predecessor_relation 2>/dev/null || true)"
  AZURE_CLOSED_STATE="$(azure_config_string "$docs" closed_state 2>/dev/null || true)"

  azure_require_mapping organization "$AZURE_ORGANIZATION" || return 1
  azure_require_mapping project "$AZURE_PROJECT" || return 1
  azure_require_mapping repository "$AZURE_REPOSITORY" || return 1
  azure_require_mapping eligible_work_item_types "$AZURE_ELIGIBLE_TYPES" || return 1
  azure_require_mapping epic_work_item_types "$AZURE_EPIC_TYPES" || return 1
  azure_require_mapping open_states "$AZURE_OPEN_STATES" || return 1
  azure_require_mapping closed_states "$AZURE_CLOSED_STATES" || return 1
  azure_require_mapping ready_tag "$AZURE_READY_TAG" || return 1
  azure_require_mapping claim_identity "$AZURE_CLAIM_IDENTITY" || return 1
  azure_require_mapping predecessor_relation "$AZURE_PREDECESSOR_RELATION" || return 1
  azure_require_mapping closed_state "$AZURE_CLOSED_STATE" || return 1
  azure_list_contains "$AZURE_CLOSED_STATE" "$AZURE_CLOSED_STATES" || {
    printf '%s: closed_state is not included in closed_states\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  }

  while IFS= read -r remote; do
    [[ -n "$remote" ]] || continue
    urls="$({
      git -C "$repo_root" config --get-all "remote.${remote}.url" 2>/dev/null || true
      git -C "$repo_root" config --get-all "remote.${remote}.pushurl" 2>/dev/null || true
    })"
    while IFS= read -r url; do
      [[ -n "$url" ]] || continue
      parts="$(azure_remote_parts "$url" 2>/dev/null || true)"
      [[ -n "$parts" ]] || {
        printf '%s: invalid Azure DevOps remote: %s (%s)\n' \
          "${RUNNER_NAME:-issue-killer}" "$remote" "${url:-missing URL}" >&2
        return 1
      }
      if [[ -n "$discovered" && "$parts" != "$discovered" ]]; then
        printf '%s: ambiguous Azure DevOps remotes resolve to different repositories\n' \
          "${RUNNER_NAME:-issue-killer}" >&2
        return 1
      fi
      discovered="$parts"
      count=$((count + 1))
    done <<<"$urls"
  done < <(git -C "$repo_root" remote 2>/dev/null)

  [[ "$count" -gt 0 && -n "$discovered" ]] || {
    printf '%s: unable to determine an Azure DevOps remote\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  }
  IFS=$'\t' read -r mapped_org mapped_project mapped_repository <<<"$discovered"
  [[ "$mapped_org" == "$AZURE_ORGANIZATION" && \
     "$mapped_project" == "$AZURE_PROJECT" && \
     "$mapped_repository" == "$AZURE_REPOSITORY" ]] || {
    printf '%s: Azure documentation mapping does not match the Git remote\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  }

  az devops project show \
    --organization "$(azure_organization_url)" \
    --project "$AZURE_PROJECT" \
    --output json >/dev/null || {
      printf '%s: Azure DevOps authentication or project validation failed for %s/%s\n' \
        "${RUNNER_NAME:-issue-killer}" "$AZURE_ORGANIZATION" "$AZURE_PROJECT" >&2
      return 1
    }

  az repos show \
    --repository "$AZURE_REPOSITORY" \
    --organization "$(azure_organization_url)" \
    --project "$AZURE_PROJECT" \
    --output json >/dev/null || {
      printf '%s: Azure DevOps repository validation failed for %s/%s/%s\n' \
        "${RUNNER_NAME:-issue-killer}" "$AZURE_ORGANIZATION" "$AZURE_PROJECT" "$AZURE_REPOSITORY" >&2
      return 1
    }

  local relation_types
  relation_types="$(az boards work-item relation list-type \
    --org "https://dev.azure.com/${AZURE_ORGANIZATION}" \
    --output json)" || {
      printf '%s: Azure DevOps work-item relation validation failed for %s\n' \
        "${RUNNER_NAME:-issue-killer}" "$AZURE_PREDECESSOR_RELATION" >&2
      return 1
    }
  jq -e --arg relation "$AZURE_PREDECESSOR_RELATION" \
    'any(.. | scalars; . == $relation)' <<<"$relation_types" >/dev/null || {
      printf '%s: configured predecessor relation is not supported: %s\n' \
        "${RUNNER_NAME:-issue-killer}" "$AZURE_PREDECESSOR_RELATION" >&2
      return 1
    }

  az devops user show \
    --user "$AZURE_CLAIM_IDENTITY" \
    --org "$(azure_organization_url)" \
    --output json >/dev/null || {
      printf '%s: Azure claim identity is unavailable: %s\n' \
        "${RUNNER_NAME:-issue-killer}" "$AZURE_CLAIM_IDENTITY" >&2
      return 1
    }
  azure_validate_process_mappings || return 1

  TRACKER_KIND="azure-devops"
  TRACKER_REPO_SLUG="${AZURE_ORGANIZATION}/${AZURE_PROJECT}/${AZURE_REPOSITORY}"
  printf '[%s] Tracker validated: Azure DevOps (%s)\n' \
    "${RUNNER_NAME:-issue-killer}" "$TRACKER_REPO_SLUG"
}

azure_wiql_in_list() {
  local list="$1"
  local item first=true
  while IFS= read -r item; do
    if [[ "$first" == "true" ]]; then
      first=false
    else
      printf ', '
    fi
    printf "'%s'" "${item//\'/''}"
  done <<<"$list"
}

tracker_item_read() {
  az boards work-item show \
    --id "$1" \
    --expand all \
    --org "https://dev.azure.com/${AZURE_ORGANIZATION}" \
    --output json
}

tracker_item_state() {
  jq -r '.fields["System.State"] // empty' <<<"$1"
}

tracker_item_type() {
  jq -r '.fields["System.WorkItemType"] // empty' <<<"$1"
}

azure_item_has_ready_tag() {
  local tags="$1"
  local tag
  IFS=';' read -r -a tag_values <<<"$tags"
  for tag in "${tag_values[@]}"; do
    tag="${tag#${tag%%[![:space:]]*}}"
    tag="${tag%${tag##*[![:space:]]}}"
    [[ "$tag" == "$AZURE_READY_TAG" ]] && return 0
  done
  return 1
}

azure_item_is_epic() {
  local item_json="$1"
  local item_type title tags tag

  item_type="$(tracker_item_type "$item_json")"
  azure_list_contains "$item_type" "$AZURE_EPIC_TYPES" && return 0
  title="$(jq -r '.fields["System.Title"] // .title // empty' <<<"$item_json")"
  [[ "$title" == \[Epic\]* ]] && return 0
  tags="$(jq -r '.fields["System.Tags"] // empty' <<<"$item_json")"
  IFS=';' read -r -a tag_values <<<"$tags"
  for tag in "${tag_values[@]}"; do
    tag="${tag#${tag%%[![:space:]]*}}"
    tag="${tag%${tag##*[![:space:]]}}"
    [[ "$(printf '%s' "$tag" | tr '[:upper:]' '[:lower:]')" == 'epic' ]] && return 0
  done
  return 1
}

tracker_item_dependencies() {
  local issue_number="$1"
  local item_json relation_url related_id related_json related_state
  local blocked=0

  item_json="$(tracker_item_read "$issue_number")" || return 1
  while IFS= read -r relation_url; do
    [[ -n "$relation_url" ]] || continue
    related_id="$(sed -nE 's#.*/([0-9]+)$#\1#p' <<<"$relation_url")"
    [[ "$related_id" =~ ^[0-9]+$ ]] || return 1
    related_json="$(tracker_item_read "$related_id")" || return 1
    related_state="$(tracker_item_state "$related_json")"
    [[ -n "$related_state" ]] || return 1
    if ! azure_list_contains "$related_state" "$AZURE_CLOSED_STATES"; then
      blocked=$((blocked + 1))
    fi
  done < <(
    jq -r --arg relation "$AZURE_PREDECESSOR_RELATION" \
      '.relations[]? | select(.rel == $relation) | .url // empty' <<<"$item_json"
  )
  printf '%s\n' "$blocked"
}

tracker_list_eligible_items() {
  local wiql item_json item_id item_type item_state assigned tags blocked az_items
  local wiql_types wiql_states

  wiql_types="$(azure_wiql_in_list "$AZURE_ELIGIBLE_TYPES")"
  wiql_states="$(azure_wiql_in_list "$AZURE_OPEN_STATES")"
  wiql="SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${AZURE_PROJECT//\'/''}' AND [System.WorkItemType] IN (${wiql_types}) AND [System.State] IN (${wiql_states}) AND [System.Tags] CONTAINS '${AZURE_READY_TAG//\'/''}' ORDER BY [System.Id]"

  az_items="$(az boards query \
    --wiql "$wiql" \
    --org "https://dev.azure.com/${AZURE_ORGANIZATION}" \
    --project "$AZURE_PROJECT" \
    --output json)" || return 1
  while IFS= read -r item_id; do
    [[ "$item_id" =~ ^[0-9]+$ ]] || continue
    item_json="$(tracker_item_read "$item_id")" || return 1
    item_type="$(tracker_item_type "$item_json")"
    item_state="$(tracker_item_state "$item_json")"
    assigned="$(jq -r '.fields["System.AssignedTo"] // empty | if type == "object" then (.uniqueName // .displayName // "assigned") else . end' <<<"$item_json")"
    tags="$(jq -r '.fields["System.Tags"] // empty' <<<"$item_json")"
    azure_list_contains "$item_type" "$AZURE_ELIGIBLE_TYPES" || continue
    ! azure_item_is_epic "$item_json" || continue
    azure_list_contains "$item_state" "$AZURE_OPEN_STATES" || continue
    [[ -z "$assigned" ]] || continue
    azure_item_has_ready_tag "$tags" || continue
    blocked="$(tracker_item_dependencies "$item_id")" || return 1
    [[ "$blocked" == "0" ]] || continue
    printf '%s\n' "$item_id"
  done < <(jq -r '.[] | (.id // .fields["System.Id"] // empty)' <<<"$az_items")
}

tracker_item_claim() {
  az boards work-item update \
    --id "$1" \
    --assigned-to "$AZURE_CLAIM_IDENTITY" \
    --org "https://dev.azure.com/${AZURE_ORGANIZATION}" \
    --output json
}

tracker_item_close() {
  local issue_number="$1"
  local branch="${2:-}"
  local pr_json pr_state

  if [[ -z "$branch" ]] && declare -F current_branch >/dev/null 2>&1; then
    branch="$(current_branch)"
  fi
  [[ -n "$branch" && "$branch" != "unknown" ]] || {
    printf '%s: source branch is required before closing Azure work item %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$issue_number" >&2
    return 1
  }
  pr_json="$(tracker_prs_for_branch "$branch")" || {
    printf '%s: unable to verify Azure pull request before closing work item %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$issue_number" >&2
    return 1
  }
  pr_state="$(tracker_pr_is_merged "$pr_json")"
  [[ "$pr_state" == "true" ]] || {
    printf '%s: Azure pull request for branch %s is not uniquely merged into %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$branch" "${BASE_BRANCH:-main}" >&2
    return 1
  }

  az boards work-item update \
    --id "$issue_number" \
    --state "$AZURE_CLOSED_STATE" \
    --org "https://dev.azure.com/${AZURE_ORGANIZATION}" \
    --output json
}

tracker_item_completion_verified() {
  local issue_number="$1"
  local branch="$2"
  local item_json item_state pr_json

  [[ -n "$branch" && "$branch" != "unknown" ]] || return 1
  item_json="$(tracker_item_read "$issue_number")" || return 1
  item_state="$(tracker_item_state "$item_json")"
  azure_list_contains "$item_state" "$AZURE_CLOSED_STATES" || return 1
  pr_json="$(tracker_prs_for_branch "$branch")" || return 1
  [[ "$(tracker_pr_is_merged "$pr_json")" == "true" ]]
}

tracker_prs_for_branch() {
  az repos pr list \
    --repository "$AZURE_REPOSITORY" \
    --source-branch "$1" \
    --status all \
    --org "https://dev.azure.com/${AZURE_ORGANIZATION}" \
    --project "$AZURE_PROJECT" \
    --output json
}

tracker_pr_is_merged() {
  local pr_json="$1"
  local base_ref="refs/heads/${BASE_BRANCH:-main}"
  jq -r --arg base "$base_ref" '
    if length != 1 then "ambiguous"
    elif (.[0].status // "") == "completed"
      and (.[0].mergeStatus // "") == "succeeded"
      and (.[0].targetRefName // "") == $base then "true"
    else "false"
    end
  ' <<<"$pr_json"
}

tracker_reconcile_recovery_state() {
  local issue_number="$1"
  local branch="$(current_branch)"
  local pr_json pr_count merged item_json state

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
    item_json="$(tracker_item_read "$issue_number" 2>/dev/null)" || {
      printf 'unknown\n'
      return 0
    }
    state="$(tracker_item_state "$item_json")"
    if azure_list_contains "$state" "$AZURE_CLOSED_STATES"; then
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
  local item_json issue_state pr_json pr_count blocked_by merged

  item_json="$(tracker_item_read "$issue_number" 2>/dev/null)" || {
    emit_recovery_required "unable to reconcile Azure work item ${issue_number} before recovery"
  }
  issue_state="$(tracker_item_state "$item_json")"
  [[ -n "$issue_state" ]] || \
    emit_recovery_required "unable to determine Azure work item ${issue_number} state before recovery"

  blocked_by="$(tracker_item_dependencies "$issue_number" 2>/dev/null || true)"
  [[ "$blocked_by" =~ ^[0-9]+$ ]] || \
    emit_recovery_required "ambiguous predecessor state for Azure work item ${issue_number}"
  [[ "$blocked_by" -eq 0 ]] || \
    emit_recovery_required "Azure work item ${issue_number} is blocked by ${blocked_by} open predecessor(s)"

  pr_json="$(tracker_prs_for_branch "$branch" 2>/dev/null)" || \
    emit_recovery_required "unable to reconcile Azure PR state for branch ${branch} before recovery"
  pr_count="$(jq -r 'length' <<<"$pr_json" 2>/dev/null || true)"
  [[ "$pr_count" =~ ^[0-9]+$ ]] || \
    emit_recovery_required "ambiguous Azure PR state for branch ${branch}"
  [[ "$pr_count" -le 1 ]] || \
    emit_recovery_required "ambiguous Azure PR state for branch ${branch}: ${pr_count} PRs found"
  azure_list_contains "$issue_state" "$AZURE_CLOSED_STATES" && \
    emit_recovery_required "Azure work item ${issue_number} is already closed; refusing recovery over dirty files"
  if [[ "$pr_count" -eq 1 ]]; then
    merged="$(tracker_pr_is_merged "$pr_json" 2>/dev/null || true)"
    [[ "$merged" == "true" || "$merged" == "false" ]] || \
      emit_recovery_required "ambiguous merged state for Azure PR on branch ${branch}"
    [[ "$merged" != "true" ]] || \
      emit_recovery_required "Azure PR for branch ${branch} is already merged; refusing duplicate recovery effects"
  fi

  printf '[%s] Reconciled recovery target: Azure work item %s is %s; open predecessors: %s; PRs for %s: %s\n' \
    "${RUNNER_NAME:-issue-killer}" "$issue_number" "$issue_state" "$blocked_by" "$branch" "$pr_count"
}

tracker_runtime_decode_command() {
  local cmd="$1"
  local item_number

  case "$cmd" in
    "az boards work-item show"*)
      item_number="$(printf '%s\n' "$cmd" | sed -nE 's/.*--id[[:space:]]+([0-9]+).*/\1/p')"
      if [[ -n "$item_number" ]]; then
        printf 'identify\t%s\n' "$item_number"
      else
        printf 'tracker\t\n'
      fi
      ;;
    "az repos pr create"*) printf 'pr_create\t\n' ;;
    "az repos pr update"*|"az repos pr set"*) printf 'tracker\t\n' ;;
    "az boards work-item update"*) printf 'tracker\t\n' ;;
    "az boards"*|"az repos pr list"*) printf 'tracker\t\n' ;;
    *) return 1 ;;
  esac
}
