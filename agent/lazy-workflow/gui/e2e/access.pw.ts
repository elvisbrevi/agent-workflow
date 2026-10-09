/** UI-only Access gateway simulation. Real JWT/JWKS/identity checks are Rust integration tests. */
import { test, expect } from "@playwright/test";

const loginUrl = "https://synthetic.cloudflareaccess.com/cdn-cgi/access/login/synthetic-audience?redirect_url=https%3A%2F%2Flocalhost";
const auth = { mode: "cloudflareAccess", loginUrl, logoutUrl: "/cdn-cgi/access/logout" };
const session = { username: "GitHub", csrf: "synthetic-csrf", expiresAt: 9999999999 };
const settings = { schemaVersion: 1, lzCommand: "local-only", inheritShellEnvironment: false, extraPath: [], environment: {}, secretEnvironment: [], repositories: [], activeRepository: null, flagDefaults: {}, commandDefaults: {}, confirmWrites: true, theme: "system" };

test("Access UI exchanges the edge identity without a password form and navigates to Access logout", async ({ page }) => {
  const failures: string[] = []; let exchanges = 0; let csrf = "";
  page.on("pageerror", (error) => failures.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    let value: unknown = {};
    if (path === "/api/auth") value = auth;
    else if (path === "/api/session") return route.fulfill({ status: 401, json: { error: "login required" } });
    else if (path === "/api/access-session") { exchanges++; expect(request.postDataJSON()).toEqual({}); expect(request.headers()["authorization"]).toBeUndefined(); value = session; }
    else if (path === "/api/logout") { csrf = request.headers()["x-csrf-token"] ?? ""; value = { ok: true, logoutUrl: auth.logoutUrl }; }
    else if (path.endsWith("load_catalog")) value = { schemaVersion: 1, binary: "lz", defaultCli: "codex", agents: [], families: [], environment: [], groups: [], commands: [] };
    else if (path.endsWith("get_settings")) value = { path: "local-only", settings, error: null };
    else if (path.endsWith("diagnose")) value = { settingsPath: "local-only", runLogPath: "local-only", lzLauncher: "synthetic", lzError: null, shellEnvironment: false, binaries: [], variables: [] };
    else if (path === "/api/events") value = { events: [], cursor: 0, instance: "synthetic" };
    else if (path === "/api/runs") value = [];
    else throw new Error(`Unexpected Access UI test request: ${path}`);
    await route.fulfill({ json: value });
  });
  await page.route("**/cdn-cgi/access/logout", (route) => route.fulfill({ contentType: "text/html", body: "<p>Synthetic Access session closed</p>" }));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Cerrar sesion", exact: true })).toBeVisible();
  expect(await page.locator("input[type=password]").count()).toBe(0); expect(exchanges).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Cerrar sesion", exact: true }).click();
  await expect(page).toHaveURL("https://localhost/cdn-cgi/access/logout");
  expect(csrf).toBe("synthetic-csrf"); expect(failures).toEqual([]);
});

test("an unbound Access identity has a GitHub sign-in link and no password fallback", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth") return route.fulfill({ json: auth });
    return route.fulfill({ status: path === "/api/session" ? 401 : 403, json: { error: "GitHub identity is not bound to this installation" } });
  });
  await page.route("https://synthetic.cloudflareaccess.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<p>Synthetic GitHub authorization</p>" }));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("not bound");
  expect(await page.locator("input[type=password]").count()).toBe(0);
  await page.getByRole("link", { name: "Continuar con GitHub", exact: true }).click();
  await expect(page).toHaveURL(loginUrl);
});
