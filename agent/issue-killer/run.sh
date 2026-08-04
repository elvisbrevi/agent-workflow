#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ISSUE_KILLER_CANONICAL=true
exec "${SCRIPT_DIR}/../claude-minimax-issue-runner/run.sh" "$@"
