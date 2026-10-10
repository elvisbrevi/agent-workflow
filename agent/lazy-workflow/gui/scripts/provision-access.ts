/** Project-owned Access resources only. OAuth login credentials never reach the app or Git. */
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import { administrationApi, type CloudflareApi } from "./provision-tunnel.ts";
import { outsideCheckout } from "./web-paths.ts";

interface Provider { id: string; type: string; name: string; config?: { client_id?: string } }
interface Policy { name: string; decision: string; include: unknown[]; require?: unknown[]; exclude?: unknown[] }
interface Application { id: string; name: string; type: string; domain?: string; self_hosted_domains?: string[]; destinations?: Array<{ type: string; uri?: string; hostname?: string }>; aud?: string; allowed_idps?: string[]; auto_redirect_to_identity?: boolean; http_only_cookie_attribute?: boolean; session_duration?: string }
export interface AccessOptions { accountId: string; hostname: string; ownerEmail: string; ownedAppId?: string; ownedProviderId?: string; protectOnly?: boolean }
export interface AccessPlan { options: AccessOptions; issuer: string; provider: Provider | null; application: Application | null; appName: string; providerName: string }
export interface LoginCredentials { clientId: string; clientSecret: string }

async function listing<T>(api: CloudflareApi, path: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const items = await api.call<T[]>("GET", `${path}?page=${page}&per_page=100`);
    if (!Array.isArray(items)) throw new Error("Unexpected Access listing response");
    all.push(...items); if (items.length < 100) return all;
  }
  throw new Error("Access resource listing exceeded the page limit");
}
function overlaps(domain: string, hostname: string) {
  const host = domain.split("/")[0]!;
  const pattern = host.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${pattern}$`, "i").test(hostname);
}
function normalized(policy: Policy) { return { name: policy.name, decision: policy.decision, include: policy.include, require: policy.require ?? [], exclude: policy.exclude ?? [] }; }
function policy(options: AccessOptions, providerId?: string): Policy {
  return options.protectOnly
    ? { name: "lz-web locked pending GitHub setup", decision: "deny", include: [{ everyone: {} }], require: [], exclude: [] }
    : { name: "lz-web owner GitHub identity", decision: "allow", include: [{ email: { email: options.ownerEmail } }], require: [{ login_method: { id: providerId } }], exclude: [] };
}

export async function planAccess(api: CloudflareApi, options: AccessOptions): Promise<AccessPlan> {
  if (!/^[a-f0-9]{32}$/.test(options.accountId) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+){2,}$/.test(options.hostname) || options.hostname.includes("..")) throw new Error("A configured account and application subdomain are required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.ownerEmail) || options.ownerEmail.length > 254) throw new Error("An explicit owner email is required for edge admission");
  const base = `/accounts/${options.accountId}/access`;
  const organization = await api.call<{ auth_domain: string }>("GET", `${base}/organizations`);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(organization.auth_domain)) throw new Error("Unexpected Cloudflare Access team domain");
  const appName = `lz-web-${options.hostname}`; const providerName = `${appName}-login`;
  const providers = await listing<Provider>(api, `${base}/identity_providers`);
  const matching = providers.filter((p) => options.ownedProviderId ? p.id === options.ownedProviderId : p.name === providerName);
  if (matching.length > 1 || (matching[0] && matching[0].type !== "github")) throw new Error("The GitHub provider conflicts with existing resources");
  const provider = matching[0] ?? null;
  if (provider && !options.ownedProviderId) throw new Error("Existing provider is unrecorded; explicitly adopt its ID only if it is the project's GitHub login provider");
  if (options.ownedProviderId && !provider) throw new Error("The recorded GitHub provider no longer exists");
  const apps = await listing<Application>(api, `${base}/apps`);
  let application: Application | null = null;
  for (const app of apps) {
    const domains = [app.domain, ...(app.self_hosted_domains ?? []), ...(app.destinations ?? []).filter((d) => d.type === "public").map((d) => d.uri ?? d.hostname)].filter((d): d is string => !!d);
    if (!domains.some((d) => overlaps(d, options.hostname))) continue;
    if (app.id !== options.ownedAppId || app.name !== appName || app.type !== "self_hosted" || app.domain !== options.hostname || domains.some((d) => d !== options.hostname) || application) throw new Error("An overlapping or unowned Access application exists; it is preserved");
    const policies = await api.call<Policy[]>("GET", `${base}/apps/${app.id}/policies`);
    if (policies.some((p) => !["lz-web owner GitHub identity", "lz-web locked pending GitHub setup"].includes(p.name))) throw new Error("The project application has unmanaged policies; it is preserved");
    application = app;
  }
  if (options.ownedAppId && !application) throw new Error("The recorded project application no longer matches Cloudflare");
  return { options, issuer: `https://${organization.auth_domain}`, provider, application, appName, providerName };
}

