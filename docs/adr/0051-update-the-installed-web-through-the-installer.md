---
status: proposed
---

# Update the installed web through the installer

`lz update` refreshed the managed cache, CLI, skills and desktop app, while the
web needed a separate frontend build, backend build and service reinstall. A
web profile pointing at a development checkout continued running that checkout's
CLI. The manual agent-picker deployment recorded in WEB-VERIFICATION.md made
this gap explicit.

The Bun installer owns the complete update (ADR-0043). Global launcher modes
also update an existing web installation, detected by both `web.json` and
`service.json` in `LZ_WEB_DATA_DIR`, default `~/.local/share/lz-web`. No web means
no additional work; `--no-web` skips this step. Dry-run describes it; uninstall
does not remove the independent web installation. Imports have no effects.

The web must run the installed CLI: `lz` on the PATH or the managed cache's
`agent/lazy-workflow/main.ts` or `run.sh`. A launcher outside that cache produces
a migration warning and skips the web step. No development checkout is pulled,
rewritten or removed. The dedicated web operation refuses this configuration.
The operator migrates locally by removing `lzCommand` or pointing it at the
cache; the bootstrap procedure uses the latter to make resolution explicit.

Frontend builds use the freshly downloaded cache, a frozen Bun install and
`build:web`. Its GUI tree stamp is independent of the backend's `src-tauri` tree
stamp. Rust builds only a changed or missing backend, with Cargo artifacts in
`~/.cache/agent-workflow-build/web`. Replacements stage complete artifacts next
to their destinations and rename them with restoration on activation failure,
following the cache/desktop convention. A CLI-only commit also restarts the
backend so its startup catalog is refreshed; identical trees and commit skip
builds and restart.

Before any cache or installed artifact replacement, the installer saves the web
binary, frontend, public deployment configuration and stamps under
`deployment-backups/before-update-<sha>-<UTC>`. The old cache is retained through
verification, then moved into that backup. Credentials, sessions, runs and owner
binding remain in their existing private files. Backups require disk space and
are pruned locally by the operator, never automatically during an update.

Choose **refusal**, rather than leaving a pending restart: an active execution,
an unreachable or incompatible health endpoint, a binary different from the
running backend, edited/foreign service metadata or another update stops the
web update before replacing anything. A filesystem gate blocks new runs and
background CLI captures; health reads synchronize with run admission. An
independent installer lock excludes duplicate installers. Preflight and the
check before deployment require no active runs. Only the two unmodified units
recorded in this installation's manifest are restarted, using the existing
service installer's naming/ownership rules. Local `/health` reports the hash
of the running executable, captured at startup, and the active run count.
Verification checks health and that hash; a failure restores the previous cache
and web artifacts, restarts those same services and verifies the old backend.
Failure to verify restoration names the backup for local recovery.

This narrows ADR-0044's local maintenance rule. `update` remains forbidden in
`allowedCommands` and ordinary `start_run`. The authenticated owner instead has
one dedicated operation accepting **only `{}`**, protected by the existing
session, Access owner binding where applicable, Host/Origin, JSON and CSRF
checks. It schedules only installed `lz update --all-global --ref main`;
browser refs, destinations, repository URLs, launchers, flags and environments
are rejected. It refuses active executions and allows only one update.

The backend has `KillMode=control-group`, so its child cannot restart it safely.
A copied worker outside the replaced cache/binary runs as a transient user
systemd service on Linux or a separate, non-restarting launchd job on macOS.
Its environment contains only HOME, build-tool PATH and the local toolchain, Codex home and
service-manager selectors; no credential or repository URL override is
forwarded. It writes a private progress log and persistent result. These are
read through authenticated RPC; no command or log path comes from the browser.
The page retains progress through downtime, keeps explicit expired-session
rejection, reconnects after restart and reloads the new assets on success.
The service manager remains the parent of the worker, as described by
[systemd-run](https://github.com/systemd/systemd/blob/main/man/systemd-run.xml).
launchd's job uses `KeepAlive=false`, avoiding automatic installer retries.

Desktop Ajustes uses the catalog's `update` entry and the normal run feed,
always asks for confirmation, excludes active runs and requests a full quit and
reopen after success. The browser uses the dedicated operation and the same
confirmation. Both display the installed commit and a readable result. Remote
ahead detection is omitted: starting an update already fetches `main`.

An interrupted worker or machine leaves its gate closed rather than guessing
whether deployment completed. The operator inspects the private result/log,
backup, worker job and health locally, stops or confirms the worker absent,
restores if necessary and only then removes stale update gates. No timeout
silently admits new work into an uncertain installation. The first deployment
is manual because the old backend lacks this operation and health contract;
the deployment runbook includes the pending PR #18 frontend and launcher
migration. No production deployment is part of this implementation.

Rejected: adding installer flags to the web allowlist, pulling an owner's
checkout, duplicating installation policy in Rust, running the updater inside
the backend's cgroup, restarting active workflows, or changing session/auth
configuration as part of deployment.
