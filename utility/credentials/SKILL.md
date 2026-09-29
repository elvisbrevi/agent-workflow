---
name: credentials
description: Credentials: audit before asking, load existing secrets, and store or migrate on request. Use when a task needs a token, password, API key, or authentication environment variable.
---

# Credentials

Use `scripts/credentials.py` from this skill's directory. It locates
credentials in `~/.config/secrets/*.env` and legacy macOS Keychain items
without showing their values. The helper writes local env files with `0600`
permissions; chezmoi encrypts managed source files with age. In the commands
below, replace `<skill-directory>` with the directory containing this file and
`NAME` with the required variable.

Keep values in the designated secret files or in the consuming process's
environment. Prevent values from appearing in tool output, command text,
logs, issues, commits, other files, and chat. Run secret-loading commands with
shell tracing disabled. Variable names must be uppercase shell identifiers
containing a credential word such as `TOKEN`, `PASSWORD`, or `API_KEY`.

## Find and use

1. Audit the exact variable before asking the user for it:

   ```bash
   "<skill-directory>/scripts/credentials.py" audit NAME
   ```

   In PowerShell, invoke the same helper with `python`. The result reports
   `secrets=<file|missing>` and `keychain=<present|missing|n/a>`, never the
   value. This step ends when every required name has a reported location.
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
   user for that credential and state the missing variable name.

## Store or migrate on request

When the user explicitly asks to save, add, rotate, or repair a credential,
use the helper's hidden prompt:

```bash
"<skill-directory>/scripts/credentials.py" store NAME [--service SERVICE]
```

When the user explicitly asks to move a legacy macOS Keychain item into the
env-file model, use:

```bash
"<skill-directory>/scripts/credentials.py" migrate NAME [--service SERVICE]
```

In PowerShell, run either command with `python`. The helper writes
`export NAME=<shell-quoted value>` to the matching service file, or to
`<service>.env` (default `other.env`) when the name is new. It rejects empty
values, keeps the file at `0600`, and attempts `chezmoi re-add` when chezmoi
already manages the file. Use a single-line value; `--stdin` reads only its
first line and requires protected stdin that keeps the value out of command
text and logs.

After a write, run `audit NAME` again. The local step is complete when exactly
the intended env file reports the name and the helper has reported whether
chezmoi updated its encrypted source. If the user requested availability on
another machine, publish the encrypted chezmoi change and run `chezmoi update`
there; a local store or migration alone does not sync it.
