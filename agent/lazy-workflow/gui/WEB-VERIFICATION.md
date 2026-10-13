# Web implementation verification

Recorded in Linux on 2026-10-09 and continued on the owner's Mac on
2026-10-10. Automated scenarios use synthetic inputs; the Mac section explicitly
identifies real provider/public HTTPS checks. Each owner runs an independent
installation on their own server/OS identity.

## Plan from the tracker update (2026-10-13)

`main` at `76f0445` (PR #14) was deployed to the Linux installation: Planificar
reading `work-plannable` at the tracker, downloading or creating the repository
a plan is worked in, cross-repository epic sub-issues, and each command's own
agent in Ajustes. No workflow runs were active: the backend unit held only its
own `lz-web` process. The previous backend, frontend, `service.json` and
`web.json` were backed up under
`deployment-backups/before-plan-from-tracker-76f0445-2026-10-13T01-19-46Z`.

`lz update` installed the CLI and skills at `76f0445`, with the six new commands
in its catalog, and rebuilt `~/.local/bin/lz-gui`, whose tree stamp
`19734d00c1d134829a404bd6cdde6ab94a810ab3` matches the merged GUI tree. The owner
checkout the web backend runs the CLI from was fast-forwarded to the same
commit. With both units stopped, `work-plannable`, `azure-project-list`,
`azure-repo-list`, `github-owner-list`, `repo-clone` and `repo-create` were
appended to `allowedCommands`; `repositoryRoots` stays unset, so a download or
creation writes only below the server account's home. The frozen installs,
typecheck, frontend build and optimized `lz-web` build ran from the owner
checkout, and the service helper reinstalled and started both units.

Readback: both units active, the backend started with the extended allowlist
(it refuses to start when an allowed command is missing from the catalog),
local `/health` returning `ok`, the installed backend hash
`b8b4b191577e0323d9c2caa501ea63387c004bddb82c8530f144c2ae6a8c9509` equal to the
build, the three frontend files identical to `dist/`, and the connector
registered four tunnel connections again. The public origin and an anonymous
RPC both answer the Cloudflare Access redirect (302).

Read-only checks with the deployed CLI against the real trackers succeeded:
`work-plannable --tracker azure` and `--tracker github` each answered one item,
`azure-project-list` the organization's projects and `github-owner-list` the
operator's account. No repository was downloaded or created, and no Plan or Code
ran against the live backlog; cross-repository sub-issues and reconciliation
are covered by synthetic tests only. The browser scenarios, including the new
Planificar download flow on an emulated iPhone 15, ran against the synthetic
backend before the merge.

During development the owner checkout briefly carried uncommitted changes,
which the web backend would have run; the run log shows no Plan or Code in that
window, and development moved to a separate worktree before deployment.

## Plan from the work update (2026-10-12)

`main` at `4cf10c3` (PRs #11 and #12) was deployed to the Linux installation:
the **Planificar** view, `plan --issue` for GitHub epics, Bugs planned as HUs,
and the HU transition after a single-repository delivery. No workflow runs were
active: the backend unit held only its own `lz-web` process. The previous
backend, frontend, `service.json` and `web.json` were backed up under
`deployment-backups/before-plan-from-work-4cf10c3-2026-10-12T22-14-47Z`.
`web.json` was not changed: `--issue` is a flag of the already allowed `plan`.

`lz update` ran first, so the catalog the backend reads at start already
offered `plan --issue`: it installed the CLI and skills at `4cf10c3` and rebuilt
`~/.local/bin/lz-gui`, whose tree stamp
`1dce4d2b4051ff5767dc975425607e2913afd645` matches the merged GUI tree. The web
backend runs the CLI from the owner checkout (`gui.json` `lzCommand`), which was
on `main` at `4cf10c3`. The frozen installs, typecheck, frontend build and
optimized `lz-web` build ran from the owner checkout; no Rust source changed
since PR #9, so the build reproduced the deployed backend. The service helper
reinstalled and started both units.

Readback: both units active, local `/health` returning `ok`, the installed
backend hash `d9f6759d5d793f1a6edb19a29f62a2313eb358cb7697ab4a0163649dbff79932`
equal to the build, the three frontend files identical to `dist/`, and the
connector registered four tunnel connections again. The public origin and an
anonymous RPC both answer the Cloudflare Access redirect (302).

Before the merge, the browser scenarios ran against the synthetic backend,
including the new Planificar scenario on an iPhone 15 upright and sideways in
WebKit; these are emulated devices. No authenticated operation over the public
origin, physical-phone check or live Plan/Code run was performed: publishing an
epic's sub-issues and moving a Bug HU to `En revisión` have not yet run against
GitHub or Azure.

## Server folder browser update (2026-10-12)

`main` at `3786add` (PR #9) was deployed to the Linux installation. Before it,
the host's Ubuntu `gh` 2.45.0 did not know the `blockedBy` JSON field, so
`github-issue-list` failed and the Code queue showed only `url))`, the end of
the field list gh prints after an unknown field. `gh` 2.102.0 was installed
from GitHub CLI's signed apt repository, and the queue read of the owner
repository succeeded with the deployed CLI (no managed issues at the time).

No workflow runs were active: the backend unit held only its own `lz-web`
process. The previous backend, frontend, `service.json` and `web.json` were
backed up under
`deployment-backups/before-server-folders-3786add-2026-10-12T15-28-34Z`.
`web.json` was not changed: without `repositoryRoots`, the browser walks the
server account's home directory. The frozen installs, typecheck, frontend build
and optimized `lz-web` build ran from the owner checkout, and the service helper
reinstalled and started both units.

Readback: both units active, local `/health` returning `ok`, the installed
backend hash `d9f6759d5d793f1a6edb19a29f62a2313eb358cb7697ab4a0163649dbff79932`
equal to the build, the three frontend files identical to `dist/`, and the
connector registered four tunnel connections again. The public origin and an
anonymous `list_folders` request both answer the Cloudflare Access redirect
(302). `lz update` installed the CLI and skills at `3786add` and rebuilt
`~/.local/bin/lz-gui`, whose tree stamp
`9294f7b44f5d2f3efe75dfdfae69ac41e949d721` matches the merged GUI tree.

The browser scenarios ran against the synthetic backend, including an iPhone 15
upright and sideways in WebKit; these are emulated devices. No authenticated
operation over the public origin or physical-phone check was performed during
this update.

## Work-focused GUI update (2026-10-12)

`main` at `df60613` (PR #7) was deployed to the Linux installation. No workflow
runs were active: the backend unit held only its own `lz-web` process. The
previous backend, frontend, `service.json` and `web.json` were backed up under
`deployment-backups/before-gui-work-focus-df60613-2026-10-12T08-09-01Z`.

With both units stopped, `agent-models` and `setup` were appended to
`allowedCommands`, so the browser lists each agent's real models and offers
**Reparar con agente**. The frozen frontend install, typecheck, frontend build
and optimized `lz-web` build ran from the owner checkout, and the service helper
reinstalled and started both units.

Readback: both units active, local `/health` returning `ok`, the backend started
with the extended allowlist (it refuses to start when an allowed command is
missing from the catalog), the installed backend hash
`6856753181c37965590e13387f321704b545f570afcf7f97e74ca6dcb24f535c` equal to the
build, the three frontend files identical to `dist/`, and the connector
registered its tunnel connections again. The public origin and an anonymous RPC
both answer the Cloudflare Access redirect (302). `lz update` installed the CLI
and skills at `df60613` and rebuilt `~/.local/bin/lz-gui`, whose tree stamp
`46375332ce3e8b2aa9c4a7b9cf5d1eaf4909e6d8` matches the merged GUI tree.

The browser scenarios ran against the synthetic backend, including an iPhone 15
upright and sideways in WebKit; these are emulated devices. No authenticated
operation over the public origin, physical-phone check or live Plan/Code run was
performed during this update.

## Linux deployment update (2026-10-12)

The active installation at `https://agent-workflow.elvisbrevi.cl` was located
on the Linux host under `/home/administrator/.local/share/lz-web`. Its units are
`lz-web-e8032b38f114-backend.service` and
`lz-web-e8032b38f114-connector.service`; the older Mac snapshots below remain
historical records.

The frontend and optimized `lz-web` backend from `main` commit `2012c81` were
installed with the existing service helper. There were no active workflow runs.
The previous backend, frontend and deployment manifests were backed up under
`deployment-backups/before-credentials-2012c81-2026-10-12T01-57-32-679Z`.

The first service restart exposed an invalid quoted `WorkingDirectory` in the
Linux installer template. Both services were recovered with literal absolute
paths, and the helper now checks `is-active` after enabling a service instead
of treating a successful enable command as proof of a running service. Regression
checks cover systemd's actual parser and an inactive service after a successful
enable command.

Readback verified both units active, local `/health` returning `ok`, four ready
connector connections, and exact backend/frontend hashes matching the build.
The public HTTPS origin returns the Cloudflare Access redirect (302), and an
anonymous diagnostic request is rejected (401). Settings, Access configuration
and binding, connector credentials, sessions, revocations and run receipts were
unchanged. No live workflow or authenticated browser operation was performed;
the public redirect and local readback do not claim an authenticated phone test.

## Mac deployment continuation (2026-10-10)

Executed on the owner's macOS arm64 account from
`/Users/elvis/code/agent-workflow`, on `feat/self-hosted-web` after
`git pull --ff-only`. Commit `f51c051` was HEAD at entry and its ancestry was
verified. The checkout was clean before these changes. Private state is
`/Users/elvis/.local/share/lz-web`, separate from the existing desktop profile.

| State | Mac observation |
|---|---|
| Frontend / backend build | Frozen Bun installs, typecheck, frontend build and optimized `lz-web` Rust build passed; installed binary matches the final build |
| Installed artifacts | Binary/assets installed privately; both LaunchAgent plists and ownership/hashes recorded in `service.json` |
| DNS / tunnel | Existing proxied CNAME and UUID `f8c82b9c-49e9-43f6-a180-6bd8037487ea` read back; ingress remains `127.0.0.1:8234` then 404 with no Host override; neither DNS nor ingress rewritten |
| Cloudflare token | Active verification and successful project app/policy/IdP writes/readback plus connector-token retrieval; policy introspection returned 403/code 9109, so a full permission inventory is unavailable |
| Access protection | App `282b30e3-efa8-4cff-901c-d26eff1b633b` read back with owner-email admission AND dedicated GitHub provider, HttpOnly enabled and 12h session duration |
| Dedicated GitHub OAuth / provider | OAuth App `agent-workflow-login` (`3920572`) created; provider `36e7861f-1008-4904-aa59-96baf1b83169`, named `lz-web-agent-workflow.elvisbrevi.cl-login`, created/read back; real GitHub authorization and Access sign-in completed |
| Connector | Existing tunnel credential retrieved into `connector.token` (0600); dedicated LaunchAgent running; Cloudflare reports `healthy` and four connections after restart |
| Backend / owner binding | Fresh independent Access profile initialized without a password hash; original provider identity verified and bound with backend stopped; backend enabled/running and `/health` returns `ok` |
| Public HTTPS / issuer | Normal trusted TLS used. Unauthenticated browser root returns 302 to the team login; generic request returns Access 403. Issuer certs return 200 with two RSA keys. Authenticated root/UI and `/api/session` return successfully |
| Authorized operation | Real HTTPS UI ran actual `lz git-branch-list` against the synthetic `verification-repo`, displayed `verification-check` and exit code 0; run receipt persisted |
| Protected configuration | An authenticated attempt to change the server launcher returned 400; allowed theme updates returned 200. Server-controlled fields are disabled in the rendered form |
| Real logout / reentry | UI logout removed the local session, persisted assertion revocation and navigated to Access logout; revocation survived backend restart. Fresh GitHub/Access sign-in returned a working session without a password form |
| Chrome incognito follow-up | Chrome 155.0.8059.39 on this Mac reproduced the supplied GitHub WebAuthn error. The owner then completed direct GitHub login in that same incognito window; reopening the protected origin succeeded. Actual synthetic read displayed `verification-check` and code 0; UI logout removed one session and added one persisted revocation; fresh Access reentry succeeded |
| Real Access expiry | Temporarily set the same owner/provider policy's app session to 1m, minted a real 60s assertion, waited for expiry and observed API redirect plus the expired/sign-in interface. Local session was capped by assertion expiration. Restored/read back 12h and signed in again |
| Persistence after service restart | Normal installer restarted both managed services. Settings, run receipts and existing sessions preserved; browser session remained authorized, saved theme restored, backend healthy and connector healthy. Logout revocation also survived a separate backend restart |
| Physical phone / mobile data | **Not accepted**: operator reported a login error; supplied capture shows GitHub `/sessions/two-factor/webauthn` with an unexpected-browser error before returning to Access. Capture device/mobile-data status unconfirmed. No successful physical-phone operation, logout or reentry is claimed |
| Tauri | Current native binary built/opened with separate synthetic profile and fake CLI catalog; window capture verified start page/catalog/diagnostics. Installed `~/Applications/lz.app` preserved with unchanged binary hash |
| macOS logout/login or reboot | Not performed; user LaunchAgents and service restarts verified, OS-login/reboot persistence still unverified |

The dedicated services are `com.elvisbrevi.lz-web.f1e81b7ac52c.backend` and
`com.elvisbrevi.lz-web.f1e81b7ac52c.connector`. The CLI points at this checkout.
The synthetic repository has an empty synthetic commit, no remotes and branch
`verification-check`; no live backlog or real project data was used for the read.
Normal planning interviews were exercised in synthetic HTTPS fixtures only,
not at the production origin. No second process used the production profile.

No `personal-teams` or foreign Cloudflare/LaunchAgent resource was changed.
The administration token, dedicated OAuth bindings and connector token remained
in their consuming processes or private local files, outside Git and tool output.
The existing desktop profile/application was not migrated or replaced.

### Deployment fixes reproduced and verified

- Cloudflare's actual field is `http_only_cookie_attribute`, not
  `http_only_cookie`. Provisioning/readback now use the real field; regression
  tests cover both normal and protection-only modes and reject HttpOnly=false.
- Fresh initialization listed nonexistent CLI command `review`, preventing
  startup. It was removed; a local administration test checks the initialized
  allowlist against the real Bun CLI catalog.
- Cloudflare returned GitHub's provider `id` as a JSON integer. Local binding and
  runtime verification now canonicalize positive integers to decimal strings;
  malformed values remain rejected, with signed-JWT and CLI regression coverage.
- OAuth's return navigation was rejected by the global cross-site check. Only
  Access-mode GET `/` with navigate/document metadata is admitted to the existing
  identity checks; API requests, writes and frames remain blocked. Router tests
  exercise both acceptance and rejection cases.
- Reentry constructed an invalid issuer URL using the audience. It now opens
  the protected origin so Access supplies valid signed login metadata and its
  return URL; real expiry/logout/reentry and a router assertion verify the fix.

Issuer, signature, audience, account, IdP, owner binding, Origin/Host, CSRF and
revocation checks remain required. An existing profile-lease test also now
waits up to two seconds for concurrent test children's transient pre-exec
CLOEXEC descriptors; production lease handling is unchanged.

### Mac validation

| Check | Result |
|---|---|
| Focused Access/web Bun tests | 12 passed; real-field regression first failed, then passed |
| `agent/lazy-workflow` Bun suite | 922 passed, 2 Windows-specific skipped, 0 failed |
| Installer suite | 29 passed, 0 failed |
| Bootstrap Bash / zsh suites | Both passed |
| GUI frozen install / typecheck / `build:web` | Passed |
| Desktop Rust tests / Clippy with `-D warnings` / native build | 14 tests passed; Clippy and build passed |
| Web Rust tests / Clippy with `-D warnings` / optimized build | 34 library and 3 local administration tests passed; Clippy and build passed |
| Synthetic HTTPS Chromium | 6 scenarios passed across desktop/touch viewports; synthetic read, planning interview, text upload, logout, expiry and fixture-backend restart covered |
| LaunchAgent plists / restart | Both passed `plutil -lint`; both running after the normal installer restart; health/data/session comparisons passed |
| `git diff --check` | Passed |

The standard Playwright fixture initially failed because this macOS account
cannot bind privileged loopback port 443 (`EACCES`, confirmed with a socket
probe; Bun reported `EADDRINUSE`). Its orphaned synthetic backend was stopped
and its temporary profile removed. An ignored temporary harness then used TLS
on 127.0.0.1:8443 and Chromium's
`--host-resolver-rules=MAP localhost 127.0.0.1:8443`, keeping the browser origin
`https://localhost`. Fixture control requests alone used the explicit loopback
port. All six original scenarios passed without sudo or production changes.
The temporary harness/profile were removed; screenshots remain locally in
ignored `gui/test-results/macos-verification/` (`native.png`,
`synthetic-desktop.png`, `synthetic-phone.png`). These are not physical-phone
or production-provider evidence.

The remaining acceptance depends on the operator completing GitHub 2FA in the
phone's browser, then checking the synthetic read, logout and fresh sign-in over
mobile data. The supplied error occurs at GitHub's WebAuthn second factor; its
root cause is not established. Retry with another already configured method as
in [GitHub's 2FA guide](https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa/accessing-github-using-two-factor-authentication),
then reopen the protected origin. Do not alter the owner/provider policy to
bypass this failure. See [the Mac handoff](DEPLOYMENT-elvisbrevi.cl.md) for
service inspection/update and later OS-login/reboot acceptance.

The incognito comparison reached GitHub's own error page at
`/sessions/two-factor/webauthn` before returning to Access. Direct
`https://github.com/login` subsequently completed with the owner's browser
interaction and verified the expected account, after which the app, read,
logout and fresh session worked. The successful direct-login second-factor
method was not recorded; this observation does not establish or fix the cause
of GitHub's initial WebAuthn failure. It verifies incognito on the Mac, not a
physical phone or mobile data. No authentication settings or policies changed
for this comparison.

### Documentation and CLI help follow-up

The `lz` skill now routes desktop and web installation requests, identifies the
web profile and permitted HTTP subset, and links the setup/recovery guides.
READMEs no longer describe the completed Access/OAuth setup as pending.
`lz --help` identifies the separate web executable; `lz-web --help`, `-h`,
`help`, no arguments and command-level help return successfully without
reading/writing installation data. A synthetic CLI regression first failed,
then passed against an intentionally invalid profile; no locks/state files
were created. The full Bun (922 passed, 2 skipped), installer (29 passed),
Bash/zsh bootstrap, GUI typecheck, desktop Rust (14), web Rust (34 + 3), Clippy
and optimized build checks passed again for these changes.

The rebuilt binary was installed through the normal owned service installer.
Settings, Access configuration/binding, sessions, revocations and run receipts
were unchanged; local health and installed command-level help passed.

## Previous Linux publication snapshot (2026-10-09)

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
