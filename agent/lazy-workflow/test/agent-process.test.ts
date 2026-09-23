import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAgentProcess } from "../src/coding-agent/agent-process.ts";

test.skipIf(process.platform !== "win32")("Windows .cmd agent receives a prompt as one UTF-8 argument", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lazy workflow agent ü "));
  try {
    const entrypoint = join(directory, "capture.ts");
    const launcher = join(directory, "capture.cmd");
    const powershellLauncher = join(directory, "capture.ps1");
    await writeFile(entrypoint, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    await writeFile(launcher, '@echo off\r\nbun run "%~dp0capture.ts" %*\r\nexit /b %errorlevel%\r\n');
    await writeFile(powershellLauncher, '& bun run (Join-Path $PSScriptRoot "capture.ts") @args\nexit $LASTEXITCODE\n');
    const prompt = 'Una instrucción con espacios, "comillas", & y dos líneas\nsegunda línea; %TEMP%; $x; C:\\ruta\\"texto"';
    const argumentsSent = ["--prompt", prompt, "--path", "C:\\folder with space\\", "--empty", ""];
    const child = spawnAgentProcess([launcher, ...argumentsSent], { cwd: directory });
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(error).toBe("");
    expect(JSON.parse(output)).toEqual(argumentsSent);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
