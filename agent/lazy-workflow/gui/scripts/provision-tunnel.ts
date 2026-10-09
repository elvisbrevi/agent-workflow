/** A dedicated remotely managed tunnel. Administration credentials are never connector credentials. */
import { mkdir, readFile, writeFile, chmod, rename } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { outsideCheckout } from "./web-paths.ts";

export interface CloudflareApi { call<T>(method: string, path: string, body?: unknown): Promise<T> }
interface Zone { id: string; name: string; account: { id: string } }
interface Tunnel { id: string; name: string; config_src?: string }
interface DnsRecord { id: string; type: string; name: string; content: string; proxied: boolean }
interface Ingress { hostname?: string; service: string; path?: string; originRequest?: Record<string, unknown> }
export interface TunnelOptions { accountId: string; hostname: string; listen: string; tunnelName?: string; ownedTunnelId?: string }
export interface TunnelPlan { options: TunnelOptions; zone: Zone; tunnel: Tunnel | null; record: DnsRecord | null; ingress: Ingress[]; configure: boolean }

export function administrationApi(token: string): CloudflareApi {
  return { async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(25000) });
    const result = await response.json() as { success: boolean; result: T; errors?: Array<{ code: number; message?: string; error?: string }> };
    if (!response.ok || !result.success) throw new Error(`Cloudflare ${method} ${path.split("?")[0]} failed (${response.status}): ${(result.errors ?? []).map((error) => `${error.code}: ${error.message ?? error.error ?? "request rejected"}`).join("; ")}`);
    return result.result;
  } };
}

export async function planTunnel(api: CloudflareApi, options: TunnelOptions): Promise<TunnelPlan> {
  if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(options.hostname) || options.hostname.includes("..") || options.hostname.endsWith(".") || options.hostname.split(".").length < 3) throw new Error("hostname must be a concrete application subdomain");
  if (!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(options.listen) || Number(options.listen.split(":")[1]) > 65535) throw new Error("listen must be 127.0.0.1:<port>");
  if (!/^[a-f0-9]{32}$/.test(options.accountId)) throw new Error("a configured Cloudflare account ID is required");
  const labels = options.hostname.split(".");
  let zone: Zone | undefined;
  for (let index = 1; index < labels.length - 1; index++) {
    const zones = await api.call<Zone[]>("GET", `/zones?name=${encodeURIComponent(labels.slice(index).join("."))}&account.id=${options.accountId}&status=active`);
    zone = zones.find((candidate) => candidate.account.id === options.accountId);
    if (zone) break;
  }
  if (!zone) throw new Error("no active zone found in the configured account; Zone Read is required");
  const tunnelName = options.tunnelName ?? `lz-web-${options.hostname}`;
  const tunnels = await api.call<Tunnel[]>("GET", `/accounts/${options.accountId}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`);
  const matching = tunnels.filter((tunnel) => tunnel.name === tunnelName);
  if (matching.length > 1) throw new Error("tunnel name is ambiguous; no resource was changed");
  const tunnel = matching[0] ?? null;
  if (tunnel && options.ownedTunnelId !== tunnel.id) throw new Error("existing tunnel has no ownership record for this installation; explicitly supply its ID only if it belongs to this project");
  if (options.ownedTunnelId && options.ownedTunnelId !== tunnel?.id) throw new Error("the recorded project tunnel no longer matches Cloudflare");
  const records = await api.call<DnsRecord[]>("GET", `/zones/${zone.id}/dns_records?name=${encodeURIComponent(options.hostname)}`);
  if (records.length > 1) throw new Error("hostname has multiple DNS records; existing records are preserved");
  const record = records[0] ?? null;
  if (record && (!tunnel || record.type !== "CNAME" || record.content.replace(/\.$/, "") !== `${tunnel.id}.cfargotunnel.com`)) throw new Error("hostname already belongs to a different DNS target; existing records are preserved");
  const ingress: Ingress[] = [{ hostname: options.hostname, service: `http://${options.listen}` }, { service: "http_status:404" }];
  let configure = !tunnel;
  if (tunnel) {
    if (tunnel.config_src !== "cloudflare") throw new Error("existing tunnel is not remotely managed; it is preserved");
    const configuration = await api.call<{ config: { ingress?: Ingress[]; [key: string]: unknown } }>("GET", `/accounts/${options.accountId}/cfd_tunnel/${tunnel.id}/configurations`);
    const actual = configuration.config.ingress ?? [];
    if (actual.length === 0 && options.ownedTunnelId === tunnel.id) configure = true;
    else if (actual.length !== 2 || actual[0]?.hostname !== options.hostname || actual[0]?.service !== `http://${options.listen}` || actual[0]?.path || actual[1]?.hostname || actual[1]?.service !== "http_status:404" || actual[1]?.path
      || Object.keys(configuration.config).some((key) => key !== "ingress" && key !== "originRequest" && key !== "warp-routing")
      || Object.keys(configuration.config.originRequest as object ?? {}).length > 0
      || (configuration.config["warp-routing"] as { enabled?: boolean } | undefined)?.enabled === true
      || actual.some((entry) => Object.keys(entry.originRequest ?? {}).length > 0)) throw new Error("existing tunnel has incompatible routes or Host overrides; it is preserved");
  }
  return { options: { ...options, tunnelName }, zone, tunnel, record, ingress, configure };
}

