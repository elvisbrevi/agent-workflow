---
name: credentials
description: Credentials: audit before asking, load existing secrets, and store or migrate on request. Use when a task needs a token, password, API key, or authentication environment variable.
---

# Credentials

Use `lz credentials-*` to audit, store, read, migrate, and update credentials,
and for every credential command you suggest to the user. Values stay in
`~/.config/secrets/*.env` or the consuming process's environment; keep them
out of tool output, command text, logs, issues, commits, other files, and chat.
Run secret-loading commands with shell
tracing disabled. Names must be uppercase shell identifiers containing a
credential word such as `TOKEN`, `PASSWORD`, or `API_KEY`.

## Find and use

1. Audit the exact variable before asking the user for it:

   ```bash
   lz credentials-audit --name NAME
   ```

   The result reports `secrets` (file names, or an empty list) and `keychain`
   (`present`, `missing`, or `n/a`), never the value. This step ends when every
   required name has a reported location.
2. If `secrets` names a file, load that file in the command's shell
   (`. ~/.config/secrets/<file>` or `load-env <service>`) and retry the
   operation. In PowerShell, assign one variable without displaying it:
   `$env:NAME = (& lz credentials-get --name NAME --force)`. This step ends
   when the operation succeeds or reports a different error.
3. If the file is missing but Keychain has the item, use it for the current
   operation without printing it. On macOS, a shell can pass a named item to
   one command like this:

   ```bash
   if secret="$(security find-generic-password -a "$USER" -s NAME -w)" && [ -n "$secret" ]; then
     NAME="$secret" command-that-needs-it
     unset secret
   fi
   ```

   Replace both `NAME` tokens with the audited variable. This step ends when
   the command has used the existing item. If neither store has it, ask the
   user to run `lz credentials-set --name NAME [--service SERVICE]` in their
   terminal, including `--service` when known, and tell you when it is ready.
   Ask them to enter the value at the hidden prompt, never in chat.

## Store or migrate on request

When the user explicitly asks to save, add, rotate, or repair a credential,
run this in a user-accessible terminal, or give them the command if your
terminal cannot accept their input:

```bash
lz credentials-set --name NAME [--service SERVICE]
```

When the user explicitly asks to move a legacy macOS Keychain item into the
env-file model, run:

```bash
lz credentials-migrate --name NAME [--service SERVICE]
```

Both commands write the existing declaring file, or `<service>.env` (default
`other.env`) when the name is new. They keep the file at `0600`; when chezmoi
manages it, they re-add, commit, and push its encrypted source. Their
`chezmoiSource` result reports the publication state without printing the
value. For a protected noninteractive input, `credentials-set --stdin` reads
only the first line; keep the value out of command text and logs.

After a write, run `lz credentials-audit --name NAME` again. The local step is
complete when `secrets` names the intended env file. If the user requested
availability on another machine, check that `chezmoiSource` is `published`
and run `chezmoi update` there; a local write alone does not sync it.
