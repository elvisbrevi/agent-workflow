---
status: accepted
---

# Install with Bun and build the desktop GUI locally

One dependency-free TypeScript installer in `installer/` owns skill and agent
discovery, destinations, cache replacement, launcher dependencies and managed
entry reconciliation on every platform. The Bash/Zsh and PowerShell 5.1 entry
points retain their existing URLs, verify Git and Bun, clone the requested ref
into a disposable checkout and forward arguments unchanged. They interpret only
`--ref` and the repository URL needed to acquire that version's installer.
`lz update` invokes the Bun entry point directly with `process.execPath`.
Imports perform no installation work.

Bun is already mandatory for the CLI. A Cargo installer would add Rust as a
requirement for installing skills and the CLI; parallel shell implementations
would keep duplicating policy. Node/Bun filesystem and process APIs need no
`node_modules`, so they can run before dependency preparation. Windows retains
directory junctions and file/launcher copies, tracked by uppercase SHA256 in
`~/.cache/agent-workflow-copies.json`. Modified copies and unrelated entries
survive reconciliation and uninstall.

Refresh clones into a sibling `.refresh` directory, installs locked executable
dependencies there, then swaps it into the managed cache with rollback if
activation fails. Dirty cached files are disposable. Dry-run uses an existing
cache or a disposable preview checkout and never installs dependencies or
changes installed entries. Uninstall needs neither a refresh nor network access
and retains the shared source cache, since other modes and project installs may
still reference it.

The global modes that install launchers also install the GUI unless `--no-gui`
is given. The interactive menu offers it by default. This repository uses no
hosted CI or binary release pipeline, so the installer compiles locally with
`bun install --frozen-lockfile` and `bun run tauri build`; it does not install
Rust. Missing tools or failed builds warn with prerequisite commands, preserve
the previous GUI and let skills and CLI installation succeed.

On macOS only the `app` bundle is built and copied to `~/Applications/lz.app`:
Finder discovers it and installation needs no system privileges. The local
build needs no downloaded-app quarantine handling or signing pipeline. Linux
and Windows use `--no-bundle`, copying `lz-gui` / `lz-gui.exe` to `~/.local/bin`
beside the CLI. Linux also gets `~/.local/share/applications/lz.desktop`.
These user destinations avoid package-manager privileges and installer formats.

Cargo artifacts persist outside the replaced checkout at
`~/.cache/agent-workflow-build/gui`. A `.lz-gui-tree` stamp beside the installed
app/binary records `git rev-parse HEAD:agent/lazy-workflow/gui`; an identical
tree and an existing executable skip compilation, even when unrelated CLI or
skill files changed. Uninstall in either global launcher mode removes the GUI,
Linux desktop entry, stamp and GUI build directory, including with `--no-gui`.

`lz gui` resolves the installed executable, or `LAZY_WORKFLOW_GUI`, launches
a detached process and returns immediately. Its launcher is an injected system
boundary. Like `update` and `catalog`, it opens no session, run log or reporter
panel. It belongs to the catalog but the GUI omits it from its forms, so the
window does not offer to launch itself (ADR-0042).
