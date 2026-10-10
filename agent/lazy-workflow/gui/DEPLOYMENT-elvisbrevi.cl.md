# Mac handoff: agent-workflow.elvisbrevi.cl

Continue on `feat/self-hosted-web` in `elvisbrevi/agent-workflow`.
The implementation in `5635764` is included in
[PR #4](https://github.com/elvisbrevi/agent-workflow/pull/4). The Mac continuation
started from `f51c051`; the snapshot below records the deployed services and
actual HTTPS checks. The numbered steps remain a setup/recovery guide.

This is one owner per independent server/OS account, with that owner's
configuration and CLI credentials. Another owner uses their own hostname,
tunnel and installation. Separate profile directories are not an OS sandbox.

## Recorded deployment status

DNS and the dedicated tunnel were configured on 2026-10-09 and read back on
the owner's Mac on 2026-10-10. The following snapshot records that Mac session;
consult the service manager and Cloudflare for current health.

| Resource | Value or remaining work |
|---|---|
| Repository / branch | `elvisbrevi/agent-workflow` / `feat/self-hosted-web` |
| Public origin | `https://agent-workflow.elvisbrevi.cl` |
| Cloudflare account | `26f1f3a05cbfe51ade90a57362c15fad` |
| Zone | `elvisbrevi.cl`, active |
| Dedicated remotely managed tunnel | `lz-web-agent-workflow.elvisbrevi.cl` |
| Tunnel UUID | `f8c82b9c-49e9-43f6-a180-6bd8037487ea` |
| DNS | Proxied CNAME to `f8c82b9c-49e9-43f6-a180-6bd8037487ea.cfargotunnel.com` |
| Ingress | Hostname to `http://127.0.0.1:8234`, then `http_status:404` |
| Host override | None; preserve the public Host |
| Access issuer | `https://small-forest-4923.cloudflareaccess.com` |
| Access application/policy | App `282b30e3-efa8-4cff-901c-d26eff1b633b`; Allow requires the owner's email and the dedicated GitHub provider; HttpOnly enabled, session duration 12h; readback verified |
| GitHub identity provider | `36e7861f-1008-4904-aa59-96baf1b83169`, dedicated `lz-web-agent-workflow.elvisbrevi.cl-login`; OAuth App `agent-workflow-login` (`3920572`) created and real sign-in verified |
| Connector | LaunchAgent running; Cloudflare `healthy`, four connections, also after connector restart |
| Backend / LaunchAgents | Frontend and optimized Rust backend installed; both LaunchAgents running; local `/health` returns `ok` |
| Owner identity binding | Real provider response verified and bound locally with backend stopped; Access logout and fresh sign-in completed |
| Public HTTPS | Mac GitHub sign-in, synthetic `git-branch-list`, protected settings, logout/reentry, actual Access expiry and persistence after restarting both services passed |
| Incognito on the Mac | Initial GitHub WebAuthn error reproduced; direct GitHub login followed by reopening the app succeeded, including synthetic read, logout and fresh Access reentry |
| Physical phone acceptance | Operator reported a login error; supplied capture shows GitHub `/sessions/two-factor/webauthn` failure before returning to Access. Phone operations/logout/reentry remain unverified |

The Mac checkout is `/Users/elvis/code/agent-workflow`; private deployment state
is `/Users/elvis/.local/share/lz-web`. Its backend and connector labels are
`com.elvisbrevi.lz-web.f1e81b7ac52c.backend` and
`com.elvisbrevi.lz-web.f1e81b7ac52c.connector`. `service.json` records their paths
and hashes. This installation is already initialized in Access mode and bound;
updates use step 9 without repeating `init`, `use-access` or owner binding.
The existing Tauri installation was preserved and a new desktop build was
opened using a separate synthetic profile. A synthetic repository remains at
`/Users/elvis/.local/share/lz-web/verification-repo`, with branch
`verification-check`, for the remaining physical-phone acceptance.

The earlier development environment lacked Mac/public-host access. Those limits
do not apply to the Mac's verified HTTPS requests. Actual checks and remaining
login/phone work are recorded in [WEB-VERIFICATION.md](WEB-VERIFICATION.md).

## 1. Obtain the branch on the Mac

Read the repository's `AGENTS.md`. Preserve existing changes and stay on
`feat/self-hosted-web`; do not reset or force checkout over local work.

For a fresh checkout, start a Bash session in Terminal. Keep the same session
for the following commands. Choose a different project directory if this one
already exists:

```bash
bash

export LZ_PROJECT_DIR="$HOME/src/agent-workflow-web"
export LZ_WEB_DATA_DIR="$HOME/.local/share/lz-web"
export LZ_WEB_BINARY="$LZ_PROJECT_DIR/agent/lazy-workflow/gui/src-tauri/target/release/lz-web"
export LZ_SERVER_REPOSITORY="$LZ_PROJECT_DIR"
export CLOUDFLARE_ACCOUNT_ID="26f1f3a05cbfe51ade90a57362c15fad"
export LZ_OWNER_EMAIL="elvisbrevi@gmail.com"

mkdir -p "$HOME/src"
git clone --branch feat/self-hosted-web https://github.com/elvisbrevi/agent-workflow.git "$LZ_PROJECT_DIR"
cd "$LZ_PROJECT_DIR"
git status --short --branch
git log -1 --oneline
```

For an existing checkout, set `LZ_PROJECT_DIR` to its absolute path before
defining the other variables, inspect its status/branch, and use
`git pull --ff-only origin feat/self-hosted-web` only when on that branch.
If local work prevents an update, resolve it without discarding changes.

The selected owner email came from the repository owner's public GitHub
profile. Change `LZ_OWNER_EMAIL` if the intended GitHub sign-in uses another
verified email. The email limits admission; the backend additionally requires
a verified provider-subject binding in step 10.

## 2. Install prerequisites and build

Install Git, Bun, Rust 1.90 or newer, Xcode Command Line Tools and a current
`cloudflared` supporting `--token-file`. With Homebrew already installed,
install only missing prerequisites:

```bash
xcode-select --install
brew install git oven-sh/bun/bun rust cloudflared
```

Wait for Command Line Tools installation to finish before building. If they
are already installed, skip `xcode-select --install`.

```bash
cd "$LZ_PROJECT_DIR/agent/lazy-workflow"
bun install --frozen-lockfile
cd gui
bun install --frozen-lockfile
bun run typecheck
bun run build:web
cd src-tauri
cargo build --locked --release --no-default-features --features web --bin lz-web
```

Stop on a failed command and resolve that failure before continuing.

## 3. Check Cloudflare administration token permissions

In [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens),
inspect the intended token; edit it only if the required API action is denied.
The Mac token successfully wrote/read back the project app, policy and IdP and
retrieved the existing connector token. Token policy introspection returned
403/code 9109, so a full scope inventory was unavailable. Restrict resources to this
account and zone:

| Resource | Dashboard permission |
|---|---|
| Account `26f1f3a05cbfe51ade90a57362c15fad` | `Access: Apps and Policies` — Edit |
| Same account | `Access: Organizations, Identity Providers, and Groups` — Edit |
| Same account | `Cloudflare Tunnel` — Edit |
| Zone `elvisbrevi.cl` | `Zone` — Read |
| Same zone | `DNS` — Edit |

The API calls these Access permissions `Write`. The combined organization/IdP
permission can also be replaced with the account's granular Identity Providers
write and organization read permissions. Zone/tunnel permissions already
worked in the development environment; keep them for retrieving the existing
connector on the Mac. Token readiness alone does not prove API authorization.

The administration token, GitHub OAuth secret and tunnel connector token are
different credentials. Store administrative secrets in a password manager;
none belongs in Git or in browser responses.

## 4. Create a dedicated GitHub OAuth App

Open [GitHub Developer Settings](https://github.com/settings/developers), select
**OAuth Apps**, and create a new application:

```text
Application name: agent-workflow-login
Homepage URL: https://small-forest-4923.cloudflareaccess.com
Authorization callback URL: https://small-forest-4923.cloudflareaccess.com/cdn-cgi/access/callback
```

Save its Client ID and generate/save a Client Secret privately. This is an
OAuth App for Access login, separate from `gh`, repository GitHub Apps and
Device Flow. Do not reuse the `personal-teams` app or modify its resources.

## 5. Enter setup credentials and provision Access

Use configured credential bindings first; audit them with public
`lz credentials-audit --name NAME` without displaying values. The Mac has private
bindings in `~/.config/secrets/cloudflare.env` and `~/.config/secrets/lz-access.env`.
If a binding is absent, enter values only in these Terminal prompts, not in
command literals, chat or source files. Bash's hidden prompts keep secrets out of shell history.
The variables are needed only for setup in this session:

```bash
set +x
read -rsp "Cloudflare administration token: " CLOUDFLARE_API_TOKEN
printf '\n'
read -rp "GitHub OAuth Client ID: " LZ_ACCESS_GITHUB_CLIENT_ID
read -rsp "GitHub OAuth Client Secret: " LZ_ACCESS_GITHUB_CLIENT_SECRET
printf '\n'
export CLOUDFLARE_API_TOKEN LZ_ACCESS_GITHUB_CLIENT_ID LZ_ACCESS_GITHUB_CLIENT_SECRET

mkdir -p -m 700 "$LZ_WEB_DATA_DIR"
cd "$LZ_PROJECT_DIR/agent/lazy-workflow/gui"
bun scripts/provision-access.ts \
  --data-dir "$LZ_WEB_DATA_DIR" --hostname agent-workflow.elvisbrevi.cl \
  --owner-email "$LZ_OWNER_EMAIL"
```

Inspect the read-only plan. It must refer to this hostname, the expected team
issuer, and the explicit owner email **and** GitHub provider policy. Then apply:

```bash
bun scripts/provision-access.ts \
  --data-dir "$LZ_WEB_DATA_DIR" --hostname agent-workflow.elvisbrevi.cl \
  --owner-email "$LZ_OWNER_EMAIL" --apply
```

The helper creates dedicated provider `lz-web-agent-workflow.elvisbrevi.cl-login`
and application `lz-web-agent-workflow.elvisbrevi.cl`, verifies policy readback,
and saves public authentication configuration in `access.json` and resource
ownership in `access-cloudflare.json`, outside Git. Do not invent audience/IdP
IDs or allow everyone to get past a failure.

In Cloudflare Zero Trust's identity-provider/login-method settings, find that
GitHub provider and complete its **Test/Authorize** flow. A successful API
creation does not by itself verify OAuth sign-in. A 403 means the token still
lacks authorization. An ownership/overlap error means inspect the existing
resources; do not delete another project's app or policy. See [ACCESS.md](ACCESS.md)
for explicit adoption of verified project resources and private `_FILE` bindings.

## 6. Initialize or migrate the installation

For a **new** installation, run:

```bash
"$LZ_WEB_BINARY" init \
  --data-dir "$LZ_WEB_DATA_DIR" \
  --public-url https://agent-workflow.elvisbrevi.cl \
  --settings "$LZ_WEB_DATA_DIR/gui.json" \
  --frontend "$LZ_PROJECT_DIR/agent/lazy-workflow/gui/dist" \
  --access-config "$LZ_WEB_DATA_DIR/access.json"
```

This takes no application password. For an **existing password-mode** installation,
stop its backend first and run this command **instead of `init`**:

```bash
"$LZ_WEB_BINARY" use-access --data-dir "$LZ_WEB_DATA_DIR" \
  --access-config "$LZ_WEB_DATA_DIR/access.json"
```

Migration preserves settings, repositories, credentials and run data while
revoking sessions. Configuration from a different public origin is rejected.
Do not initialize over existing data or use password mode to bypass Access.
An existing bound Access installation needs only an artifact/service update;
repeating `use-access` clears its binding and requires local owner binding again.

## 7. Configure the local CLI and repository

The initial repository is this checkout. Set `LZ_SERVER_REPOSITORY` to another
existing absolute Mac path if the installation should operate on that project.

```bash
cd "$LZ_PROJECT_DIR/utility/lz"
export LAZY_WORKFLOW_GUI_SETTINGS="$LZ_WEB_DATA_DIR/gui.json"
bun scripts/gui-settings.ts set lzCommand "$LZ_PROJECT_DIR/agent/lazy-workflow/main.ts"
bun scripts/gui-settings.ts add repositories "$LZ_SERVER_REPOSITORY"
bun scripts/gui-settings.ts set activeRepository "$LZ_SERVER_REPOSITORY"
bun scripts/gui-settings.ts set commandDefaults.plan.--interview http
```

Configure the coding-agent tools and their credentials for this Mac's owner
using the existing CLI procedure. GitHub Access login does not authenticate
`gh` or a coding agent. Do not run desktop and web simultaneously against the
same settings profile; the process lease intentionally prevents that.

## 8. Recover the existing tunnel connector on the Mac

No private archive from the development environment is required. The helper
uses the administration token to retrieve this dedicated tunnel's connector
credential and records ownership locally:

```bash
cd "$LZ_PROJECT_DIR/agent/lazy-workflow/gui"
bun scripts/provision-tunnel.ts --data-dir "$LZ_WEB_DATA_DIR" \
  --reuse-tunnel-id f8c82b9c-49e9-43f6-a180-6bd8037487ea
```

The plan must report `reuse compatible tunnel` and `reuse project CNAME`, with
`http://127.0.0.1:8234`, catch-all 404 and no Host override. Once verified, apply:

```bash
bun scripts/provision-tunnel.ts --data-dir "$LZ_WEB_DATA_DIR" \
  --reuse-tunnel-id f8c82b9c-49e9-43f6-a180-6bd8037487ea --apply
unset CLOUDFLARE_API_TOKEN LZ_ACCESS_GITHUB_CLIENT_ID LZ_ACCESS_GITHUB_CLIENT_SECRET
```

`connector.token` and `cloudflare.json` are saved privately in `LZ_WEB_DATA_DIR`.
Do not print the token or create another tunnel/DNS record to replace this one.
The services need only the connector token and public Access configuration.

An earlier private archive exists outside the development checkout at
`/workspace/.private/agent-workflow-cloudflare-macos.tar.gz`. It contains connector
credentials/ownership and status records, not the administration/OAuth secrets.
It is optional: retrieve credentials above rather than depending on workspace
files that are not pushed to GitHub. If transferring it privately instead, keep
the token and ownership metadata together outside Git and preserve existing files.

## 9. Install and start the two LaunchAgents

Run as the logged-in Mac owner, without `sudo`:

```bash
cd "$LZ_PROJECT_DIR/agent/lazy-workflow/gui"
bun scripts/install-web-services.ts \
  --data-dir "$LZ_WEB_DATA_DIR" \
  --backend "$LZ_WEB_BINARY" \
  --frontend "$PWD/dist" \
  --cloudflared "$(command -v cloudflared)" \
  --install --start
curl --fail http://127.0.0.1:8234/health
```

The installer copies the backend/assets outside the checkout, records exact
LaunchAgent labels and plist paths in `service.json`, and preserves unrelated
or manually modified services. Cloudflare should now report the tunnel Healthy.
Logs are in `$LZ_WEB_DATA_DIR/logs/`. The Mac must remain awake with the owner's
session available; LaunchAgents start at login and restart after failures.

On this Mac, immediate reinstallation once encountered launchctl bootstrap
error 5 because bootout had not finished. Unload only the two labels recorded
in this installation's manifest, wait until `launchctl print gui/$(id -u)/LABEL`
reports each absent, and rerun the installer. Do not use sudo or unload unrelated
services. The successful repeat restarted both services and preserved data.

**Start services before the first real identity binding.** This makes the
public hostname reachable for GitHub login. The backend still denies every
unbound identity, so it is expected to return 403 at this stage.

## 10. Sign in, bind the owner locally and sign in again

1. Visit `https://agent-workflow.elvisbrevi.cl` and complete GitHub sign-in.
   An initial backend 403 is expected until the owner is bound.
2. In that same signed-in browser, open
   `https://agent-workflow.elvisbrevi.cl/cdn-cgi/access/get-identity`.
3. Save the unmodified JSON response as
   `$HOME/.local/share/lz-web/owner-identity.json` on the Mac (use the actual
   `LZ_WEB_DATA_DIR` if changed). Save JSON, not an HTML/webarchive page.
4. Verify the intended GitHub account and configured account/provider. Required
   fields are `id`, `user_uuid`, `account_id`, `idp.id` and `idp.type: github`.
   If missing, investigate the provider rather than inventing a binding.
5. Stop only the backend, bind from the private file and reload its LaunchAgent:

```bash
chmod 600 "$LZ_WEB_DATA_DIR/owner-identity.json"
LZ_BACKEND_PLIST="$(bun -e '
  const state = await Bun.file(process.env.LZ_WEB_DATA_DIR + "/service.json").json();
  console.log(state.units.find(u => u.label.endsWith(".backend")).path);
')"
launchctl bootout "gui/$(id -u)" "$LZ_BACKEND_PLIST"
"$LZ_WEB_BINARY" bind-access --data-dir "$LZ_WEB_DATA_DIR" \
  < "$LZ_WEB_DATA_DIR/owner-identity.json"
launchctl bootstrap "gui/$(id -u)" "$LZ_BACKEND_PLIST"
```

Stop if backend unloading fails; do not administer a running profile. Keep the
connector running during this operation. Binding uses the provider subject,
not GitHub login/email or the email-associated Access JWT subject. Do not paste
cookies, JWTs or identity files into chat or commit them.

Visit `https://agent-workflow.elvisbrevi.cl/cdn-cgi/access/logout`, then return
to the app and sign in again. Binding revokes old sessions and requires an
Access assertion issued after that operation. The interface should now open
without an application password form. The Mac needs outbound HTTPS to
`small-forest-4923.cloudflareaccess.com` for normal TLS-verified keys and identity.

## 11. Complete acceptance and record evidence

- Verify the local health endpoint and Cloudflare's active connector status.
- Open the real HTTPS hostname from the Mac and a physical phone using mobile
  data. Check certificate, GitHub sign-in and usable interface without a password
  form. Browser viewport emulation is not physical-phone verification.
- Use a synthetic repository/provider input to test an allowed operation and
  an authenticated planning interview if used. Verify another unbound identity
  is denied. Cookie-only/forged/expired assertions must remain unauthorized.
- Verify logout/relogin and that an expired Access session requires a new login.
- Repeat step 9 to restart both managed services and verify settings/run data
  persist. Test after logging out/in to macOS or restarting the Mac, allowing
  the user LaunchAgents to start after login.
- Verify Tauri separately with its own profile and synthetic inputs. Keep one
  process per profile; do not remove the lease to run both against the same data.

Diagnose failures with local logs and service labels, not by weakening the
Access policy or exposing the private local administration token:

```bash
tail -n 40 "$LZ_WEB_DATA_DIR/logs/backend.err.log"
tail -n 40 "$LZ_WEB_DATA_DIR/logs/connector.err.log"
```

Update [WEB-VERIFICATION.md](WEB-VERIFICATION.md) with the actual date/results
after acceptance. Keep code prepared, DNS configured, Access configured,
connector active and public HTTPS verified as distinct states. Recovery and
revocation are in [ACCESS.md](ACCESS.md); updates, leases and shutdown are in
[WEB.md](WEB.md).

## Resume prompt for a Mac session

```text
Continue agent-workflow on feat/self-hosted-web on this Mac. Read AGENTS.md,
agent/lazy-workflow/gui/DEPLOYMENT-elvisbrevi.cl.md, ACCESS.md and WEB.md.
Preserve existing changes and stay on this branch. The web/desktop shared core
and verified Cloudflare Access/GitHub mode are implemented. DNS and dedicated
tunnel f8c82b9c-49e9-43f6-a180-6bd8037487ea already exist for
https://agent-workflow.elvisbrevi.cl. Follow the numbered Mac handoff to finish
Access permissions/OAuth/provider/app, local profile initialization or migration,
connector retrieval, LaunchAgents, real owner binding and HTTPS/phone acceptance.
The 2026-10-10 Mac snapshot is already configured and active; inspect it before
repeating initialization or binding. Complete the remaining physical-phone
GitHub 2FA/operation/logout acceptance and record any exact upstream error.
Use configured credentials without printing or committing their values. Do not
modify personal-teams or unrelated DNS/tunnels/Access resources. Keep one owner
per independent installation and one process per profile. Finish independent
work if credentials are missing and identify the exact missing binding or scope.
Record actual checks separately from prepared code and configured DNS. Commit
and push completed changes on the same branch.
```
