# Desktop and web interfaces

`agent/lazy-workflow/gui/` is a Tauri app for the work itself: the Azure HU and
GitHub issues assigned to the operator, Plan or Code on them, and the runs that
followed. It holds no workflow logic of its own: it reads `lz catalog` to build
the same argument vector an operator would type for `plan`, `code` and `setup`,
and runs `lz` as a child process. Every effect, validation, checkpoint and
run-log record is still the CLI's, so anything this skill says about a command
holds in the GUI too.

Contents: [Install and launch](#install-and-launch) · [How it maps to the CLI](#how-it-maps-to-the-cli) ·
[Settings file](#settings-file) · [Configure it](#configure-it) ·
[Web access](#web-access) · [What the GUI adds](#what-the-gui-adds) · [Troubleshooting](#troubleshooting)

## Install and launch

The shared Bun installer builds and installs the GUI by default in
`--all-global` and `--claude-global`. Rust and Tauri's system libraries are
required only for this build; missing tools or build failures warn, complete
the CLI installation and preserve the previous GUI.

```bash
lz update
lz gui
lz update --all-global --no-gui    # skip GUI compilation and installation
lz update --no-web                 # skip an installed web deployment
```

| Platform | Build prerequisites | Installation |
|---|---|---|
| macOS | Rust, Xcode Command Line Tools (`xcode-select --install`) | `~/Applications/lz.app` |
| Linux | Rust, `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`, `build-essential` | `~/.local/bin/lz-gui`, `~/.local/share/applications/lz.desktop` |
| Windows | Rust MSVC, Microsoft C++ Build Tools, WebView2 | `~/.local/bin/lz-gui.exe` |

See [the GUI README](../../agent/lazy-workflow/gui/README.md#install-and-launch)
for prerequisite commands. `LAZY_WORKFLOW_GUI` overrides the binary opened by
`lz gui`, which detaches the process and returns the terminal immediately.
Neither it nor `update` opens a session, reporter panel or run log.

The desktop tray icon (macOS menu bar) remains visible while lz is active;
its tooltip and menu show how many runs are in progress. **Abrir lz** restores
the window, **Ocultar ventana** hides it, and **Salir de lz** quits the app.
Closing the window keeps runs alive in the background. Explicit Quit interrupts
remaining runs; the menu labels this when runs are active. The macOS Dock also
restores the window. Linux requires a desktop with an AppIndicator/system tray host.

Builds use persistent `CARGO_TARGET_DIR=~/.cache/agent-workflow-build/gui`.
The `.lz-gui-tree` stamp beside the installed app or binary records the GUI's
Git tree hash; an unchanged hash with an existing executable skips compilation.
Uninstalling either global launcher mode removes the GUI, stamp, desktop entry
and build directory, while preserving the shared source cache.

For development, run `bun install && bun run dev` inside
`agent/lazy-workflow/gui/`. The GUI reads the installed `lz catalog` at startup,
so an updated CLI's flags and defaults apply without rebuilding an unchanged
frontend.

## Web access

`lz gui` opens the native desktop app. Browser access uses the separately built
`lz-web` executable and frontend, a dedicated Cloudflare tunnel, HTTPS and the
owner's service manager. The global CLI/desktop installer updates an existing
managed web installation; first provisioning stays separate. `lz-web --help` lists its local administration
commands; it does not open a profile or change data.

For the deployed owner installation, open
[agent-workflow.elvisbrevi.cl](https://agent-workflow.elvisbrevi.cl) and sign in
through Cloudflare Access with GitHub. Each additional owner runs their own
server/OS identity, hostname, tunnel, profile and credentials. Setup/recovery:
[web guide](../../agent/lazy-workflow/gui/WEB.md),
[GitHub Access guide](../../agent/lazy-workflow/gui/ACCESS.md),
[Mac runbook](../../agent/lazy-workflow/gui/DEPLOYMENT-elvisbrevi.cl.md).
[Verification evidence](../../agent/lazy-workflow/gui/WEB-VERIFICATION.md)
distinguishes live HTTPS checks from mobile viewport emulation and pending
physical-phone acceptance.

Set `LAZY_WORKFLOW_GUI_SETTINGS` to the existing web profile's path before
using `scripts/gui-settings.ts`. Launcher, repository registration, environment
and credentials are configured on the server; the browser can change permitted
preferences and execute only the configured catalog subset. Local credential
commands, arbitrary installer maintenance and shutdown are excluded. A dedicated
owner-only update operation takes no parameters and always updates global main.
The web adapter
bridges `plan --interview http` back to the authenticated page.
**Ajustes → Estado del equipo** shows, read-only, which tools the server's runs
find and whether the Azure organization is configured; secret values never
reach the browser. A missing piece raises a notice: with `setup` in
`allowedCommands`, **Reparar con agente** runs `lz setup` on the server;
otherwise configure it locally with the credentials skill and CLI. The web
profile needs `work-assigned`, `agent-models`, `hu-info`, `hu-children-info`
and `github-issue-list` in `allowedCommands`, and **Planificar** needs
`work-plannable`, `azure-project-list`, `azure-repo-list`, `github-owner-list`,
`repo-clone` and `repo-create`.

New installations seed `allowedCommands` with every safe command in the CLI
catalog. Existing installations keep their explicit list; to adopt full parity,
set it locally to all catalog names except `credentials-*`, `gui`, `update` and
`catalog`, then restart the backend while idle. Names must contain only lowercase
letters and hyphens. The current catalog has 73 commands, of which 63 are safe
for this list. This enables the API without adding views or command buttons.
The web policy still rejects secret/forwarded flags and `--off`, `--off-delay`,
`--log-file`, `--no-log-file`, `--interview-host`, `--interview-port` and
`--verbose-output`; `update` remains a separate owner operation.

The SAG toggle in Plan and Code passes `--normas-sag` unchanged. When enabled,
it shows the presence and source of `LAZY_WORKFLOW_SAG_NORMS_REPOSITORY` from
the existing machine diagnosis, without displaying its value, and reminds the
operator that each repository needs `.sag/config.json`. Configure the source
in the server account's credential store ([SAG norms](CONFIGURATION.md#sag-norms));
keep `inheritShellEnvironment: false`. A shell export alone does not configure
systemd runs. Backend configuration and stored variables take effect on restart;
code changes reach the running app only after updating its managed installation.

Keep desktop and web on separate profiles or stop one before opening the other.
**Ajustes → Actualización** shows the installed commit, confirms the update and
follows progress. Desktop uses the catalog's `update` and requests a full quit
and reopen; web schedules it outside the backend and reconnects/reloads after
restart. `lz update` also rebuilds changed web trees and verifies a backed-up,
idle restart, preserving data and Access binding. The web must use installed
`lz` on PATH or the cache's `main.ts`; an external checkout is reported and
preserved. First deployment and migration are
[manual once](../../agent/lazy-workflow/gui/DEPLOYMENT-elvisbrevi.cl.md#first-self-update-deployment-manual-once).
Do not repeat `init` or migrate an already bound Access installation.

## How it maps to the CLI

**Trabajo** reads `work-assigned` for every saved repository (`@me` on GitHub,
`@Me` in Azure) without changing delivery eligibility. Azure tasks are grouped
under their verified HU; a repository with nothing assigned keeps its section,
and any other HU of the project opens by number. Background reads never create
run-log entries; a read that fails becomes a configuration notice.

| In the GUI | In the CLI |
|---|---|
| An HU's tasks, their state and progress | `hu-children-info --hu <id>` (Task and Bug children) |
| **Planificar** view | `work-plannable --tracker azure\|github`: your HUs in `En Desarrollo` and Bugs in `En progreso`, or the open epics of your repositories and organizations |
| **Dónde trabajar** → Proyecto existente | `--working-directory a,b`, in delivery order; the first one receives an epic's issues |
| **Dónde trabajar** → Descargar repo / Crear repo nuevo | `repo-clone` / `repo-create --tracker … --repository … [--project …] --destination <new folder>`, then the folder is registered and chosen; the lists come from `azure-project-list`, `azure-repo-list` and `github-owner-list` |
| An epic planned in another repository | `plan --issue <n> --issue-repository owner/name` |
| **Ajustes** → "Plan/Code usa otro agente" | the `--cli`, `--model` and `--variant` saved in `commandDefaults.plan` or `.code`, which win over `flagDefaults` |
| **Planificar** / **Implementar** on an HU or lone Bug | `plan --hu <id>` / `code --hu <id> [--ticket <id>]` |
| **Planificar esta épica** | `plan --issue <n>`: the coordinator reads the epic and publishes its issues as sub-issues |
| **Planificar desde esta issue** (not an epic) | `plan` with a `--prompt` naming the issue; the session reads it with `gh issue view` |
| **Nuevo plan** / **Implementar la cola** | `plan --prompt <text>` / `code` on the repository |
| **Cola de Code** | `github-issue-list`: what `code` would take, in order, and why it skips the rest |
| Agent, model and effort menus | `--cli`, `--model`, `--variant`; the lists come from `agent-models`, the defaults from `lz catalog` |
| **Más opciones** | extra repositories (`--working-directory a,b`, in delivery order), `--base-branch`, `--number-of-questions`, `--normas-sag`, `--fallback`, `--idle-timeout`, `--verbose` |
| An option left at its default | not sent, so the CLI applies its own default |
| **Reparar con agente** | `setup --prompt <detected problems>` with an installed agent |
| Confirmation before a run | `confirmWrites`: Plan, Code and setup open sessions |
| A run in **Ejecuciones** | its operator lines (stderr) as a progress feed with their time, and its stdout as the result: the session's summary as formatted text with its cost, a plan's published tickets with their id, type, estimate and description, a setup report as text, and every JSON document as printed under **Resultado técnico** |
| **Interrumpir** | Ctrl-C: SIGINT to the run's process group, so the run is recorded as interrupted and a pending `--off` is cancelled; a second click kills it. Windows has no SIGINT for a windowless process, so there it ends the run's process tree at once |
| **Ejecuciones** | runs in progress, and the CLI's run log (`LAZY_WORKFLOW_LOG_FILE` or `~/.local/state/lazy-workflow/runs.jsonl`) for Plan, Code and setup, terminal runs included |

The deterministic tools a workflow calls internally are not buttons in the
window; run them from a terminal ([TOOLS.md](TOOLS.md)). To know which flags the
installed version offers, read `lz catalog`:

```bash
lz catalog | jq '.commands[] | select(.name == "code") | .flags[].flag'
lz catalog | jq -r '.commands[] | "\(.family)\t\(.effect)\t\(.name)"'
```

## Settings file

`~/.config/lazy-workflow/gui.json` on every platform, or the path in
`LAZY_WORKFLOW_GUI_SETTINGS`. The window's **Ajustes** page edits only the
preferences (`flagDefaults` for the agent, model and effort, `confirmWrites`,
`theme`, and `repositories` on desktop); every key can be edited with
[`scripts/gui-settings.ts`](scripts/gui-settings.ts). A missing key takes
its default, unknown keys are kept on save, and a malformed file is reported in
the window rather than replaced.

| Key | Default | Meaning |
|---|---|---|
| `lzCommand` | `"lz"` | `lz` on the PATH, an absolute launcher, or a checkout's `.../agent/lazy-workflow/main.ts` (run with Bun) |
| `inheritShellEnvironment` | `true` | Read the login shell's environment, so the PATH and exported `LAZY_WORKFLOW_*` variables match a terminal |
| `extraPath` | `[]` | Directories searched before the inherited PATH (`~` expands) |
| `environment` | `{}` | Variables every run receives — never a secret |
| `secretEnvironment` | `[]` | Names resolved with `lz credentials-get --name <NAME> --force` when a run starts |
| `repositories` | `[]` | Offered by every repository field |
| `activeRepository` | `null` | Prefills `--working-directory` and is the run's working directory |
| `flagDefaults` | `{}` | Initial value of a flag in every command that has it: `{ "--cli": "claudecode" }` |
| `commandDefaults` | `{}` | Initial values for one command, over `flagDefaults`: `{ "plan": { "--interview": "http" } }` |
| `confirmWrites` | `true` | Ask before `write`, `session` and `maintenance` commands |
| `theme` | `"system"` | `system`, `light` or `dark` |

A run's environment is layered: the GUI process, then the login shell (when
inherited), then the PATH with `extraPath` first, then `environment`, then each
`secretEnvironment` name not already set, and finally `NO_COLOR=1` for the
panel. Defaults only prefill a form — the operator can still change any option
before running.
The CLI then loads missing catalog-declared stored variables from its credential
store. `credentials-status` uses the same precedence for diagnostics.

## Configure it

Run the helper from this skill's directory; it validates every write against the
types the GUI reads, writes atomically, and refuses a secret in `environment`.

```bash
bun scripts/gui-settings.ts path
bun scripts/gui-settings.ts show
bun scripts/gui-settings.ts add repositories /path/to/repository
bun scripts/gui-settings.ts set environment.LAZY_WORKFLOW_AZURE_ORGANIZATION https://dev.azure.com/acme
bun scripts/gui-settings.ts set flagDefaults.--cli claudecode
bun scripts/gui-settings.ts set flagDefaults.--variant high
bun scripts/gui-settings.ts set commandDefaults.plan.--interview http
bun scripts/gui-settings.ts set commandDefaults.code.--fallback '["codex:gpt-5.6-sol:high"]'
bun scripts/gui-settings.ts unset commandDefaults.plan.--interview
bun scripts/gui-settings.ts validate
```

A value that parses as JSON is stored as JSON (`true`, `30`, `["a","b"]`);
anything else is a string. Repeatable flags (`--fallback`, `--field`) take a
list. Flag keys are the flags exactly as `lz catalog` names them, with their
dashes.

Secrets go through the CLI's credential store, never the settings file:

```bash
lz credentials-set --name AZURE_DEVOPS_EXT_PAT                  # prompts for the value
lz credentials-set --name LAZY_WORKFLOW_AZURE_ORGANIZATION --service azure
lz credentials-status
```

The window offers no `--off`; a terminal run takes its password from
`LAZY_WORKFLOW_OFF_PASSWORD`, stored the same way. The window rereads the file whenever it regains focus, so an edit made
with the helper shows up without a restart; a settings page with unsaved edits
keeps them until they are saved or discarded.

## What the GUI adds

- **Work-first.** Assigned HU and issues per repository, each HU's tasks with
  their state, and GitHub's queue before Code drains it.
- **Real model lists.** Each installed CLI's models and efforts from
  `agent-models`, grouped by provider, with the default and a free entry.
- **Ordered workspaces.** Extra repositories join a run in order; the order is
  the delivery order.
- **Interviews.** When `plan --interview http` prints its URL, the run's page
  offers it in the browser or embedded in the window, and every screen shows that
  the plan is waiting.
- **Configuration repair.** A notice lists what a run would miss and runs
  `lz setup` on request; there are no credential fields.
- **Several runs at once**, each followed in **Ejecuciones**; a finished one can
  be repeated with the same arguments.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "No se pudo iniciar lz" with "lz no esta en el PATH" | The GUI cannot find `lz`. Install it (`install.sh --all-global`), add its directory to `extraPath`, or set `lzCommand` to the launcher or to a checkout's `main.ts` |
| "`lz catalog` fallo" naming an unsupported command | The installed `lz` predates the GUI: `lz update` |
| "el catalogo de lz usa el esquema N" | The GUI is older than the CLI's catalog: `lz update` rebuilds the GUI when its source tree changed |
| A tool is "No encontrado" in **Ajustes → Estado del equipo** but works in a terminal | The desktop session has a shorter PATH: keep `inheritShellEnvironment` on and reopen the window, or add the directory to `extraPath` |
| Azure commands fail with a missing organization | Store it with `lz credentials-set --name LAZY_WORKFLOW_AZURE_ORGANIZATION --service azure` under the server's account; inspect `lz credentials-status` for a profile override |
| "no se pudo resolver el secreto NAME" | `lz credentials-get --name NAME` fails: store it with `lz credentials-set --name NAME`, or remove it from `secretEnvironment` |
| The window shows an error about `gui.json` | The file is not valid JSON or has a wrong type: `bun scripts/gui-settings.ts validate` names the key |
| **Interrumpir** does nothing | The run ignores SIGINT; click again (**Forzar**) to kill its process group, then follow [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for the checkpoint it left |

Everything about why a *run* failed is the CLI's: read the operator panel, then
[TROUBLESHOOTING.md](TROUBLESHOOTING.md), exactly as for a terminal run.
