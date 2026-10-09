# agent-workflow.elvisbrevi.cl on macOS

DNS and the dedicated tunnel were configured on 2026-10-09. This installation's
selected login is now Cloudflare Access with GitHub, prepared on the same
`feat/self-hosted-web` branch:

| Resource | Value |
|---|---|
| Public origin | `https://agent-workflow.elvisbrevi.cl` |
| Zone | `elvisbrevi.cl`, active |
| Dedicated remotely managed tunnel | `lz-web-agent-workflow.elvisbrevi.cl` |
| Tunnel UUID | `f8c82b9c-49e9-43f6-a180-6bd8037487ea` |
| DNS | Proxied CNAME → `f8c82b9c-49e9-43f6-a180-6bd8037487ea.cfargotunnel.com` |
| Ingress | `agent-workflow.elvisbrevi.cl` → `http://127.0.0.1:8234`, then catch-all `http_status:404` |
| Host override | None; the public Host is preserved |
| Cloudflare Access application/policy | **Not configured**: application creation returned HTTP 403; `Access: Apps and Policies Write` is missing |
| GitHub identity provider | **Not configured**: dedicated OAuth App credentials and Access IdP write permission are required |
| Access issuer | `https://small-forest-4923.cloudflareaccess.com`, verified through the account API |
| Connector | Inactive, zero connections at provisioning verification |
| Backend and LaunchAgents | Awaiting installation on the owner's Mac |
| Public HTTPS application acceptance | Pending backend and connector activation |

The tunnel configuration and DNS record were read back through the Cloudflare
API after creation. No unrelated DNS record or tunnel was modified. The Mac is
the selected runtime host; the development session has no remote access to it.
The public hostname is also absent from this session's HTTP destination
allowlist, so an automated public HTTPS check here requires that environment
configuration to be updated. The owner can perform acceptance directly from
their phone after starting the Mac services.

## Move the connector credentials to the Mac

The private handoff archive `agent-workflow-cloudflare-macos.tar.gz` is stored
outside the source checkout in `/workspace/.private/`. It contains
`cloudflare.json`, `connector.token`, `provisioning-status.json` and
`access-status.json` (the pending Access setup record). The token is
only the dedicated tunnel's connector credential; the Cloudflare administration
token is not included. Transfer this archive privately to the owner's Mac,
keep it outside the checkout, and use this tunnel from that one installation.

For a fresh installation, save the archive under Downloads and run:

```bash
LZ_WEB_DATA_DIR="$HOME/.local/share/lz-web"
mkdir -p "$LZ_WEB_DATA_DIR"
chmod 700 "$LZ_WEB_DATA_DIR"
tar -xzkf "$HOME/Downloads/agent-workflow-cloudflare-macos.tar.gz" -C "$LZ_WEB_DATA_DIR"
chmod 600 "$LZ_WEB_DATA_DIR/connector.token" "$LZ_WEB_DATA_DIR/cloudflare.json"
```

`-k` preserves files that already exist. Keep ownership metadata with the token
so future provisioning reuses this project's tunnel. Never commit either the
archive or token. No browser-owner password has been generated. Access-mode
initialization below takes no password. Do not start this deployment in password
mode to bypass the pending Access setup.

## Build and initialize on the Mac

Install Bun, Rust 1.90 or newer, Xcode Command Line Tools, Git and `cloudflared`
(for example, `brew install cloudflared`). Use a checkout containing PR #4. The
following clone uses a new directory and does not replace an existing checkout:

```bash
LZ_PROJECT_DIR="$HOME/src/agent-workflow-web"
LZ_SERVER_REPOSITORY="$LZ_PROJECT_DIR"
LZ_PUBLIC_URL="https://agent-workflow.elvisbrevi.cl"

git clone --branch feat/self-hosted-web https://github.com/elvisbrevi/agent-workflow.git "$LZ_PROJECT_DIR"
cd "$LZ_PROJECT_DIR/agent/lazy-workflow"
bun install --frozen-lockfile
cd gui
bun install --frozen-lockfile
bun run typecheck
bun run build:web
cd src-tauri
cargo build --locked --release --no-default-features --features web --bin lz-web
```

Configure the dedicated OAuth App and private secret bindings from
[ACCESS.md](ACCESS.md). Add account permissions `Access: Apps and Policies Write`
and `Access: Identity Providers Write` to the administration token. The selected
owner email in the read-only plan is `elvisbrevi@gmail.com`, read from the
authenticated GitHub account; confirm it is the intended GitHub sign-in email.
No provider/Access app existed in the configured account when inspected.
The existing token's Access application creation attempt was rejected with 403.
Finish these steps before initializing or starting the installation:

