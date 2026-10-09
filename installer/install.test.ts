import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { install, Installer, destinations, readTtyLine } from "./install.ts";
import { guiPaths } from "./gui.ts";
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
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const name of ["git", "bun", "cargo", "rustc"]) {
    file(join(bin, name), `#!${process.execPath}\n` + `
import { appendFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.COMMAND_LOG, JSON.stringify({tool: ${JSON.stringify(name)}, args, cwd: process.cwd(), target: process.env.CARGO_TARGET_DIR}) + "\\n");
if (${JSON.stringify(name)} === "git") {
  if (args[0] === "clone") {
    if (process.env.CLONE_FAIL) process.exit(2);
    cpSync(process.env.FIXTURE, args.at(-2), {recursive: true});
  } else if (args[0] === "rev-parse") console.log(process.env.GUI_TREE);
}
if (${JSON.stringify(name)} === "bun") {
  if (args[0] === "install" && process.env.DEPENDENCIES_FAIL && !process.cwd().endsWith("gui")) process.exit(3);
  if (args[0] === "run") {
    if (process.env.BUILD_FAIL) process.exit(4);
    const target = process.env.CARGO_TARGET_DIR;
    const artifact = args.includes("app") ? join(target, "release/bundle/macos/lz.app/Contents/MacOS/lz-gui") : join(target, "release", process.env.GUI_PLATFORM === "win32" ? "lz-gui.exe" : "lz-gui");
    mkdirSync(dirname(artifact), {recursive: true});
    writeFileSync(artifact, "built GUI");
  }
}
`);
    chmodSync(join(bin, name), 0o755);
  }
  env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), PATH: bin, FIXTURE: fixture, COMMAND_LOG: join(root, "commands.jsonl"), GUI_TREE: "tree-one", AGENT_WORKFLOW_REPO_URL: fixture };
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
