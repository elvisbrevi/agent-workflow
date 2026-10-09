import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type GuiLauncher = () => Promise<void>;

export function guiExecutable(env = process.env, platform = process.platform): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return env.LAZY_WORKFLOW_GUI || (platform === "darwin"
    ? join(home, "Applications/lz.app/Contents/MacOS/lz-gui")
    : join(home, ".local/bin", platform === "win32" ? "lz-gui.exe" : "lz-gui"));
}

export async function launchGui(env = process.env, platform = process.platform): Promise<void> {
  const executable = guiExecutable(env, platform);
  if (!existsSync(executable)) throw new Error(`La GUI no esta instalada en ${executable}. Ejecuta lz update; para compilarla necesitas Rust (cargo y rustc) y las bibliotecas de Tauri indicadas en gui/README.md.`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [], { detached: true, stdio: "ignore", env, windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
