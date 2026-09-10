---
name: credentials
description: Finds credentials in ~/.bashrc and macOS Keychain before asking the user, and stores or migrates credentials as Keychain-backed shell variables. Use whenever a coding agent needs, requests, configures, rotates, saves, or encounters a missing credential, token, password, passphrase, API key, secret, or authentication environment variable.
---

# Credentials

Keep credential values in macOS Keychain and keep only Keychain lookups in
`~/.bashrc`. Never print, log, quote back, or place a credential in a command
line, generated file, commit, issue, or chat response.

Use the bundled helper:

```bash
"<skill-directory>/scripts/credentials.py" audit NAME
```

Replace `<skill-directory>` with this skill's directory. Variable names must be
uppercase shell identifiers such as `AZURE_DEVOPS_TOKEN`.

## Before asking for a credential

1. Run `audit NAME`. It reports only whether `~/.bashrc` references the
   credential and whether Keychain contains it; it never returns the value.
2. If both are present, load `~/.bashrc` in the command's shell and retry the
   operation. Do not ask the user for the credential.
3. If Keychain has it but `~/.bashrc` does not, explain that the lookup is
   missing. Add it only when the user asks to save or repair it.
4. Ask for the credential only after the audit reports it missing.

## Store a requested credential

Only after an explicit user request to save, add, rotate, or repair it, run:

```bash
"<skill-directory>/scripts/credentials.py" store NAME
```

The helper reads the value with a hidden prompt, writes or updates the Keychain
item using account `$USER` and service `NAME`, creates a structurally complete
backup with credential values redacted, and writes a sorted managed block in
this form:

```bash
if command -v security >/dev/null 2>&1; then
  export NAME="$(security find-generic-password -a "$USER" -s "NAME" -w 2>/dev/null)"
fi
```

Use `--stdin` only when a protected interactive session supplies stdin without
putting the value in command text or logs.

## Audit and migrate existing entries

Run a read-only audit before changing the file:

```bash
"<skill-directory>/scripts/credentials.py" audit
"<skill-directory>/scripts/credentials.py" migrate
```

The second command previews credential variable names only. After the user
explicitly asks to organize or migrate them, run:

```bash
"<skill-directory>/scripts/credentials.py" migrate --apply
```

The helper moves simple literal values into Keychain, groups and sorts active
top-level exports, preserves function-local scope, and keeps commented entries
commented. Review the reported variable names and backup path, then run `audit`
again. Handle unsupported dynamic shell expressions manually without revealing
their values.
