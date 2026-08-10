#!/usr/bin/env bash
set -euo pipefail

source_path="${BASH_SOURCE[0]}"
while [[ -L "$source_path" ]]; do
  source_dir="$(cd -P "$(dirname "$source_path")" && pwd)"
  source_path="$(readlink "$source_path")"
  [[ "$source_path" = /* ]] || source_path="${source_dir}/${source_path}"
done

agent_dir="$(cd -P "$(dirname "$source_path")" && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "lazy-workflow: Bun is required but was not found in PATH." >&2
  exit 127
fi

exec bun run "${agent_dir}/main.ts" "$@"
