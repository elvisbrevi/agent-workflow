/**
 * `update` como comando: mantiene la herramienta, no ejecuta trabajo. Reenvía
 * sus argumentos al instalador — `--all-global` cuando no declara ninguno — y
 * propaga su código de salida sin abrir sesión, reportero ni run log.
 */
import { expect, test } from "bun:test";
import { createCli } from "./_helpers/create-cli.ts";

test("update reenvia los argumentos declarados al instalador", async () => {
  const calls: string[][] = [];
  const code = await createCli({
    runInstaller: async (args) => {
      calls.push(args);
      return 0;
    },
  }).run(["update", "--codex", "--ref", "v1"]);

  expect({ code, calls }).toEqual({ code: 0, calls: [["--codex", "--ref", "v1"]] });
});

test("update sin argumentos reinstala el modo global completo", async () => {
  const calls: string[][] = [];
  const code = await createCli({
    runInstaller: async (args) => {
      calls.push(args);
      return 0;
    },
  }).run(["update"]);

  expect({ code, calls }).toEqual({ code: 0, calls: [["--all-global"]] });
});

test("update propaga el codigo de salida del instalador", async () => {
  const code = await createCli({ runInstaller: async () => 3 }).run(["update"]);

  expect(code).toBe(3);
});
