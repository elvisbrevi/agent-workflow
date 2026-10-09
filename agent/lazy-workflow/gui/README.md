# lz GUI

A desktop window for `lz`, built with [Tauri](https://tauri.app). Every command
of the CLI is a form, the exact command line is shown before it runs, and its
output streams into a panel — operator lines (stderr) beside the result (stdout),
with a JSON result rendered as a tree.

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
The [Mac deployment handoff](DEPLOYMENT-elvisbrevi.cl.md) records pending Access
permissions/OAuth setup separately from the already configured DNS and tunnel.

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
| **Inicio** | Quick actions, and a diagnosis of the launcher, the tools a run shells out to (`bun`, `git`, `gh`, `az`, `opencode`, `claude`, `codex`, `chezmoi`) and the variables a run will see |
| **Commands** | One form per command, grouped as the CLI groups them; shared flags (agent, interview, reporter, shutdown) in collapsible sections; validation before running; confirmation before anything that writes, opens a session or reinstalls |
| **Runs** | One tab per run, live output, **Interrumpir** sends SIGINT to the run's process group (Ctrl-C), a second click kills it; the planning interview URL opens in the browser or inside the window |
| **Historial** | The CLI's run log, grouped by run, terminal runs included |
| **Configuracion** | The settings file below |

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

## Layout

| Path | Contents |
|---|---|
| `src-tauri/src/core.rs`, `desktop.rs`, `web/` | Shared machine adapter, Tauri IPC and authenticated headless HTTP adapter |
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
