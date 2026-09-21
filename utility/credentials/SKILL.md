---
name: credentials
description: Finds credentials in ~/.config/secrets/*.env (chezmoi + age) and in macOS Keychain before asking the user, and stores or migrates them as encrypted env files. Use whenever a coding agent needs, requests, configures, rotates, saves, or encounters a missing credential, token, password, passphrase, API key, secret, or authentication environment variable.
---

# Credentials

Credential values live in `~/.config/secrets/<service>.env` (local files with
0600 permissions), committed to a private chezmoi repository where they are
encrypted with age. Never print, log, quote back, or place a credential in a
command line, generated file, commit, issue, or chat response.

Use the bundled helper:

```bash
"<skill-directory>/scripts/credentials.py" audit NAME
```

Replace `<skill-directory>` with this skill's directory. Variable names must be
uppercase shell identifiers such as `AZURE_DEVOPS_TOKEN`.

## Before asking for a credential

1. Run `audit NAME`. It reports which env file holds it and whether macOS
   Keychain still has a legacy copy; it never returns the value.
2. If an env file has it, load that file in the command's shell
   (`. ~/.config/secrets/<file>` or the `load-env <service>` helper) and retry.
   Do not ask the user for the credential.
3. Ask for the credential only after the audit reports it missing.

## Store a requested credential

Only after an explicit user request to save, add, rotate, or repair it, run:

```bash
"<skill-directory>/scripts/credentials.py" store NAME [--service SERVICE]
```

The helper reads the value with a hidden prompt, updates
`~/.config/secrets/<service>.env` (creating it with 0600 when needed),
re-adds it to chezmoi so the encrypted source state is updated, and prints how
to publish the change. Values never appear in the output. Use `--stdin` only
when a protected interactive session supplies stdin without putting the value
in command text or logs.

## Migrate a legacy Keychain item

On macOS, credentials that still live only in Keychain can be moved into the
env-file model without retyping them:

```bash
"<skill-directory>/scripts/credentials.py" migrate NAME [--service SERVICE]
```

The helper reads the value from Keychain without printing it.

## Rules

- File format is `export NAME=<shell-quoted value>`; one credential per line.
- The helper validates the name and refuses values that span multiple lines.
- `~/.bashrc` is never edited: secrets are loaded on demand, not at shell start.
- To make the change available on another machine, publish it and run
  `chezmoi update` there; files are decrypted with that machine's age identity.