export async function applyAccess(api: CloudflareApi, plan: AccessPlan, credentials: LoginCredentials | null, recordOwnership: (value: { appId?: string; providerId?: string }) => Promise<void>) {
  const { options } = plan; const base = `/accounts/${options.accountId}/access`;
  let provider = plan.provider;
  if (!options.protectOnly && !provider) {
    if (!credentials?.clientId || !credentials.clientSecret) throw new Error("Missing dedicated GitHub OAuth App credentials: configure LZ_ACCESS_GITHUB_CLIENT_ID[_FILE] and LZ_ACCESS_GITHUB_CLIENT_SECRET[_FILE] privately. Repository GitHub tokens and connector tokens cannot replace them.");
    try { provider = await api.call<Provider>("POST", `${base}/identity_providers`, { type: "github", name: plan.providerName, config: { client_id: credentials.clientId, client_secret: credentials.clientSecret } }); }
    catch { throw new Error("Cloudflare rejected GitHub IdP creation. Required account permission: Access: Identity Providers Write (or Access: Organizations, Identity Providers, and Groups Write). OAuth credentials were not printed."); }
    await recordOwnership({ providerId: provider.id });
    provider = await api.call<Provider>("GET", `${base}/identity_providers/${provider.id}`);
    if (provider.type !== "github" || provider.config?.client_id !== credentials.clientId) throw new Error("GitHub provider readback does not match the dedicated OAuth App");
  }
  if (provider && credentials && provider.config?.client_id !== credentials.clientId) throw new Error("Existing GitHub provider uses another OAuth App; it is preserved");
  const expectedPolicy = policy(options, provider?.id);
  const definition = { name: plan.appName, type: "self_hosted", domain: options.hostname, session_duration: "12h", app_launcher_visible: false, allowed_idps: options.protectOnly ? [] : [provider!.id], auto_redirect_to_identity: !options.protectOnly, http_only_cookie_attribute: true, policies: [expectedPolicy] };
  let created: Application;
  try { created = await api.call<Application>(plan.application ? "PUT" : "POST", `${base}/apps${plan.application ? `/${plan.application.id}` : ""}`, definition); }
  catch (error) { throw new Error(`Access application write failed. Required account permission: Access: Apps and Policies Write. ${error instanceof Error ? error.message : "Cloudflare rejected the operation"}`); }
  await recordOwnership({ appId: created.id, ...(provider ? { providerId: provider.id } : {}) });
  const actual = await api.call<Application>("GET", `${base}/apps/${created.id}`);
  const actualPolicies = await api.call<Policy[]>("GET", `${base}/apps/${created.id}/policies`);
  if (actual.type !== "self_hosted" || actual.domain !== options.hostname || JSON.stringify(actual.allowed_idps ?? []) !== JSON.stringify(definition.allowed_idps) || actual.http_only_cookie_attribute !== true || actual.auto_redirect_to_identity !== definition.auto_redirect_to_identity || actual.session_duration !== definition.session_duration || JSON.stringify(actualPolicies.map(normalized)) !== JSON.stringify([normalized(expectedPolicy)]) || !/^[a-f0-9]{64}$/.test(actual.aud ?? "")) throw new Error("Access readback did not match the intended policy; do not activate the backend");
  return options.protectOnly ? null : { publicUrl: `https://${options.hostname}`, access: { issuer: plan.issuer, audience: actual.aud!, accountId: options.accountId, githubIdpId: provider!.id, ownerSubject: null } };
}

