/** Native tray smoke check. Close other lz windows first; macOS Accessibility is required. */
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

if (process.platform !== "darwin") throw new Error("This native smoke check requires macOS.");
const binary = resolve(process.argv[2] ?? "src-tauri/target/release/bundle/macos/lz.app/Contents/MacOS/lz-gui");
const existing = Bun.spawnSync(["osascript", "-e", 'tell application "System Events" to count (every application process whose name is "lz-gui")']);
if (existing.exitCode !== 0) throw new Error(existing.stderr.toString());
if (existing.stdout.toString().trim() !== "0") throw new Error("Quit the other lz desktop instance before this isolated smoke check.");

const directory = await mkdtemp(join(tmpdir(), "lz-tray-check-"));
// NSStatusItem's Accessibility press does not consistently open menus on macOS.
// Click its reported bounds through the native event API instead.
const clickSource = join(directory, "click.swift");
const clickBinary = join(directory, "click");
await writeFile(clickSource, `import CoreGraphics
import Foundation
let point = CGPoint(x: Double(CommandLine.arguments[1])!, y: Double(CommandLine.arguments[2])!)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
Thread.sleep(forTimeInterval: 0.05)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
`);
const compile = Bun.spawnSync(["swiftc", clickSource, "-o", clickBinary]);
if (compile.exitCode !== 0) { await rm(directory, { recursive: true, force: true }); throw new Error(compile.stderr.toString()); }
const launcher = join(directory, "lz-fixture");
const catalog = {
  schemaVersion: 1, binary: "lz", defaultCli: "codex", agents: [], environment: [], groups: [],
  families: [{ id: "git", title: "Verificación", description: "Synthetic tray check" }],
  commands: [{ name: "tray-check", family: "git", summary: "Synthetic tray check", effect: "read", output: "json", flags: [], groups: [] }],
};
await writeFile(join(directory, "catalog.json"), JSON.stringify(catalog));
await writeFile(launcher, `#!/bin/sh
LZ_TRAY_FIXTURE_DIR=$(dirname "$0")
case "$1" in
  catalog) cat "$LZ_TRAY_FIXTURE_DIR/catalog.json" ;;
  tray-check)
    trap 'echo interrupted > "$LZ_TRAY_FIXTURE_DIR/interrupted"; exit 130' INT
    echo $$ > "$LZ_TRAY_FIXTURE_DIR/run.pid"
    while [ ! -f "$LZ_TRAY_FIXTURE_DIR/finish" ]; do sleep 0.1; done
    printf '{"ok":true}\\n' ;;
  *) printf '{}\\n' ;;
esac
`);
await chmod(launcher, 0o700);
await writeFile(join(directory, "gui.json"), JSON.stringify({
  schemaVersion: 1, lzCommand: launcher, inheritShellEnvironment: false,
  repositories: [], environment: {}, secretEnvironment: [], confirmWrites: false,
}));
const gui = Bun.spawn([binary], {
  env: { ...process.env, LAZY_WORKFLOW_GUI_SETTINGS: join(directory, "gui.json"), LAZY_WORKFLOW_LOG_FILE: join(directory, "runs.jsonl") },
  stdout: Bun.file(join(directory, "gui.log")), stderr: Bun.file(join(directory, "gui.log")),
});

async function ui(body: string): Promise<string> {
  const script = `on run argv
    set expectedPid to item 1 of argv as integer
    tell application "System Events"
      set p to first application process whose unix id is expectedPid
      tell p
        ${body}
      end tell
    end tell
  end run`;
  const result = Bun.spawn(["osascript", "-e", script, String(gui.pid)], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(result.stdout).text();
  const error = await new Response(result.stderr).text();
  if (await result.exited !== 0) throw new Error(error);
  return output.trim();
}

async function until(check: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await Bun.sleep(200);
  }
  throw new Error(`Timed out: ${description}${lastError ? ` (${lastError})` : ""}`);
}

