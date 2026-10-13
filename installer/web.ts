import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Installer } from "./install.ts";
import { registeredServices, restartServiceCommands, type ServiceManifest } from "../agent/lazy-workflow/gui/scripts/install-web-services.ts";
import { outsideCheckout } from "../agent/lazy-workflow/gui/scripts/web-paths.ts";

export interface WebHealth { status: string; activeRuns: number; backendHash: string }
export interface WebRuntime {
  health: (url: string) => Promise<WebHealth>;
  wait: (ms: number) => Promise<void>;
}
const runtime: WebRuntime = {
  async health(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "error", proxy: null });
    if (!response.ok) throw new Error("web health unavailable");
    return await response.json() as WebHealth;
  },
  wait: (ms) => Bun.sleep(ms),
};

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/** The installer owns deployment. The server only schedules the same installed updater. */
export class WebUpdate {
  readonly dataDir: string;
  backup: string | null = null;
  private config!: { frontendDir: string; settingsPath: string; listen: string };
  private units!: ServiceManifest["units"];
  private ownsGate = false;
  private locked = false;
  private touched = false;
  private readonly io: WebRuntime;
  private get gate() { return join(this.dataDir, "update.lock"); }
  private get lock() { return join(this.dataDir, "installer-update.lock"); }
  private get binary() { return join(this.dataDir, "bin/lz-web"); }
  private get frontendStamp() { return join(this.dataDir, ".lz-web-frontend-tree"); }
  private get backendStamp() { return join(this.dataDir, ".lz-web-backend-tree"); }
  private get commitStamp() { return join(this.dataDir, ".lz-web-commit"); }

  constructor(private installer: Installer, io: Partial<WebRuntime> = {}) {
    this.dataDir = installer.env.LZ_WEB_DATA_DIR || join(installer.home, ".local/share/lz-web");
    this.io = { ...runtime, ...io };
  }

  async preflight(): Promise<boolean> {
    const i = this.installer;
    if (i.options.noWeb || i.options.uninstall || !["all-global", "claude-global"].includes(i.options.mode!)) return false;
    if (!existsSync(join(this.dataDir, "web.json")) || !existsSync(join(this.dataDir, "service.json"))) return false;
    if (i.platform !== "linux" && i.platform !== "darwin") throw new Error("La web requiere Linux o macOS.");
    if (!isAbsolute(this.dataDir)) throw new Error("LZ_WEB_DATA_DIR debe ser absoluto.");
    await outsideCheckout(this.dataDir);
    this.config = readJson(join(this.dataDir, "web.json"));
    if (!isAbsolute(this.config.frontendDir) || !isAbsolute(this.config.settingsPath) || !/^127\.0\.0\.1:\d+$/.test(this.config.listen)) throw new Error("Configuracion web invalida; no se cambiaron artefactos.");
    if (existsSync(this.config.frontendDir)) await outsideCheckout(this.config.frontendDir);
    const settings = readJson(this.config.settingsPath);
    const configured = (settings.lzCommand || "").trim() || "lz";
    const launcher = configured.startsWith("~/") ? join(i.home, configured.slice(2)) : configured;
    const resolved = isAbsolute(launcher) ? launcher : i.binary(launcher);
    const installed = [join(i.cache, "agent/lazy-workflow/main.ts"), join(i.cache, "agent/lazy-workflow/run.sh")];
    if (!resolved || !existsSync(resolved) || !installed.includes(realpathSync(resolved))) {
      i.warn("La web usa un lzCommand fuera del cache instalado; se omite su actualizacion. Quita lzCommand para usar lz del PATH o apunta al main.ts del cache. No se modifica ningun checkout.");
      return false;
    }
    this.units = registeredServices(readJson(join(this.dataDir, "service.json")), { dataDir: this.dataDir, backend: this.binary, cloudflared: "/unused/cloudflared", userHome: i.home, platform: i.platform }, (path) => readFileSync(path, "utf8"));
    if (i.options.dryRun) { i.log(`dry-run: actualizar web en ${this.dataDir}; respaldar, comprobar ejecuciones, reiniciar servicios registrados y verificar /health.`); return false; }
    try {
      mkdirSync(this.lock, { mode: 0o700 });
      this.locked = true;
      if (existsSync(this.gate)) {
        if (!i.env.LZ_WEB_UPDATE_ID || readFileSync(join(this.gate, "id"), "utf8") !== i.env.LZ_WEB_UPDATE_ID) throw new Error("Ya hay una actualizacion web; revisa su progreso antes de reintentar.");
      } else {
        mkdirSync(this.gate, { mode: 0o700 });
        this.ownsGate = true;
        writeFileSync(join(this.gate, "id"), `local-${process.pid}`, { mode: 0o600 });
      }
      await this.checkIdle();
      return true;
    } catch (error) { this.release(); throw error; }
  }

  private async checkIdle() {
    let health: WebHealth;
    try { health = await this.io.health(`http://${this.config.listen}/health`); }
    catch { throw new Error("No se pudo comprobar la web; actualizacion rechazada antes de reemplazar archivos."); }
    if (health.status !== "ok" || !Number.isInteger(health.activeRuns) || !health.backendHash) throw new Error("El backend necesita el primer despliegue manual de ADR-0051 antes de usar lz update.");
    if (health.activeRuns !== 0) throw new Error("Hay ejecuciones activas en la web; no se actualizaron archivos ni se reinicio el servicio. Termina las ejecuciones y reintenta.");
    if (health.backendHash.toUpperCase() !== this.installer.hash(this.binary)) throw new Error("El backend en ejecucion no coincide con el instalado; revisa el servicio antes de actualizar.");
  }

