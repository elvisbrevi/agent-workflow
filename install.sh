#!/usr/bin/env bash
set -eu

# Bootstrap only: installation policy lives in installer/.
command -v git >/dev/null 2>&1 || { echo 'agent-workflow: Se requiere Git en PATH.' >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { echo 'agent-workflow: Se requiere Bun en PATH. Instala Bun: https://bun.sh' >&2; exit 1; }

installer_ref=main
installer_read_ref=false
for installer_arg in "$@"; do
  if [ "$installer_read_ref" = true ]; then
    installer_ref="$installer_arg"
    installer_read_ref=false
  elif [ "$installer_arg" = --ref ]; then
    installer_read_ref=true
  fi
done
if [ "$installer_read_ref" = true ]; then
  echo 'agent-workflow: --ref requiere una rama o tag.' >&2
  exit 1
fi
installer_temporary=$(mktemp -d "${TMPDIR:-/tmp}/agent-workflow-bootstrap.XXXXXX")
trap 'rm -rf "$installer_temporary"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git clone --branch "$installer_ref" --depth 1 "${AGENT_WORKFLOW_REPO_URL:-https://github.com/elvisbrevi/agent-workflow.git}" "$installer_temporary/repo" --quiet
bun run "$installer_temporary/repo/installer/main.ts" "$@"