async function secret(name: string): Promise<string | null> {
  const path = process.env[`${name}_FILE`];
  if (path) { if ((await stat(path)).mode & 0o077) throw new Error(`${name}_FILE must be private (0600)`); return (await readFile(path, "utf8")).trim() || null; }
  return process.env[name]?.trim() || null;
}
async function privateJson(path: string, value: unknown) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" }); await rename(temporary, path); await chmod(path, 0o600);
}
async function main() {
  const args = process.argv.slice(2); const flags = new Map<string, string>(); let apply = false; let protectOnly = false;
  while (args.length) {
    const flag = args.shift()!;
    if (flag === "--apply") { apply = true; continue; } if (flag === "--protect-only") { protectOnly = true; continue; }
    if (!["--data-dir", "--hostname", "--owner-email", "--reuse-idp-id", "--reuse-app-id"].includes(flag) || !args[0] || flags.has(flag)) throw new Error("usage: bun scripts/provision-access.ts --data-dir <private-absolute-directory> --hostname <application-subdomain> --owner-email <explicit-owner-email> [--reuse-idp-id <project-provider>] [--reuse-app-id <project-app>] [--protect-only] [--apply]");
    flags.set(flag, args.shift()!);
  }
  const dataDir = flags.get("--data-dir"); if (!dataDir || !isAbsolute(dataDir)) throw new Error("--data-dir must be absolute");
  await outsideCheckout(dataDir);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID; const token = await secret("CLOUDFLARE_API_TOKEN");
  if (!accountId || !token) throw new Error("Configure the Cloudflare account ID and administration token privately");
  const hostname = flags.get("--hostname") ?? ""; const ownerEmail = flags.get("--owner-email") ?? "";
  let ownership: { accountId: string; hostname: string; appId?: string; providerId?: string } = { accountId, hostname };
  try { ownership = JSON.parse(await readFile(join(dataDir, "access-cloudflare.json"), "utf8")); if (ownership.accountId !== accountId || ownership.hostname !== hostname) throw new Error("Access ownership metadata belongs to another account or hostname"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const [flag, field] of [["--reuse-app-id", "appId"], ["--reuse-idp-id", "providerId"]] as const) {
    const id = flags.get(flag); if (!id) continue;
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) || (ownership[field] && ownership[field] !== id)) throw new Error("Explicit reuse ID must match the recorded project resource");
    ownership[field] = id;
  }
  const api = administrationApi(token);
  const plan = await planAccess(api, { accountId, hostname, ownerEmail, ownedAppId: ownership.appId, ownedProviderId: ownership.providerId, protectOnly });
  console.log(JSON.stringify({ hostname, issuer: plan.issuer, oauthHomepage: plan.issuer, oauthCallback: `${plan.issuer}/cdn-cgi/access/callback`, githubProvider: plan.provider ? "reuse recorded GitHub provider" : "dedicated OAuth credentials required", edgePolicy: protectOnly ? "block everyone pending GitHub setup" : "explicit owner email AND GitHub provider", application: plan.application ? "update owned application" : "create dedicated application", mode: apply ? "apply" : "read-only plan" }, null, 2));
  if (!apply) return;
  const clientId = await secret("LZ_ACCESS_GITHUB_CLIENT_ID"); const clientSecret = await secret("LZ_ACCESS_GITHUB_CLIENT_SECRET");
  if (!!clientId !== !!clientSecret) throw new Error("Both dedicated OAuth credentials must be configured privately");
  await mkdir(dataDir, { recursive: true, mode: 0o700 }); await chmod(dataDir, 0o700);
  const result = await applyAccess(api, plan, clientId && clientSecret ? { clientId, clientSecret } : null, async (record) => { ownership = { ...ownership, ...record }; await privateJson(join(dataDir, "access-cloudflare.json"), ownership); });
  if (result) { await privateJson(join(dataDir, "access.json"), result); console.log("Access application and GitHub-only policy read back. access.json contains no secrets. Bind the owner locally, deploy on the Mac and verify HTTPS before declaring login operational."); }
  else console.log("Hostname locked at Access. GitHub login is still pending; no backend authentication configuration was produced.");
}
if (import.meta.main) main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Access provisioning failed"); process.exitCode = 1; });
