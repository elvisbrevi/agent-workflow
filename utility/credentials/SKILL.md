---
name: credentials
description: Audit, load, store, rotate and migrate credentials, and configure lz's stored environment, including its Azure organization. Use for tokens, passwords, API keys or configuring lz connections from any coding agent.
---

# Credentials

Use `lz credentials-*` to audit, store, read, migrate, and update credentials,
and for every credential command you suggest to the user. Secret values stay in
`~/.config/secrets/*.env` or the consuming process's environment; keep them
out of tool output, command text, logs, issues, commits, other files, and chat.
Run secret-loading commands with shell
tracing disabled. Names must be uppercase shell identifiers containing a
credential word such as `TOKEN`, `PASSWORD`, or `API_KEY`. Non-secret lz variables
are also accepted when `lz catalog` marks them `credentialStore: true`.

## Configure lz connections

Use the same commands for the CLI, desktop and owner-hosted web server. Configure
the OS account and credential directory that actually run lz; saving on another
machine or under another account does not configure that server. GUI profile
environment values override the shared store; shell/process values also take
precedence. Inspect `lz credentials-status [--name NAME]` first: it reports the
effective source and public values, with presence only for secrets.

For an Azure setup, audit both `LAZY_WORKFLOW_AZURE_ORGANIZATION` and
`AZURE_DEVOPS_EXT_PAT` before asking for missing values. The organization URL is
public: when supplied by the user or verified from their target repository, an
agent can store it directly:

```bash
printf '%s\n' 'https://dev.azure.com/acme' | lz credentials-set --name LAZY_WORKFLOW_AZURE_ORGANIZATION --service azure --stdin
lz credentials-set --name AZURE_DEVOPS_EXT_PAT --service azure
lz credentials-status
```

Replace the example URL with the intended organization; never guess it. The
PAT uses the hidden prompt or an existing protected input stream, never chat or
command text. Audit each write again. `lz` automatically loads the catalog's
stored variables for its commands and child tools; no shell-profile edit or GUI
`secretEnvironment` entry is needed for those names. For arbitrary secrets that
other programs need, follow **Find and use** below.

The web settings page is read-only for connections: a lock accompanies public
values, and secrets show only configured/missing status. Reload its environment
after a server-side change to verify the effective result. Use the lz skill's
settings helper only for a profile override or other GUI preferences.

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
