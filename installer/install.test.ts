import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { install, Installer, destinations, readTtyLine } from "./install.ts";
import { guiPaths } from "./gui.ts";
import { createHash } from "node:crypto";
import { marker, serviceFiles } from "../agent/lazy-workflow/gui/scripts/install-web-services.ts";
import type { WebRuntime } from "./web.ts";
import { createCli } from "../agent/lazy-workflow/test/_helpers/create-cli.ts";
import { MODES, parseOptions } from "./options.ts";

let root: string;
let home: string;
let fixture: string;
let env: NodeJS.ProcessEnv;
let output: string[];
let errors: string[];
const originalLog = console.log;
const originalError = console.error;

function file(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agent-workflow-install-test-"));
  home = join(root, "home");
  fixture = join(root, "fixture");
  mkdirSync(home);
  file(join(fixture, "utility/alpha/SKILL.md"), "alpha");
  file(join(fixture, "design/beta/SKILL.md"), "beta");
  file(join(fixture, "agent/lazy-workflow/AGENT.md"), "agent");
  for (const script of ["run.sh", "run.cmd", "run.ps1", "main.ts", "package.json"]) file(join(fixture, "agent/lazy-workflow", script), script === "package.json" ? "{}" : "fixture");
  file(join(fixture, "agent/lazy-workflow/gui/package.json"), "{}");
  file(join(fixture, "agent/lazy-workflow/gui/src-tauri/Cargo.toml"), "# synthetic");
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const name of ["git", "bun", "cargo", "rustc", "systemctl", "launchctl"]) {
    file(join(bin, name), `#!${process.execPath}\n` + `
import { appendFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.COMMAND_LOG, JSON.stringify({tool: ${JSON.stringify(name)}, args, cwd: process.cwd(), target: process.env.CARGO_TARGET_DIR}) + "\\n");
if (${JSON.stringify(name)} === "git") {
  if (process.env.REAL_GIT) {
    const result = Bun.spawnSync([process.env.REAL_GIT, ...args], { stdout: "inherit", stderr: "inherit" }); process.exit(result.exitCode);
  }
  if (args[0] === "clone") {
    if (process.env.CLONE_FAIL) process.exit(2);
    cpSync(process.env.FIXTURE, args.at(-2), {recursive: true});
  } else if (args[0] === "rev-parse") console.log(args[1].endsWith("src-tauri") ? process.env.BACKEND_TREE || "backend-one" : args[1] === "HEAD" ? process.env.WEB_SHA || "sha-one" : process.env.GUI_TREE);
}
if (${JSON.stringify(name)} === "cargo" && args[0] === "build") {
  if (process.env.WEB_BUILD_FAIL) process.exit(7);
  const artifact = join(process.env.CARGO_TARGET_DIR, "release/lz-web");
  mkdirSync(dirname(artifact), {recursive: true}); writeFileSync(artifact, "built backend");
}
if (${JSON.stringify(name)} === "bun") {
  if (args[0] === "install" && process.env.DEPENDENCIES_FAIL && !process.cwd().endsWith("gui")) process.exit(3);
  if (args[0] === "run") {
    if (args[1] === "build:web") {
      mkdirSync("dist", {recursive: true}); writeFileSync("dist/index.html", "built frontend"); process.exit(0);
    }
    if (process.env.BUILD_FAIL) process.exit(4);
    const target = process.env.CARGO_TARGET_DIR;
    const artifact = args.includes("app") ? join(target, "release/bundle/macos/lz.app/Contents/MacOS/lz-gui") : join(target, "release", process.env.GUI_PLATFORM === "win32" ? "lz-gui.exe" : "lz-gui");
    mkdirSync(dirname(artifact), {recursive: true});
    writeFileSync(artifact, process.env.GUI_EXECUTABLE ? '#!/bin/sh\\nprintf launched > "' + process.env.GUI_LAUNCH_MARKER + '"\\n' : "built GUI");
  }
}
`);
    chmodSync(join(bin, name), 0o755);
  }
  env = { HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), CARGO_HOME: process.env.CARGO_HOME || join(process.env.HOME!, ".cargo"), RUSTUP_HOME: process.env.RUSTUP_HOME || join(process.env.HOME!, ".rustup"), PATH: bin, FIXTURE: fixture, COMMAND_LOG: join(root, "commands.jsonl"), GUI_TREE: "tree-one", AGENT_WORKFLOW_REPO_URL: fixture };
  output = [];
  errors = [];
  console.log = (...values) => output.push(values.join(" "));
  console.error = (...values) => errors.push(values.join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  rmSync(root, { recursive: true, force: true });
});

