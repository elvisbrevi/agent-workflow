#!/usr/bin/env bash
# Test stub used by `test/unit/system/command.test.ts`.
# Parses a few well-known flags so tests can assert stdout/stderr/exit-code
# capture without spawning external CLIs.

set -u

stdout_value=""
stderr_value=""
exit_value=0
sleep_millis=0

for arg in "$@"; do
  case "$arg" in
    --stdout=*) stdout_value="${arg#--stdout=}" ;;
    --stderr=*) stderr_value="${arg#--stderr=}" ;;
    --exit=*) exit_value="${arg#--exit=}" ;;
    --sleep=*) sleep_millis="${arg#--sleep=}" ;;
    --help)
      printf 'usage: command-stub.sh [--stdout=STR] [--stderr=STR] [--exit=N] [--sleep=MS]\n'
      exit 0
      ;;
    *)
      printf 'unknown flag: %s\n' "$arg" >&2
      exit 64
      ;;
  esac
done

if [[ -n "$stdout_value" ]]; then
  printf '%s' "$stdout_value"
fi

if [[ -n "$stderr_value" ]]; then
  printf '%s' "$stderr_value" >&2
fi

if [[ "$sleep_millis" -gt 0 ]]; then
  # shellcheck disable=SC2086
  sleep "0.${sleep_millis}"
fi

exit "$exit_value"
