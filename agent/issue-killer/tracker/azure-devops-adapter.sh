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
AZURE_HU_TYPES=""
AZURE_TICKET_TYPES=""
AZURE_COMPLETION_EVIDENCE_FIELD=""
AZURE_REAL_EFFORT_FIELD=""
AZURE_CONFIG_DOC=""
AZURE_HU_SCOPE_ENABLED=false
AZURE_HIERARCHY_RELATION="System.LinkTypes.Hierarchy-Forward"
AZURE_SCOPE_STATUS=""
AZURE_SCOPE_HU=""
AZURE_SCOPE_ITEM=""
AZURE_SCOPE_BLOCKED_COUNT=0
AZURE_SCOPE_PENDING_COUNT=0
AZURE_SCOPE_CANDIDATES=""
TRACKER_SCOPE_STATUS=""
TRACKER_SCOPE_HU=""
TRACKER_SCOPE_ITEM=""
TRACKER_HU_BRANCH=""
TRACKER_HU_BRANCH_CATEGORY=""
TRACKER_HU_BRANCH_ORIGIN=""
TRACKER_HU_BRANCH_ORIGIN_SHA=""
TRACKER_HU_BRANCH_REUSED=""
AZURE_GUARD_DIR=""
AZURE_ORIGINAL_PATH=""

# The HU branch bootstrap module owns the deterministic naming, the
# origin prompt, and the recovery reconciliation. It is sourced here
# so the supervisor, the worker, and the recovery guards all share
# the same closed list of branches and categories.
# shellcheck source=agent/issue-killer/tracker/azure-hu-branch.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/azure-hu-branch.sh"

tracker_prepare_worker_environment() {
  local guard_bin real_az adapter_dir

  real_az="$(command -v az 2>/dev/null || true)"
  [[ -x "$real_az" ]] || return 1
  AZURE_ORIGINAL_PATH="$PATH"
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
  export AZURE_GUARD_HU_BRANCH="${TRACKER_HU_BRANCH:-}"
  export AZURE_GUARD_EVIDENCE_FIELD="$AZURE_COMPLETION_EVIDENCE_FIELD"
  export AZURE_GUARD_EFFORT_FIELD="$AZURE_REAL_EFFORT_FIELD"
  export PATH="${AZURE_GUARD_DIR}:$PATH"
}