  /** Called after downloading, before swapping the CLI cache or any installed artifact. */
  snapshot(source: string) {
    const sha = this.installer.command(["git", "rev-parse", "HEAD"], source, {}, true);
    if (!/^[a-zA-Z0-9-]+$/.test(sha)) throw new Error("Commit invalido para el respaldo.");
    this.backup = join(this.dataDir, "deployment-backups", `before-update-${sha}-${new Date().toISOString().replaceAll(":", "-")}`);
    mkdirSync(this.backup, { recursive: true, mode: 0o700 });
    for (const [path, name] of this.artifacts()) if (existsSync(path)) cpSync(path, join(this.backup, name), { recursive: true });
    this.installer.log(`Respaldo web: ${this.backup}`);
  }

  private artifacts(): Array<[string, string]> {
    return [[this.binary, "lz-web"], [this.config.frontendDir, "frontend"], [join(this.dataDir, "web.json"), "web.json"], [join(this.dataDir, "service.json"), "service.json"], [this.frontendStamp, "frontend-tree"], [this.backendStamp, "backend-tree"], [this.commitStamp, "commit"]];
  }

  private replace(source: string, target: string) {
    const staged = `${target}.next.${process.pid}`;
    const previous = `${target}.previous.${process.pid}`;
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, staged, { recursive: true });
    try {
      if (!statSync(staged).isDirectory()) { renameSync(staged, target); return; }
      if (existsSync(target)) renameSync(target, previous);
      try { renameSync(staged, target); }
      catch (error) { if (existsSync(previous)) renameSync(previous, target); throw error; }
      rmSync(previous, { recursive: true, force: true });
    } finally { rmSync(staged, { recursive: true, force: true }); }
  }

  private restart() {
    for (const command of restartServiceCommands(this.units, this.installer.platform as "linux" | "darwin", process.getuid?.() ?? 0)) this.installer.command(command);
  }

  private async verify(expected: string) {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const health = await this.io.health(`http://${this.config.listen}/health`);
        if (health.status === "ok" && health.backendHash?.toUpperCase() === expected && health.activeRuns === 0) return;
      } catch { /* The service may still be starting. */ }
      await this.io.wait(500);
    }
    throw new Error("La web no supero /health y la comprobacion del hash del backend.");
  }

  async deploy(source: string): Promise<void> {
    const i = this.installer;
    const gui = join(source, "agent/lazy-workflow/gui");
    const frontendTree = i.command(["git", "rev-parse", "HEAD:agent/lazy-workflow/gui"], source, {}, true);
    const backendTree = i.command(["git", "rev-parse", "HEAD:agent/lazy-workflow/gui/src-tauri"], source, {}, true);
    const sha = i.command(["git", "rev-parse", "HEAD"], source, {}, true);
    const matches = (stamp: string, tree: string) => existsSync(stamp) && readFileSync(stamp, "utf8").trim() === tree;
    const frontendChanged = !matches(this.frontendStamp, frontendTree) || !existsSync(join(this.config.frontendDir, "index.html"));
    const backendChanged = !matches(this.backendStamp, backendTree) || !existsSync(this.binary);
    const build = join(i.home, ".cache/agent-workflow-build/web");
    if (frontendChanged) {
      i.log("Compilando frontend web...");
      i.command(["bun", "install", "--frozen-lockfile"], gui);
      i.command(["bun", "run", "build:web"], gui);
      if (!existsSync(join(gui, "dist/index.html"))) throw new Error("La compilacion web no produjo index.html.");
    } else i.log("Frontend web sin cambios: se omite la compilacion.");
    if (backendChanged) {
      i.log("Compilando backend lz-web...");
      i.command(["cargo", "build", "--locked", "--release", "--no-default-features", "--features", "web", "--bin", "lz-web"], join(gui, "src-tauri"), { CARGO_TARGET_DIR: build });
      if (!existsSync(join(build, "release/lz-web"))) throw new Error("La compilacion web no produjo lz-web.");
    } else i.log("Backend web sin cambios: se omite la compilacion.");
    if (!frontendChanged && !backendChanged && matches(this.commitStamp, sha)) { i.log("Web sin cambios; no necesita reinicio."); return; }
    await this.checkIdle();
    this.touched = true;
    if (frontendChanged) this.replace(join(gui, "dist"), this.config.frontendDir);
    if (backendChanged) { this.replace(join(build, "release/lz-web"), this.binary); chmodSync(this.binary, 0o700); }
    this.restart();
    await this.verify(i.hash(this.binary));
    for (const [path, value] of [[this.frontendStamp, frontendTree], [this.backendStamp, backendTree], [this.commitStamp, sha]]) writeFileSync(path!, `${value}\n`, { mode: 0o600 });
    i.log(`Web actualizada a ${sha}; servicios registrados reiniciados y /health verificado.`);
  }

  async rollback() {
    if (!this.backup || !this.touched) return;
    for (const [path, name] of this.artifacts()) {
      const saved = join(this.backup, name);
      if (existsSync(saved)) this.replace(saved, path);
      else rmSync(path, { recursive: true, force: true });
    }
    this.restart();
    await this.verify(this.installer.hash(this.binary));
    this.installer.warn("Se restauro el respaldo web y se verifico el backend anterior.");
  }

  release(recoveryRequired = false) {
    if (recoveryRequired) return;
    if (this.ownsGate) rmSync(this.gate, { recursive: true, force: true });
    if (this.locked) rmSync(this.lock, { recursive: true, force: true });
    this.ownsGate = this.locked = false;
  }
}
