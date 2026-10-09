# Web implementation verification

Recorded on 2026-10-09 in a Linux development environment, using synthetic
repositories, credentials and provider responses. The intended deployment is
one owner per independent server/OS identity, as specified for this change.

## Publication states

| State | Result |
|---|---|
| Code prepared | Shared Rust core, desktop/headless adapters, responsive frontend, verified Cloudflare Access/GitHub SSO mode, persistent local revocation, local binding/migration, interview bridge, provisioning and service installer implemented |
| Build artifacts | Linux `lz-gui` development binary and optimized `lz-web` binary built successfully |
| Project DNS configured | **Yes**; `agent-workflow.elvisbrevi.cl` has a proxied CNAME to dedicated tunnel `f8c82b9c-49e9-43f6-a180-6bd8037487ea`; DNS and ingress were read back through the Cloudflare API |
| Cloudflare Access application/policy configured | **No**; dedicated application creation returned HTTP 403, code 1010. The configured token lacks `Access: Apps and Policies Write` |
| GitHub Access identity provider configured | **No**; no GitHub IdP in the account, and no dedicated `LZ_ACCESS_GITHUB_CLIENT_ID/SECRET` bindings. IdP creation also needs the account's Access IdP write permission |
| Dedicated connector active | **No**; macOS was selected as the runtime host, but no remote access to that Mac is configured; Cloudflare reports the connector inactive with zero connections |
| Application verified over public HTTPS | **No**; the automated check used loopback HTTPS and a synthetic certificate |
| Browser/phone layout over local HTTPS | **Passed** in Chromium, 1280×800 and 390×844 touch/mobile viewports; this is not a physical-phone test |

The configured Cloudflare administration credentials successfully read the
`elvisbrevi.cl` zone, created this project's tunnel and proxied DNS record, and
configured/verified its hostname ingress plus catch-all 404 without a Host
override. No unrelated resources were modified. Connector credentials and
ownership metadata were stored outside Git in private files for transfer to
the Mac; no administration credential is included in that handoff.

Access organization reads verified issuer `https://small-forest-4923.cloudflareaccess.com`.
The read-only plan used `elvisbrevi@gmail.com` from the authenticated GitHub
owner's public profile for edge admission; a verified provider-subject binding
is still required locally. No Access application, policy or identity provider
was created or changed: the protection-only app request was rejected. API
readback confirmed the project app/provider absent and tunnel inactive with
zero connections. `personal-teams-assistant` was read only as a reference from
its `feat/cloudflare-access` branch; none of its resources were modified.

Finishing publication requires supplying dedicated OAuth credentials, granting
Access write permissions, applying the helper, binding the verified owner, and
installing and starting the backend and connector
on the owner's Mac and verifying the application at its real HTTPS origin.
This session also lacks that subdomain in its HTTP destination allowlist.
See [the macOS deployment handoff](DEPLOYMENT-elvisbrevi.cl.md) and
[the Access setup/recovery guide](ACCESS.md). The configured team domain also
needs to be allowed if real issuer/JWKS/identity checks are attempted from this
restricted development environment; automated tests use synthetic loopback endpoints.
No secret values were printed or committed. A real Mac,
Windows desktop, physical phone, live provider login and the target machine's
service manager were not available for this verification.

## Completed checks

Run these from the repository root, with Bun/Rust and the desktop prerequisites
installed where applicable:

| Check | Result |
|---|---|
| `(cd agent/lazy-workflow && bun test)` | 921 passed, 2 Windows-specific tests skipped, 0 failed |
| `bun test installer` | 28 passed, 1 PowerShell-specific test skipped, 0 failed |
| `bash tests/install_test.sh` | Passed |
| `BASH_BIN=zsh bash tests/install_test.sh` | Passed |
| GUI `bun install --frozen-lockfile`, `bun run typecheck`, `bun run build:web` | Passed |
| Desktop `cargo test --locked` | 14 passed, 0 failed |
| Desktop `cargo clippy --locked --all-targets -- -D warnings` | Passed |
| Desktop `cargo build --locked --bin lz-gui` | Passed |
| Web `cargo test --locked --no-default-features --features web` | 33 library tests and 2 local CLI migration/binding tests passed, 0 failed |
| Web `cargo clippy --locked --no-default-features --features web --all-targets -- -D warnings` | Passed |
| Web `cargo build --locked --release --no-default-features --features web --bin lz-web` | Passed |
| GUI Playwright | 6 scenarios passed: 2 full scenarios against the optimized backend and 4 Access UI gateway simulations (desktop/phone); no page JavaScript errors |
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
result under the ignored `gui/test-results/` directory. The Access UI scenarios
mock only the gateway/API boundary to check automatic session exchange, absence
of password inputs/fallback, blocked unbound identities and top-level GitHub
sign-in/Access logout navigation. They do not authenticate against real GitHub
or Cloudflare.

Rust Access tests use an actual generated RSA key and signed JWTs with a mock
JWKS/identity server. They reject forged signatures, wrong issuer/audience,
expired/future/missing claims, HS256/service tokens, identity/email headers,
duplicate assertions/key IDs, incompatible key algorithms/use, wrong provider,
account or subject, redirects, stale/unknown keys and unavailable/oversized
responses. Router tests require the verified assertion plus cookie and CSRF,
cap sessions by JWT expiration, reject password login, and verify logout replay
remains blocked after reopening the installation. Local CLI tests cover fresh
Access initialization, binding/unbinding, rejection of password changes and
migration preserving settings and the retired inert hash while revoking sessions.

During a concurrent run, an existing process-lease test exposed a transient
fork-before-exec descriptor inherited by another test child. Its release check
now waits up to two seconds for those CLOEXEC descriptors to close, while still
requiring that the active CLI holds the lease and release occurs after exit.
Production lease handling was not changed.

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
owned compatible resource reuse and rejection of foreign resources. Access
tests additionally verify read-only planning, GitHub-only owner policies,
resource ownership and wildcard/path conflicts, missing-credential refusal,
protection-only Block policy and policy/provider readback failure. Service
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
