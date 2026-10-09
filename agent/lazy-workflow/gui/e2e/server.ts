/** Synthetic loopback HTTPS fixture. Never a production server or a Cloudflare connector. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const gui = fileURLToPath(new URL("..", import.meta.url));
const binary = process.env.LZ_WEB_TEST_BINARY ?? join(gui, "src-tauri/target/debug/lz-web");
const root = await mkdtemp(join(tmpdir(), "lz-web-browser-"));
const settings = join(root, "gui.json");
const launcher = join(root, "fake-lz.ts");
const catalog = fileURLToPath(new URL("../../src/cli/command-catalog.ts", import.meta.url));
const factory = fileURLToPath(new URL("../../src/interaction/create-question-channel.ts", import.meta.url));
await writeFile(launcher, `import { commandCatalog } from ${JSON.stringify(catalog)};
import { createQuestionChannel } from ${JSON.stringify(factory)};
const command = process.argv[2];
if (command === "catalog") console.log(JSON.stringify(commandCatalog()));
else if (command === "plan") {
  const channel = createQuestionChannel({ channel: "http", host: "127.0.0.1", port: 0, timeoutSeconds: 60, rounds: 1 });
  const answers = await channel!.ask({ round: 1, questions: [{ id: "scope", question: "Synthetic: one service or two?", recommended: "one", options: ["one", "two"], rationale: "Synthetic browser verification" }] });
  await channel!.close();
  console.log(JSON.stringify({ syntheticAnswers: answers }));
} else console.log(JSON.stringify({ synthetic: true, branch: "main" }));
`, { mode: 0o600 });
await writeFile(settings, JSON.stringify({ lzCommand: launcher, inheritShellEnvironment: false, repositories: [root], activeRepository: root, flagDefaults: { "--interview": "http" } }), { mode: 0o600 });
const certificate = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"), "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stderr: "ignore" });
if (certificate.exitCode !== 0) throw new Error("could not prepare synthetic TLS certificate");
const initialized = Bun.spawn([binary, "init", "--data-dir", root, "--public-url", "https://localhost", "--settings", settings, "--frontend", join(gui, "dist"), "--owner", "owner", "--password-stdin"], { stdin: "pipe", stdout: Bun.file(join(root, "init.log")), stderr: Bun.file(join(root, "init-error.log")) });
initialized.stdin.write("synthetic-passphrase\n"); initialized.stdin.end();
if (await initialized.exited !== 0) throw new Error(`synthetic initialization failed: ${await readFile(join(root, "init-error.log"), "utf8")}`);
const config = JSON.parse(await readFile(join(root, "web.json"), "utf8"));
config.allowedCommands = ["plan", "git-branch-list", "pr-create"];
await writeFile(join(root, "web.json"), JSON.stringify(config), { mode: 0o600 });
let backend: ReturnType<typeof Bun.spawn>;
async function startBackend() {
  backend = Bun.spawn([binary, "serve", "--data-dir", root], { stdout: Bun.file(join(root, "backend.log")), stderr: Bun.file(join(root, "backend-error.log")) });
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if ((await fetch("http://127.0.0.1:8234/health")).ok) return; } catch {}
    if (backend.exitCode !== null) throw new Error(`synthetic backend failed: ${await readFile(join(root, "backend-error.log"), "utf8")}`);
    await Bun.sleep(100);
  }
  throw new Error("synthetic backend did not become ready");
}
await startBackend();
const proxy = Bun.serve({ hostname: "127.0.0.1", port: 443, tls: { key: Bun.file(join(root, "key.pem")), cert: Bun.file(join(root, "cert.pem")) }, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/__test/health") return Response.json({ synthetic: true });
  if (url.pathname === "/__test/restart" || url.pathname === "/__test/expire") {
    if (request.method !== "POST" || request.headers.get("x-synthetic-test") !== "synthetic-loopback-fixture") return new Response("Forbidden", { status: 403 });
    backend.kill("SIGTERM"); await backend.exited;
    if (url.pathname === "/__test/expire") {
      const sessions = JSON.parse(await readFile(join(root, "sessions.json"), "utf8")) as Record<string, { expiresAt: number }>;
      for (const session of Object.values(sessions)) session.expiresAt = Math.floor(Date.now() / 1000) - 1;
      await writeFile(join(root, "sessions.json"), JSON.stringify(sessions), { mode: 0o600 });
    }
    await startBackend(); return Response.json({ synthetic: true });
  }
  if (url.hostname !== "localhost") return new Response("Unexpected synthetic Host", { status: 403 });
  const headers = new Headers(request.headers); headers.set("host", "localhost");
  const response = await fetch(`http://127.0.0.1:8234${url.pathname}${url.search}`, { method: request.method, headers, redirect: "manual", body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer() });
  return new Response(response.body, { status: response.status, headers: response.headers });
} });
let closing = false;
async function close() {
  if (closing) return; closing = true;
  proxy.stop(true); backend.kill("SIGTERM"); await backend.exited;
  await rm(root, { recursive: true, force: true }); process.exit(0);
}
process.on("SIGTERM", () => { void close(); }); process.on("SIGINT", () => { void close(); });
console.log("Synthetic HTTPS browser fixture ready on loopback. No public DNS or tunnel is used.");
