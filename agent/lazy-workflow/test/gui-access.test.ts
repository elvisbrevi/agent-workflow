import { expect, test } from "bun:test";
import { createHttpTransport } from "../gui/src/lib/http-transport.ts";
import { applyAccess, planAccess, type AccessOptions } from "../gui/scripts/provision-access.ts";
import type { CloudflareApi } from "../gui/scripts/provision-tunnel.ts";

test("Access exchanges no password or bearer, uses CSRF and exits to Access logout", async () => {
  const calls: Array<{ path: string; options: RequestInit }> = []; let unauthorized = 0;
  const transport = createHttpTransport(async (path, options = {}) => {
    calls.push({ path: String(path), options });
    if (path === "/api/auth") return Response.json({ mode: "cloudflareAccess", loginUrl: "https://synthetic.cloudflareaccess.com/cdn-cgi/access/login/a", logoutUrl: "/cdn-cgi/access/logout" });
    if (path === "/api/access-session") return Response.json({ username: "GitHub", csrf: "synthetic-csrf", expiresAt: 123 });
    if (path === "/api/logout") return Response.json({ ok: true, logoutUrl: "/cdn-cgi/access/logout" });
    throw new TypeError("Access login redirect rejected by fetch");
  }, () => { unauthorized++; });
  expect((await transport.authentication()).mode).toBe("cloudflareAccess");
  await transport.accessLogin();
  expect(calls[1]!.options.body).toBe("{}");
  expect(new Headers(calls[1]!.options.headers).has("authorization")).toBe(false);
  expect(await transport.logout()).toBe("/cdn-cgi/access/logout");
  expect(new Headers(calls[2]!.options.headers).get("x-csrf-token")).toBe("synthetic-csrf");
  await expect(transport.session()).rejects.toThrow("redirect"); expect(unauthorized).toBe(1);
});

const appId = "be853070-e8b0-4672-9346-e1db3fd4b01c";
const providerId = "44f98379-e81f-4323-9b9b-ec11b856af08";
const options: AccessOptions = { accountId: "a".repeat(32), hostname: "app.example.test", ownerEmail: "synthetic@example.test" };
function fixture(initial: { apps?: unknown[]; providers?: unknown[]; policies?: unknown[]; readbackWrong?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; body?: any }> = []; let app: any = null; let provider: any = null;
  const api: CloudflareApi = { async call<T>(method: string, path: string, body?: any): Promise<T> {
    calls.push({ method, path, body }); let result: unknown;
    if (path.endsWith("organizations")) result = { auth_domain: "synthetic.cloudflareaccess.com" };
    else if (method === "GET" && path.includes("identity_providers?")) result = initial.providers ?? [];
    else if (method === "GET" && path.includes("apps?")) result = initial.apps ?? [];
    else if (method === "POST" && path.endsWith("identity_providers")) result = provider = { ...body, id: providerId };
    else if (method === "GET" && path.endsWith(`identity_providers/${providerId}`)) result = provider;
    else if (["POST", "PUT"].includes(method) && /\/apps(?:\/[^/]+)?$/.test(path)) result = app = { ...body, id: appId, aud: "b".repeat(64) };
    else if (method === "GET" && path.endsWith("policies")) result = app ? app.policies : initial.policies ?? [];
    else if (method === "GET" && path.endsWith(`apps/${appId}`)) result = initial.readbackWrong ? { ...app, allowed_idps: ["foreign-idp"] } : app;
    else throw new Error(`Unexpected mocked ${method} ${path}`);
    return result as T;
  } };
  return { api, calls };
}

test("Access plan is read-only and applies GitHub-only explicit owner policy with checked audience", async () => {
  const { api, calls } = fixture(); const plan = await planAccess(api, options);
  expect(calls.every((c) => c.method === "GET")).toBe(true);
  const ownership: unknown[] = [];
  const setup = await applyAccess(api, plan, { clientId: "synthetic-client", clientSecret: "synthetic-secret" }, async (value) => { ownership.push(value); });
  expect(setup!.access.issuer).toBe("https://synthetic.cloudflareaccess.com");
  expect(setup!.access.audience).toBe("b".repeat(64)); expect(setup!.access.ownerSubject).toBeNull();
  const app = calls.find((c) => c.method === "POST" && c.path.endsWith("apps"))!.body;
  expect(app.allowed_idps).toEqual([providerId]); expect(app.auto_redirect_to_identity).toBe(true);
  expect(app.policies[0].include).toEqual([{ email: { email: options.ownerEmail } }]);
  expect(app.policies[0].require).toEqual([{ login_method: { id: providerId } }]);
  expect(app.domain).toBe(options.hostname); expect(app.http_only_cookie).toBe(true);
  expect(ownership).toEqual([{ providerId }, { appId, providerId }]);
  expect(JSON.stringify(setup)).not.toContain("synthetic-secret");
  expect(calls.every((c) => !c.path.includes("cfd_tunnel") && !c.path.includes("dns_records"))).toBe(true);
});

test("Access preserves foreign, overlapping and unmanaged applications and providers before mutation", async () => {
  for (const initial of [
    { apps: [{ id: "foreign", domain: options.hostname, name: "someone-else", type: "self_hosted" }] },
    { apps: [{ id: "foreign", domain: "*.example.test", name: "wildcard", type: "self_hosted" }] },
    { apps: [{ id: "foreign", domain: `${options.hostname}/internal`, name: "path", type: "self_hosted" }] },
    { providers: [{ id: providerId, name: `lz-web-${options.hostname}-login`, type: "github" }] },
    { apps: [{ id: appId, domain: options.hostname, name: `lz-web-${options.hostname}`, type: "self_hosted" }], policies: [{ name: "unmanaged" }] },
  ]) {
    const { api, calls } = fixture(initial);
    await expect(planAccess(api, { ...options, ...(initial.policies ? { ownedAppId: appId } : {}) })).rejects.toThrow();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  }
});

test("missing OAuth credentials cause no mutations; a protection-only app blocks everyone and produces no login config", async () => {
  const a = fixture(); const plan = await planAccess(a.api, options);
  await expect(applyAccess(a.api, plan, null, async () => {})).rejects.toThrow("dedicated GitHub OAuth");
  expect(a.calls.every((c) => c.method === "GET")).toBe(true);
  const b = fixture(); const blocked = await planAccess(b.api, { ...options, protectOnly: true });
  expect(await applyAccess(b.api, blocked, null, async () => {})).toBeNull();
  const app = b.calls.find((c) => c.method === "POST" && c.path.endsWith("apps"))!.body;
  expect(app.policies[0].decision).toBe("deny"); expect(app.allowed_idps).toEqual([]);
  expect(b.calls.some((c) => c.method === "POST" && c.path.endsWith("identity_providers"))).toBe(false);
});

test("Access refuses successful writes whose policy/provider readback is incompatible", async () => {
  const { api } = fixture({ readbackWrong: true }); const plan = await planAccess(api, options);
  await expect(applyAccess(api, plan, { clientId: "synthetic", clientSecret: "synthetic" }, async () => {})).rejects.toThrow("readback");
});
