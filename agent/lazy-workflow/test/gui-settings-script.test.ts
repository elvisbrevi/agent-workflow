/**
 * El helper de la skill `lz` que edita la configuración de la GUI escribe el
 * mismo archivo que la ventana lee. Estas pruebas fijan que conozca exactamente
 * los campos del `GuiSettings` de Rust, que conserve las claves que no conoce,
 * que rechace tipos que la GUI no podría leer y que nunca guarde un secreto.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, run, SETTINGS_PATH_ENV } from "../../../utility/lz/scripts/gui-settings.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function settingsFile(content?: string): { env: Record<string, string>; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "lz-gui-settings-"));
  directories.push(directory);
  const path = join(directory, "nested", "gui.json");
  if (content !== undefined) {
    mkdirSync(join(directory, "nested"), { recursive: true });
    writeFileSync(path, content);
  }
  return { env: { [SETTINGS_PATH_ENV]: path }, path };
}

const saved = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("conoce exactamente los campos que la GUI deserializa", async () => {
  const rust = await Bun.file(new URL("../gui/src-tauri/src/settings.rs", import.meta.url)).text();
  const struct = rust.slice(rust.indexOf("pub struct GuiSettings"), rust.indexOf("impl Default for GuiSettings"));
  const fields = [...struct.matchAll(/^\s+pub (\w+):/gm)]
    .map((match) => match[1]!)
    .filter((field) => field !== "extra")
    .map((field) => field.replace(/_(\w)/g, (_, letter: string) => letter.toUpperCase()));
  expect(fields.sort()).toEqual(Object.keys(DEFAULTS).sort());
});

test("set crea el archivo, anida claves de flags y variables, y conserva las desconocidas", () => {
  const { env, path } = settingsFile(JSON.stringify({ futureKey: { a: 1 } }));
  expect(run(["set", "flagDefaults.--cli", "claudecode"], env).code).toBe(0);
  expect(run(["set", "commandDefaults.plan.--interview", "http"], env).code).toBe(0);
  expect(run(["set", "environment.LAZY_WORKFLOW_AZURE_ORGANIZATION", "https://dev.azure.com/acme"], env).code).toBe(0);
  expect(run(["set", "confirmWrites", "false"], env).code).toBe(0);
  expect(saved(path)).toEqual({
    schemaVersion: 1,
    futureKey: { a: 1 },
    flagDefaults: { "--cli": "claudecode" },
    commandDefaults: { plan: { "--interview": "http" } },
    environment: { LAZY_WORKFLOW_AZURE_ORGANIZATION: "https://dev.azure.com/acme" },
    confirmWrites: false,
  });
  expect(JSON.parse(run(["get", "commandDefaults.plan"], env).stdout)).toEqual({ "--interview": "http" });
  expect(JSON.parse(run(["get", "theme"], env).stdout)).toBe("system");
});

test("unset quita la clave y el contenedor que queda vacio", () => {
  const { env, path } = settingsFile();
  run(["set", "commandDefaults.code.--verbose", "true"], env);
  expect(run(["unset", "commandDefaults.code.--verbose"], env).code).toBe(0);
  expect(saved(path).commandDefaults).toEqual({});
});

test("add y remove mantienen las listas sin duplicados y el repositorio activo valido", () => {
  const { env, path } = settingsFile();
  run(["add", "repositories", "/repo/api"], env);
  run(["add", "repositories", "/repo/web"], env);
  run(["add", "repositories", "/repo/api"], env);
  expect(saved(path)).toMatchObject({ repositories: ["/repo/web", "/repo/api"], activeRepository: "/repo/api" });
  run(["remove", "repositories", "/repo/api"], env);
  expect(saved(path)).toMatchObject({ repositories: ["/repo/web"], activeRepository: "/repo/web" });
  expect(run(["add", "theme", "dark"], env).code).toBe(1);
});

test("rechaza lo que la GUI no podria leer y lo que nunca debe guardar", () => {
  const { env, path } = settingsFile();
  expect(run(["set", "theme", "blue"], env).stderr).toContain("theme debe ser");
  expect(run(["set", "flagDefaults.cli", "codex"], env).stderr).toContain("flagDefaults debe ser");
  expect(run(["set", "unknownKey", "1"], env).stderr).toContain("clave desconocida");
  const secret = run(["set", "environment.AZURE_DEVOPS_EXT_PAT", "abc"], env);
  expect(secret.code).toBe(1);
  expect(secret.stderr).toContain("lz credentials-set --name AZURE_DEVOPS_EXT_PAT");
  expect(() => readFileSync(path)).toThrow();
});

test("validate senala un archivo escrito a mano con tipos incorrectos", () => {
  const { env } = settingsFile(JSON.stringify({ repositories: "/repo", environment: { GITHUB_TOKEN: "x" } }));
  const result = run(["validate"], env);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("repositories debe ser una lista de textos");
  expect(result.stderr).toContain("environment.GITHUB_TOKEN parece un secreto");
});
