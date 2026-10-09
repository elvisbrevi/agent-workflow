import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MODES, parseOptions, USAGE, type Destination, type Options } from "./options.ts";
import { installGui } from "./gui.ts";

const CATEGORIES = ["utility", "discovery", "design", "planning", "implementation", "diagnosis", "review"];
export type Entry = { name: string; source: string };

export function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code!)) return false;
    throw error;
  }
}

export function promptTty(prompt: string, failure: string, platform = process.platform): string {
  if (platform === "win32" && !process.stdin.isTTY) throw new Error(failure);
  let fd: number;
  try { fd = openSync(platform === "win32" ? "CONIN$" : "/dev/tty", "r+"); }
  catch { throw new Error(failure); }
  try {
    writeFileSync(platform === "win32" ? "CONOUT$" : fd, prompt);
    return readTtyLine(fd);
  } finally { closeSync(fd); }
}

export function readTtyLine(fd: number): string {
  const byte = Buffer.alloc(1);
  const bytes: number[] = [];
  while (readSync(fd, byte, 0, 1, null)) {
    if (byte[0] === 10) return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
    bytes.push(byte[0]!);
  }
  throw new Error("No se pudo leer la respuesta del terminal.");
}

export function destinations(options: Options, home: string, codexHome: string): Destination[] {
  const shared = (base: string): Destination[] => [{ kind: "skills", path: join(base, ".agents/skills") }, { kind: "agents", path: join(base, ".agents/agents") }];
  const claude = (base: string, bin: string): Destination[] => [{ kind: "skills", path: join(base, ".claude/skills") }, { kind: "claude-agents", path: join(base, ".claude/agents") }, { kind: "runners", path: bin }];
  const opencode: Destination[] = [{ kind: "skills", path: join(options.target, ".opencode/skills") }, { kind: "agents", path: join(options.target, ".opencode/agent") }];
  const codex: Destination = { kind: "skills", path: join(codexHome, "skills") };
  switch (options.mode) {
    case "all-global": return [...claude(home, join(home, ".local/bin")), ...shared(home), codex];
    case "claude-global": return claude(home, join(home, ".local/bin"));
    case "claude-local": return claude(options.target, join(options.target, ".claude/bin"));
    case "global": return shared(home);
    case "local": return shared(options.target);
    case "opencode": return opencode;
    case "both": return [...shared(options.target), ...opencode];
    case "codex": return [codex];
    default: throw new Error("Falta el modo de instalacion.");
  }
}

export function discover(source: string, categories: string[], marker: string): Entry[] {
  return categories.flatMap((category) => {
    const directory = join(source, category);
    if (!existsSync(directory)) return [];
    return readdirSync(directory).sort().flatMap((name) => {
      const path = join(directory, name);
      return existsSync(join(path, marker)) ? [{ name, source: path }] : [];
    });
  });
}

export class Installer {
  readonly home: string;
  readonly cache: string;
  readonly manifestPath: string;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly options: Options;
  readonly copies: Record<string, string> = {};

  constructor(options: Options, env = process.env, platform = process.platform) {
    this.options = options;
    this.env = env;
    this.platform = platform;
    this.home = resolve(env.HOME || env.USERPROFILE || homedir());
    this.cache = join(this.home, ".cache/agent-workflow");
    this.manifestPath = join(this.home, ".cache/agent-workflow-copies.json");
  }

  log(message: string): void { console.log(message); }
  warn(message: string): void { console.error(`⚠ ${message}`); }
  command(command: string[], cwd?: string, extraEnv: NodeJS.ProcessEnv = {}, capture = false): string {
    const result = Bun.spawnSync(command, { cwd, env: { ...this.env, ...extraEnv }, stdin: "inherit", stdout: capture ? "pipe" : "inherit", stderr: "inherit" });
    if (result.exitCode !== 0) throw new Error(`Fallo el comando: ${command.join(" ")} (codigo ${result.exitCode})`);
    return capture ? result.stdout!.toString().trim() : "";
  }

