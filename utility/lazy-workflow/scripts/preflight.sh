#!/usr/bin/env bash
# Read-only preflight for a lazy-workflow run.
#
# Every probe here is a deterministic tool command: no session is opened, no
# tracker item is mutated, nothing is written. It answers the questions that
# decide the next command — does the environment authenticate, does the HU have
# an integration branch, is there eligible work — in one pass instead of four
# round trips, and prints one JSON document so an agent can read the answers
# without parsing operator output.
#
#   preflight.sh --working-directory /repo                 # GitHub scope
#   preflight.sh --hu 23438 --working-directory /repo      # Azure HU scope
#   preflight.sh --hu 23438 --ticket 23459 --working-directory /repo
#   preflight.sh --issue 201 --working-directory /repo     # one GitHub issue
#
# Exit codes: 0 the report was produced (read `allOk` and each probe's `ok`),
# 2 a usage error, 3 no lazy-workflow binary could be resolved.

set -uo pipefail

WORKING_DIRECTORY="$PWD"
HU=""
ISSUE=""
TICKET=""

die_usage() { printf '%s\n' "$1" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --working-directory) [[ $# -ge 2 ]] || die_usage "--working-directory requires a path"; WORKING_DIRECTORY="$2"; shift 2 ;;
    --hu)     [[ $# -ge 2 ]] || die_usage "--hu requires an id";     HU="$2";     shift 2 ;;
    --issue)  [[ $# -ge 2 ]] || die_usage "--issue requires an id";  ISSUE="$2";  shift 2 ;;
    --ticket) [[ $# -ge 2 ]] || die_usage "--ticket requires an id"; TICKET="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die_usage "Unknown argument: $1" ;;
  esac
done

[[ -n "$TICKET" && -z "$HU" ]] && die_usage "--ticket also needs --hu: a ticket is read through its HU"

# The binary, in the order an operator would find it: an explicit override, the
# installed launcher, then the agent source next to this skill — which is where
# it lives when the skill is used from a repository checkout or its managed
# cache, since `cd -P` resolves the install symlink back to the real directory.
resolve_runner() {
  if [[ -n "${LAZY_WORKFLOW_BIN:-}" ]]; then RUNNER=("${LAZY_WORKFLOW_BIN}"); return 0; fi
  if command -v lazy-workflow >/dev/null 2>&1; then RUNNER=(lazy-workflow); return 0; fi
  local script_dir agent_main
  script_dir="$(cd -P "$(dirname "$0")" && pwd)"
  agent_main="${LAZY_WORKFLOW_HOME:-${script_dir}/../../../agent/lazy-workflow}/main.ts"
  if [[ -f "$agent_main" ]] && command -v bun >/dev/null 2>&1; then RUNNER=(bun run "$agent_main"); return 0; fi
  return 1
}

if ! resolve_runner; then
  printf '%s\n' \
    "No lazy-workflow binary found. Install it with install.sh --all-global, or set" \
    "LAZY_WORKFLOW_BIN=/path/to/lazy-workflow, or LAZY_WORKFLOW_HOME=/path/to/agent/lazy-workflow." >&2
  exit 3
fi

json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/}
  s=${s//$'\n'/\\n}
  printf '%s' "$s"
}

PROBES=""
NOTES=""
ALL_OK=true
BRANCH_JSON=""

add_note() { NOTES="${NOTES}${NOTES:+,}$(printf '\n    "%s"' "$(json_escape "$1")")"; }

# Run one tool command. Its JSON result is on stdout and its operator output on
# stderr, so the two are captured separately and neither corrupts the other.
probe() {
  local label="$1"; shift
  local stdout_file stderr_file status
  stdout_file="$(mktemp)"; stderr_file="$(mktemp)"
  "${RUNNER[@]}" "$@" --no-color >"$stdout_file" 2>"$stderr_file"
  status=$?
  local out err entry stamped
  out="$(tr -d '\033' <"$stdout_file")"
  err="$(tr -d '\033' <"$stderr_file")"
  rm -f "$stdout_file" "$stderr_file"

  # Every reported line is stamped `dd/mm/yy HH:mm:ss`; the run panel is not.
  # Keeping only the stamped lines leaves the cause instead of the banner.
  stamped="$(printf '%s\n' "$err" | grep -E '^[0-9]{2}/[0-9]{2}/[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} ')"
  [[ -n "$stamped" ]] && err="$stamped"
  err="$(printf '%s\n' "$err" | tail -n 5)"

  if [[ $status -eq 0 && -n "$out" ]]; then
    entry="$(printf '\n    {\n      "probe": "%s",\n      "command": "lazy-workflow %s",\n      "ok": true,\n      "result": %s\n    }' \
      "$(json_escape "$label")" "$(json_escape "$*")" "$out")"
    [[ "$label" == "hu-branch" ]] && BRANCH_JSON="$out"
  else
    ALL_OK=false
    entry="$(printf '\n    {\n      "probe": "%s",\n      "command": "lazy-workflow %s",\n      "ok": false,\n      "exitCode": %s,\n      "error": "%s"\n    }' \
      "$(json_escape "$label")" "$(json_escape "$*")" "$status" "$(json_escape "${err:-$out}")")"
  fi
  PROBES="${PROBES}${PROBES:+,}${entry}"
}

if [[ -n "$HU" ]]; then
  SCOPE="azure"
  probe hu           hu-info          --hu "$HU"
  probe hu-children  hu-children-info --hu "$HU"
  probe hu-branch    hu-branch-info   --hu "$HU"
  if [[ -n "$TICKET" ]]; then
    probe ticket            ticket-info            --hu "$HU" --ticket "$TICKET"
    probe ticket-completion ticket-completion-info --hu "$HU" --ticket "$TICKET"
  fi
  if [[ "$BRANCH_JSON" =~ \"branch\"[[:space:]]*:[[:space:]]*null ]]; then
    add_note "HU ${HU} has no integration branch link: the first 'code --hu ${HU}' needs --base-branch <name>."
  fi
else
  SCOPE="github"
  probe auth   github-auth-info  --working-directory "$WORKING_DIRECTORY"
  probe repo   github-repo-info  --working-directory "$WORKING_DIRECTORY"
  if [[ -n "$ISSUE" ]]; then
    probe issue github-issue-info --issue "$ISSUE" --working-directory "$WORKING_DIRECTORY"
  else
    probe queue    github-issue-list   --working-directory "$WORKING_DIRECTORY"
    probe selection github-issue-select --working-directory "$WORKING_DIRECTORY"
  fi
fi

[[ "$ALL_OK" == true ]] || add_note "A probe failed: read its 'error' before proposing a command; the failure is the answer, not a reason to retry blindly."

printf '{\n  "scope": "%s",\n  "workingDirectory": "%s",\n  "runner": "%s",\n  "allOk": %s,\n  "probes": [%s\n  ],\n  "notes": [%s\n  ]\n}\n' \
  "$SCOPE" \
  "$(json_escape "$WORKING_DIRECTORY")" \
  "$(json_escape "${RUNNER[*]}")" \
  "$ALL_OK" \
  "$PROBES" \
  "$NOTES"
