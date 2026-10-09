#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHELL_BIN="$(command -v "${BASH_BIN:-bash}")"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-workflow-bootstrap-tests.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

mkdir -p "$TEST_ROOT/source/installer" "$TEST_ROOT/home" "$TEST_ROOT/bin" "$TEST_ROOT/tmp"
printf '%s\n' 'version-main' > "$TEST_ROOT/source/installer/main.ts"
git -C "$TEST_ROOT/source" init --quiet
git -C "$TEST_ROOT/source" config user.name 'Bootstrap Test'
git -C "$TEST_ROOT/source" config user.email 'bootstrap@example.invalid'
git -C "$TEST_ROOT/source" add .
git -C "$TEST_ROOT/source" commit --quiet -m 'main fixture'
git -C "$TEST_ROOT/source" branch -M main
git -C "$TEST_ROOT/source" switch --quiet -c requested-ref
printf '%s\n' 'version-requested' > "$TEST_ROOT/source/installer/main.ts"
git -C "$TEST_ROOT/source" commit --quiet -am 'requested fixture'
cat > "$TEST_ROOT/bin/bun" <<'BUN'
#!/bin/sh
[ "$1" = run ] || exit 91
[ -f "$2" ] || exit 92
cat "$2" > "$VERSION_LOG"
shift 2
printf '%s\n' "$@" > "$ARG_LOG"
exit "${FAKE_EXIT:-0}"
BUN
chmod +x "$TEST_ROOT/bin/bun"
export HOME="$TEST_ROOT/home" TMPDIR="$TEST_ROOT/tmp" AGENT_WORKFLOW_REPO_URL="$TEST_ROOT/source"
export ARG_LOG="$TEST_ROOT/args" VERSION_LOG="$TEST_ROOT/version"
export PATH="$TEST_ROOT/bin:$PATH"

cat "$ROOT_DIR/install.sh" | "$SHELL_BIN" -s -- --all-global --target "$TEST_ROOT/proyecto con espacios" --ref requested-ref --dry-run --no-gui --force --uninstall > "$TEST_ROOT/output" 2>&1 || fail 'piped bootstrap failed'
printf '%s\n' --all-global --target "$TEST_ROOT/proyecto con espacios" --ref requested-ref --dry-run --no-gui --force --uninstall > "$TEST_ROOT/expected"
cmp -s "$ARG_LOG" "$TEST_ROOT/expected" || fail 'arguments changed during delegation'
[ "$(cat "$VERSION_LOG")" = version-requested ] || fail '--ref did not select bootstrap installer version'
[ -z "$(ls -A "$TEST_ROOT/tmp")" ] || fail 'bootstrap left temporary checkout'
[ -z "$(ls -A "$HOME")" ] || fail 'bootstrap wrote to installation HOME'
pass 'stdin bootstrap obtains requested version and forwards every argument intact'

set +e
FAKE_EXIT=17 "$SHELL_BIN" "$ROOT_DIR/install.sh" --global > "$TEST_ROOT/failure" 2>&1
status=$?
set -e
[ "$status" = 17 ] || fail 'installer exit code was not propagated'
[ -z "$(ls -A "$TEST_ROOT/tmp")" ] || fail 'failed delegation left temporary checkout'
pass 'exit status and cleanup survive failed delegation'

mkdir -p "$TEST_ROOT/no-bun"
ln -s "$(command -v git)" "$TEST_ROOT/no-bun/git"
set +e
PATH="$TEST_ROOT/no-bun" "$SHELL_BIN" "$ROOT_DIR/install.sh" --all-global > "$TEST_ROOT/missing-bun" 2>&1
status=$?
set -e
[ "$status" != 0 ] || fail 'missing Bun should fail'
rg -q 'Se requiere Bun en PATH' "$TEST_ROOT/missing-bun" || fail 'missing Bun diagnostic is not actionable'
pass 'missing Bun fails before cloning'

mkdir -p "$TEST_ROOT/no-git"
ln -s "$TEST_ROOT/bin/bun" "$TEST_ROOT/no-git/bun"
set +e
PATH="$TEST_ROOT/no-git" "$SHELL_BIN" "$ROOT_DIR/install.sh" --global > "$TEST_ROOT/missing-git" 2>&1
status=$?
set -e
[ "$status" != 0 ] || fail 'missing Git should fail'
rg -q 'Se requiere Git en PATH' "$TEST_ROOT/missing-git" || fail 'missing Git diagnostic is not actionable'
pass 'missing Git fails before cloning'

printf 'All bootstrap tests passed (%s).\n' "$SHELL_BIN"