  binary(name: string): string | null { return Bun.which(name, { PATH: this.env.PATH }); }
  hash(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase(); }
  saveManifest(): void {
    if (this.platform !== "win32" || this.options.dryRun) return;
    mkdirSync(dirname(this.manifestPath), { recursive: true });
    const temporary = `${this.manifestPath}.tmp.${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(this.copies, null, 2)}\n`);
    renameSync(temporary, this.manifestPath);
  }

  remove(path: string): void {
    // Remove a junction itself; never traverse its cache target.
    if (process.platform === "win32" && lstatSync(path).isSymbolicLink() && statSync(path, { throwIfNoEntry: false })?.isDirectory()) rmdirSync(path);
    else rmSync(path, { recursive: true, force: true });
  }

  managed(path: string): boolean {
    const item = lstatSync(path);
    if (item.isSymbolicLink()) {
      const target = readlinkSync(path).replace(/^(\\\\\?\\|\\\?\?\\)/, "");
      const normalized = isAbsolute(target) ? resolve(target) : resolve(dirname(path), target);
      const inside = relative(this.cache, normalized);
      return inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
    }
    return item.isFile() && this.copies[path] === this.hash(path);
  }

  reconcile(directory: string): void {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (this.managed(path)) {
        this.log(`${this.options.dryRun ? "dry-run: retirar" : "Retirando entrada gestionada:"} ${path}`);
        if (!this.options.dryRun) this.remove(path);
      }
      delete this.copies[path];
    }
  }

  approve(path: string, owned = this.managedIfExists(path)): boolean {
    if (!exists(path) || this.options.force || owned) return true;
    const answer = promptTty(`Ya existe ${path}. ¿Reemplazar? [y/N]: `, `No se puede reemplazar ${path} sin TTY. Ejecuta de nuevo con --force.`, this.platform);
    if (/^[yY]$/.test(answer)) return true;
    this.warn(`Omitido: ${path}`);
    return false;
  }

  private managedIfExists(path: string): boolean { return exists(path) && this.managed(path); }

  prepare(path: string): boolean {
    if (!this.approve(path)) return false;
    if (exists(path)) this.remove(path);
    delete this.copies[path];
    return true;
  }

  entry(source: string, path: string, directory = false, content?: string): void {
    if (this.options.dryRun) { this.log(`dry-run: instalar ${path} → ${source}`); return; }
    if (!this.prepare(path)) return;
    if (this.platform === "win32" && !directory) {
      if (content !== undefined) writeFileSync(path, content, "ascii");
      else cpSync(source, path);
      this.copies[path] = this.hash(path);
    } else symlinkSync(source, path, directory && this.platform === "win32" ? "junction" : undefined);
    this.log(`Instalado: ${path}`);
    this.saveManifest();
  }

  runners(agents: Entry[], directory: string): void {
    for (const agent of agents) {
      for (const name of agent.name === "lazy-workflow" ? [agent.name, "lz"] : [agent.name]) {
        if (this.platform !== "win32") {
          const script = join(agent.source, "run.sh");
          if (existsSync(script)) this.entry(script, join(directory, name));
          continue;
        }
        const main = join(agent.source, "main.ts");
        if (!existsSync(main) || !existsSync(join(agent.source, "run.cmd"))) continue;
        const suffix = relative(this.cache, main).replaceAll("/", "\\");
        const script = `%USERPROFILE%\\.cache\\agent-workflow\\${suffix}`;
        this.entry(main, join(directory, `${name}.cmd`), false, `@echo off\r\nwhere bun >nul 2>nul\r\nif errorlevel 1 (echo lz: Se requiere Bun en PATH. 1>&2 & exit /b 127)\r\nbun run "${script}" %*\r\nexit /b %errorlevel%\r\n`);
        const powershell = join(agent.source, "run.ps1");
        if (existsSync(powershell)) {
          const installed = `.cache\\agent-workflow\\${relative(this.cache, powershell).replaceAll("/", "\\")}`;
          this.entry(powershell, join(directory, `${name}-powershell.ps1`), false, `$sourceScript = Join-Path $env:USERPROFILE '${installed}'\n& $sourceScript @args\nexit $LASTEXITCODE\n`);
        }
      }
    }
  }

  syncCache(): string {
    if ((this.options.dryRun || this.options.uninstall) && existsSync(this.cache)) return this.cache;
    if (this.options.uninstall) return this.cache;
    const preview = this.options.dryRun ? mkdtempSync(join(tmpdir(), "agent-workflow-preview-")) : null;
    const refresh = preview ? join(preview, "repo") : `${this.cache}.refresh.${process.pid}`;
    const previous = `${this.cache}.previous.${process.pid}`;
    if (!preview) mkdirSync(dirname(this.cache), { recursive: true });
    this.log(`Actualizando cache gestionado (${this.options.ref})...`);
    try {
      this.command(["git", "clone", "--branch", this.options.ref, "--depth", "1", this.env.AGENT_WORKFLOW_REPO_URL || "https://github.com/elvisbrevi/agent-workflow.git", refresh, "--quiet"]);
      if (preview) return refresh;
      if (["all-global", "claude-global", "claude-local"].includes(this.options.mode!)) {
        for (const agent of discover(refresh, ["agent"], "AGENT.md")) {
          if (existsSync(join(agent.source, "package.json")) && existsSync(join(agent.source, this.platform === "win32" ? "run.cmd" : "run.sh"))) {
            this.command(["bun", "install", "--frozen-lockfile"], agent.source);
          }
        }
      }
      if (exists(this.cache)) renameSync(this.cache, previous);
      try { renameSync(refresh, this.cache); }
      catch (error) { if (exists(previous)) renameSync(previous, this.cache); throw error; }
      rmSync(previous, { recursive: true, force: true });
      return this.cache;
    } catch (error) {
      rmSync(preview || refresh, { recursive: true, force: true });
      throw new Error(`No se pudo actualizar el cache; el cache anterior permanece intacto. ${error instanceof Error ? error.message : error}`);
    }
  }

  run(): void {
    if (this.platform === "win32" && existsSync(this.manifestPath)) Object.assign(this.copies, JSON.parse(readFileSync(this.manifestPath, "utf8").replace(/^\uFEFF/, "")));
    const source = this.syncCache();
    try {
      const skills = discover(source, CATEGORIES, "SKILL.md");
      const agents = discover(source, ["agent"], "AGENT.md");
      this.log(`Skills encontradas: ${skills.length}; agentes encontrados: ${agents.length}`);
      for (const destination of destinations(this.options, this.home, this.env.CODEX_HOME || join(this.home, ".codex"))) {
        this.log(`${this.options.uninstall ? "Desinstalando" : "Instalando"} ${destination.kind} → ${destination.path}`);
        if (!this.options.uninstall && !this.options.dryRun) mkdirSync(destination.path, { recursive: true });
        this.reconcile(destination.path);
        if (this.options.uninstall) continue;
        if (destination.kind === "runners") this.runners(agents, destination.path);
        else for (const entry of destination.kind === "skills" ? skills : agents) {
          const claude = destination.kind === "claude-agents";
          this.entry(claude ? join(entry.source, "AGENT.md") : entry.source, join(destination.path, entry.name + (claude ? ".md" : "")), !claude);
        }
      }
      if (["all-global", "claude-global"].includes(this.options.mode!)) installGui(this, source);
      this.log(this.options.dryRun ? "Dry-run: no se cambiaron archivos instalados ni el cache." : "¡Listo!");
    } finally {
      this.saveManifest();
      if (source !== this.cache) rmSync(dirname(source), { recursive: true, force: true });
    }
  }
}

