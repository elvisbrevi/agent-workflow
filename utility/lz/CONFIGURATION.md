# Configuring lz and its GUI

`lz` keeps no configuration file of its own: a run is decided by its flags, its
environment variables, the credential store and the files installed with it.
The GUI adds one file, `gui.json`, that only prefills forms and shapes
the environment of the runs it starts. Find the setting in this table before
changing anything.

| To change | Edit | Applies to |
|---|---|---|
| Which command, flags and defaults exist | nothing — read `lz catalog` (or `lz --help`) | both |
| Agent, model, effort, fallback, verbosity of one run | that run's flags ([COMMANDS.md](COMMANDS.md), [CODING-AGENTS.md](CODING-AGENTS.md)) | CLI |
| The flags a GUI form opens with | `flagDefaults` / `commandDefaults` in `gui.json` ([GUI.md](GUI.md#settings-file)) | GUI |
| Azure organization, SAG norms source, run-log path | `lz credentials-set` or an environment override | both |
| Secrets directory | `LAZY_WORKFLOW_SECRETS_DIR` in the consuming process's environment | both |
| A secret lz consumes (`AZURE_DEVOPS_EXT_PAT`, `GH_TOKEN`, `LAZY_WORKFLOW_OFF_PASSWORD`) | `lz credentials-set`; lz loads it automatically | both |
| Where skills, agents and the launcher are installed | `install.sh` / `install.ps1` modes, or `lz update <mode>` | CLI |
| How the GUI finds `lz`, its PATH, its repositories, its theme | `gui.json` | GUI |
| What a session may execute | the authority profiles in the repository ([CODING-AGENTS.md](CODING-AGENTS.md#authority-what-a-session-may-execute)) | both |

## Environment variables

`lz catalog | jq '.environment'` lists them for the installed version.

| Variable | Needed for | Default |
|---|---|---|
| `LAZY_WORKFLOW_AZURE_ORGANIZATION` | every Azure workflow and tool, and `pr-*` on an Azure `origin` | none: Azure fails without it |
| `LAZY_WORKFLOW_SAG_NORMS_REPOSITORY` | `--normas-sag` | none: the run stops before a session opens |
| `LAZY_WORKFLOW_LOG_FILE` | moving the run log; `--log-file` overrides it per run | `~/.local/state/lazy-workflow/runs.jsonl` |
| `LAZY_WORKFLOW_SECRETS_DIR` | moving the credential store | `~/.config/secrets` |
| `LAZY_WORKFLOW_OFF_PASSWORD` | `--off` without a value on Unix | passwordless `sudo -n` |
| `AZURE_DEVOPS_EXT_PAT` | `az` without an interactive login, and authenticated SAG sources | `az`'s own login |
| `GH_TOKEN` / `GITHUB_TOKEN` | `gh` without an interactive login | `gh`'s own login; `GH_TOKEN` precedes `GITHUB_TOKEN` |
| `NO_COLOR` | plain output, as `--no-color` | colored on a terminal |

**One place for both.** `lz credentials-set` stores both secrets and the public
variables the catalog marks `credentialStore: true`. `lz` automatically loads
them for commands, desktop runs and web runs, without editing a shell profile.
Bootstrap variables such as `LAZY_WORKFLOW_SECRETS_DIR` stay in the process
environment. An explicit environment value takes precedence over the store.
Put a public variable in `gui.json`'s `environment` only for a profile override:

```bash
bun scripts/gui-settings.ts set environment.LAZY_WORKFLOW_AZURE_ORGANIZATION https://dev.azure.com/acme
```

**Secrets never go in a profile or in `gui.json` as values.** Store them in the
credential store, which also publishes the encrypted chezmoi source when chezmoi
manages the file:

```bash
lz credentials-set --name AZURE_DEVOPS_EXT_PAT                 # hidden prompt
printf '%s\n' 'https://dev.azure.com/acme' | lz credentials-set --name LAZY_WORKFLOW_AZURE_ORGANIZATION --service azure --stdin
lz credentials-audit --name AZURE_DEVOPS_EXT_PAT               # where it exists, never the value
lz credentials-status                                       # effective public values; secrets masked
```

For arbitrary secrets that other programs consume, load the file into that
program's shell or list the name in a GUI profile's `secretEnvironment`.
Configure the account and `LAZY_WORKFLOW_SECRETS_DIR` used by the web server;
the browser displays locked connections and cannot change them.

## Installation and updates

| Mode | Installs |
|---|---|
| `--all-global` | skills, agent entries, CLI, desktop and an existing managed web (what `lz update` uses by default) |
| `--claude-global` / `--claude-local` | Claude Code skills, agents and the CLI, globally or into a project |
| `--global` / `--local` | shared skills and agents |
| `--opencode` / `--both` | OpenCode project entries, alone or with the shared ones |
| `--codex` | Codex skills in `~/.codex/skills`, needed for a fallback that lands on Codex |

```bash
lz update                    # reinstall with --all-global
lz update --codex            # forwarded to the Bun installer
lz update --ref v1 --dry-run # another ref, without changing anything
```

`--target <dir>` sets the project for the local modes; `--uninstall`, `--force`
and `--dry-run` combine with any of them. The launcher lands in `~/.local/bin`
(`lz.cmd` on Windows), which must be on the PATH — and in `extraPath` for a GUI
that does not inherit it.

The global launcher modes build and install the GUI by default; `--no-gui`
skips it. Open it with `lz gui`, or set `LAZY_WORKFLOW_GUI` to another binary.
Rust is optional for the CLI and required for the GUI. A failed build preserves
the existing GUI and reports the prerequisite commands. `lz update` skips a
GUI build when its Git tree hash matches the stamp beside the installed artifact.
Cargo build artifacts persist in `~/.cache/agent-workflow-build/gui`.
Locations, prerequisites and uninstall behavior: [GUI.md](GUI.md#install-and-launch).

Web deployment is configured separately with `lz-web` and the dedicated
provisioning/service scripts for first setup; `lz update` updates the CLI,
skills, desktop and an installed web. Use the web installation's existing absolute settings path with
`LAZY_WORKFLOW_GUI_SETTINGS`, preserve its private state and Access binding,
and follow [GUI.md#web-access](GUI.md#web-access) for deployment and updates.

## Defaults the CLI applies

Read them from the catalog instead of memory — they are what an omitted flag
means, and what an empty GUI field means:

```bash
lz catalog | jq '.groups[].flags[] | select(.default != null) | {flag, default}'
lz catalog | jq '.agents'          # default model and accepted efforts per --cli
```

The CLI has no way to change them persistently: a shell alias or function is the
terminal's equivalent of `flagDefaults`, and either one is visible in the
command that runs.

## Checking the result

```bash
lz catalog > /dev/null && echo "lz responds"          # the binary the PATH resolves works
scripts/preflight.sh --working-directory /repo        # tracker access for a workflow run
bun scripts/gui-settings.ts validate                  # gui.json is readable by the GUI
```

In the GUI, **Ajustes → Estado del equipo** shows, read-only, whether lz, git,
`gh`, `az` and each coding agent CLI are found and whether the Azure
organization is configured; secret values never reach the window or the
browser. Whatever a run would miss raises a notice whose **Reparar con agente**
runs `lz setup` with the detected problems.