export async function applyTunnel(api: CloudflareApi, plan: TunnelPlan, recordOwnership: (tunnelId: string) => Promise<void>): Promise<{ tunnelId: string; connectorToken: string }> {
  const { options, zone } = plan;
  const tunnel = plan.tunnel ?? await api.call<Tunnel>("POST", `/accounts/${options.accountId}/cfd_tunnel`, { name: options.tunnelName, config_src: "cloudflare", tunnel_secret: randomBytes(32).toString("base64") });
  await recordOwnership(tunnel.id);
  if (plan.configure) await api.call("PUT", `/accounts/${options.accountId}/cfd_tunnel/${tunnel.id}/configurations`, { config: { ingress: plan.ingress } });
  const target = `${tunnel.id}.cfargotunnel.com`;
  if (!plan.record) await api.call("POST", `/zones/${zone.id}/dns_records`, { type: "CNAME", name: options.hostname, content: target, proxied: true, ttl: 1 });
  else if (!plan.record.proxied) await api.call("PATCH", `/zones/${zone.id}/dns_records/${plan.record.id}`, { proxied: true });
  const connectorToken = await api.call<string>("GET", `/accounts/${options.accountId}/cfd_tunnel/${tunnel.id}/token`);
  if (typeof connectorToken !== "string" || connectorToken.length < 20) throw new Error("Cloudflare returned no valid connector token");
  return { tunnelId: tunnel.id, connectorToken };
}

async function privateFile(path: string, text: string) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, text, { mode: 0o600, flag: "wx" }); await rename(temporary, path); await chmod(path, 0o600);
}

async function main() {
  const args = process.argv.slice(2);
  const options = new Map<string, string>(); let apply = false;
  while (args.length) {
    const flag = args.shift()!;
    if (flag === "--apply") { apply = true; continue; }
    if (!["--data-dir", "--reuse-tunnel-id"].includes(flag) || !args[0] || options.has(flag)) throw new Error("usage: bun scripts/provision-tunnel.ts --data-dir <absolute-installation-directory> [--reuse-tunnel-id <owned-project-UUID>] [--apply]");
    options.set(flag, args.shift()!);
  }
  const dataDir = options.get("--data-dir"); if (!dataDir || !isAbsolute(dataDir)) throw new Error("--data-dir must be absolute");
  await outsideCheckout(dataDir);
  const config = JSON.parse(await readFile(join(dataDir, "web.json"), "utf8")) as { publicUrl: string; listen: string };
  const url = new URL(config.publicUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw new Error("web.json needs an explicit HTTPS origin");
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID; const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) throw new Error("configure CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN locally; required permissions: Zone Read, DNS Edit and Cloudflare Tunnel Edit");
  let ownedTunnelId: string | undefined;
  try {
    const metadata = JSON.parse(await readFile(join(dataDir, "cloudflare.json"), "utf8")) as { accountId: string; hostname: string; tunnelId: string };
    if (metadata.accountId !== accountId || metadata.hostname !== url.hostname) throw new Error("installation metadata belongs to another account or hostname");
    ownedTunnelId = metadata.tunnelId;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (options.has("--reuse-tunnel-id")) {
    const explicit = options.get("--reuse-tunnel-id")!;
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(explicit) || (ownedTunnelId && ownedTunnelId !== explicit)) throw new Error("reuse ID must be the project's actual tunnel UUID and match existing ownership metadata");
    ownedTunnelId = explicit;
  }
  const api = administrationApi(token);
  const plan = await planTunnel(api, { accountId, hostname: url.hostname, listen: config.listen, ...(ownedTunnelId ? { ownedTunnelId } : {}) });
  console.log(JSON.stringify({ hostname: url.hostname, zone: plan.zone.name, tunnel: plan.tunnel ? "reuse compatible tunnel" : "create dedicated tunnel", dns: plan.record ? "reuse project CNAME" : "create proxied CNAME", ingress: plan.ingress, mode: apply ? "apply" : "read-only plan" }, null, 2));
  if (!apply) return;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const result = await applyTunnel(api, plan, async (tunnelId) => privateFile(join(dataDir, "cloudflare.json"), JSON.stringify({ accountId, hostname: url.hostname, zoneId: plan.zone.id, tunnelId }, null, 2)));
  await privateFile(join(dataDir, "connector.token"), `${result.connectorToken}\n`);
  console.log(`DNS and tunnel configured for ${url.hostname}. Connector credentials saved outside the repository. Connector activity and public HTTPS are not yet verified.`);
}
if (import.meta.main) main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Cloudflare provisioning failed"); process.exitCode = 1; });