tracker_cleanup_worker_environment() {
  [[ -n "$AZURE_GUARD_DIR" ]] || return 0
  rm -rf "$AZURE_GUARD_DIR"
  AZURE_GUARD_DIR=""
  if [[ -n "$AZURE_ORIGINAL_PATH" ]]; then
    export PATH="$AZURE_ORIGINAL_PATH"
    AZURE_ORIGINAL_PATH=""
  fi
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

azure_resolve_field_mapping() {
  local catalog="$1" intent="$2" expected_type="$3" matches
  matches="$(jq -c --arg intent "$intent" --arg type "$expected_type" '
    [(.value // .)[]?
      | select((.name // .displayName // "") == $intent)
      | select((.referenceName // "") != "")
      | select((.readOnly // false) == false)
      | select((.type // .fieldType // "") == $type)]' <<<"$catalog")" || return 1
  [[ "$(jq 'length' <<<"$matches")" == 1 ]] || {
    printf '%s: Azure field mapping is missing, ambiguous, incompatible, or non-editable: %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$intent" >&2
    return 1
  }
  jq -r '.[0].referenceName' <<<"$matches"
}

azure_persist_field_mapping() {
  local docs="$1" key="$2" value="$3" tmp
  tmp="${docs}.tmp.$$"
  awk -v key="$key" -v value="$value" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" { print key " = \"" value "\""; found=1; next }
    { print }
    END { if (!found) print key " = \"" value "\"" }
  ' "$docs" >"$tmp" && mv "$tmp" "$docs"
}

azure_validate_or_discover_field_mappings() {
  local docs="$1" catalog evidence_name effort_name
  evidence_name="$(azure_config_string "$docs" completion_evidence_field_name 2>/dev/null || true)"
  effort_name="$(azure_config_string "$docs" real_effort_field_name 2>/dev/null || true)"
  if [[ -n "$evidence_name" && -n "$effort_name" ]]; then
    AZURE_COMPLETION_EVIDENCE_FIELD="$evidence_name"
    AZURE_REAL_EFFORT_FIELD="$effort_name"
    return 0
  fi
  evidence_name="$(azure_config_string "$docs" completion_evidence_field 2>/dev/null || true)"
  effort_name="$(azure_config_string "$docs" real_effort_field 2>/dev/null || true)"
  [[ -n "$evidence_name" && -n "$effort_name" ]] || {
    printf '%s: Azure field intent mappings are required: completion_evidence_field and real_effort_field\n' "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  }
  catalog="$(az devops invoke --area wit --resource fields --org "$(azure_organization_url)" --api-version 7.1 --output json)" || return 1
  AZURE_COMPLETION_EVIDENCE_FIELD="$(azure_resolve_field_mapping "$catalog" "$evidence_name" "html")" || return 1
  AZURE_REAL_EFFORT_FIELD="$(azure_resolve_field_mapping "$catalog" "$effort_name" "double")" || return 1
  azure_persist_field_mapping "$docs" completion_evidence_field_name "$AZURE_COMPLETION_EVIDENCE_FIELD" || return 1
  azure_persist_field_mapping "$docs" real_effort_field_name "$AZURE_REAL_EFFORT_FIELD" || return 1
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

# Formats a structured HTML completion-evidence block with named sections
# so reviewers can navigate summary, delivered changes, validation, and
# development references independently. The function never embeds raw
# user-controlled HTML in caller-supplied strings: the caller is expected
# to pre-render Markdown or plain text and supply it as plain text. Each
# section argument is rendered as-is between the section headers.
azure_format_evidence_section() {
  local heading="$1"
  local body="$2"
  printf '<h3>%s</h3>\n' "$heading"
  printf '<div class="evidence-section">\n'
  if [[ -n "$body" ]]; then
    printf '%s\n' "$body"
  else
    printf '<p><em>Not provided.</em></p>\n'
  fi
  printf '</div>\n'
}

# Produces the canonical Azure completion evidence HTML for a non-visual
# delivery ticket. The function is pure: callers pass the work-item
# identifier for traceability, the delivered change summary, the
# validation output, and the development references (typically the pull
# request URL, integrated commit SHA, and a branch reference). The
# returned HTML is intended to be written into the work item's
# completion evidence field through `tracker_item_set_completion_evidence`.
tracker_format_completion_evidence() {
  local item_id="$1"
  local summary="$2"
  local changes="$3"
  local validation="$4"
  local references="$5"
  local generated_at="${6:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

  [[ -n "$item_id" ]] || {
    printf '%s: tracker_format_completion_evidence: missing work item identifier\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  }

  printf '<div class="completion-evidence" data-work-item="%s" data-generated="%s">\n' \
    "$item_id" "$generated_at"
  printf '<h2>Completion evidence for work item %s</h2>\n' "$item_id"
  azure_format_evidence_section "Summary" "$summary"
  azure_format_evidence_section "Delivered changes" "$changes"
  azure_format_evidence_section "Validation" "$validation"
  azure_format_evidence_section "Development references" "$references"
  printf '</div>\n'
}

# Computes the cumulative Real Effort hours rounded upward to the
# nearest quarter hour. Inputs:
#   $1: active seconds (positive integer; non-active waits excluded)
#   $2: existing effort in hours (decimal; may be empty)
# The function returns the new total in hours. An empty existing value
# is treated as zero. Negative or non-numeric values are rejected so
# the worker cannot accidentally clobber prior effort.
tracker_calculate_real_effort_hours() {
  local active_seconds="$1"
  local existing="$2"
  local total_hours quotient remainder

  [[ "$active_seconds" =~ ^[0-9]+$ ]] || {
    printf '%s: tracker_calculate_real_effort_hours: active seconds must be a non-negative integer: %s\n' \
      "${RUNNER_NAME:-issue-killer}" "${active_seconds:-empty}" >&2
    return 1
  }
  if [[ -z "$existing" ]]; then
    existing="0"
  elif [[ ! "$existing" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    printf '%s: tracker_calculate_real_effort_hours: existing effort is not numeric: %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$existing" >&2
    return 1
  fi

  total_hours="$(awk -v secs="$active_seconds" -v prev="$existing" \
    'BEGIN { printf "%.4f", (secs / 3600.0) + prev }')" || return 1
  quotient="$(awk -v t="$total_hours" 'BEGIN { printf "%d", t / 0.25 }')"
  remainder="$(awk -v t="$total_hours" 'BEGIN { printf "%.4f", t - (int(t / 0.25) * 0.25) }')"
  awk -v q="$quotient" -v r="$remainder" \
    'BEGIN {
      if (r > 0.0001) q = q + 1;
      printf "%g", q * 0.25
    }'
}

# Computes the deterministic ticket branch name (issue-N-slug) for the
# active delivery ticket. The branch originates from the HU integration
# branch and targets it through the worker's pull request. The slug is
# derived from the ticket title using the same lowercase, dash-collapsing
# normalization used by the HU branch module so both branches share a
# consistent naming convention. Existing `tracker_compute_hu_branch` is
# the source of truth for HU-level naming; the ticket slug only depends
# on the ticket title.
tracker_compute_ticket_branch() {
  local ticket_id="$1"
  local ticket_title="$2"

  [[ "$ticket_id" =~ ^[1-9][0-9]*$ ]] || {
    printf '%s: tracker_compute_ticket_branch: invalid ticket identifier: %s\n' \
      "${RUNNER_NAME:-issue-killer}" "${ticket_id:-empty}" >&2
    return 1
  }
  local slug
  slug="$(printf '%s' "${ticket_title:-ticket}" | tr '[:upper:]' '[:lower:]')"
  slug="$(printf '%s' "$slug" | tr -cs '[:alnum:]' '-')"
  slug="$(printf '%s' "$slug" | sed -E 's/-+/-/g; s/^-+//; s/-+$//')"
  if [[ "${#slug}" -gt 48 ]]; then
    slug="${slug:0:48}"
    slug="$(printf '%s' "$slug" | sed -E 's/-+$//')"
  fi
  [[ -n "$slug" ]] || slug="ticket"
  printf 'issue-%s-%s\n' "$ticket_id" "$slug"
}

# Returns 0 when the supplied pull-request target ref matches the HU
# integration branch or, when no HU branch is pinned, the configured
# repository base branch. The function keeps the GitHub-compatible
# `refs/heads/main` comparison intact so tracker-neutral tests that
# exercise the configured base branch keep working.
tracker_pr_target_matches_integration_branch() {
  local target_ref="$1"

  [[ -n "$target_ref" ]] || return 1
  if [[ -n "${TRACKER_HU_BRANCH:-}" ]]; then
    [[ "$target_ref" == "refs/heads/${TRACKER_HU_BRANCH}" ]] && return 0
    return 1
  fi
  [[ "$target_ref" == "refs/heads/${BASE_BRANCH:-main}" ]] && return 0
  return 1
}

# Sets the completion evidence field on a work item. The HTML payload is
# passed verbatim through the `--fields` argument. The function relies on
# the previously discovered Azure reference name so localized display
# names never enter the update call.
tracker_item_set_completion_evidence() {
  local item_id="$1"
  local html="$2"

  [[ "$item_id" =~ ^[1-9][0-9]*$ ]] || {
    printf '%s: tracker_item_set_completion_evidence: invalid work item identifier: %s\n' \
      "${RUNNER_NAME:-issue-killer}" "${item_id:-empty}" >&2
    return 1
  }
  [[ -n "$AZURE_COMPLETION_EVIDENCE_FIELD" ]] || {
    printf '%s: tracker_item_set_completion_evidence: completion evidence reference name is unset\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  }
  [[ -n "$html" ]] || {
    printf '%s: tracker_item_set_completion_evidence: empty HTML payload for work item %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$item_id" >&2
    return 1
  }
  az boards work-item update \
    --id "$item_id" \
    --fields "${AZURE_COMPLETION_EVIDENCE_FIELD}=${html}" \
    --org "https://dev.azure.com/${AZURE_ORGANIZATION}" \
    --output json >/dev/null
}

# Reads the completion evidence HTML stored on a work item. The
# function returns the raw HTML on stdout so callers can render or
# verify it without re-formatting. Returns 1 when the field is empty or
# the work item cannot be read; callers must distinguish "absent" from
# "present but empty" before allowing the work item to reach Done.
tracker_item_read_completion_evidence() {
  local item_id="$1"
  local item_json value

  [[ "$item_id" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -n "$AZURE_COMPLETION_EVIDENCE_FIELD" ]] || return 1
  item_json="$(tracker_item_read "$item_id")" || return 1
  value="$(jq -r --arg f "$AZURE_COMPLETION_EVIDENCE_FIELD" \
    '.fields[$f] // empty' <<<"$item_json")"
  [[ -n "$value" ]] || return 1
  printf '%s\n' "$value"
}

# Sets the Real Effort field on a work item using the previously
# discovered reference name. The function rejects negative values,
# empty values, and non-decimal inputs so a buggy worker cannot corrupt
# the cumulative effort recorded for the ticket.
tracker_item_set_real_effort() {
  local item_id="$1"
  local hours="$2"

  [[ "$item_id" =~ ^[1-9][0-9]*$ ]] || {
    printf '%s: tracker_item_set_real_effort: invalid work item identifier: %s\n' \
      "${RUNNER_NAME:-issue-killer}" "${item_id:-empty}" >&2
    return 1
  }
  [[ -n "$AZURE_REAL_EFFORT_FIELD" ]] || {
    printf '%s: tracker_item_set_real_effort: real effort reference name is unset\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  }
  [[ "$hours" =~ ^[0-9]+(\.[0-9]+)?$ ]] || {
    printf '%s: tracker_item_set_real_effort: effort must be a non-negative number: %s\n' \
      "${RUNNER_NAME:-issue-killer}" "${hours:-empty}" >&2
    return 1
  }
  az boards work-item update \
    --id "$item_id" \
    --fields "${AZURE_REAL_EFFORT_FIELD}=${hours}" \
    --org "https://dev.azure.com/${AZURE_ORGANIZATION}" \
    --output json >/dev/null
}

# Reads the Real Effort value from a work item. Returns the value on
# stdout and 0 when the field is set (including zero), 1 when the field
# is absent or unparseable. Callers should treat absent as "never
# recorded" and treat zero as a deliberate reset by the operator.
tracker_item_read_real_effort() {
  local item_id="$1"
  local item_json value

  [[ "$item_id" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -n "$AZURE_REAL_EFFORT_FIELD" ]] || return 1
  item_json="$(tracker_item_read "$item_id")" || return 1
  value="$(jq -r --arg f "$AZURE_REAL_EFFORT_FIELD" \
    '.fields[$f] // empty' <<<"$item_json")"
  [[ -n "$value" ]] || return 1
  printf '%s\n' "$value"
}

# Adds a native development relation (ArtifactLink) to a work item.
# Azure exposes Pull Request and Integrated Commit as named artifact
# types; using them keeps the relation navigable from the work item and
# the pull request views. The relation comment is intentionally short
# so sensitive notes never leak into the work item history.
tracker_item_add_development_relation() {
  local item_id="$1"
  local artifact_type="$2"
  local artifact_url="$3"
  local comment="${4:-}"

  [[ "$item_id" =~ ^[1-9][0-9]*$ ]] || {
    printf '%s: tracker_item_add_development_relation: invalid work item identifier\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  }
  [[ "$artifact_type" =~ ^[A-Za-z][A-Za-z0-9\ .\-]*$ ]] || {
    printf '%s: tracker_item_add_development_relation: invalid artifact type: %s\n' \
      "${RUNNER_NAME:-issue-killer}" "${artifact_type:-empty}" >&2
    return 1
  }
  [[ -n "$artifact_url" ]] || {
    printf '%s: tracker_item_add_development_relation: empty artifact URL\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  }

  local args=(work-item relation add --id "$item_id" \
    --relation-type "ArtifactLink" \
    --target "$artifact_url" \
    --target-type "$artifact_type" \
    --org "https://dev.azure.com/${AZURE_ORGANIZATION}")
  if [[ -n "$comment" ]]; then
    args+=(--comment "$comment")
  fi
  az boards "${args[@]}" --output json >/dev/null
}

# Lists the development relations (ArtifactLinks) attached to a work item
# so the closure guard can verify that a Pull Request and Integrated
# Commit link both exist before allowing the work item to reach the
# configured closed state. Returns one relation per line in the form
# `<type>\t<url>`.
tracker_item_list_development_relations() {
  local item_id="$1"
  local item_json

  [[ "$item_id" =~ ^[1-9][0-9]*$ ]] || return 1
  item_json="$(tracker_item_read "$item_id")" || return 1
  jq -r '.relations[]?
    | select((.rel // "") | ascii_downcase | test("artifactlink"))
    | [(.attributes.name // .attributes."Artifact Link Type" // "Unknown"),
       (.url // empty)]
    | @tsv' <<<"$item_json"
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
  local process_types type type_json state state_catalog state_lines available_category
  local configured_types

  configured_types="$(printf '%s\n%s\n' "$AZURE_ELIGIBLE_TYPES" "$AZURE_EPIC_TYPES" | awk 'NF && !seen[$0]++')"
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

  state_catalog=""
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
    state_lines=$(jq -r '.states // .value // [] | .[]? | [(.name // ""), (.category // .stateCategory // "")] | @tsv' <<<"$type_json")
    state_catalog="${state_catalog}${state_lines}"$'\n'
  done <<<"$configured_types"

  while IFS= read -r state; do
    [[ -n "$state" ]] || continue
    azure_list_contains "$state" "$AZURE_CLOSED_STATES" && {
      printf '%s: Azure state cannot be both open and closed: %s\n' \
        "${RUNNER_NAME:-issue-killer}" "$state" >&2
      return 1
    }
    available_category=$(awk -F '\t' -v wanted="$state" \
      '$1 == wanted && $2 != "Completed" && $2 != "Removed" && $2 != "" { print $2; exit }' \
      <<<"$state_catalog")
    [[ -n "$available_category" ]] || {
      printf '%s: configured Azure open state is absent or terminal: %s\n' \
        "${RUNNER_NAME:-issue-killer}" "$state" >&2
      return 1
    }
  done <<<"$AZURE_OPEN_STATES"

  while IFS= read -r state; do
    [[ -n "$state" ]] || continue
    available_category=$(awk -F '\t' -v wanted="$state" \
      '$1 == wanted && ($2 == "Completed" || $2 == "Removed") { print $2; exit }' \
      <<<"$state_catalog")
    [[ -n "$available_category" ]] || {
      printf '%s: configured Azure closed state is absent or non-terminal: %s\n' \
        "${RUNNER_NAME:-issue-killer}" "$state" >&2
      return 1
    }
  done <<<"$AZURE_CLOSED_STATES"

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
  AZURE_HU_TYPES="$(azure_config_array "$docs" delivery_hu_work_item_types 2>/dev/null || true)"
  AZURE_TICKET_TYPES="$(azure_config_array "$docs" delivery_ticket_work_item_types 2>/dev/null || true)"
  AZURE_CONFIG_DOC="$docs"

  [[ -n "$AZURE_HU_TYPES" && -n "$AZURE_TICKET_TYPES" ]] || {
    printf '%s: Azure delivery_hu_work_item_types and delivery_ticket_work_item_types mappings are required\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  }
  AZURE_HU_SCOPE_ENABLED=true

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
  azure_require_mapping delivery_hu_work_item_types "$AZURE_HU_TYPES" || return 1
  azure_require_mapping delivery_ticket_work_item_types "$AZURE_TICKET_TYPES" || return 1
  local role_type
  while IFS= read -r role_type; do
    [[ -n "$role_type" ]] || continue
    azure_list_contains "$role_type" "$AZURE_ELIGIBLE_TYPES" || {
      printf '%s: Azure HU type is not included in eligible_work_item_types: %s\n' \
        "${RUNNER_NAME:-issue-killer}" "$role_type" >&2
      return 1
    }
    azure_list_contains "$role_type" "$AZURE_TICKET_TYPES" && {
      printf '%s: Azure work-item type cannot be both an HU and a ticket: %s\n' \
        "${RUNNER_NAME:-issue-killer}" "$role_type" >&2
      return 1
    }
  done <<<"$AZURE_HU_TYPES"
  while IFS= read -r role_type; do
    [[ -n "$role_type" ]] || continue
    azure_list_contains "$role_type" "$AZURE_ELIGIBLE_TYPES" || {
      printf '%s: Azure ticket type is not included in eligible_work_item_types: %s\n' \
        "${RUNNER_NAME:-issue-killer}" "$role_type" >&2
      return 1
    }
  done <<<"$AZURE_TICKET_TYPES"
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
  azure_validate_or_discover_field_mappings "$docs" || return 1

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

tracker_validate_run_options() {
  local hu_id="${1:-}"

  if [[ -n "$hu_id" && "$AZURE_HU_SCOPE_ENABLED" != "true" ]]; then
    printf '%s: --hu requires repository-owned Azure HU and ticket type mappings\n' \
      "${RUNNER_NAME:-issue-killer}" >&2
    return 1
  fi
  if [[ -n "$hu_id" && ! "$hu_id" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s: Azure HU identifier must be a positive numeric ID: %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$hu_id" >&2
    return 1
  fi
}

azure_item_id() {
  jq -r '.id // .fields["System.Id"] // empty' <<<"$1"
}

azure_item_created_date() {
  jq -r '.fields["System.CreatedDate"] // empty' <<<"$1"
}

azure_item_assignee() {
  jq -r '.fields["System.AssignedTo"] // empty | if type == "object" then (.uniqueName // .displayName // "assigned") else . end' <<<"$1"
}

azure_item_is_unassigned() {
  [[ -z "$(azure_item_assignee "$1")" ]]
}

azure_item_is_delivery_hu() {
  local item_json="$1"
  local item_type item_state tags

  item_type="$(tracker_item_type "$item_json")"
  item_state="$(tracker_item_state "$item_json")"
  tags="$(jq -r '.fields["System.Tags"] // empty' <<<"$item_json")"
  azure_list_contains "$item_type" "$AZURE_HU_TYPES" || return 1
  azure_list_contains "$item_state" "$AZURE_OPEN_STATES" || return 1
  azure_item_is_epic "$item_json" && return 1
  azure_item_is_unassigned "$item_json" || return 1
  azure_item_has_ready_tag "$tags" || return 1
}

azure_validate_direct_child_relations() {
  jq -e --arg relation "$AZURE_HIERARCHY_RELATION" '
    all(.relations[]? | select(.rel == $relation);
      ((.url // "") | type == "string" and test("/[1-9][0-9]*$")))
  ' <<<"$1" >/dev/null
}

azure_hu_direct_child_ids() {
  azure_validate_direct_child_relations "$1" || return 1
  jq -r --arg relation "$AZURE_HIERARCHY_RELATION" \
    '.relations[]? | select(.rel == $relation) | .url // empty | capture("/(?<id>[0-9]+)$").id' \
    <<<"$1"
}

tracker_validate_delivery_hu() {
  local hu_id="$1"
  local allow_assigned="${2:-false}"
  local item_json item_type item_state blocked actual_id

  tracker_validate_run_options "$hu_id" || return 1
  item_json="$(tracker_item_read "$hu_id" 2>/dev/null)" || {
    printf '%s: Azure delivery HU %s is unavailable or could not be read\n' \
      "${RUNNER_NAME:-issue-killer}" "$hu_id" >&2
    return 1
  }
  actual_id="$(azure_item_id "$item_json")"
  if [[ -n "$actual_id" && "$actual_id" != "$hu_id" ]]; then
    printf '%s: Azure work item %s returned a mismatched identity (%s)\n' \
      "${RUNNER_NAME:-issue-killer}" "$hu_id" "$actual_id" >&2
    return 1
  fi
  item_type="$(tracker_item_type "$item_json")"
  if ! azure_list_contains "$item_type" "$AZURE_HU_TYPES"; then
    printf '%s: Azure work item %s is not an eligible delivery HU (type: %s)\n' \
      "${RUNNER_NAME:-issue-killer}" "$hu_id" "${item_type:-unknown}" >&2
    return 1
  fi
  if azure_item_is_epic "$item_json"; then
    printf '%s: Azure work item %s is an epic and cannot be a delivery HU\n' \
      "${RUNNER_NAME:-issue-killer}" "$hu_id" >&2
    return 1
  fi
  item_state="$(tracker_item_state "$item_json")"
  if ! azure_list_contains "$item_state" "$AZURE_OPEN_STATES"; then
    printf '%s: Azure delivery HU %s is not open (state: %s)\n' \
      "${RUNNER_NAME:-issue-killer}" "$hu_id" "${item_state:-unknown}" >&2
    return 1
  fi
  if ! azure_item_has_ready_tag "$(jq -r '.fields["System.Tags"] // empty' <<<"$item_json")"; then
    printf '%s: Azure delivery HU %s is missing the ready tag %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$hu_id" "$AZURE_READY_TAG" >&2
    return 1
  fi
  if [[ "$allow_assigned" != "true" ]] && ! azure_item_is_unassigned "$item_json"; then
    printf '%s: Azure delivery HU %s is already assigned and is not available\n' \
      "${RUNNER_NAME:-issue-killer}" "$hu_id" >&2
    return 1
  fi
  blocked="$(tracker_item_dependencies "$hu_id" 2>/dev/null || true)"
  if [[ ! "$blocked" =~ ^[0-9]+$ ]]; then
    printf '%s: unable to determine predecessors for Azure delivery HU %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$hu_id" >&2
    return 1
  fi
  if [[ "$blocked" -ne 0 ]]; then
    printf '%s: Azure delivery HU %s is blocked by %s open predecessor(s)\n' \
      "${RUNNER_NAME:-issue-killer}" "$hu_id" "$blocked" >&2
    return 1
  fi

  AZURE_SCOPE_HU_JSON="$item_json"
  return 0
}

tracker_list_eligible_hus() {
  local wiql item_json item_id created lines blocked
  local wiql_types wiql_states

  wiql_types="$(azure_wiql_in_list "$AZURE_HU_TYPES")"
  wiql_states="$(azure_wiql_in_list "$AZURE_OPEN_STATES")"
  wiql="SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${AZURE_PROJECT//\'/\'\'}' AND [System.WorkItemType] IN (${wiql_types}) AND [System.State] IN (${wiql_states}) AND [System.Tags] CONTAINS '${AZURE_READY_TAG//\'/\'\'}' ORDER BY [System.Id]"

  # Keep the query result in a variable so the adapter can sort by the
  # repository's creation-time/ID ordering without relying on Azure's query
  # ordering. The read loop below runs in the current shell.
  local az_items
  az_items="$(az boards query \
    --wiql "$wiql" \
    --org "https://dev.azure.com/${AZURE_ORGANIZATION}" \
    --project "$AZURE_PROJECT" \
    --output json)" || return 1
  lines=""
  while IFS= read -r item_id; do
    [[ "$item_id" =~ ^[0-9]+$ ]] || continue
    item_json="$(tracker_item_read "$item_id")" || return 1
    azure_item_is_delivery_hu "$item_json" || continue
    blocked="$(tracker_item_dependencies "$item_id")" || return 1
    [[ "$blocked" == "0" ]] || continue
    created="$(azure_item_created_date "$item_json")"
    [[ -n "$created" ]] || created="9999-12-31T23:59:59Z"
    lines="${lines}${created}\t${item_id}\n"
  done < <(jq -r '.[] | (.id // .fields["System.Id"] // empty)' <<<"$az_items")

  if [[ -n "$lines" ]]; then
    printf '%b' "$lines" | sort -t $'\t' -k1,1 -k2,2n | cut -f2
  fi
}

azure_child_scope_candidates() {
  local hu_json="$1"
  local child_id child_json child_type child_state created blocked
  local candidates=""

  AZURE_SCOPE_PENDING_COUNT=0
  AZURE_SCOPE_BLOCKED_COUNT=0
  while IFS= read -r child_id; do
    [[ "$child_id" =~ ^[0-9]+$ ]] || continue
    child_json="$(tracker_item_read "$child_id")" || return 1
    child_type="$(tracker_item_type "$child_json")"
    azure_list_contains "$child_type" "$AZURE_TICKET_TYPES" || continue
    child_state="$(tracker_item_state "$child_json")"
    if azure_list_contains "$child_state" "$AZURE_CLOSED_STATES"; then
      continue
    fi
    if ! azure_list_contains "$child_state" "$AZURE_OPEN_STATES"; then
      printf '%s: Azure child ticket %s has an unmapped non-terminal state: %s\n' \
        "${RUNNER_NAME:-issue-killer}" "$child_id" "${child_state:-unknown}" >&2
      return 1
    fi
    AZURE_SCOPE_PENDING_COUNT=$((AZURE_SCOPE_PENDING_COUNT + 1))
    blocked="$(tracker_item_dependencies "$child_id")" || return 1
    if [[ "$blocked" != "0" ]]; then
      AZURE_SCOPE_BLOCKED_COUNT=$((AZURE_SCOPE_BLOCKED_COUNT + 1))
      continue
    fi
    created="$(azure_item_created_date "$child_json")"
    [[ -n "$created" ]] || created="9999-12-31T23:59:59Z"
    candidates="${candidates}${created}\t${child_id}\n"
  done < <(azure_hu_direct_child_ids "$hu_json")
  AZURE_SCOPE_CANDIDATES="$candidates"
}

azure_sync_scope_state() {
  TRACKER_SCOPE_STATUS="$AZURE_SCOPE_STATUS"
  TRACKER_SCOPE_HU="$AZURE_SCOPE_HU"
  TRACKER_SCOPE_ITEM="$AZURE_SCOPE_ITEM"
}

azure_prepare_recovery_scope() {
  local hu_id="$1"
  local ticket_id="$2"
  local child_id child_json child_type child_state blocked found=false

  tracker_validate_delivery_hu "$hu_id" true || return 1
  azure_validate_direct_child_relations "$AZURE_SCOPE_HU_JSON" || {
    printf '%s: Azure delivery HU %s contains a malformed hierarchy relation\n' \
      "${RUNNER_NAME:-issue-killer}" "$hu_id" >&2
    return 1
  }
  while IFS= read -r child_id; do
    [[ "$child_id" =~ ^[1-9][0-9]*$ ]] || continue
    [[ "$child_id" == "$ticket_id" ]] || continue
    found=true
    child_json="$(tracker_item_read "$child_id")" || return 1
    child_type="$(tracker_item_type "$child_json")"
    azure_list_contains "$child_type" "$AZURE_TICKET_TYPES" || {
      printf '%s: checkpoint ticket %s is not an eligible direct child of HU %s\n' \
        "${RUNNER_NAME:-issue-killer}" "$ticket_id" "$hu_id" >&2
      return 1
    }
    child_state="$(tracker_item_state "$child_json")"
    azure_list_contains "$child_state" "$AZURE_CLOSED_STATES" && {
      printf '%s: checkpoint ticket %s is already complete; refusing to change recovery scope\n' \
        "${RUNNER_NAME:-issue-killer}" "$ticket_id" >&2
      return 1
    }
    azure_list_contains "$child_state" "$AZURE_OPEN_STATES" || {
      printf '%s: checkpoint ticket %s has an unmapped state: %s\n' \
        "${RUNNER_NAME:-issue-killer}" "$ticket_id" "${child_state:-unknown}" >&2
      return 1
    }
    blocked="$(tracker_item_dependencies "$ticket_id")" || return 1
    [[ "$blocked" == "0" ]] || {
      printf '%s: checkpoint ticket %s is blocked by %s open predecessor(s)\n' \
        "${RUNNER_NAME:-issue-killer}" "$ticket_id" "$blocked" >&2
      return 1
    }
  done < <(azure_hu_direct_child_ids "$AZURE_SCOPE_HU_JSON")

  [[ "$found" == "true" ]] || {
    printf '%s: checkpoint ticket %s is not a direct child of pinned HU %s\n' \
      "${RUNNER_NAME:-issue-killer}" "$ticket_id" "$hu_id" >&2
    return 1
  }

  AZURE_SCOPE_HU="$hu_id"
  AZURE_SCOPE_ITEM="$ticket_id"
  AZURE_SCOPE_STATUS="ready"
  azure_sync_scope_state
}

tracker_prepare_worker_scope() {
  local requested_hu="${1:-}"
  local allow_assigned="${2:-false}"
  local hu_id hu_ids child_lines sorted_children first_line

  AZURE_SCOPE_STATUS=""
  AZURE_SCOPE_HU=""
  AZURE_SCOPE_ITEM=""
  AZURE_SCOPE_HU_JSON=""
  AZURE_SCOPE_PENDING_COUNT=0
  AZURE_SCOPE_BLOCKED_COUNT=0
  AZURE_SCOPE_CANDIDATES=""
  azure_sync_scope_state

  if [[ "$AZURE_HU_SCOPE_ENABLED" != "true" ]]; then
    AZURE_SCOPE_STATUS="worker_selects"
    azure_sync_scope_state
    return 0
  fi

  if [[ -n "${STARTUP_RECOVERY_MODE:-}" ]]; then
    [[ "${CHECKPOINT_HU:-}" =~ ^[1-9][0-9]*$ && \
       "${CHECKPOINT_TICKET:-}" =~ ^[1-9][0-9]*$ ]] || {
      printf '%s: Azure recovery checkpoint does not pin both HU and ticket identity\n' \
        "${RUNNER_NAME:-issue-killer}" >&2
      return 1
    }
    azure_prepare_recovery_scope "$CHECKPOINT_HU" "$CHECKPOINT_TICKET" || return 1
    return 0
  fi

  if [[ -n "$requested_hu" ]]; then
    tracker_validate_delivery_hu "$requested_hu" "$allow_assigned" || return 1
    hu_id="$requested_hu"
  else
    hu_ids="$(tracker_list_eligible_hus)" || return 1
    hu_id="${hu_ids%%$'\n'*}"
    if [[ -z "$hu_id" ]]; then
      AZURE_SCOPE_STATUS="queue_empty"
      azure_sync_scope_state
      return 0
    fi
    tracker_validate_delivery_hu "$hu_id" || return 1
  fi

  azure_validate_direct_child_relations "$AZURE_SCOPE_HU_JSON" || {
    printf '%s: Azure delivery HU %s contains a malformed hierarchy relation\n' \
      "${RUNNER_NAME:-issue-killer}" "$hu_id" >&2
    return 1
  }
  azure_child_scope_candidates "$AZURE_SCOPE_HU_JSON" || return 1
  child_lines="$AZURE_SCOPE_CANDIDATES"
  if [[ -z "$child_lines" ]]; then
    AZURE_SCOPE_HU="$hu_id"
    if [[ "$AZURE_SCOPE_PENDING_COUNT" -gt 0 && "$AZURE_SCOPE_BLOCKED_COUNT" -eq "$AZURE_SCOPE_PENDING_COUNT" ]]; then
      AZURE_SCOPE_STATUS="blocked"
    else
      AZURE_SCOPE_STATUS="empty"
    fi
    azure_sync_scope_state
    return 0
  fi

  sorted_children="$(printf '%b' "$child_lines" | sort -t $'\t' -k1,1 -k2,2n)" || return 1
  first_line="${sorted_children%%$'\n'*}"
  AZURE_SCOPE_ITEM="${first_line#*$'\t'}"
  AZURE_SCOPE_HU="$hu_id"
  AZURE_SCOPE_STATUS="ready"
  azure_sync_scope_state
}

tracker_worker_scope_prompt() {
  if [[ -n "$AZURE_SCOPE_HU" && -n "$AZURE_SCOPE_ITEM" ]]; then
    printf '%s\n' \
      'Azure delivery scope:' \
      "- The pinned delivery HU is ${AZURE_SCOPE_HU}; the active delivery ticket is ${AZURE_SCOPE_ITEM}." \
      "- Inspect, claim, implement, test, review, and publish only ticket ${AZURE_SCOPE_ITEM} under HU ${AZURE_SCOPE_HU}; do not select or inspect another HU or queue item." \
      '- Re-read the pinned HU, the active ticket, its direct parent relation, and its configured predecessors before mutation.'
    if [[ -n "${TRACKER_HU_BRANCH:-}" ]]; then
      printf '%s\n' \
        "- The HU integration branch is ${TRACKER_HU_BRANCH}; every ticket branch must start from it and every ticket pull request must target it." \
        "- Never create or merge a pull request from ${TRACKER_HU_BRANCH} to ${BASE_BRANCH:-main} or another repository mainline." \
        "- Name the ticket branch with the issue-N-slug convention (issue-${AZURE_SCOPE_ITEM}-<slug>) so the worker session, the runner, and the recovery reconciler all reference the same branch."
    fi
    printf '%s\n' \
      '- Before moving the ticket to Done: capture reproducible command or test output as the validation evidence; record it in the completion evidence field using the summary, delivered changes, validation, and development references sections; record cumulative active agent effort rounded upward to 0.25 hours in the Real Effort field; and add native Azure development relations to the pull request and the integrated commit.' \
      '- The completion evidence, Real Effort, and development relations are mandatory prerequisites: the Azure closure guard refuses Done when any are missing.'
  fi
}

# Promotes the internal HU branch bootstrap state into the
# worker-visible globals. Called by the supervisor after
# tracker_prepare_hu_branch returns so the worker prompt, the
# checkpoint, and the lock status can all reference the same
# identifiers. The function is read-only: it never recomputes the
# branch or asks the operator again.
tracker_publish_hu_branch() {
  TRACKER_HU_BRANCH="${AZURE_HU_BRANCH_NAME:-}"
  TRACKER_HU_BRANCH_CATEGORY="${AZURE_HU_BRANCH_CATEGORY:-}"
  TRACKER_HU_BRANCH_ORIGIN="${AZURE_HU_BRANCH_ORIGIN:-}"
  TRACKER_HU_BRANCH_ORIGIN_SHA=""
  TRACKER_HU_BRANCH_REUSED="${AZURE_HU_BRANCH_REUSED:-false}"
  if [[ -n "${AZURE_HU_BRANCH_ORIGIN:-}" ]]; then
    TRACKER_HU_BRANCH_ORIGIN_SHA="$(azure_hu_branch_origin_sha "${AZURE_HU_BRANCH_ORIGIN}" 2>/dev/null || true)"
  fi
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
  tracker_list_eligible_hus
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
  if ! tracker_item_completion_prerequisites "$issue_number" "$branch"; then
    printf '%s: refusing Azure work-item closure %s until completion prerequisites are verified\n' \
      "${RUNNER_NAME:-issue-killer}" "$issue_number" >&2
    return 1
  fi

  az boards work-item update \
    --id "$issue_number" \
    --state "$AZURE_CLOSED_STATE" \
    --org "https://dev.azure.com/${AZURE_ORGANIZATION}" \
    --output json
}

tracker_item_completion_verified() {
  local issue_number="$1"
  local branch="$2"
  local item_json item_state

  [[ -n "$branch" && "$branch" != "unknown" ]] || return 1
  item_json="$(tracker_item_read "$issue_number")" || return 1
  item_state="$(tracker_item_state "$item_json")"
  azure_list_contains "$item_state" "$AZURE_CLOSED_STATES" || return 1
  tracker_item_completion_prerequisites "$issue_number" "$branch"
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
  if [[ -n "${TRACKER_HU_BRANCH:-}" ]]; then
    base_ref="refs/heads/${TRACKER_HU_BRANCH}"
  fi
  jq -r --arg base "$base_ref" '
    if length != 1 then "ambiguous"
    elif (.[0].status // "") == "completed"
      and (.[0].mergeStatus // "") == "succeeded"
      and (.[0].targetRefName // "") == $base then "true"
    else "false"
    end
  ' <<<"$pr_json"
}

# Verifies the live work item meets every prerequisite before the
# configured closed state may be reached. The guard requires:
#   - exactly one PR for the source branch, completed and succeeded
#     into the HU integration branch (or the configured base branch when
#     no HU branch is pinned);
#   - a non-empty completion evidence field with section markers;
#   - a numeric Real Effort value greater than or equal to the active
#     seconds captured for the worker invocation;
#   - native development relations for the pull request and integrated
#     commit so Azure keeps durable traceability.
# The function returns 0 only when every prerequisite is satisfied. The
# closure guard invokes this function before accepting `Done`.
tracker_item_completion_prerequisites() {
  local item_id="$1"
  local branch="$2"
  local pr_json merged evidence effort relations pr_relation commit_relation

  [[ -n "$branch" && "$branch" != "unknown" ]] || return 1
  [[ "$item_id" =~ ^[1-9][0-9]*$ ]] || return 1

  pr_json="$(tracker_prs_for_branch "$branch")" || return 1
  merged="$(tracker_pr_is_merged "$pr_json")"
  [[ "$merged" == "true" ]] || return 1

  evidence="$(tracker_item_read_completion_evidence "$item_id" 2>/dev/null || true)"
  [[ -n "$evidence" ]] || return 1
  grep -Fq 'class="completion-evidence"' <<<"$evidence" || return 1
  grep -Fq 'Summary' <<<"$evidence" || return 1
  grep -Fq 'Delivered changes' <<<"$evidence" || return 1
  grep -Fq 'Validation' <<<"$evidence" || return 1
  grep -Fq 'Development references' <<<"$evidence" || return 1

  effort="$(tracker_item_read_real_effort "$item_id" 2>/dev/null || true)"
  [[ "$effort" =~ ^[0-9]+(\.[0-9]+)?$ ]] || return 1
  awk -v e="$effort" 'BEGIN { exit !(e + 0 >= 0) }' || return 1

  relations="$(tracker_item_list_development_relations "$item_id")"
  [[ -n "$relations" ]] || return 1
  pr_relation="$(grep -Fi 'pull request' <<<"$relations" || true)"
  commit_relation="$(grep -Fi 'commit' <<<"$relations" || true)"
  [[ -n "$pr_relation" && -n "$commit_relation" ]] || return 1
  return 0
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
  local target_branch="refs/heads/${BASE_BRANCH:-main}"

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

  if [[ -n "${TRACKER_HU_BRANCH:-}" ]]; then
    target_branch="refs/heads/${TRACKER_HU_BRANCH}"
  fi
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
    local target_ref
    target_ref="$(jq -r '.[0].targetRefName // empty' <<<"$pr_json" 2>/dev/null || true)"
    if [[ -n "$target_ref" && "$target_ref" != "$target_branch" ]]; then
      emit_recovery_required "Azure PR for branch ${branch} targets ${target_ref:-unknown}; expected ${target_branch}"
    fi
    merged="$(tracker_pr_is_merged "$pr_json" 2>/dev/null || true)"
    [[ "$merged" == "true" || "$merged" == "false" ]] || \
      emit_recovery_required "ambiguous merged state for Azure PR on branch ${branch}"
    [[ "$merged" != "true" ]] || \
      emit_recovery_required "Azure PR for branch ${branch} is already merged; refusing duplicate recovery effects"
  fi

  printf '[%s] Reconciled recovery target: Azure work item %s is %s; open predecessors: %s; PRs for %s: %s; target: %s\n' \
    "${RUNNER_NAME:-issue-killer}" "$issue_number" "$issue_state" "$blocked_by" "$branch" "$pr_count" "$target_branch"
}

# Returns the tracker-specific portion of the worker contract. The
# orchestrator concatenates this supplement with the shared
# PROMPT.md and the runtime configuration section before invoking
# any runtime adapter. Azure uses an HU (User Story) as the
# integration container and one direct child Task or Bug as the
# worker unit. The supplement is intentionally restricted to
# lifecycle rules so the shared contract remains the source of
# truth for safety, status reporting, and recovery semantics.
tracker_worker_supplement() {
  printf '%s\n' \
    'Azure DevOps tracker supplement:' \
    '- Treat the pinned Azure delivery HU as the integration container; never close the HU and never target the repository mainline from the HU integration branch.' \
    '- The worker unit is one direct hierarchical child Task or Bug of the pinned HU. Related links, indirect descendants, and other work-item types are excluded.' \
    '- Open exactly one ticket branch (issue-<ticket-id>-<slug>) from the HU integration branch and exactly one pull request targeting that HU integration branch (not the configured base branch).' \
    '- Confirm exactly one pull request exists for the ticket source branch, that it is completed and succeeded into the HU integration branch, and only then move the ticket to the configured closed state.' \
    '- Record completion evidence, cumulative active effort, and native development relations for the pull request and integrated commit on the work item before the ticket reaches Done; the Azure closure guard refuses Done when any prerequisite is missing.' \
    '- Respect the configured predecessor relation; never start a ticket while an open predecessor remains, and never duplicate a pull request, attachment, development link, effort increment, or state transition.'
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
