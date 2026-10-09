/** Install one owner's backend and connector on their own machine. No machine-wide services. */
import { chmod, copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { outsideCheckout } from "./web-paths.ts";

export interface ServiceOptions { dataDir: string; backend: string; cloudflared: string; userHome: string; platform: "linux" | "darwin" }
interface Unit { path: string; text: string; label: string }
const marker = "Managed by agent-workflow lz-web";
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const systemdQuote = (value: string, commandArgument = false) => `"${(commandArgument ? value.replaceAll("$", () => "$$") : value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

export function serviceFiles(options: ServiceOptions): Unit[] {
  for (const path of [options.dataDir, options.backend, options.cloudflared, options.userHome]) if (!isAbsolute(path) || /[\r\n\0]/.test(path)) throw new Error("service paths must be absolute and contain no control characters");
  const id = createHash("sha256").update(options.dataDir).digest("hex").slice(0, 12);
  const backend = join(options.dataDir, "bin", "lz-web");
  const tokenFile = join(options.dataDir, "connector.token");
  const logs = join(options.dataDir, "logs");
  const pathValue = [join(options.userHome, ".local/bin"), join(options.userHome, ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const jobs = [
    { kind: "backend", args: [backend, "serve", "--data-dir", options.dataDir] },
    { kind: "connector", args: [options.cloudflared, "tunnel", "--no-autoupdate", "run", "--protocol", "http2", "--token-file", tokenFile] },
  ];
  return jobs.map(({ kind, args }) => {
    if (options.platform === "darwin") {
      const label = `com.elvisbrevi.lz-web.${id}.${kind}`;
      return { label, path: join(options.userHome, "Library/LaunchAgents", `${label}.plist`), text: `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${marker} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(options.dataDir)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(pathValue)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>5</integer><key>ExitTimeOut</key><integer>15</integer>
<key>ProcessType</key><string>Background</string><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(logs, `${kind}.out.log`))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, `${kind}.err.log`))}</string>
</dict></plist>
` };
    }
    const label = `lz-web-${id}-${kind}.service`;
    return { label, path: join(options.userHome, ".config/systemd/user", label), text: `# ${marker}
