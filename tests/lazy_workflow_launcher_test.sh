#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCHER="${ROOT_DIR}/agent/lazy-workflow/run.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/lazy-workflow-launcher.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1" expected="$2"
  grep -Fq -- "$expected" "$file" || fail "Expected '${expected}' in ${file}"
}

fake_bin="${TEST_ROOT}/bin"
output="${TEST_ROOT}/bun-args.log"
mkdir -p "$fake_bin"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" "$@"' > "${fake_bin}/bun"
chmod +x "${fake_bin}/bun"

ln -s "$LAUNCHER" "${TEST_ROOT}/lazy-workflow"

PATH="${fake_bin}:/usr/bin:/bin" "${TEST_ROOT}/lazy-workflow" \
  plan --hu 23438 --working-directory /tmp/example >"$output"

assert_contains "$output" 'run'
assert_contains "$output" "${ROOT_DIR}/agent/lazy-workflow/main.ts"
assert_contains "$output" 'plan'
assert_contains "$output" '23438'
assert_contains "$output" '--working-directory'
assert_contains "$output" '/tmp/example'

printf '%s launcher tests passed.\n' 1
