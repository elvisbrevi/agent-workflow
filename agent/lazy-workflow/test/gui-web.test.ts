import { expect, test } from "bun:test";
import { createHttpTransport, HttpError } from "../gui/src/lib/http-transport.ts";
import { planTunnel, applyTunnel, type CloudflareApi } from "../gui/scripts/provision-tunnel.ts";
import { serviceFiles } from "../gui/scripts/install-web-services.ts";
import { interviewUrl } from "../gui/src/lib/output.ts";

test("web transport uses same-origin cookies, CSRF, unique start IDs and coherent backend errors", async () => {
  const calls: Array<{ path: string; options: RequestInit }> = [];
  let expired = false;
  const transport = createHttpTransport(async (path, options = {}) => {
    calls.push({ path: String(path), options });
    if (String(path) === "/api/login") return Response.json({ username: "owner", csrf: "synthetic-csrf", expiresAt: 123 });
    if (String(path).endsWith("forbidden")) return Response.json({ error: "not permitted" }, { status: 403 });
    if (String(path).endsWith("expired")) return Response.json({ error: "session expired" }, { status: 401 });
    return Response.json({ id: 1 });
  }, () => { expired = true; });
  await transport.login("owner", "synthetic-passphrase");
  await transport.rpc("start_run", { request: { args: ["code"] } });
  await transport.rpc("start_run", { request: { args: ["code"] } });
  const first = calls[1]!.options; const second = calls[2]!.options;
  expect(first.credentials).toBe("same-origin"); expect(first.redirect).toBe("error");
  expect(new Headers(first.headers).get("X-CSRF-Token")).toBe("synthetic-csrf");
  expect(new Headers(first.headers).get("X-LZ-Web")).toBe("1");
  expect(new Headers(first.headers).get("X-Request-ID")).not.toBe(new Headers(second.headers).get("X-Request-ID"));
  expect(new Headers(first.headers).has("Authorization")).toBe(false);
  await expect(transport.rpc("forbidden")).rejects.toBeInstanceOf(HttpError);
  await expect(transport.rpc("expired")).rejects.toThrow("session expired");
  expect(expired).toBe(true);
  await expect(transport.request("https://foreign.test/api/commands")).rejects.toThrow("Invalid API path");
});

const accountId = "a".repeat(32); const tunnelId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
function cloudflare(options: { record?: unknown; ingress?: unknown; tunnel?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const api: CloudflareApi = { async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    let result: unknown = null;
    if (path.startsWith("/zones?")) result = [{ id: "synthetic-zone", name: "example.test", account: { id: accountId } }];
    else if (method === "GET" && path.includes("dns_records")) result = options.record ? [options.record] : [];
    else if (method === "GET" && path.includes("cfd_tunnel?")) result = options.tunnel ? [{ id: tunnelId, name: "lz-web-app.example.test", config_src: "cloudflare" }] : [];
    else if (method === "GET" && path.endsWith("configurations")) result = { config: { ingress: options.ingress ?? [] } };
    else if (method === "POST" && path.endsWith("cfd_tunnel")) result = { id: tunnelId, name: "lz-web-app.example.test", config_src: "cloudflare" };
    else if (method === "GET" && path.endsWith("token")) result = "synthetic-connector-token-never-admin";
    return result as T;
  } };
  return { api, calls };
}
const tunnelOptions = { accountId, hostname: "app.example.test", listen: "127.0.0.1:8234" };

test("tunnel provisioning plans read-only, preserves public Host and creates a catch-all 404", async () => {
  const { api, calls } = cloudflare();
  const plan = await planTunnel(api, tunnelOptions);
  expect(calls.every((call) => call.method === "GET")).toBe(true);
  expect(plan.ingress).toEqual([{ hostname: "app.example.test", service: "http://127.0.0.1:8234" }, { service: "http_status:404" }]);
  let owned = "";
  const result = await applyTunnel(api, plan, async (id) => { owned = id; });
  expect(owned).toBe(tunnelId);
  expect(result.connectorToken).toBe("synthetic-connector-token-never-admin");
  expect(calls.find((call) => call.method === "POST" && call.path.includes("dns_records"))?.body).toEqual({ type: "CNAME", name: "app.example.test", content: `${tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1 });
  expect(JSON.stringify(calls.find((call) => call.method === "PUT")?.body)).not.toContain("httpHostHeader");
});

test("foreign DNS and incompatible tunnel routes are rejected before any mutation", async () => {
  for (const setup of [
    { record: { type: "A", content: "192.0.2.1" } },
    { tunnel: true, ingress: [{ hostname: "other.example.test", service: "http://127.0.0.1:99" }, { service: "http_status:404" }] },
  ]) {
    const { api, calls } = cloudflare(setup);
    await expect(planTunnel(api, { ...tunnelOptions, ...(setup.tunnel ? { ownedTunnelId: tunnelId } : {}) })).rejects.toThrow();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  }
});

test("compatible project DNS and tunnel are reused without rewriting configuration", async () => {
  const { api, calls } = cloudflare({ tunnel: true, record: { id: "record", type: "CNAME", content: `${tunnelId}.cfargotunnel.com`, proxied: true }, ingress: [{ hostname: "app.example.test", service: "http://127.0.0.1:8234" }, { service: "http_status:404" }] });
  await applyTunnel(api, await planTunnel(api, { ...tunnelOptions, ownedTunnelId: tunnelId }), async () => {});
  expect(calls.every((call) => call.method === "GET")).toBe(true);
});

test("service templates keep connector secrets in files, scope names to the installation and manage shutdown", () => {
  const options = { dataDir: "/tmp/synthetic owner/install", backend: "/tmp/build/lz-web", cloudflared: "/usr/local/bin/cloudflared", userHome: "/tmp/synthetic owner" };
  const linux = serviceFiles({ ...options, platform: "linux" });
  expect(linux[0]!.text).toContain("KillMode=control-group"); expect(linux[0]!.text).toContain("TimeoutStopSec=15");
  expect(linux[1]!.text).toContain('"--token-file"'); expect(linux[1]!.text).not.toContain("CLOUDFLARE_API_TOKEN");
  expect(linux[0]!.path).not.toBe(serviceFiles({ ...options, dataDir: "/tmp/another-install", platform: "linux" })[0]!.path);
  const literal = serviceFiles({ ...options, dataDir: "/tmp/$owner%install", platform: "linux" })[0]!.text;
  expect(literal).toContain('WorkingDirectory="/tmp/$owner%%install"');
  expect(literal).toContain('ExecStart="/tmp/$$owner%%install/bin/lz-web"');
  const mac = serviceFiles({ ...options, dataDir: "/tmp/owner & install", platform: "darwin" });
  expect(mac[0]!.text).toContain("owner &amp; install"); expect(mac[1]!.text).toContain("<string>--token-file</string>");
  expect(() => serviceFiles({ ...options, dataDir: "/tmp/bad\npath", platform: "linux" })).toThrow();
});

test("the run panel recognizes only the authorized public interview path in web mode", () => {
  expect(interviewUrl([`Responde las preguntas del plan en /api/interviews/${"a".repeat(64)}`])).toBe(`/api/interviews/${"a".repeat(64)}`);
});
