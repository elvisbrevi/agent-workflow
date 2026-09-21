#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${SKILL_DIR}/scripts/credentials.py"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/credentials-skill.XXXXXX")"
cleanup_test_root() {
  rm -rf "$TEST_ROOT"
}
trap cleanup_test_root EXIT

SECRETS="${TEST_ROOT}/secrets"
mkdir -p "${TEST_ROOT}/bin" "$SECRETS" "${TEST_ROOT}/keychain"

cat > "${TEST_ROOT}/bin/security" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
operation="$1"
shift
service=""
while (($#)); do
  case "$1" in
    -s) service="$2"; shift 2 ;;
    *) shift ;;
  esac
done
file="${FAKE_KEYCHAIN}/${service}"
case "$operation" in
  find-generic-password) [[ -f "$file" ]] && cat "$file" ;;
  *) exit 2 ;;
esac
EOF
chmod +x "${TEST_ROOT}/bin/security"

cat > "${TEST_ROOT}/bin/chezmoi" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  source-path) [[ -e "${2:-}" ]] && printf '%s\n' "$2" ;;
  re-add) printf 're-add %s\n' "${2:-}" >> "$FAKE_CHEZMOI_LOG" ;;
  *) exit 2 ;;
esac
EOF
chmod +x "${TEST_ROOT}/bin/chezmoi"

cat > "${SECRETS}/openai.env" <<'EOF'
# openai.env - fixture
export OPENAI_API_KEY='openai-fixture'
EOF
cat > "${SECRETS}/other.env" <<'EOF'
# other.env - fixture
export SLACK_TOKEN='slack-fixture'
export PATH="/usr/bin:$PATH"
EOF

export FAKE_KEYCHAIN="${TEST_ROOT}/keychain"
export FAKE_CHEZMOI_LOG="${TEST_ROOT}/chezmoi.log"
: > "$FAKE_CHEZMOI_LOG"
export PATH="${TEST_ROOT}/bin:${PATH}"
printf 'chain-fixture' > "${FAKE_KEYCHAIN}/KEYCHAIN_ONLY_TOKEN"

mode_of() {
  python3 -c 'import os,sys;print(oct(os.stat(sys.argv[1]).st_mode & 0o777))' "$1"
}

"$SCRIPT" --secrets-dir "$SECRETS" audit > "$TEST_ROOT/audit-all"
grep -Fq 'OPENAI_API_KEY: secrets=openai.env;' "$TEST_ROOT/audit-all"
grep -Fq 'SLACK_TOKEN: secrets=other.env;' "$TEST_ROOT/audit-all"
! grep -Fq 'fixture' "$TEST_ROOT/audit-all"
! grep -Fq 'PATH' "$TEST_ROOT/audit-all"

"$SCRIPT" --secrets-dir "$SECRETS" audit OPENAI_API_KEY > "$TEST_ROOT/audit-one"
grep -Fq 'secrets=openai.env' "$TEST_ROOT/audit-one"
! grep -Fq 'openai-fixture' "$TEST_ROOT/audit-one"

"$SCRIPT" --secrets-dir "$SECRETS" audit NOPE_API_KEY > "$TEST_ROOT/audit-missing"
grep -Fq 'secrets=missing' "$TEST_ROOT/audit-missing"

printf 'new-fixture\n' | \
  "$SCRIPT" --secrets-dir "$SECRETS" store NEW_API_KEY --service github --stdin \
  > "$TEST_ROOT/store"
grep -Fq 'export NEW_API_KEY=' "${SECRETS}/github.env"
grep -Fq 'new-fixture' "${SECRETS}/github.env"
[[ "$(mode_of "${SECRETS}/github.env")" == '0o600' ]]
! grep -Fq 'new-fixture' "$TEST_ROOT/store"
grep -Fq 're-add' "$FAKE_CHEZMOI_LOG"

printf 'rotated-fixture\n' | \
  "$SCRIPT" --secrets-dir "$SECRETS" store OPENAI_API_KEY --stdin \
  > "$TEST_ROOT/rotate"
grep -Fq 'rotated-fixture' "${SECRETS}/openai.env"
! grep -Fq 'openai-fixture' "${SECRETS}/openai.env"
[[ "$(grep -Fc 'export OPENAI_API_KEY=' "${SECRETS}/openai.env")" == '1' ]]
! grep -Fq 'rotated-fixture' "$TEST_ROOT/rotate"

if "$SCRIPT" --secrets-dir "$SECRETS" store lowercase --service x --stdin \
  > "$TEST_ROOT/bad-name" 2>&1 <<< 'value'; then
  printf 'expected an invalid name to fail\n' >&2
  exit 1
fi

"$SCRIPT" --secrets-dir "$SECRETS" migrate KEYCHAIN_ONLY_TOKEN --service legacy \
  > "$TEST_ROOT/migrate"
grep -Fq 'export KEYCHAIN_ONLY_TOKEN=' "${SECRETS}/legacy.env"
grep -Fq 'chain-fixture' "${SECRETS}/legacy.env"
! grep -Fq 'chain-fixture' "$TEST_ROOT/migrate"

if "$SCRIPT" --secrets-dir "$SECRETS" migrate ABSENT_STORE_TOKEN --service legacy \
  > "$TEST_ROOT/migrate-missing" 2>&1; then
  printf 'expected a missing Keychain item to fail\n' >&2
  exit 1
fi
grep -Fq 'Keychain' "$TEST_ROOT/migrate-missing"

/usr/bin/python3 -m py_compile "$SCRIPT"
printf 'PASS: credentials skill\n'