```bash
cd "$LZ_PROJECT_DIR/agent/lazy-workflow/gui"
bun scripts/provision-access.ts \
  --data-dir "$LZ_WEB_DATA_DIR" --hostname agent-workflow.elvisbrevi.cl \
  --owner-email elvisbrevi@gmail.com
bun scripts/provision-access.ts \
  --data-dir "$LZ_WEB_DATA_DIR" --hostname agent-workflow.elvisbrevi.cl \
  --owner-email elvisbrevi@gmail.com --apply

cd src-tauri

./target/release/lz-web init \
  --data-dir "$LZ_WEB_DATA_DIR" \
  --public-url "$LZ_PUBLIC_URL" \
  --settings "$LZ_WEB_DATA_DIR/gui.json" \
  --frontend "$LZ_PROJECT_DIR/agent/lazy-workflow/gui/dist" \
  --access-config "$LZ_WEB_DATA_DIR/access.json"
```

If an installation already exists, stop its backend and use `lz-web use-access`
as documented in [ACCESS.md](ACCESS.md); do not initialize over existing data.
The helper's `access.json` uses the actual app audience/provider IDs. No example
or invented audience is suitable for production.

The initial registered repository above is this checkout. Set
`LZ_SERVER_REPOSITORY` to another existing absolute Mac path before configuring
it below if the installation should work on that project instead.

```bash
cd "$LZ_PROJECT_DIR/utility/lz"
LAZY_WORKFLOW_GUI_SETTINGS="$LZ_WEB_DATA_DIR/gui.json" \
  bun scripts/gui-settings.ts set lzCommand "$LZ_PROJECT_DIR/agent/lazy-workflow/main.ts"
LAZY_WORKFLOW_GUI_SETTINGS="$LZ_WEB_DATA_DIR/gui.json" \
  bun scripts/gui-settings.ts add repositories "$LZ_SERVER_REPOSITORY"
LAZY_WORKFLOW_GUI_SETTINGS="$LZ_WEB_DATA_DIR/gui.json" \
  bun scripts/gui-settings.ts set activeRepository "$LZ_SERVER_REPOSITORY"
LAZY_WORKFLOW_GUI_SETTINGS="$LZ_WEB_DATA_DIR/gui.json" \
  bun scripts/gui-settings.ts set commandDefaults.plan.--interview http
```

Provider tools and their credentials must be configured for this Mac's owner,
using the existing CLI procedure. They are not included in the connector archive.
The administration/OAuth credentials are needed only for setup; the services
use the connector token and public Access configuration, never those secrets.

Finish the GitHub provider's authorization/Test in Cloudflare. Sign in through
Access and obtain the browser's verified identity JSON at
`https://agent-workflow.elvisbrevi.cl/cdn-cgi/access/get-identity`. Check the
provider account and intended GitHub identity, save it privately on the Mac,
and bind the **provider subject** locally while the backend is stopped:

```bash
"$LZ_PROJECT_DIR/agent/lazy-workflow/gui/src-tauri/target/release/lz-web" \
  bind-access --data-dir "$LZ_WEB_DATA_DIR" \
  < /private/path/verified-owner-access-identity.json
```

An unbound identity cannot open the installation. Binding revokes old sessions
and requires an Access assertion issued after that operation: visit the hostname's
`/cdn-cgi/access/logout` and sign in again. The Mac also needs outbound HTTPS to
`small-forest-4923.cloudflareaccess.com` for signature keys and identity lookup.
Do not put cookies, JWTs or OAuth secrets in that handoff or source control.

## Install and start the LaunchAgents

Run as the logged-in Mac owner:

```bash
cd "$LZ_PROJECT_DIR/agent/lazy-workflow/gui"
bun scripts/install-web-services.ts \
  --data-dir "$LZ_WEB_DATA_DIR" \
  --backend "$PWD/src-tauri/target/release/lz-web" \
  --frontend "$PWD/dist" \
  --cloudflared "$(command -v cloudflared)" \
  --install --start
```

The installer writes two managed LaunchAgents, copies the backend/frontend
outside the checkout, and records labels in `service.json`. Existing unrelated
or manually modified services are preserved. Read private backend/connector
logs under `$LZ_WEB_DATA_DIR/logs/` and inspect the labels with `launchctl print
gui/$(id -u)/<label>`. Each service starts at login and restarts after failure.
The Mac must remain awake and available for the application to be reachable.

After both services start, check `curl --fail http://127.0.0.1:8234/health` on the
Mac, then open `https://agent-workflow.elvisbrevi.cl` on a phone. Verify the
certificate, GitHub sign-in without a password form, an allowed synthetic
operation, rejection of unbound identities/cookie-only requests, logout/replay,
expiry and persistence after restarting both LaunchAgents. Validate an
authenticated planning interview using synthetic provider inputs if that
channel is used. Until these checks succeed, DNS configuration is not evidence
that the application is online.

Access revocation and local identity recovery are in [ACCESS.md](ACCESS.md).
Process leases, file handling, updates and service recovery are in [WEB.md](WEB.md).
