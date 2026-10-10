# Desktop and web interfaces

`agent/lazy-workflow/gui/` is a Tauri app that renders the installed `lz` as
forms. It holds no workflow logic of its own: it reads `lz catalog`, builds the
same argument vector an operator would type, shows it before running, and runs
`lz` as a child process. Every effect, validation, checkpoint and run-log record
is still the CLI's, so anything this skill says about a command holds in the GUI
too.

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
```

| Platform | Build prerequisites | Installation |
|---|---|---|
| macOS | Rust, Xcode Command Line Tools (`xcode-select --install`) | `~/Applications/lz.app` |
| Linux | Rust, `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`, `build-essential` | `~/.local/bin/lz-gui`, `~/.local/share/applications/lz.desktop` |
| Windows | Rust MSVC, Microsoft C++ Build Tools, WebView2 | `~/.local/bin/lz-gui.exe` |

See [the GUI README](../../agent/lazy-workflow/gui/README.md#install-and-launch)
for prerequisite commands. `LAZY_WORKFLOW_GUI` overrides the binary opened by
`lz gui`, which detaches the process and returns the terminal immediately.
Neither it nor `update` opens a session, reporter panel or run log. The GUI
excludes its own launch command from the forms.

Builds use persistent `CARGO_TARGET_DIR=~/.cache/agent-workflow-build/gui`.
The `.lz-gui-tree` stamp beside the installed app or binary records the GUI's
Git tree hash; an unchanged hash with an existing executable skips compilation.
Uninstalling either global launcher mode removes the GUI, stamp, desktop entry
and build directory, while preserving the shared source cache.

For development, run `bun install && bun run dev` inside
`agent/lazy-workflow/gui/`. The GUI reads the installed `lz catalog` at startup,
so an updated CLI changes its forms without rebuilding an unchanged frontend.

## Web access

`lz gui` opens the native desktop app. Browser access uses the separately built
`lz-web` executable and frontend, a dedicated Cloudflare tunnel, HTTPS and the
owner's service manager. The global CLI/desktop installer does not provision
or update this web installation. `lz-web --help` lists its local administration
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
commands, installer maintenance and shutdown are excluded. The web adapter
bridges `plan --interview http` back to the authenticated page.

Keep desktop and web on separate profiles or stop one before opening the other.
Updates rebuild frontend/backend and repeat the web service installer while
preserving the existing data and Access binding; do not repeat `init` or migrate
an already bound Access installation.

## How it maps to the CLI

| In the GUI | In the CLI |
|---|---|
| Sidebar families and commands | `lz catalog` → `families`, `commands` (the same list `lz --help` prints) |
| A form's fields | the command's `flags`, then its shared `groups`: `agent`, `interview`, `reporter`, `shutdown` |
| The dark line above **Ejecutar** | the exact command the run executes; copy it to run it in a terminal |
| An empty field | the flag is not sent, so the CLI applies its own default (shown as the placeholder) |
| A greyed field | a flag whose `requires` is unmet (`--ticket` without `--hu`); it is not sent |
| Effect badge and confirmation | `effect`: `read` runs at once; `write`, `session` and `maintenance` ask first unless `confirmWrites` is off |
| Run panel: Operador / Resultado | stderr / stdout, exactly as in a terminal; one JSON document is shown as a tree |
| **Interrumpir** | Ctrl-C: SIGINT to the run's process group, so the run is recorded as interrupted and a pending `--off` is cancelled; a second click kills it. Windows has no SIGINT for a windowless process, so there it ends the run's process tree at once |
| Historial | the CLI's run log (`LAZY_WORKFLOW_LOG_FILE` or `~/.local/state/lazy-workflow/runs.jsonl`), terminal runs included |

To answer "what will this button do", compose the command the form would show
and read it with [COMMANDS.md](COMMANDS.md) or [TOOLS.md](TOOLS.md). To know
which flags a form will offer for the installed version, read `lz catalog`:

```bash
lz catalog | jq '.commands[] | select(.name == "code") | .flags[].flag'
lz catalog | jq -r '.commands[] | "\(.family)\t\(.effect)\t\(.name)"'
```

## Settings file

`~/.config/lazy-workflow/gui.json` on every platform, or the path in
`LAZY_WORKFLOW_GUI_SETTINGS`. The window's **Configuracion** page edits it; so
does [`scripts/gui-settings.ts`](scripts/gui-settings.ts). A missing key takes
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
panel. Defaults only prefill a form — the operator can still change any field
before running, and the preview always shows what will run.

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
bun scripts/gui-settings.ts add secretEnvironment AZURE_DEVOPS_EXT_PAT
```

For `--off`, store `LAZY_WORKFLOW_OFF_PASSWORD` the same way: the GUI sends a
bare `--off`, so the password never reaches the command line, `ps` or the
preview. The window rereads the file whenever it regains focus, so an edit made
with the helper shows up without a restart; a settings page with unsaved edits
keeps them until they are saved or discarded.

## What the GUI adds

- **Ordered workspaces.** A multi-repository `--working-directory` is an ordered
  list; the order is the delivery order.
- **Interviews.** When `plan --interview http` prints its URL, the run panel
  offers it in the browser or embedded in the window.
- **Secrets by stdin.** `credentials-set` takes the value in a password field
  and writes it to the child's stdin with `--stdin`; it never enters the command.
  `credentials-get` output is masked until revealed.
- **Diagnostics.** **Inicio** lists the launcher `lzCommand` resolves to, each
  tool the CLI shells out to (`bun`, `git`, `gh`, `az`, `opencode`, `claude`,
  `codex`, `chezmoi`) and which catalog variables a run will see — names only for
  secrets.
- **Several runs at once**, each in its own tab; a finished one can be repeated
  with the same arguments.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "No se pudo leer el CLI" with "lz no esta en el PATH" | The GUI cannot find `lz`. Install it (`install.sh --all-global`), add its directory to `extraPath`, or set `lzCommand` to the launcher or to a checkout's `main.ts` |
| "`lz catalog` fallo" naming an unsupported command | The installed `lz` predates the GUI: `lz update` |
| "el catalogo de lz usa el esquema N" | The GUI is older than the CLI's catalog: `lz update` rebuilds the GUI when its source tree changed |
| A tool is "no encontrado" in Diagnostico but works in a terminal | The desktop session has a shorter PATH: keep `inheritShellEnvironment` on and press **Releer entorno**, or add the directory to `extraPath` |
| Azure commands fail with a missing organization | Set `environment.LAZY_WORKFLOW_AZURE_ORGANIZATION`, or export it in the shell profile the GUI inherits |
| "no se pudo resolver el secreto NAME" | `lz credentials-get --name NAME` fails: store it with `lz credentials-set --name NAME`, or remove it from `secretEnvironment` |
| The window shows an error about `gui.json` | The file is not valid JSON or has a wrong type: `bun scripts/gui-settings.ts validate` names the key |
| **Interrumpir** does nothing | The run ignores SIGINT; click again (**Forzar**) to kill its process group, then follow [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for the checkpoint it left |

Everything about why a *run* failed is the CLI's: read the operator panel, then
[TROUBLESHOOTING.md](TROUBLESHOOTING.md), exactly as for a terminal run.
