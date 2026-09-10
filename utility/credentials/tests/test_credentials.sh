#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${SKILL_DIR}/scripts/credentials.py"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/credentials-skill.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

mkdir -p "${TEST_ROOT}/bin" "${TEST_ROOT}/keychain"
cat > "${TEST_ROOT}/bin/security" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
operation="$1"
shift
service=""
value=""
while (($#)); do
  case "$1" in
    -s) service="$2"; shift 2 ;;
    -w)
      if [[ "$operation" == 'find-generic-password' ]]; then
        shift
      elif (($# > 1)) && [[ "$2" != -* ]]; then
        value="$2"
        shift 2
      else
        IFS= read -r value
        shift
      fi
      ;;
    *) shift ;;
  esac
done
file="${FAKE_KEYCHAIN}/${service}"
case "$operation" in
  add-generic-password) printf '%s' "$value" > "$file" ;;
  find-generic-password) [[ -f "$file" ]] && cat "$file" ;;
  *) exit 2 ;;
esac
EOF
chmod +x "${TEST_ROOT}/bin/security"

BASHRC="${TEST_ROOT}/bashrc"
cat > "$BASHRC" <<'EOF'
export PATH="/usr/bin:$PATH"

#api keys
if command -v security >/dev/null 2>&1; then
  export AZURE_DEVOPS_TOKEN="$(security find-generic-password -a "$USER" -s "AZURE_DEVOPS_TOKEN" -w 2>/dev/null)"
fi
export OPENAI_API_KEY="openai-fixture"
# export GOOGLE_AI_API_KEY="google-fixture"

tool-profile() {
  ANTHROPIC_AUTH_TOKEN="anthropic-fixture" \
  tool "$@"
}
EOF

export FAKE_KEYCHAIN="${TEST_ROOT}/keychain"
export PATH="${TEST_ROOT}/bin:${PATH}"
export USER="credential-test"
printf 'azure-fixture' > "${FAKE_KEYCHAIN}/AZURE_DEVOPS_TOKEN"

preview="$TEST_ROOT/preview"
"$SCRIPT" --bashrc "$BASHRC" migrate > "$preview"
grep -Fq 'OPENAI_API_KEY' "$preview"
grep -Fq 'GOOGLE_AI_API_KEY' "$preview"
grep -Fq 'ANTHROPIC_AUTH_TOKEN' "$preview"
grep -Fq 'Preview only' "$preview"
grep -Fq 'openai-fixture' "$BASHRC"

"$SCRIPT" --bashrc "$BASHRC" migrate --apply > "$TEST_ROOT/migrate"
grep -Fq 'export AZURE_DEVOPS_TOKEN=' "$BASHRC"
grep -Fq 'export OPENAI_API_KEY=' "$BASHRC"
grep -Fq '# export GOOGLE_AI_API_KEY=' "$BASHRC"
grep -Fq 'ANTHROPIC_AUTH_TOKEN="$(security find-generic-password' "$BASHRC"
! grep -Fq 'openai-fixture' "$BASHRC"
! grep -Fq 'google-fixture' "$BASHRC"
! grep -Fq 'anthropic-fixture' "$BASHRC"
[[ "$(cat "${FAKE_KEYCHAIN}/OPENAI_API_KEY")" == 'openai-fixture' ]]
[[ "$(cat "${FAKE_KEYCHAIN}/GOOGLE_AI_API_KEY")" == 'google-fixture' ]]
[[ "$(cat "${FAKE_KEYCHAIN}/ANTHROPIC_AUTH_TOKEN")" == 'anthropic-fixture' ]]
[[ -n "$(find "$TEST_ROOT" -name 'bashrc.credentials-backup-*' -print -quit)" ]]
grep -R -Fq 'export PATH="/usr/bin:$PATH"' "$TEST_ROOT"/bashrc.credentials-backup-*
grep -R -Fq 'OPENAI_API_KEY="<redacted>"' "$TEST_ROOT"/bashrc.credentials-backup-*
! grep -R -Fq 'openai-fixture' "$TEST_ROOT"/bashrc.credentials-backup-*
! grep -R -Fq 'google-fixture' "$TEST_ROOT"/bashrc.credentials-backup-*
! grep -R -Fq 'anthropic-fixture' "$TEST_ROOT"/bashrc.credentials-backup-*

printf 'new-fixture\n' | "$SCRIPT" --bashrc "$BASHRC" store NEW_API_KEY --stdin \
  > "$TEST_ROOT/store"
grep -Fq 'export NEW_API_KEY=' "$BASHRC"
[[ "$(cat "${FAKE_KEYCHAIN}/NEW_API_KEY")" == 'new-fixture' ]]

"$SCRIPT" --bashrc "$BASHRC" audit NEW_API_KEY > "$TEST_ROOT/audit"
grep -Fq 'bashrc=managed-keychain; keychain=present' "$TEST_ROOT/audit"
! grep -Fq 'new-fixture' "$TEST_ROOT/audit"

STORE_BASHRC="${TEST_ROOT}/store-bashrc"
cat > "$STORE_BASHRC" <<'EOF'
if command -v security >/dev/null 2>&1; then
  export AZURE_DEVOPS_TOKEN="$(security find-generic-password -a "$USER" -s "AZURE_DEVOPS_TOKEN" -w 2>/dev/null)"
fi
EOF
printf 'github-fixture\n' | "$SCRIPT" --bashrc "$STORE_BASHRC" store GH_PAT --stdin \
  > "$TEST_ROOT/store-pat"
[[ "$(grep -Fc 'if command -v security' "$STORE_BASHRC")" == '1' ]]
grep -Fq 'export AZURE_DEVOPS_TOKEN=' "$STORE_BASHRC"
grep -Fq 'export GH_PAT=' "$STORE_BASHRC"

CONFLICT_BASHRC="${TEST_ROOT}/conflict-bashrc"
cat > "$CONFLICT_BASHRC" <<'EOF'
export DUPLICATE_API_KEY="first-fixture"
export DUPLICATE_API_KEY="second-fixture"
EOF
"$SCRIPT" --bashrc "$CONFLICT_BASHRC" migrate > "$TEST_ROOT/conflict-preview"
grep -Fq 'Dynamic or unsupported entries requiring manual review:' "$TEST_ROOT/conflict-preview"
grep -Fq 'DUPLICATE_API_KEY' "$TEST_ROOT/conflict-preview"
! grep -Fq 'first-fixture' "$TEST_ROOT/conflict-preview"
! grep -Fq 'second-fixture' "$TEST_ROOT/conflict-preview"

/usr/bin/python3 -m py_compile "$SCRIPT"
printf 'PASS: credentials skill\n'