[Unit]
Description=agent-workflow lz web ${kind}
${kind === "connector" ? `After=lz-web-${id}-backend.service\nWants=lz-web-${id}-backend.service\n` : ""}
[Service]
Type=simple
WorkingDirectory=${systemdQuote(options.dataDir)}
ExecStart=${args.map((arg) => systemdQuote(arg, true)).join(" ")}
Environment=${systemdQuote(`PATH=${pathValue}`)}
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
KillSignal=SIGTERM
KillMode=control-group
UMask=0077
NoNewPrivileges=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
` };
  });
}

async function exists(path: string) { try { await readFile(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
async function atomicFile(path: string, text: string) { const temporary = `${path}.next`; await writeFile(temporary, text, { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, path); }
async function run(args: string[]) {
  const result = Bun.spawnSync(args, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed with exit code ${result.exitCode}`);
}
async function main() {
  const args = process.argv.slice(2); const options = new Map<string, string>(); let install = false; let start = false;
  while (args.length) {
    const flag = args.shift()!;
    if (flag === "--install") { install = true; continue; }
    if (flag === "--start") { start = true; continue; }
    if (!["--data-dir", "--backend", "--frontend", "--cloudflared"].includes(flag) || !args[0] || options.has(flag)) throw new Error("usage: bun scripts/install-web-services.ts --data-dir <absolute-path> --backend <compiled-lz-web> --cloudflared <absolute-path> [--frontend <built-assets>] [--install] [--start]");
    options.set(flag, args.shift()!);
  }
  if (start && !install) throw new Error("--start requires --install");
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("web services support macOS LaunchAgents and Linux systemd");
  const dataDir = options.get("--data-dir"); const backend = options.get("--backend"); const cloudflared = options.get("--cloudflared");
  if (!dataDir || !backend || !cloudflared) throw new Error("data directory and both executable paths are required");
  await outsideCheckout(dataDir);
  const config = JSON.parse(await readFile(join(dataDir, "web.json"), "utf8")) as { frontendDir: string };
  const frontendSource = options.get("--frontend") ?? config.frontendDir;
  if (!isAbsolute(frontendSource) || !await exists(join(frontendSource, "index.html"))) throw new Error("build the frontend before installing services");
  if (!await exists(join(dataDir, "connector.token"))) throw new Error("provision the project tunnel first; the connector needs its own token file");
  const units = serviceFiles({ dataDir, backend, cloudflared, userHome: homedir(), platform: process.platform });
  for (const unit of units) if (await exists(unit.path) && !(await readFile(unit.path, "utf8")).includes(marker)) throw new Error(`unrelated service preserved: ${unit.path}`);
  const binaryTarget = join(dataDir, "bin/lz-web"); const frontendTarget = join(dataDir, "frontend");
  if ((await exists(binaryTarget) || await exists(join(frontendTarget, "index.html"))) && !await exists(join(dataDir, "service.json"))) throw new Error("unmanaged binary/assets are preserved; use a new installation directory");
  console.log(JSON.stringify({ mode: install ? "install" : "read-only plan", files: units.map((unit) => unit.path), backend: binaryTarget, frontend: frontendTarget, connectorCredentials: join(dataDir, "connector.token"), start }, null, 2));
  if (!install) return;
  if (await exists(join(dataDir, "service.json"))) {
    const current = JSON.parse(await readFile(join(dataDir, "service.json"), "utf8")) as { units: Array<{ path: string; label: string; sha256?: string }> };
    for (const unit of current.units) if (unit.sha256 && await exists(unit.path) && createHash("sha256").update(await readFile(unit.path)).digest("hex") !== unit.sha256) throw new Error(`manually edited service preserved: ${unit.path}`);
    for (const unit of current.units) {
      if (!units.some((next) => next.path === unit.path && next.label === unit.label)) throw new Error("installation metadata belongs to different services");
      if (process.platform === "linux") await run(["systemctl", "--user", "stop", unit.label]);
      else { const result = Bun.spawnSync(["launchctl", "bootout", `gui/${process.getuid!()}/${unit.label}`]); if (result.exitCode !== 0 && result.exitCode !== 3 && result.exitCode !== 113) throw new Error("could not stop the existing launch agent"); }
    }
  }
  await mkdir(join(dataDir, "bin"), { recursive: true, mode: 0o700 });
  await mkdir(join(dataDir, "logs"), { recursive: true, mode: 0o700 });
  await copyFile(backend, `${binaryTarget}.next`); await chmod(`${binaryTarget}.next`, 0o700); await rename(`${binaryTarget}.next`, binaryTarget);
  if (frontendSource !== frontendTarget) {
    await rm(`${frontendTarget}.next`, { recursive: true, force: true });
    await cp(frontendSource, `${frontendTarget}.next`, { recursive: true });
    await rm(frontendTarget, { recursive: true, force: true }); await rename(`${frontendTarget}.next`, frontendTarget);
  }
  await chmod(join(dataDir, "connector.token"), 0o600);
  for (const unit of units) { await mkdir(dirname(unit.path), { recursive: true }); await atomicFile(unit.path, unit.text); }
  await atomicFile(join(dataDir, "web.json"), JSON.stringify({ ...config, frontendDir: frontendTarget }, null, 2));
  await atomicFile(join(dataDir, "service.json"), JSON.stringify({ managedBy: marker, units: units.map(({ path, label, text }) => ({ path, label, sha256: createHash("sha256").update(text).digest("hex") })) }, null, 2));
  if (start) {
    if (process.platform === "linux") { await run(["systemctl", "--user", "daemon-reload"]); for (const unit of units) await run(["systemctl", "--user", "enable", "--now", unit.label]); }
    else for (const unit of units) { await run(["plutil", "-lint", unit.path]); await run(["launchctl", "bootstrap", `gui/${process.getuid!()}`, unit.path]); }
  }
  console.log(`Service files installed${start ? " and service manager start succeeded" : "; services have not been started"}. Public HTTPS still needs verification.`);
}
if (import.meta.main) main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "service installation failed"); process.exitCode = 1; });
