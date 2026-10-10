# Web implementation verification

Recorded in Linux on 2026-10-09 and continued on the owner's Mac on
2026-10-10. Automated scenarios use synthetic inputs; the Mac section explicitly
identifies real provider/public HTTPS checks. Each owner runs an independent
installation on their own server/OS identity.

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
| Web Rust tests / Clippy with `-D warnings` / optimized build | 34 library and 2 local administration tests passed; Clippy and build passed |
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
