/** Synthetic loopback HTTPS fixture. Never a production server or a Cloudflare connector. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
// Repositories live outside the private installation, below the root the browser may walk.
const projects = await mkdtemp(join(tmpdir(), "lz-web-projects-"));
const github = join(projects, "github-project"); const azure = join(projects, "azure-project"); const broken = join(projects, "broken-project");
await mkdir(github); await mkdir(azure); await mkdir(broken); await mkdir(join(projects, "archive"));
await writeFile(launcher, `import { commandCatalog } from ${JSON.stringify(catalog)};
import { createQuestionChannel } from ${JSON.stringify(factory)};
const command = process.argv[2];
if (command === "catalog") console.log(JSON.stringify(commandCatalog()));
else if (command === "credentials-status") console.log(JSON.stringify([
  { name: "LAZY_WORKFLOW_AZURE_ORGANIZATION", present: true, value: "https://dev.azure.com/synthetic", source: "credentials" },
  { name: "AZURE_DEVOPS_EXT_PAT", present: true, value: null, source: "credentials" }
]));
else if (command === "agent-models") console.log(JSON.stringify([
  { cli: "opencode", installed: true, defaultModel: "opencode-go/synthetic-pro", error: null, models: [{ id: "opencode-go/synthetic-pro", name: "synthetic-pro", provider: "opencode-go", efforts: null, defaultEffort: null }] },
  { cli: "claudecode", installed: true, defaultModel: "claude-synthetic", error: null, models: [{ id: "claude-synthetic-max", name: "Synthetic Max", provider: "anthropic", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null }] },
  { cli: "codex", installed: true, defaultModel: "gpt-synthetic", error: null, models: [{ id: "gpt-synthetic-sol", name: "GPT Synthetic Sol", provider: "openai", efforts: ["low", "medium", "high"], defaultEffort: "medium" }] }
]));
else if (command === "work-assigned" && process.argv.includes(${JSON.stringify(broken)})) { console.error("lazy-workflow: no se pudo ejecutar work-assigned (gh: not logged in)"); process.exit(1); }
else if (command === "work-assigned") {
  const azure = process.argv.includes(${JSON.stringify(azure)});
  const github = process.argv.includes(${JSON.stringify(github)});
  console.log(JSON.stringify({ tracker: azure ? "azure" : "github", scope: azure ? "Synthetic Azure" : github ? "synthetic/github" : "synthetic/other", truncated: false, items: azure ? [
    { id: 50, title: "Mejorar el portal de clientes", type: "User Story", state: "Active", url: "https://example.com/hu/50", hu: null },
    { id: 51, title: "Simplificar el formulario de ingreso", type: "Task", state: "New", url: "https://example.com/task/51", hu: 50 }
  ] : !github ? [] : [
    { id: 7, title: "Mejorar la navegación principal", type: "Issue", state: "OPEN", url: "https://github.com/synthetic/github/issues/7", hu: null },
    { id: 9, title: "[Epic] Portal de autoservicio", type: "Issue", state: "OPEN", url: "https://github.com/synthetic/github/issues/9", hu: null }
  ] }));
} else if (command === "hu-children-info") console.log(JSON.stringify({ hu: 50, children: [
  { id: 51, type: "Task", title: "Simplificar el formulario de ingreso", state: "New" },
  { id: 52, type: "Task", title: "Publicar el portal", state: "Done" }
] }));
else if (command === "github-issue-list") console.log(JSON.stringify({ managed: 2, eligible: [{ number: 8, title: "Agregar el menú lateral", createdAt: "2026-10-01T00:00:00Z" }], blocked: [{ number: 7, title: "Mejorar la navegación principal", reasons: ["assigned"] }], issues: [] }));
else if (command === "setup") console.log("✓ synthetic setup report");
else if (command === "plan" && !process.argv.includes("--interview")) console.log(JSON.stringify({ syntheticPlan: true }));
else if (command === "plan") {
  const channel = createQuestionChannel({ channel: "http", host: "127.0.0.1", port: 0, timeoutSeconds: 60, rounds: 1 });
  const answers = await channel!.ask({ round: 1, questions: [{ id: "scope", question: "Synthetic: one service or two?", recommended: "one", options: ["one", "two"], rationale: "Synthetic browser verification" }] });
  await channel!.close();
  console.log(JSON.stringify({ syntheticAnswers: answers }));
} else console.log(JSON.stringify({ synthetic: true, branch: "main" }));
`, { mode: 0o600 });
const runLog = join(root, "cli-runs.jsonl");
const history = [
  { run_id: "synthetic-history", ts: "2026-10-10T12:00:00Z", event: "run.started", severity: "info", command: "code", workflow: "azure", cli: "codex", model: "synthetic", variant: "high", context: { hu: 45, ticket: 46, repository: azure }, message: "Synthetic run" },
  { run_id: "synthetic-history", ts: "2026-10-10T12:05:00Z", event: "run.finished", severity: "info", command: "code", workflow: "azure", cli: "codex", model: "synthetic", variant: "high", outcome: "success", exit_code: 0, duration_ms: 300000, context: { hu: 45, ticket: 46, repository: azure }, message: "Synthetic finish" }
];
await writeFile(runLog, history.map((record) => JSON.stringify(record)).join("\n") + "\n");
await writeFile(settings, JSON.stringify({ lzCommand: launcher, inheritShellEnvironment: false, repositories: [github, azure, broken], activeRepository: github, environment: { LAZY_WORKFLOW_LOG_FILE: runLog }, flagDefaults: { "--interview": "http" } }), { mode: 0o600 });
const certificate = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"), "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stderr: "ignore" });
if (certificate.exitCode !== 0) throw new Error("could not prepare synthetic TLS certificate");
const initialized = Bun.spawn([binary, "init", "--data-dir", root, "--public-url", "https://localhost", "--settings", settings, "--frontend", join(gui, "dist"), "--owner", "owner", "--password-stdin"], { stdin: "pipe", stdout: Bun.file(join(root, "init.log")), stderr: Bun.file(join(root, "init-error.log")) });
initialized.stdin.write("synthetic-passphrase\n"); initialized.stdin.end();
if (await initialized.exited !== 0) throw new Error(`synthetic initialization failed: ${await readFile(join(root, "init-error.log"), "utf8")}`);
const config = JSON.parse(await readFile(join(root, "web.json"), "utf8"));
config.allowedCommands = ["plan", "code", "setup", "work-assigned", "agent-models", "hu-info", "hu-children-info", "github-issue-list"];
config.listen = "127.0.0.1:18234";
config.repositoryRoots = [projects];
await writeFile(join(root, "web.json"), JSON.stringify(config), { mode: 0o600 });
let backend: ReturnType<typeof Bun.spawn>;
async function startBackend() {
  backend = Bun.spawn([binary, "serve", "--data-dir", root], { stdout: Bun.file(join(root, "backend.log")), stderr: Bun.file(join(root, "backend-error.log")) });
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if ((await fetch("http://127.0.0.1:18234/health")).ok) return; } catch {}
    if (backend.exitCode !== null) throw new Error(`synthetic backend failed: ${await readFile(join(root, "backend-error.log"), "utf8")}`);
    await Bun.sleep(100);
  }
  throw new Error("synthetic backend did not become ready");
}
await startBackend();
const proxy = Bun.serve({ hostname: "127.0.0.1", port: 18443, tls: { key: Bun.file(join(root, "key.pem")), cert: Bun.file(join(root, "cert.pem")) }, async fetch(request) {
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
  const response = await fetch(`http://127.0.0.1:18234${url.pathname}${url.search}`, { method: request.method, headers, redirect: "manual", body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer() });
  return new Response(response.body, { status: response.status, headers: response.headers });
} });
let closing = false;
async function close() {
  if (closing) return; closing = true;
  proxy.stop(true); backend.kill("SIGTERM"); await backend.exited;
  await rm(root, { recursive: true, force: true }); await rm(projects, { recursive: true, force: true }); process.exit(0);
}
process.on("SIGTERM", () => { void close(); }); process.on("SIGINT", () => { void close(); });
console.log("Synthetic HTTPS browser fixture ready on loopback:18443. No public DNS or tunnel is used.");