export async function install(args: string[], env = process.env, platform = process.platform): Promise<void> {
  const options = parseOptions(args, process.cwd());
  if (options.help) { console.log(USAGE); return; }
  if (!options.mode) {
    console.log("¿Donde instalar las skills y agentes?\n1) Todo global  2) Claude Code global  3) Claude Code local  4) Shared global\n5) Local .agents/  6) Local .opencode/  7) Ambas locales  8) Codex global");
    const failure = "El modo interactivo requiere TTY. Indica un modo como --all-global.";
    const choice = promptTty("Selecciona [1-8]: ", failure, platform);
    if (!/^[1-8]$/.test(choice)) throw new Error(`Opcion invalida: ${choice}`);
    options.mode = MODES[Number(choice) - 1];
    if (["claude-local", "local", "opencode", "both"].includes(options.mode!)) options.target = promptTty("Ruta del proyecto (Enter para cwd): ", failure, platform) || options.target;
    options.dryRun ||= /^[yY]$/.test(promptTty("¿Modo dry-run? [y/N]: ", failure, platform));
    if (["all-global", "claude-global"].includes(options.mode!) && !options.noGui) options.noGui = /^[nN]$/.test(promptTty("¿Incluir la GUI de escritorio? [Y/n]: ", failure, platform));
  }
  if (!existsSync(options.target) || !statSync(options.target).isDirectory()) throw new Error(`No existe el directorio destino: ${options.target}`);
  options.target = realpathSync(options.target);
  new Installer(options, env, platform).run();
}
