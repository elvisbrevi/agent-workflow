import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpTransport, HttpError } from "../gui/src/lib/http-transport.ts";
import { planTunnel, applyTunnel, type CloudflareApi } from "../gui/scripts/provision-tunnel.ts";
import { serviceFiles } from "../gui/scripts/install-web-services.ts";
import { interviewUrl } from "../gui/src/lib/output.ts";

test("navigation cancels pending requests without revoking the Access session", async () => {
  let unauthorized = 0; let signal: AbortSignal | null = null;
  const transport = createHttpTransport(async (path, options) => {
    if (path === "/api/auth") return Response.json({ mode: "cloudflareAccess" });
    if (path === "/api/session") return Response.json({ username: "owner", csrf: "synthetic", expiresAt: 9999999999 });
    signal = options!.signal!;
    return await new Promise<Response>((_, reject) => signal!.addEventListener("abort", () => reject(new DOMException("navigation", "AbortError"))));
  }, () => { unauthorized++; });
  await transport.authentication(); await transport.session();
  const request = transport.rpc("get_update_status");
  transport.cancelPendingRequests();
  await expect(request).rejects.toThrow("navigation");
  expect(signal!.aborted).toBe(true);
  expect(unauthorized).toBe(0);
});

test("update polling keeps Access sessions during downtime and still rejects expired sessions", async () => {
  let offline = false;
  let expired = false;
  let unauthorized = 0;
  const transport = createHttpTransport(async (path) => {
    if (path === "/api/auth") return Response.json({ mode: "cloudflareAccess", loginUrl: "https://synthetic.test", logoutUrl: "/logout" });
    if (offline) throw new TypeError("backend restarting");
    if (expired) return Response.json({ error: "expired" }, { status: 401 });
    return Response.json({ username: "owner", csrf: "synthetic-csrf", expiresAt: 9999999999 });
  }, () => { unauthorized++; });
  await transport.authentication(); await transport.session();
  transport.setUpdating(true); offline = true;
  await expect(transport.rpc("get_update_status")).rejects.toThrow("backend restarting");
  expect(unauthorized).toBe(0);
  offline = false; expired = true;
  await expect(transport.rpc("get_update_status")).rejects.toBeInstanceOf(HttpError);
  expect(unauthorized).toBe(1);
});

test("Access expiration still opens sign-in during update downtime", async () => {
  let offline = false; let unauthorized = false;
  const transport = createHttpTransport(async (path) => {
    if (path === "/api/auth") return Response.json({ mode: "cloudflareAccess" });
    if (offline) throw new TypeError("edge redirect or offline backend");
    return Response.json({ username: "owner", csrf: "synthetic", expiresAt: 1 });
  }, () => { unauthorized = true; });
  await transport.authentication(); await transport.session();
  transport.setUpdating(true); offline = true;
  await expect(transport.rpc("get_update_status")).rejects.toThrow();
  expect(unauthorized).toBe(true);
});

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
  expect(literal).toContain('WorkingDirectory=/tmp/$owner%%install');
  expect(literal).toContain('ExecStart="/tmp/$owner%%install/bin/lz-web"');
  const mac = serviceFiles({ ...options, dataDir: "/tmp/owner & install", platform: "darwin" });
  expect(mac[0]!.text).toContain("owner &amp; install"); expect(mac[1]!.text).toContain("<string>--token-file</string>");
  expect(() => serviceFiles({ ...options, dataDir: "/tmp/bad\npath", platform: "linux" })).toThrow();
});

test.skipIf(process.platform !== "linux" || !Bun.which("systemd-analyze"))("systemd accepts generated services with literal spaces, dollars and percent signs", () => {
  const root = mkdtempSync(join(tmpdir(), "lz-service-verify-"));
  try {
    const dataDir = join(root, "owner $identity% area");
    mkdirSync(join(dataDir, "bin"), { recursive: true });
    writeFileSync(join(dataDir, "bin/lz-web"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const units = serviceFiles({ dataDir, backend: join(dataDir, "bin/lz-web"), cloudflared: "/usr/bin/true", userHome: root, platform: "linux" });
    const files = units.map((unit) => {
      const path = join(root, unit.label);
      writeFileSync(path, unit.text);
      return path;
    });
    const result = Bun.spawnSync(["systemd-analyze", "--user", "verify", ...files]);
    expect(result.stderr.toString()).not.toContain("WorkingDirectory= path is not absolute");
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    expect(result.exitCode).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("service installer rejects an inactive service even when enable reports success", async () => {
  const root = mkdtempSync(join(tmpdir(), "lz-service-start-"));
  try {
    const dataDir = join(root, "data");
    const frontend = join(root, "frontend");
    const bin = join(root, "bin");
    for (const directory of [dataDir, frontend, bin]) mkdirSync(directory);
    writeFileSync(join(frontend, "index.html"), "<h1>Synthetic</h1>");
    writeFileSync(join(dataDir, "web.json"), JSON.stringify({ frontendDir: frontend }));
    writeFileSync(join(dataDir, "connector.token"), "synthetic-connector-token", { mode: 0o600 });
    const backend = join(bin, "lz-web");
    const cloudflared = join(bin, "cloudflared");
    for (const path of [backend, cloudflared]) writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const systemctl = join(bin, "systemctl");
    writeFileSync(systemctl, '#!/bin/sh\nif [ "$2" = "is-active" ]; then exit 3; fi\nexit 0\n');
    chmodSync(systemctl, 0o700);
    const child = Bun.spawn([process.execPath, Bun.fileURLToPath(new URL("../gui/scripts/install-web-services.ts", import.meta.url)),
      "--data-dir", dataDir, "--backend", backend, "--frontend", frontend, "--cloudflared", cloudflared, "--install", "--start"], {
      env: { HOME: join(root, "home"), PATH: `${bin}:${process.env.PATH ?? ""}` },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    expect(stderr).toContain("systemctl failed with exit code 3");
    expect(stdout).not.toContain("service manager start succeeded");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the run panel recognizes only the authorized public interview path in web mode", () => {
  expect(interviewUrl([`Responde las preguntas del plan en /api/interviews/${"a".repeat(64)}`])).toBe(`/api/interviews/${"a".repeat(64)}`);
});
