---
status: proposed
---

# Share the GUI with an owner-hosted web server

An owner can run the existing GUI in a browser or on a phone, with Rust and the
CLI remaining on their own machine. Each owner supplies a separate installation,
OS identity and provider credentials. A shared multi-tenant process is outside
this change.

ADR-0042 still applies: workflow logic stays in the Bun CLI, and forms come from
the installed CLI's catalog. Extract the machine adapter from Tauri into a
shared Rust core. The default desktop feature retains the same IPC commands,
plugins, settings schema and event contracts; a separate `web` feature builds
`lz-web` with Axum and no desktop system libraries. The React frontend selects
Tauri invoke/events or authenticated HTTP and polling at runtime.

The web adapter authorizes an explicit subset of the installed catalog rather
than forwarding arbitrary invocation or local IPC. Launcher, repositories,
environment and provider credentials are configured locally. Web requests
cannot select a profile, inject an environment, choose a log/output path or
proxy an arbitrary endpoint. Canonical registered paths constrain HTTP
arguments; they do not sandbox a workflow's OS permissions.

The backend serves assets and API from one origin, listens on literal loopback,
and requires an explicit public HTTPS origin. Argon2id owner credentials,
expiring and revocable sessions, secure HttpOnly cookies, CSRF/Origin/Host checks
and request limits precede operations. HTTP planning interviews keep their
existing private server; a per-run bearer registers a validated loopback URL
and authenticated web handlers expose only round/answer operations. Private
bearers and Cloudflare credentials are never sent to the page.

A profile lease prevents duplicate desktop/web instances; a second lease
prevents two servers opening the same installation with different settings.
Start intents and acknowledgements persist with request IDs, so retries and
restarts do not duplicate a job. Shutdown interrupts active process groups, and
a restarted server records interrupted runs rather than resuming them.
On Unix an active CLI also inherits the profile lease, preventing a new
instance while an orphaned run remains alive after a parent crash.

Each installation provisions a dedicated remotely managed Cloudflare tunnel,
proxied CNAME and hostname ingress followed by 404, retaining the public Host.
Provisioning separates the administration token from the connector token and
reuses only recorded or explicitly adopted compatible project resources. User
systemd services or macOS LaunchAgents run the backend and connector with private
state outside source checkouts. A Mac's login/sleep lifecycle remains a
deployment constraint; an always-on server is needed for independence from it.

Keeping all commands remotely invocable was rejected because local credential
management, installer maintenance, forwarded agent options and native files
carry authority that the browser transport must not imply. Rewriting workflows
in Rust was rejected because it would create a second implementation and
contradict the catalog/CLI boundary. A responsive browser interface reuses the
existing application without introducing a separate mobile-native codebase.

The deployment runbook is in
[gui/WEB.md](../../agent/lazy-workflow/gui/WEB.md); its verification record
distinguishes prepared code, configured DNS, a connected tunnel and a real
HTTPS application check.