async function openMenu() {
  if (await ui("return exists menu 1 of menu bar item 1 of menu bar 2") === "true") return;
  const point = await ui(`set p to position of menu bar item 1 of menu bar 2
    set s to size of menu bar item 1 of menu bar 2
    return {(item 1 of p) + (item 1 of s) / 2, (item 2 of p) + (item 2 of s) / 2}`);
  const [x, y] = point.split(",").map((value) => Number(value.trim()));
  assert.ok(Number.isFinite(x) && Number.isFinite(y));
  const click = Bun.spawnSync([clickBinary, String(x), String(y)]);
  assert.equal(click.exitCode, 0);
  await until(async () => await ui("return exists menu 1 of menu bar item 1 of menu bar 2") === "true", "tray menu opens");
}
const status = async () => {
  await openMenu();
  return ui(`set textValue to name of menu item 1 of menu 1 of menu bar item 1 of menu bar 2
    key code 53
    return textValue`);
};
const menuClick = async (name: string) => {
  await openMenu();
  return ui(`click menu item "${name}" of menu 1 of menu bar item 1 of menu bar 2`);
};
const buttonClick = (name: string) => ui(`set elements to entire contents of group 1 of window 1
  repeat with el in elements
    if role of el is "AXButton" and name of el is "${name}" then
      perform action "AXPress" of el
      return "clicked"
    end if
  end repeat
  error "Button not found: ${name}"`);

try {
  await until(async () => await status() === "lz está activo", "tray appears");
  await until(async () => await ui(`set frontmost to true
    set elements to entire contents of group 1 of window 1
    repeat with el in elements
      if role of el is "AXDisclosureTriangle" and name of el is "Herramientas avanzadas" then
        perform action "AXPress" of el
        return "clicked"
      end if
    end repeat
    error "Waiting for the frontend"`) === "clicked", "frontend appears");
  await until(async () => await buttonClick("tray-check") === "clicked", "synthetic command appears");
  await until(async () => await buttonClick("Ejecutar") === "clicked", "run button appears");
  await until(async () => (await status()).includes("1 ejecución en curso"), "running count");
  const runPid = Number(await readFile(join(directory, "run.pid"), "utf8"));
  await ui('click (first button whose description is "close button") of window 1');
  await until(async () => await ui("return count of windows") === "0", "close hides the window");
  process.kill(runPid, 0);
  assert.equal((await status()).includes("1 ejecución en curso"), true);
  await menuClick("Abrir lz");
  await until(async () => await ui("return count of windows") === "1", "tray restores the window");
  await menuClick("Ocultar ventana");
  await until(async () => await ui("return count of windows") === "0", "hide menu");
  await menuClick("Abrir lz");
  await until(async () => await ui("return count of windows") === "1", "restore after hide");
  await writeFile(join(directory, "finish"), "");
  await until(async () => await status() === "lz está activo", "completed run resets the count");
  await rm(join(directory, "finish"));
  await buttonClick("Ejecutar");
  await until(async () => (await status()).includes("1 ejecución en curso"), "second running count");
  await menuClick("Salir e interrumpir las ejecuciones");
  await until(async () => gui.exitCode !== null, "explicit quit");
  assert.equal(await gui.exited, 0);
  assert.match(await readFile(join(directory, "interrupted"), "utf8"), /interrupted/);
  console.log("PASS: tray presence, run count, close/hide, restore, completion and interrupt-on-quit.");
} catch (error) {
  console.error(await readFile(join(directory, "gui.log"), "utf8"));
  throw error;
} finally {
  await writeFile(join(directory, "finish"), "");
  if (gui.exitCode === null) {
    try {
      await openMenu();
      await ui("click last menu item of menu 1 of menu bar item 1 of menu bar 2");
    } catch {
      try { process.kill(-Number(await readFile(join(directory, "run.pid"), "utf8")), "SIGINT"); } catch { /* Only the synthetic child may remain. */ }
      gui.kill("SIGTERM");
    }
    await gui.exited;
  }
  await rm(directory, { recursive: true, force: true });
}
