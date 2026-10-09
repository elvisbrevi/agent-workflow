import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Installer } from "./install.ts";

export function guiPaths(home: string, platform: NodeJS.Platform) {
  const binary = join(home, ".local/bin", platform === "win32" ? "lz-gui.exe" : "lz-gui");
  const installed = platform === "darwin" ? join(home, "Applications/lz.app") : binary;
  return {
    installed,
    executable: platform === "darwin" ? join(installed, "Contents/MacOS/lz-gui") : installed,
    stamp: join(dirname(installed), ".lz-gui-tree"),
    desktop: join(home, ".local/share/applications/lz.desktop"),
    build: join(home, ".cache/agent-workflow-build/gui"),
  };
}

function prerequisites(platform: NodeJS.Platform): string {
  const rust = platform === "win32"
    ? "Instala Rust: winget install Rustlang.Rustup; luego ejecuta lz update."
    : "Instala Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh; luego ejecuta lz update.";
  if (platform === "darwin") return `${rust} Para las herramientas de Xcode: xcode-select --install.`;
  if (platform === "win32") return `${rust} Instala Microsoft C++ Build Tools: winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"; WebView2: winget install Microsoft.EdgeWebView2Runtime.`;
  return `${rust} En Debian/Ubuntu: sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev build-essential.`;
}

export function installGui(installer: Installer, source: string): void {
  const { options, platform } = installer;
  const paths = guiPaths(installer.home, platform);
  if (options.uninstall) {
    const owned = existsSync(paths.stamp);
    for (const path of [...(owned ? [paths.installed, ...(platform === "linux" ? [paths.desktop] : []), paths.stamp] : []), paths.build]) {
      installer.log(`${options.dryRun ? "dry-run: retirar" : "Retirando GUI:"} ${path}`);
      if (!options.dryRun) rmSync(path, { recursive: true, force: true });
    }
    return;
  }
  if (options.noGui) return;
  const gui = join(source, "agent/lazy-workflow/gui");
  const buildArgs = ["bun", "run", "tauri", "build", ...(platform === "darwin" ? ["--bundles", "app"] : ["--no-bundle"])];
  if (options.dryRun) {
    installer.log(`dry-run: GUI: bun install --frozen-lockfile en ${gui}; CARGO_TARGET_DIR=${paths.build} ${buildArgs.join(" ")}; instalar en ${paths.installed}`);
    return;
  }
  const staged = `${paths.installed}.refresh.${process.pid}`;
  const previous = `${paths.installed}.previous.${process.pid}`;
  try {
    const tree = installer.command(["git", "rev-parse", "HEAD:agent/lazy-workflow/gui"], source, {}, true);
    if (existsSync(paths.executable) && existsSync(paths.stamp) && readFileSync(paths.stamp, "utf8").trim() === tree) {
      installer.log("GUI sin cambios: se omite la compilacion.");
      return;
    }
    if (!installer.binary("cargo") || !installer.binary("rustc")) throw new Error("No se encontraron cargo y rustc en PATH.");
    const owned = existsSync(paths.stamp);
    if (!installer.approve(paths.installed, owned)) return;
    if (platform === "linux" && !installer.approve(paths.desktop, owned)) return;
    const start = performance.now();
    installer.command(["bun", "install", "--frozen-lockfile"], gui);
    installer.command(buildArgs, gui, { CARGO_TARGET_DIR: paths.build });
    const artifact = platform === "darwin" ? join(paths.build, "release/bundle/macos/lz.app") : join(paths.build, "release", platform === "win32" ? "lz-gui.exe" : "lz-gui");
    if (!existsSync(artifact)) throw new Error(`La compilacion no produjo ${artifact}.`);
    mkdirSync(dirname(paths.installed), { recursive: true });
    cpSync(artifact, staged, { recursive: true });
    if (platform !== "darwin" && platform !== "win32") chmodSync(staged, 0o755);
    if (existsSync(paths.installed)) renameSync(paths.installed, previous);
    try { renameSync(staged, paths.installed); }
    catch (error) { if (existsSync(previous)) renameSync(previous, paths.installed); throw error; }
    rmSync(previous, { recursive: true, force: true });
    if (platform === "linux") {
      mkdirSync(dirname(paths.desktop), { recursive: true });
      const escaped = paths.executable.replace(/[\\"`$]/g, "\\$&");
      writeFileSync(paths.desktop, `[Desktop Entry]\nType=Application\nName=lz\nComment=Desktop GUI for agent-workflow\nExec="${escaped}"\nTerminal=false\nCategories=Development;\n`);
    }
    writeFileSync(paths.stamp, `${tree}\n`);
    installer.log(`GUI instalada: ${paths.installed} (compilacion e instalacion: ${((performance.now() - start) / 1000).toFixed(1)} s).`);
  } catch (error) {
    installer.warn(`No se pudo instalar la GUI; la instalacion del CLI y las skills continua. ${error instanceof Error ? error.message : error} ${prerequisites(platform)}`);
  } finally { rmSync(staged, { recursive: true, force: true }); }
}
