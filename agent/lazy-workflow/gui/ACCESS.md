# Cloudflare Access with GitHub

For `agent-workflow.elvisbrevi.cl`, Cloudflare Access replaces the application's
password login. This follows the identity verification pattern in
[`personal-teams-assistant`, branch `feat/cloudflare-access`](https://github.com/elvisbrevi/personal-teams-assistant/tree/feat/cloudflare-access).
Tauri and the CLI keep their existing local authentication and credentials.
Other owners still run independent installations on their own machines.

Access protects the complete hostname, including assets and every `/api/*`
route. Its Allow policy requires the explicit owner's email **and** the selected
GitHub identity provider. Email only restricts admission at the edge; it never
associates an installation. Rust verifies each `Cf-Access-Jwt-Assertion` using
RS256, the pinned team issuer/audience and current HTTPS JWKS, then resolves the
provider identity at the official team `get-identity` endpoint. Account, GitHub
IdP and Access subject must match. Only the operator-bound **provider subject**
can open this installation; an email or forwarded identity header cannot do so.

The browser exchanges this verified identity for a local CSRF session
automatically, without a second login form. Sessions are bound to the exact
assertion fingerprint, issuer, IdP, provider subject and Access subject. The
cookie/session lifetime is capped by JWT expiration. Every protected request
still requires a valid, authorized assertion; a stolen local cookie alone is
insufficient. Host, Origin, CSRF, arguments, paths and rate limits still apply.
The backend's health check and private per-run interview callback retain their
existing loopback-only authorization. There are no public callback exceptions,
password fallback, GitHub token endpoint or registration route in Access mode.

## Dedicated OAuth App and account permissions

Create a GitHub **OAuth App** named `agent-workflow-login` in
[Developer Settings](https://github.com/settings/developers). This is separate
from the repository's `gh` credentials and any repository GitHub App/Device Flow.
Use the team origin reported by the read-only helper as homepage and
`<team-origin>/cdn-cgi/access/callback` as authorization callback. For the current
account these are:

```text
Homepage: https://small-forest-4923.cloudflareaccess.com
Callback: https://small-forest-4923.cloudflareaccess.com/cdn-cgi/access/callback
```

The configured Cloudflare administration token needs these **account** permissions:

- `Access: Apps and Policies Write` for the application and policy.
- `Access: Identity Providers Write`, or
  `Access: Organizations, Identity Providers, and Groups Write`, for the GitHub IdP.
- Access organization/read permissions for discovering the team configuration.

Configure `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
`LZ_ACCESS_GITHUB_CLIENT_ID` and `LZ_ACCESS_GITHUB_CLIENT_SECRET` privately. The
token and OAuth credentials also accept `_FILE` bindings to private 0600 files.
Never paste secrets into chat, put them in command arguments or commit them.
The administration token, OAuth secret and tunnel connector token are different
credentials; the backend receives none of them.

```bash
cd "$LZ_PROJECT_DIR/agent/lazy-workflow/gui"
mkdir -p -m 700 "$LZ_WEB_DATA_DIR"
bun scripts/provision-access.ts \
  --data-dir "$LZ_WEB_DATA_DIR" --hostname agent-workflow.elvisbrevi.cl \
  --owner-email elvisbrevi@gmail.com
bun scripts/provision-access.ts \
  --data-dir "$LZ_WEB_DATA_DIR" --hostname agent-workflow.elvisbrevi.cl \
  --owner-email elvisbrevi@gmail.com --apply
```

The first command is read-only. Use the intended owner's verified GitHub email;
the deployment plan above used the authenticated repository owner's public
email. Each independent owner supplies their own hostname/account/email.
The helper creates a dedicated GitHub provider and Access app, verifies policy
readback, and saves `access.json` outside Git. That file contains only public
authentication configuration; `access-cloudflare.json` records resource ownership.
Unowned apps, wildcard/path overlaps and unmanaged policies cause an error before
mutation. Explicit `--reuse-idp-id`/`--reuse-app-id` can adopt verified project
resources. No DNS, tunnels or `personal-teams` resources are modified.

If OAuth setup is pending, `--protect-only --apply` requests a dedicated
**Block everyone** application. It grants no admission and produces no
`access.json`. It still needs Access write permission. A later normal `--apply`
updates only that recorded app once the GitHub provider is available. Missing
OAuth credentials otherwise prevent all mutations. Complete the provider's
GitHub authorization/Test in Cloudflare before claiming SSO works.

## Initialize or migrate locally

Build the frontend and `lz-web` as in [WEB.md](WEB.md), then initialize:

```bash
LZ_WEB_BINARY="$LZ_PROJECT_DIR/agent/lazy-workflow/gui/src-tauri/target/release/lz-web"
"$LZ_WEB_BINARY" init --data-dir "$LZ_WEB_DATA_DIR" \
  --public-url https://agent-workflow.elvisbrevi.cl \
  --settings "$LZ_WEB_DATA_DIR/gui.json" \
  --frontend "$LZ_PROJECT_DIR/agent/lazy-workflow/gui/dist" \
  --access-config "$LZ_WEB_DATA_DIR/access.json"
```

This takes no password and creates no password hash. For an existing password
installation, stop its backend service first and use:

```bash
"$LZ_WEB_BINARY" use-access --data-dir "$LZ_WEB_DATA_DIR" \
  --access-config "$LZ_WEB_DATA_DIR/access.json"
```

Migration preserves settings, repositories, credentials, run receipts and uploads;
it retains the old owner hash inert and revokes existing sessions. Configuration
from a different public origin is rejected. Older installations missing the new
`authentication` field retain their explicit password mode for compatibility;
they are not silently migrated. `set-password` and `/api/login` are rejected in
Access mode. Never start this deployment in password mode to work around failed
Access setup.

## Bind the owner and start services

For the first deployment, initialize the Access installation, retrieve the
existing tunnel's connector credentials and start the two LaunchAgents using
[the numbered Mac handoff](DEPLOYMENT-elvisbrevi.cl.md) before signing in.
An unbound backend returns 403 while Cloudflare still allows the owner to
complete GitHub sign-in. Then stop only the backend to bind the identity and
reload it, as shown in the handoff. This avoids requiring a public login while
the connector is still offline.

After GitHub sign-in, open
`https://agent-workflow.elvisbrevi.cl/cdn-cgi/access/get-identity` in that browser
and save its JSON response in a private file on the Mac. The operator verifies
it belongs to the intended GitHub account and configured IdP/account, then binds
it locally with the service stopped:

```bash
"$LZ_WEB_BINARY" bind-access --data-dir "$LZ_WEB_DATA_DIR" \
  < /private/path/verified-owner-access-identity.json
```

Required fields are `id` (provider subject), `user_uuid`, `account_id`,
`idp.id` and `idp.type: github`. Cloudflare can return the GitHub `id` as a
positive JSON integer; both local binding and runtime verification normalize
that integer to the same decimal string. Save the original response unchanged.
Do not substitute GitHub login/email or the
email-associated Access JWT `sub`. If the actual identity response lacks these
verified fields, investigate the provider setup; do not relax validation or
invent a binding. Without a binding all protected requests fail closed. This
operator-local file never authenticates an HTTP request; runtime identity lookup
repeats verification independently.

Binding/rebinding, unbinding, migration and local revocation invalidate sessions
and require an Access assertion issued **after** their persisted cutoff. Visit
`https://agent-workflow.elvisbrevi.cl/cdn-cgi/access/logout` and sign in again
after local administration. Install/restart the two LaunchAgents using
[the Mac handoff](DEPLOYMENT-elvisbrevi.cl.md). On the target Mac, allow outbound
HTTPS to the configured team domain for keys and identity; preserve normal TLS
trust. Redirects, unknown keys, failed refreshes or identity failures never
create access. Keys refresh at most every five minutes, refresh retries are
bounded, and positive identities are cached by exact assertion for at most
30 seconds. Production endpoints cannot be overridden to a test issuer/server.

Recovery is local, with the service stopped:

```bash
"$LZ_WEB_BINARY" revoke-sessions --data-dir "$LZ_WEB_DATA_DIR"
"$LZ_WEB_BINARY" unbind-access --data-dir "$LZ_WEB_DATA_DIR"
# bind-access can associate a verified replacement owner without deleting data.
```

Browser logout first revokes the local session and persists the assertion's
fingerprint until expiration, then navigates to `/cdn-cgi/access/logout` to clear
Access's own session. Replay is blocked immediately by Rust, including after
restart. Cloudflare's global revocation can take 20–30 seconds to propagate.

Reentry uses the protected application origin, allowing Cloudflare to generate
its signed login metadata and return URL. Do not construct an issuer login URL
from the application audience. A verified Access identity may navigate back to
the root document after OAuth; cross-site API requests, writes and frames remain
rejected, and the root still requires the verified, bound identity.

If GitHub itself fails at `/sessions/two-factor/webauthn`, the sign-in has not
returned to Access or the backend. Retry GitHub sign-in in that browser with
another already configured second factor, then reopen the protected origin.
See [GitHub's 2FA guide](https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa/accessing-github-using-two-factor-authentication).
Do not send authentication codes to the operator or change the Access owner
policy to bypass an upstream login failure.

## Acceptance

Check GitHub sign-in without a password form on the Mac and a physical phone at
the real HTTPS hostname, an allowed synthetic operation, blocked unbound/wrong
identities, cookie-only/forged/expired JWT rejection, CSRF, logout/replay, local
revocation and persistence after restarting both services. Desktop remains a
separate local transport. The local automated checks and actual deployment
blockers are recorded in [WEB-VERIFICATION.md](WEB-VERIFICATION.md).
