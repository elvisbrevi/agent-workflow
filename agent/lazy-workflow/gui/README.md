# lz GUI

A desktop window for `lz`, built with [Tauri](https://tauri.app). Start with your
assigned work and recent Plan/Code activity. Prepare a run in three steps:
choose the work, adjust the usual options, then review and execute. The full CLI
catalog remains available under **Herramientas avanzadas**, and live output
streams into the run panel.

The window holds no workflow logic. It reads `lz catalog` — the CLI's own JSON
description of its commands, flags and effects — and renders that, so a new
command or flag in the CLI appears in the GUI without changing it. Runs execute
the same `lz` a terminal would, with the same validation, checkpoints and run
log.

The same interface can also run in a browser or on a phone through `lz-web`.
Each owner hosts it on their own server with their own configuration and CLI
credentials. See [self-hosted web access](WEB.md) for the authenticated backend,
Cloudflare tunnel, persistent services and verification procedure. Desktop
remains the default build; one desktop/web process may open a given settings
profile at a time.

`agent-workflow.elvisbrevi.cl` selects [Cloudflare Access with GitHub](ACCESS.md)
instead of the password form. Rust verifies the signed Access assertion and
operator-bound provider identity; Tauri retains its existing local transport.
The [Mac runbook](DEPLOYMENT-elvisbrevi.cl.md) records the active Access/OAuth,
backend and connector installation. [Verification evidence](WEB-VERIFICATION.md)
records actual HTTPS/incognito checks and the remaining physical-phone and
full-Mac-reboot acceptance. `lz-web --help` lists the local administration
commands; web provisioning/service updates are separate from `lz update`.

## Requirements

- `lz` installed (`install.sh --all-global`), or a checkout of this repository.
- [Bun](https://bun.sh) and [Rust](https://rustup.rs).
- Tauri's system libraries:
  - **macOS:** Xcode Command Line Tools.
  - **Linux:** `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev build-essential`.
  - **Windows:** Microsoft C++ Build Tools and WebView2 (preinstalled on Windows 11).

## Install and launch

The repository's Bun installer includes the GUI in `--all-global` and
`--claude-global`. After installing the prerequisites above:

```bash
lz update
lz gui
```

If the GUI cannot be built, installation warns and completes the skills and
CLI; a previous GUI is preserved. Rust is never installed automatically.
`--no-gui` skips compilation. `LAZY_WORKFLOW_GUI` points `lz gui` to an alternate
binary. The launcher returns immediately and opens no run log or reporter panel.

| Platform | Installed artifact |
|---|---|
| macOS | `~/Applications/lz.app` (`--bundles app`, locally compiled) |
| Linux | `~/.local/bin/lz-gui` (`--no-bundle`), `~/.local/share/applications/lz.desktop` |
| Windows | `~/.local/bin/lz-gui.exe` (`--no-bundle`) |

Cargo artifacts stay in `~/.cache/agent-workflow-build/gui` through cache refreshes.
A `.lz-gui-tree` file beside the app or executable records
`git rev-parse HEAD:agent/lazy-workflow/gui`: when it matches and the executable
exists, the installer skips the build. Uninstalling either global launcher mode
removes the app/binary, Linux entry, stamp and build directory, including with
`--no-gui`. It retains the shared source cache for other installation modes.
The window excludes `gui` from its command forms.

The desktop tray icon (menu bar on macOS) shows that lz is active and reports
the number of runs in progress. Its menu offers **Abrir lz**, **Ocultar ventana**
and **Salir de lz**. Closing the window keeps the app and its runs in the
background; reopen it from the tray or the macOS Dock. Explicitly quitting lz
interrupts remaining runs through the same shutdown path as before. On Linux,
the desktop environment must provide an AppIndicator/system tray host.

To install build prerequisites on macOS, run `xcode-select --install` and install
Rust through [rustup](https://rustup.rs). On Debian/Ubuntu:

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev build-essential
```

On Windows, install the MSVC toolchain with Rust and use:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Microsoft.EdgeWebView2Runtime
```

## Run and build

```bash
bun install
bun run dev        # the window, with hot reload of the frontend
bun run build      # release binary and installers in src-tauri/target/release/bundle/
bun run tauri build --bundles deb   # only one installer format
```

`bun run dev` starts the Bun dev server on `localhost:1420` and opens the window
against it; `bun run build` bundles the frontend into `dist/` with `bun build`
and embeds it. The release binary is `lz-gui`.

## What it does

| Area | Behaviour |
|---|---|
| **Inicio** | Assigned GitHub issues and Azure work items from saved repositories, with search/platform/repository filters; recent Plan/Code history and direct preparation actions |
| **Plan / Code** | Work → options → review. Azure HU and Task dropdowns, assistant/model/effort selectors and optional advanced settings. GitHub Code explicitly processes the complete eligible queue |
| **Carpetas** | Native directory search on desktop; searchable registered server repositories in the browser. Paths always belong to the machine running lz |
| **Móvil** | Compact header, fixed bottom navigation, touch controls of at least 44 px, single-column work lists and a short execution footer; safe areas and keyboard resizing keep controls reachable |
| **Herramientas avanzadas** | Full catalog, searchable by command or description; confirmation before writes and sessions |
| **Runs** | One tab per run, live output, **Interrumpir** sends SIGINT to the run's process group (Ctrl-C), a second click kills it; the planning interview URL opens in the browser or inside the window |
| **Tray de escritorio** | Persistent active indicator and running count; open, hide and quit from the native menu. Closing the window keeps runs alive |
| **Historial** | The CLI's run log, grouped by run, terminal runs included |
| **Configuracion** | The settings file below |

Assigned work uses the read-only `lz work-assigned --working-directory /repo`.
GitHub lists open issues assigned to `@me` in that repository, including issues
outside the managed queue; Azure queries `@Me` in the repository's project and
verifies each Task/Bug's User Story parent. Results are capped at 200 per query,
with a visible notice. Failed sources remain visible alongside successful ones.
Background reads do not add operator runs to the history. GitHub's delivery
eligibility is unchanged: assigned issues can be inspected, while Code drains
the eligible unassigned `ready-for-agent` queue.

Existing web installations must add `work-assigned`, `hu-info`, and
`hu-children-info` to their local `web.json` `allowedCommands` when enabling
these reads, and update both the CLI and backend/frontend. New installations
include these commands. The browser keeps the configured repository boundary;
register more server folders locally to make them available in the picker.

Secrets never reach a command line: `credentials-set` takes its value in a
password field and sends it on stdin, `credentials-get` output is masked, and
`--off` takes its password from `LAZY_WORKFLOW_OFF_PASSWORD`, which the GUI can
resolve from the credential store at run time.

## Settings

`~/.config/lazy-workflow/gui.json` (or `LAZY_WORKFLOW_GUI_SETTINGS`): the `lz`
launcher, PATH additions, environment variables, secrets resolved through
`lz credentials-get`, saved repositories, per-flag and per-command form defaults,
confirmation and theme. The full schema, and a helper that edits it safely, are in
the [`lz` skill's GUI reference](../../../utility/lz/GUI.md).

The browser shows server connections with a lock and no editable fields.
Public values are visible; tokens and passwords show configured/missing status
without reaching the browser. Configure them on the server with the
[`credentials` skill](../../../utility/credentials/SKILL.md) and `lz credentials-set`.
`lz` loads its stored catalog variables automatically; the process and GUI
profile environment take precedence.

## Layout

| Path | Contents |
|---|---|
| `src-tauri/src/core.rs`, `desktop.rs`, `web/` | Shared machine adapter, Tauri IPC and authenticated headless HTTP adapter |
| `src-tauri/src/desktop_tray.rs` | Native tray presence, run status and window controls |
| `src-tauri/src/runner.rs` | Spawning `lz`, streaming its output, SIGINT-then-kill cancellation, stdin for secrets |
| `src-tauri/src/environment.rs` | The login-shell environment, PATH composition, how `lzCommand` resolves |
| `src-tauri/src/settings.rs` | `gui.json`: defaults, atomic save, unknown keys kept |
| `src-tauri/src/run_log.rs` | Reading the CLI's run log for the history view |
| `src/lib/command-line.ts` | Form values → argument vector, validation, the masked preview |
| `src/lib/runs.ts` | The runs reducer, including output that arrives before its run is registered |
| `src/components/` | The views |
| `../src/cli/command-catalog.ts` | The catalog the CLI prints, pinned to the parser by `test/command-catalog.test.ts` |

## Checks

```bash
bun run typecheck                 # the frontend
(cd src-tauri && cargo test)      # settings, environment, run log, runner
(cd .. && bun test)               # the CLI suite, which includes the catalog and the GUI's pure logic
```

On macOS, quit other lz desktop instances, build the release app, and run
`bun scripts/verify-tray-macos.ts`. With Accessibility permission for the
terminal, this checks the actual tray, close/hide/restore, live run count and
interruption on Quit using an isolated profile and a synthetic CLI.