const commands = (): Array<{ tool: string; args: string[]; target?: string; cwd: string }> => existsSync(env.COMMAND_LOG!) ? readFileSync(env.COMMAND_LOG!, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
const run = (args: string[], platform: NodeJS.Platform = "linux") => install(args, env, platform);

async function syntheticWeb(platform: "linux" | "darwin" = "linux", data = join(home, ".local/share/lz-web")) {
  await run(["--all-global", "--no-web"], platform);
  const backend = join(data, "bin/lz-web");
  const frontend = join(data, "frontend");
  file(backend, "old backend"); file(join(frontend, "index.html"), "old frontend");
  const settings = join(data, "gui.json");
  file(settings, JSON.stringify({ lzCommand: join(home, ".cache/agent-workflow/agent/lazy-workflow/main.ts") }));
  file(join(data, "web.json"), JSON.stringify({ listen: "127.0.0.1:8234", settingsPath: settings, frontendDir: frontend }));
  const units = serviceFiles({ dataDir: data, backend, cloudflared: join(root, "cloudflared"), userHome: home, platform });
  for (const unit of units) file(unit.path, unit.text);
  file(join(data, "service.json"), JSON.stringify({ managedBy: marker, units: units.map(({ path, label, text }) => ({ path, label, sha256: createHash("sha256").update(text).digest("hex") })) }));
  const io: WebRuntime = { health: async () => ({ status: "ok", activeRuns: 0, backendHash: createHash("sha256").update(readFileSync(backend)).digest("hex") }), wait: async () => {} };
  return { data, backend, frontend, settings, units, io };
}

for (const platform of ["linux", "darwin"] as const) test(`global update deploys synthetic web, backs up, checks health and skips unchanged builds on ${platform}`, async () => {
  const web = await syntheticWeb(platform);
  let healthChecks = 0;
  const io = { ...web.io, health: async (url: string) => { expect(url).toBe("http://127.0.0.1:8234/health"); healthChecks++; return web.io.health(url); } };
  env.GUI_TREE = "tree-two";
  await install(["--all-global"], env, platform, io);
  expect(readFileSync(join(web.frontend, "index.html"), "utf8")).toBe("built frontend");
  expect(readFileSync(web.backend, "utf8")).toBe("built backend");
  expect(readFileSync(guiPaths(home, platform).stamp, "utf8")).toBe("tree-two\n");
  const backups = readdirSync(join(web.data, "deployment-backups"));
  expect(backups).toHaveLength(1);
  expect(backups[0]).toStartWith("before-update-sha-one-");
  expect(readFileSync(join(web.data, "deployment-backups", backups[0]!, "lz-web"), "utf8")).toBe("old backend");
  expect(existsSync(join(web.data, "deployment-backups", backups[0]!, "cache/utility/alpha/SKILL.md"))).toBe(true);
  expect(healthChecks).toBe(3);
  const serviceCalls = commands().filter((command) => ["systemctl", "launchctl"].includes(command.tool));
  expect(serviceCalls.filter((command) => command.args.includes(platform === "linux" ? "restart" : "kickstart"))).toHaveLength(2);
  expect(serviceCalls.every((command) => web.units.some((unit) => command.args.some((arg) => arg.endsWith(unit.label))))).toBe(true);
  const builds = () => commands().filter((command) => (command.tool === "cargo" && command.args[0] === "build") || (command.tool === "bun" && command.args[0] === "run"));
  const buildCount = builds().length;
  await install(["--all-global"], env, platform, io);
  expect(builds()).toHaveLength(buildCount);
  expect(commands().filter((command) => ["systemctl", "launchctl"].includes(command.tool))).toHaveLength(serviceCalls.length);
  env.GUI_TREE = "tree-three";
  await install(["--all-global"], env, platform, io);
  expect(commands().filter((command) => command.tool === "cargo" && command.args[0] === "build")).toHaveLength(1);
  env.BACKEND_TREE = "backend-two";
  await install(["--all-global"], env, platform, io);
  expect(commands().filter((command) => command.tool === "cargo" && command.args[0] === "build")).toHaveLength(2);
});

test("custom web data directory is updated and checkout frontend paths are refused", async () => {
  const web = await syntheticWeb("linux", join(root, "custom-web"));
  env.LZ_WEB_DATA_DIR = web.data;
  await install(["--all-global"], env, "linux", web.io);
  expect(readFileSync(join(web.data, ".lz-web-commit"), "utf8")).toBe("sha-one\n");
  file(join(fixture, ".git/HEAD"), "ref: refs/heads/main\n");
  const config = JSON.parse(readFileSync(join(web.data, "web.json"), "utf8"));
  config.frontendDir = join(fixture, "agent/lazy-workflow/gui");
  file(join(web.data, "web.json"), JSON.stringify(config));
  const count = commands().length;
  await expect(install(["--all-global"], env, "linux", web.io)).rejects.toThrow("outside every Git checkout");
  expect(commands()).toHaveLength(count);
});

test("lz update downloads a new real git commit and updates CLI, skills, GUI and synthetic web together", async () => {
  const git = Bun.which("git")!;
  const gitCommand = (args: string[], cwd = fixture) => {
    const result = Bun.spawnSync([git, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  gitCommand(["init", "-b", "main"]);
  const commit = () => {
    gitCommand(["add", "."]);
    gitCommand(["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.test", "-c", "core.hooksPath=/dev/null", "commit", "--no-gpg-sign", "-m", "synthetic version"]);
    return gitCommand(["rev-parse", "HEAD"]);
  };
  const old = commit(); env.REAL_GIT = git;
  const web = await syntheticWeb();
  file(join(fixture, "agent/lazy-workflow/main.ts"), "new CLI");
  file(join(fixture, "utility/alpha/SKILL.md"), "new skill");
  file(join(fixture, "agent/lazy-workflow/gui/new-frontend.ts"), "// new frontend");
  const next = commit(); expect(next).not.toBe(old);
  const cli = createCli({ runInstaller: async (args) => { await install(args, env, "linux", web.io); return 0; } });
  expect(await cli.run(["update"])).toBe(0);
  expect(gitCommand(["rev-parse", "HEAD"], join(home, ".cache/agent-workflow"))).toBe(next);
  expect(readFileSync(join(home, ".cache/agent-workflow/agent/lazy-workflow/main.ts"), "utf8")).toBe("new CLI");
  expect(readFileSync(join(home, ".codex/skills/alpha/SKILL.md"), "utf8")).toBe("new skill");
  expect(readFileSync(guiPaths(home, "linux").stamp, "utf8").trim()).toBe(gitCommand(["rev-parse", "HEAD:agent/lazy-workflow/gui"]));
  expect(readFileSync(join(web.frontend, "index.html"), "utf8")).toBe("built frontend");
  expect(readFileSync(web.backend, "utf8")).toBe("built backend");
  const builds = () => commands().filter((command) => (command.tool === "cargo" && command.args[0] === "build") || (command.tool === "bun" && command.args[0] === "run"));
  const count = builds().length;
  expect(await cli.run(["update"])).toBe(0);
  expect(builds()).toHaveLength(count);
  expect(await cli.run(["update", "--no-web"])).toBe(0);
  expect(builds()).toHaveLength(count);
});

test("active runs and missing health refuse before the cache or installed artifacts change", async () => {
  const web = await syntheticWeb();
  file(join(home, ".cache/agent-workflow/sentinel"), "old cache");
  const count = commands().length;
  for (const health of [async () => ({ ...await web.io.health(""), activeRuns: 1 }), async () => { throw new Error("offline"); }, async () => ({ status: "ok" } as any)]) {
    await expect(install(["--all-global"], env, "linux", { ...web.io, health })).rejects.toThrow();
    expect(commands()).toHaveLength(count);
    expect(readFileSync(join(home, ".cache/agent-workflow/sentinel"), "utf8")).toBe("old cache");
    expect(readFileSync(web.backend, "utf8")).toBe("old backend");
    expect(existsSync(join(web.data, "update.lock"))).toBe(false);
  }
});

test("health failure after restart restores web artifacts, stamps and previous CLI cache", async () => {
  const web = await syntheticWeb();
  file(join(home, ".cache/agent-workflow/sentinel"), "old cache");
  const health = async () => readFileSync(web.backend, "utf8") === "old backend" ? web.io.health("") : { status: "failed", activeRuns: 0, backendHash: "wrong" };
  await expect(install(["--all-global"], env, "linux", { ...web.io, health })).rejects.toThrow("/health");
  expect(readFileSync(web.backend, "utf8")).toBe("old backend");
  expect(readFileSync(join(web.frontend, "index.html"), "utf8")).toBe("old frontend");
  expect(readFileSync(join(home, ".cache/agent-workflow/sentinel"), "utf8")).toBe("old cache");
  expect(existsSync(join(web.data, ".lz-web-backend-tree"))).toBe(false);
  expect(commands().filter((command) => command.tool === "systemctl" && command.args.includes("restart"))).toHaveLength(4);
  expect(errors.join("\n")).toContain("Se restauro el respaldo web");
});

test("unverified rollback leaves the maintenance gates closed for local recovery", async () => {
  const web = await syntheticWeb(); let calls = 0;
  const health = async () => ++calls <= 2 ? web.io.health("") : { status: "unavailable", activeRuns: 0, backendHash: "wrong" };
  await expect(install(["--all-global"], env, "linux", { ...web.io, health })).rejects.toThrow("Requiere recuperacion local");
  expect(existsSync(join(web.data, "installer-update.lock"))).toBe(true);
  expect(existsSync(join(web.data, "update.lock"))).toBe(true);
  expect(readFileSync(web.backend, "utf8")).toBe("old backend");
});

test("no-web, external development launcher, dry-run and uninstall leave the web untouched", async () => {
  const web = await syntheticWeb();
  for (const args of [["--all-global", "--no-web"], ["--all-global", "--dry-run"], ["--all-global", "--uninstall"]]) {
    await install(args, env, "linux", { health: async () => { throw new Error("must not check health"); } });
    expect(readFileSync(web.backend, "utf8")).toBe("old backend");
  }
  file(web.settings, JSON.stringify({ lzCommand: join(fixture, "agent/lazy-workflow/main.ts") }));
  await install(["--all-global"], env, "linux", { health: async () => { throw new Error("must not check health"); } });
  expect(errors.join("\n")).toContain("fuera del cache");
  expect(readFileSync(web.settings, "utf8")).toContain(fixture);
  expect(commands().some((command) => command.tool === "systemctl")).toBe(false);
});

test("foreign services and simultaneous updates fail without using a real service manager", async () => {
  const web = await syntheticWeb();
  file(web.units[0]!.path, "edited service");
  await expect(install(["--all-global"], env, "linux", web.io)).rejects.toThrow("manually edited");
  file(web.units[0]!.path, web.units[0]!.text);
  mkdirSync(join(web.data, "update.lock")); file(join(web.data, "update.lock/id"), "other-update");
  await expect(install(["--all-global"], env, "linux", web.io)).rejects.toThrow("Ya hay una actualizacion");
  expect(existsSync(join(web.data, "update.lock"))).toBe(true);
});

for (const mode of MODES) test(`${mode} installs and uninstalls all its destinations`, async () => {
  const args = [`--${mode}`, "--target", home, "--no-gui"];
  await run(args);
  const options = parseOptions(args, root);
  for (const destination of destinations(options, home, env.CODEX_HOME!)) {
    const names = destination.kind === "skills" ? ["alpha", "beta"] : destination.kind === "claude-agents" ? ["lazy-workflow.md"] : destination.kind === "runners" ? ["lz", "lazy-workflow"] : ["lazy-workflow"];
    for (const name of names) expect(lstatSync(join(destination.path, name)).isSymbolicLink()).toBe(true);
  }
  await run([...args, "--uninstall"]);
  for (const destination of destinations(options, home, env.CODEX_HOME!)) expect(readdirSync(destination.path)).toEqual([]);
});

test("CODEX_HOME and repository/ref override are respected", async () => {
  env.CODEX_HOME = join(root, "custom-codex");
  await run(["--codex", "--ref", "other-ref"]);
  expect(readlinkSync(join(env.CODEX_HOME, "skills/alpha"))).toBe(join(home, ".cache/agent-workflow/utility/alpha"));
  expect(commands()[0]!.args.slice(0, 6)).toEqual(["clone", "--branch", "other-ref", "--depth", "1", fixture]);
});

test("dry-run leaves an empty HOME untouched and never installs dependencies or compiles", async () => {
  await run(["--all-global", "--dry-run"]);
  expect(readdirSync(home)).toEqual([]);
  expect(commands().map((command) => command.tool)).toEqual(["git"]);
  expect(output.join("\n")).toContain("CARGO_TARGET_DIR=");
  const cloned = commands()[0]!.args.at(-2)!;
  expect(existsSync(dirname(cloned))).toBe(false);
});

test("dry-run with an existing dirty cache does not replace it or reconcile links", async () => {
  await run(["--global"]);
  const cacheFile = join(home, ".cache/agent-workflow/utility/alpha/SKILL.md");
  writeFileSync(cacheFile, "local edits");
  symlinkSync(join(home, ".cache/agent-workflow/old"), join(home, ".agents/skills/old"));
  const count = commands().length;
  await run(["--global", "--dry-run"]);
  expect(readFileSync(cacheFile, "utf8")).toBe("local edits");
  expect(readlinkSync(join(home, ".agents/skills/old"))).toContain("/old");
  expect(commands()).toHaveLength(count);
});

test("dirty cache and stale managed links are reconciled, foreign entries survive", async () => {
  await run(["--all-global", "--no-gui"]);
  const cache = join(home, ".cache/agent-workflow");
  file(join(cache, "local-file"), "dirty");
  symlinkSync(join(cache, "old"), join(home, ".claude/skills/old"));
  symlinkSync(fixture, join(home, ".claude/skills/foreign"));
  file(join(home, ".local/bin/unrelated"), "other tool");
  await run(["--all-global", "--no-gui"]);
  expect(existsSync(join(cache, "local-file"))).toBe(false);
  expect(() => lstatSync(join(home, ".claude/skills/old"))).toThrow();
  expect(readlinkSync(join(home, ".claude/skills/foreign"))).toBe(fixture);
  expect(readFileSync(join(home, ".local/bin/unrelated"), "utf8")).toBe("other tool");
});

for (const failure of ["CLONE_FAIL", "DEPENDENCIES_FAIL"]) test(`${failure} preserves previous cache and links`, async () => {
  await run(["--claude-global", "--no-gui"]);
  file(join(home, ".cache/agent-workflow/sentinel"), "keep");
  env[failure] = "1";
  await expect(run(["--claude-global", "--no-gui"])).rejects.toThrow("cache anterior permanece intacto");
  expect(readFileSync(join(home, ".cache/agent-workflow/sentinel"), "utf8")).toBe("keep");
  expect(lstatSync(join(home, ".local/bin/lz")).isSymbolicLink()).toBe(true);
  expect(readdirSync(join(home, ".cache"))).toEqual(["agent-workflow"]);
});

for (const platform of ["darwin", "linux", "win32"] as const) test(`GUI build, hash skip, missing artifact rebuild and uninstall on ${platform}`, async () => {
  env.GUI_PLATFORM = platform;
  const paths = guiPaths(home, platform);
  await run(["--all-global"], platform);
  expect(readFileSync(paths.executable, "utf8")).toBe("built GUI");
  expect(readFileSync(paths.stamp, "utf8")).toBe("tree-one\n");
  const builds = () => commands().filter((command) => command.tool === "bun" && command.args[0] === "run");
  expect(builds()[0]!.args).toEqual(["run", "tauri", "build", ...(platform === "darwin" ? ["--bundles", "app"] : ["--no-bundle"])]);
  expect(builds()[0]!.target).toBe(paths.build);
  if (platform === "linux") expect(readFileSync(paths.desktop, "utf8")).toContain(`Exec="${paths.executable}"`);
  await run(["--all-global"], platform);
  expect(builds()).toHaveLength(1);
  expect(output.join("\n")).toContain("GUI sin cambios");
  rmSync(paths.executable);
  await run(["--all-global"], platform);
  expect(builds()).toHaveLength(2);
  env.GUI_TREE = "tree-two";
  await run(["--all-global"], platform);
  expect(builds()).toHaveLength(3);
  await run(["--all-global", "--uninstall"], platform);
  for (const path of [paths.installed, paths.stamp, paths.build, paths.desktop]) expect(existsSync(path)).toBe(false);
});

test("missing cargo or rustc warns and still installs CLI", async () => {
  rmSync(join(root, "bin/cargo"));
  await run(["--all-global"]);
  expect(lstatSync(join(home, ".local/bin/lz")).isSymbolicLink()).toBe(true);
  expect(errors.join("\n")).toContain("cargo y rustc");
  expect(errors.join("\n")).toContain("sudo apt-get install libwebkit2gtk-4.1-dev");
  expect(commands().some((command) => command.args[0] === "run")).toBe(false);
});

test.skipIf(process.platform !== "linux")("installed GUI launches through the real CLI in a temporary HOME, skips unchanged builds and uninstalls", async () => {
  env.GUI_EXECUTABLE = "1";
  env.GUI_LAUNCH_MARKER = join(root, "gui-launched");
  env.CARGO_HOME = process.env.CARGO_HOME || join(process.env.HOME!, ".cargo");
  env.RUSTUP_HOME = process.env.RUSTUP_HOME || join(process.env.HOME!, ".rustup");
  await run(["--all-global"]);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../agent/lazy-workflow/main.ts"), "gui"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe(""); expect(code).toBe(0);
  for (let attempt = 0; attempt < 100 && !existsSync(env.GUI_LAUNCH_MARKER); attempt++) await Bun.sleep(10);
  expect(readFileSync(env.GUI_LAUNCH_MARKER, "utf8")).toBe("launched");
  const builds = () => commands().filter((command) => command.tool === "bun" && command.args[0] === "run");
  await run(["--all-global"]);
  expect(builds()).toHaveLength(1);
  await run(["--all-global", "--uninstall"]);
  expect(existsSync(guiPaths(home, "linux").executable)).toBe(false);
});

test("failed GUI build leaves the previous GUI and stamp intact, CLI update succeeds", async () => {
  await run(["--all-global"]);
  const paths = guiPaths(home, "linux");
  writeFileSync(paths.executable, "previous GUI");
  env.GUI_TREE = "new-tree";
  env.BUILD_FAIL = "1";
  await run(["--all-global"]);
  expect(readFileSync(paths.executable, "utf8")).toBe("previous GUI");
  expect(readFileSync(paths.stamp, "utf8")).toBe("tree-one\n");
  expect(errors.join("\n")).toContain("No se pudo instalar la GUI");
});

test("--no-gui leaves previous GUI alone and does not compile", async () => {
  const paths = guiPaths(home, "linux");
  file(paths.executable, "previous GUI");
  await run(["--all-global", "--no-gui"]);
  expect(readFileSync(paths.executable, "utf8")).toBe("previous GUI");
  expect(commands().some((command) => command.args[0] === "run")).toBe(false);
});

test("uninstall without a cache needs no network and preserves foreign links", async () => {
  const directory = join(home, ".claude/skills");
  mkdirSync(directory, { recursive: true });
  symlinkSync(fixture, join(directory, "alpha"));
  await run(["--claude-global", "--uninstall"]);
  expect(readlinkSync(join(directory, "alpha"))).toBe(fixture);
  expect(commands()).toEqual([]);
});

test("Windows file copies use the existing uppercase SHA256 manifest; changed files survive uninstall", async () => {
  await run(["--all-global", "--no-gui"], "win32");
  const runner = join(home, ".local/bin/lz.cmd");
  const psRunner = join(home, ".local/bin/lz-powershell.ps1");
  const manifest = JSON.parse(readFileSync(join(home, ".cache/agent-workflow-copies.json"), "utf8"));
  expect(manifest[runner]).toMatch(/^[0-9A-F]{64}$/);
  expect(lstatSync(runner).isFile()).toBe(true);
  expect(readFileSync(runner, "utf8")).toContain('%USERPROFILE%\\.cache\\agent-workflow\\agent\\lazy-workflow\\main.ts');
  expect(readFileSync(psRunner, "utf8")).toContain("& $sourceScript @args");
  writeFileSync(psRunner, "edited by operator");
  await run(["--all-global", "--uninstall"], "win32");
  expect(existsSync(runner)).toBe(false);
  expect(readFileSync(psRunner, "utf8")).toBe("edited by operator");
});

test("no TTY menu and collision produce actionable errors without reading piped stdin", async () => {
  for (const args of [[], ["--global"]]) {
    if (args.length) file(join(home, ".agents/skills/alpha/SKILL.md"), "foreign");
    const child = spawn(process.execPath, [join(import.meta.dir, "main.ts"), ...args], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    expect(status).toBe(1);
    expect(stderr).toContain(args.length ? "--force" : "TTY");
  }
});

test("--force replaces a conflicting entry; malformed flags fail before cache writes", async () => {
  file(join(home, ".agents/skills/alpha/SKILL.md"), "foreign");
  await run(["--global", "--force"]);
  expect(lstatSync(join(home, ".agents/skills/alpha")).isSymbolicLink()).toBe(true);
  for (const args of [["--bogus"], ["--ref"], ["--target", "--local"]]) expect(() => parseOptions(args, home)).toThrow();
});

test("imports have no installation effects", () => {
  new Installer(parseOptions(["--global"], home), env);
  expect(readdirSync(home)).toEqual([]);
  expect(commands()).toEqual([]);
});

test("interactive input preserves UTF-8 project paths and CRLF", () => {
  const input = join(root, "input");
  writeFileSync(input, "proyecto con espacios ü y 日本語\r\n");
  const fd = openSync(input, "r");
  try { expect(readTtyLine(fd)).toBe("proyecto con espacios ü y 日本語"); }
  finally { closeSync(fd); }
});

test("GUI dry-run uninstall leaves the GUI, desktop and build intact", async () => {
  await run(["--all-global"]);
  const paths = guiPaths(home, "linux");
  await run(["--all-global", "--uninstall", "--dry-run"]);
  for (const path of [paths.executable, paths.desktop, paths.stamp, paths.build]) expect(existsSync(path)).toBe(true);
  expect(lstatSync(join(home, ".local/bin/lz")).isSymbolicLink()).toBe(true);
});

test("foreign GUI without an ownership stamp survives uninstall", async () => {
  const paths = guiPaths(home, "linux");
  file(paths.executable, "foreign executable");
  file(paths.desktop, "foreign desktop entry");
  await run(["--all-global", "--uninstall"]);
  expect(readFileSync(paths.executable, "utf8")).toBe("foreign executable");
  expect(readFileSync(paths.desktop, "utf8")).toBe("foreign desktop entry");
});

const powershell = Bun.which("pwsh");
test.skipIf(!powershell)("PowerShell bootstrap selects ref, delegates argument boundaries and cleans up on failure", () => {
  file(join(fixture, "installer/main.ts"), "// bootstrap fixture");
  file(join(root, "bin/bun"), `#!${process.execPath}\nimport {writeFileSync} from "node:fs"; writeFileSync(process.env.ARGUMENTS_LOG, JSON.stringify(process.argv.slice(2))); process.exit(17);`);
  chmodSync(join(root, "bin/bun"), 0o755);
  const argumentLog = join(root, "args.json");
  const args = ["--claude-global", "--ref", "requested-ref", "--target", "proyecto con espacios ü", "--no-gui", "--dry-run"];
  const child = Bun.spawnSync([powershell!, "-NoProfile", "-File", join(import.meta.dir, "../install.ps1"), ...args], { env: { ...env, ARGUMENTS_LOG: argumentLog, XDG_CACHE_HOME: join(root, "powershell-cache"), XDG_DATA_HOME: join(root, "powershell-data") }, stdout: "pipe", stderr: "pipe" });
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(17);
  const forwarded = JSON.parse(readFileSync(argumentLog, "utf8"));
  expect(forwarded[0]).toBe("run");
  expect(forwarded.slice(2)).toEqual(args);
  expect(commands()[0]!.args.slice(0, 4)).toEqual(["clone", "--branch", "requested-ref", "--depth"]);
  expect(existsSync(commands()[0]!.args.at(-2)!)).toBe(false);
  expect(readdirSync(home)).toEqual([]);
});
