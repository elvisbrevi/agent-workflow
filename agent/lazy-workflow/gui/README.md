# lz GUI

A desktop window for `lz`, built with [Tauri](https://tauri.app), focused on the
work itself: the Azure DevOps HU and GitHub issues assigned to you, Plan or Code
on them with their options, and the progress of what ran or is running, which
**Ejecuciones** shows as a readable feed rather than a console.

The window holds no workflow logic. It reads `lz catalog` — the CLI's own JSON
description of its commands, flags, defaults and effects — to validate and build
the `plan`, `code` and `setup` command lines, and runs the same `lz` a terminal
would, with the same validation, checkpoints and run log. The deterministic
tools a workflow calls internally are not offered as buttons; they remain
commands of the CLI.

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
| **Trabajo** | One section per saved repository's tracker: Azure HU with the tasks assigned to you under them, GitHub issues (epics marked). Search and platform filter. Selecting an item opens its panel |
| **Planificar** | Only what a plan slices and is assigned to you: GitHub epics, Azure HUs and Bugs no story owns. Choosing one opens its plan form, whose first field is **Dónde trabajar**: the saved repositories of that tracker, in delivery order (an epic's own repository stays first, where its sub-issues are published). The section header still opens the repository-level plan |
| **HU panel** | The HU's — or the lone Bug's — tasks from `hu-children-info` with their state and progress, **Planificar** / **Implementar** (all pending tasks or one), per-task **Code**, and the runs that touched that HU |
| **GitHub panel** | **Planificar esta épica** (`plan --issue`: its issues become the epic's sub-issues) or, for any other issue, **Planificar desde esta issue** (the session reads it with `gh issue view`), **Nuevo plan**, **Implementar la cola**, and the queue `code` would drain (`github-issue-list`) with why each issue is skipped |
| **Plan / Code form** | One screen: the task (Code on an HU), instructions, agent, model and effort, the planning interview; under **Más opciones** extra repositories, base branch, question budget, SAG norms, fallback agents, idle timeout and verbose output, and saving them as defaults |
| **Models** | `lz agent-models` lists each installed CLI's models and efforts (OpenCode's providers, Codex's listed models, Claude Code's cached catalog); the defaults and a free entry remain |
| **Ejecuciones** | The window's runs with their latest line; a run opens as a page with its status, **Interrumpir** or **Repetir**, the planning interview, its progress feed (the CLI's operator lines with their time) and its result. Below, the CLI's run log grouped by run (Plan, Code and setup; internal reads on request), searchable, with each run's warnings and errors. Starting a run opens its page; a plan waiting for answers is announced on every screen |
| **Configuration notice** | Shown only when something is missing: an agent CLI, `gh`/`az` for the trackers in use, the Azure organization, lz's stored configuration, or a repository whose work cannot be read. **Reparar con agente** runs `lz setup` with those problems |
| **Ajustes** | Read-only machine status, default agent/model/effort, confirmation, repositories and theme. No credential or token fields |
| **Agregar repositorio** | The native folder dialog on the desktop. In the browser, the server's folders one level at a time from the root its owner allows (`~` by default): tap to enter, `..` to go up, or type a path; registered folders and Git checkouts are marked |
| **Interrupting** | **Interrumpir** sends SIGINT to the run's process group (Ctrl-C), a second click kills it |
| **Tray de escritorio** | Persistent active indicator and running count; open, hide and quit from the native menu. Closing the window keeps runs alive |
| **Móvil** | Checked as an iPhone 15 upright and on its side: compact top bar, bottom navigation clear of the home indicator (in the top bar when the phone is on its side), safe-area insets, 44 pt touch targets, 16 px fields so Safari does not zoom, and list or panel one at a time. The account control moves from the sidebar to **Ajustes** |

Assigned work uses the read-only `lz work-assigned --working-directory /repo`.
GitHub lists open issues assigned to `@me` in that repository, including issues
outside the managed queue; Azure queries `@Me` in the repository's project and
verifies each Task/Bug's User Story parent. Results are capped at 200 per query.
Background reads do not add runs to the history. GitHub's delivery eligibility
is unchanged: Code drains the eligible unassigned `ready-for-agent` queue, which
the panel shows before it runs. Any other HU of a project opens by number.

Web installations need `work-assigned`, `agent-models`, `hu-info`,
`hu-children-info` and `github-issue-list` in `allowedCommands`; `setup` is
opt-in (see [WEB.md](WEB.md)).

## Settings

`~/.config/lazy-workflow/gui.json` (or `LAZY_WORKFLOW_GUI_SETTINGS`): the `lz`
launcher, PATH additions, environment variables, secrets resolved through
`lz credentials-get`, saved repositories, per-flag and per-command defaults,
confirmation and theme. **Ajustes** edits only the preferences; the launcher,
environment and secrets are configured with the helper in the
[`lz` skill's GUI reference](../../../utility/lz/GUI.md), the
[`credentials` skill](../../../utility/credentials/SKILL.md), or by
**Reparar con agente**. Secret values never reach the window or the browser.
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
| `src/lib/work.ts`, `run-request.ts`, `models.ts`, `setup-check.ts` | Assigned work grouping, Plan/Code argument vectors, model menus, missing configuration |
| `src/lib/command-line.ts` | Flag values → argument vector against the catalog, validation, the masked command line |
| `src/lib/runs.ts` | The runs reducer, including output that arrives before its run is registered |
| `src/components/` | The views |
| `../src/cli/command-catalog.ts` | The catalog the CLI prints, pinned to the parser by `test/command-catalog.test.ts` |

## Checks

```bash
bun run typecheck                 # the frontend
(cd src-tauri && cargo test)      # settings, environment, run log, runner
(cd .. && bun test)               # the CLI suite, which includes the catalog and the GUI's pure logic
```

The browser scenarios run the built frontend against a synthetic `lz-web` on
loopback HTTPS: desktop, two phone widths, and an iPhone 15 upright and on its
side in WebKit, Safari's engine. `e2e/mobile.pw.ts` walks every screen on the
iPhone and fails on horizontal overflow, controls under 44 pt, fields Safari
would zoom into, or content under the bottom navigation.

```bash
bunx playwright install --with-deps chromium webkit   # once
(cd src-tauri && cargo build --bin lz-web --no-default-features --features web)
bun run build:web && bun run test:web
```

On macOS, quit other lz desktop instances, build the release app, and run
`bun scripts/verify-tray-macos.ts`. With Accessibility permission for the
terminal, this checks the actual tray, close/hide/restore, live run count and
interruption on Quit using an isolated profile and a synthetic CLI.
