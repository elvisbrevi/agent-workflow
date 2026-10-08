/**
 * El ejecutable entrega su stdout entero por una tubería.
 *
 * Con yargs y ora cargados, el `console.log` de Bun descartaba lo que pasaba de
 * 64 KiB al salir el proceso, y `lz catalog | jq` —o la GUI, que lee por una
 * tubería— recibía medio documento. Un lector que cierra antes de tiempo
 * (`| head -c 1`) sigue siendo silencioso, como lo era con `console.log`.
 *
 * Las tuberías son las de `sh`: las de `Bun.spawn` tienen más búfer y no
 * reproducen el corte.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = Bun.fileURLToPath(new URL("../main.ts", import.meta.url));

test.skipIf(process.platform === "win32")("un documento de mas de 64 KiB llega entero por la tuberia", async () => {
  const child = Bun.spawn(["sh", "-c", 'bun run "$0" catalog | cat', main], { stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(code).toBe(0);
  expect(stdout.length).toBeGreaterThan(64 * 1024);
  expect(JSON.parse(stdout).commands.length).toBeGreaterThan(0);
});

test.skipIf(process.platform === "win32")("un lector que cierra la tuberia antes de tiempo no produce un error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lz-epipe-"));
  try {
    const stderr = join(directory, "stderr");
    const status = join(directory, "status");
    const child = Bun.spawn(["sh", "-c", '{ bun run "$0" catalog 2>"$1"; echo $? >"$2"; } | head -c 1 >/dev/null', main, stderr, status]);
    await child.exited;
    expect({ code: readFileSync(status, "utf8").trim(), stderr: readFileSync(stderr, "utf8") }).toEqual({ code: "0", stderr: "" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
