# Web implementation verification

Recorded on 2026-10-09 in a Linux development environment, using synthetic
repositories, credentials and provider responses. The intended deployment is
one owner per independent server/OS identity, as specified for this change.

## Publication states

| State | Result |
|---|---|
| Code prepared | Shared Rust core, desktop adapter, headless authenticated API, responsive shared frontend, interview bridge, Cloudflare provisioning and service installer implemented |
| Build artifacts | Linux `lz-gui` development binary and optimized `lz-web` binary built successfully |
| Project DNS configured | **No**; no actual domain/subdomain was supplied and no Cloudflare resources were mutated |
| Dedicated connector active | **No**; no target machine was supplied and no persistent services were installed |
| Application verified over public HTTPS | **No**; the automated check used loopback HTTPS and a synthetic certificate |
| Browser/phone layout over local HTTPS | **Passed** in Chromium, 1280×800 and 390×844 touch/mobile viewports; this is not a physical-phone test |

The environment advertises configured Cloudflare administration credentials;
their permissions for a chosen zone/account have not been established. Finishing
publication requires a concrete hostname, the corresponding Zone Read/DNS Edit
and Cloudflare Tunnel Edit permissions, and execution access to the owner's
persistent machine. No secret values were printed or committed. A real Mac,
Windows desktop, physical phone, live provider login and the target machine's
service manager were not available for this verification.

## Completed checks

Run these from the repository root, with Bun/Rust and the desktop prerequisites
installed where applicable:

| Check | Result |
|---|---|
| `(cd agent/lazy-workflow && bun test)` | 916 passed, 2 Windows-specific tests skipped, 0 failed |
| `bun test installer` | 28 passed, 1 PowerShell-specific test skipped, 0 failed |
| `bash tests/install_test.sh` | Passed |
| `BASH_BIN=zsh bash tests/install_test.sh` | Passed |
| GUI `bun install --frozen-lockfile`, `bun run typecheck`, `bun run build:web` | Passed |
| Desktop `cargo test --locked` | 14 passed, 0 failed |
| Desktop `cargo clippy --locked --all-targets -- -D warnings` | Passed |
| Desktop `cargo build --locked --bin lz-gui` | Passed |
| Web `cargo test --locked --no-default-features --features web` | 23 passed, 0 failed |
| Web `cargo clippy --locked --no-default-features --features web --all-targets -- -D warnings` | Passed |
| Web `cargo build --locked --release --no-default-features --features web --bin lz-web` | Passed |
| GUI Playwright against the optimized backend | 2 full scenarios passed (desktop and phone), no page JavaScript errors |
| `git diff --check` | Passed |

The Rust commands run inside `agent/lazy-workflow/gui/src-tauri/`; GUI commands
run inside `agent/lazy-workflow/gui/`. For the browser scenarios, install
Chromium and build the frontend as in [WEB.md](WEB.md), then run:

```bash
LZ_WEB_TEST_BINARY="$PWD/src-tauri/target/release/lz-web" bun run test:web
```

The suite starts a real Axum process with fake `lz` operations, serves HTTPS
on loopback, and restarts the backend process. It checks secure cookie attributes,
login/logout/expiry, an allowed read operation, authenticated planning answers,
device text upload to a generated server path, protected server configuration,
saved preferences and session persistence after restart, and no horizontal page
overflow at both viewport sizes. Screenshots are attached to each Playwright
result under the ignored `gui/test-results/` directory.

Rust integration tests additionally check rejected Host/Origin/CSRF, login
limits, secret redaction despite malicious diagnostic arguments, blocked local
credential helpers and unknown profiles, canonical file/repository restrictions,
session separation between two installations, idempotency after restart, private
callback bearers and rejection of arbitrary interview URLs, and duplicate
profile/installation processes. A Unix process test confirms that an active
CLI retains its profile lease after the parent releases it. A separate synthetic
Bun subprocess check confirmed that Bun preserves that inherited file lease and
releases it on exit.

Cloudflare tests use a synthetic API: they verify read-only planning, proxied
CNAME creation, hostname ingress plus catch-all 404, preserved public Host,
owned compatible resource reuse and rejection of foreign resources. Service
tests verify separate backend/connector templates, per-installation names,
token-file handling, path quoting and shutdown settings for Linux/macOS. These
checks do not establish live DNS permissions or service-manager installation.

## Desktop launch

The actual Linux Tauri binary opened under Xvfb with a synthetic `gui.json` and
a fake Bun launcher serving the real command catalog. The window rendered the
existing start page, all desktop command families and native diagnostics through
Tauri IPC. The default desktop build still contains dialog/opener plugins and
its original command contracts. The runner's existing capture, secret-resolution
and SIGINT tests also passed.

This launch used a disposable Debian container with the libraries listed in
[README.md](README.md#requirements), Xvfb and a D-Bus session. WebKit's sandbox
was disabled only for that disposable container probe; that switch is neither
installed nor required by the production scripts. Desktop launch on an owner's
Mac or Windows machine remains part of that machine's deployment acceptance.

To repeat the application launch with synthetic inputs, configure
`LAZY_WORKFLOW_GUI_SETTINGS` to a temporary settings file outside the checkout,
point `lzCommand` at a fake launcher emitting `lz catalog` JSON, disable login
shell inheritance and use a temporary registered repository. Run `bun run dev`
in the GUI directory; no provider/backlog is needed to load the start page.

The reproducible deployment and real-host acceptance checklist are in
[WEB.md](WEB.md). Stop a service before changing its credentials/profile, retain
its ownership metadata, and verify each publication state independently.
