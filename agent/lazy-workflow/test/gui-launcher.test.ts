import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { guiExecutable, launchGui } from "../src/system/gui-launcher.ts";
import { createCli } from "./_helpers/create-cli.ts";
import { installerPath } from "../src/system/self-update.ts";

test("gui launches through its boundary without reporter or installer", async () => {
  let launches = 0;
  const cli = createCli({
    openGui: async () => { launches++; },
    runInstaller: async () => { throw new Error("no installer"); },
    createReporterFn: () => { throw new Error("no run reporter"); },
  });
  expect(await cli.run(["gui"])).toBe(0);
  expect(launches).toBe(1);
  expect(await cli.run(["gui", "--verbose"])).toBe(1);
  expect(launches).toBe(1);
});

test("missing GUI returns an actionable Spanish error", async () => {
  const cli = createCli({ openGui: () => launchGui({ HOME: "/missing/gui/home" }, "linux") });
  expect(await cli.run(["gui"])).toBe(1);
  await expect(launchGui({ HOME: "/missing/gui/home" }, "linux")).rejects.toThrow("Ejecuta lz update");
  await expect(launchGui({ HOME: "/missing/gui/home" }, "linux")).rejects.toThrow("cargo y rustc");
});

test("GUI location and binary override match installation on each platform", () => {
  expect(guiExecutable({ HOME: "/home/test" }, "darwin")).toBe("/home/test/Applications/lz.app/Contents/MacOS/lz-gui");
  expect(guiExecutable({ HOME: "/home/test" }, "linux")).toBe("/home/test/.local/bin/lz-gui");
  expect(guiExecutable({ HOME: "/home/test" }, "win32")).toBe("/home/test/.local/bin/lz-gui.exe");
  expect(guiExecutable({ LAZY_WORKFLOW_GUI: "/custom/gui" })).toBe("/custom/gui");
  expect(installerPath()).toEndWith("/installer/main.ts");
});

test.skipIf(process.platform === "win32")("installed GUI and override launch detached children and return before they finish", async () => {
  const root = mkdtempSync(join(tmpdir(), "lz-gui-launch-test-"));
  try {
    for (const override of [false, true]) {
      const marker = join(root, override ? "override-started" : "installed-started");
      const env = { ...process.env, HOME: root, MARKER: marker, ...(override ? { LAZY_WORKFLOW_GUI: join(root, "custom-gui") } : {}) };
      const path = guiExecutable(env, "linux");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '#!/bin/sh\nprintf started > "$MARKER"\nsleep 2\n');
      chmodSync(path, 0o755);
      const start = performance.now();
      expect(await createCli({ openGui: () => launchGui(env, "linux") }).run(["gui"])).toBe(0);
      expect(performance.now() - start).toBeLessThan(900);
      for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++) await Bun.sleep(10);
      expect(readFileSync(marker, "utf8")).toBe("started");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
