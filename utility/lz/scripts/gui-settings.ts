#!/usr/bin/env bun
/**
 * Reads and edits the lz desktop GUI's settings file, so an agent configures the
 * GUI with the same guarantees the window gives: known keys only, the types the
 * GUI's Rust side deserializes, an atomic write that keeps unknown keys, and no
 * secret ever written to disk.
 *
 *   bun gui-settings.ts path
 *   bun gui-settings.ts show
 *   bun gui-settings.ts get flagDefaults
 *   bun gui-settings.ts set lzCommand /home/me/agent-workflow/agent/lazy-workflow/main.ts
 *   bun gui-settings.ts set environment.LAZY_WORKFLOW_AZURE_ORGANIZATION https://dev.azure.com/acme
 *   bun gui-settings.ts set flagDefaults.--cli claudecode
 *   bun gui-settings.ts set commandDefaults.plan.--interview http
 *   bun gui-settings.ts unset flagDefaults.--cli
 *   bun gui-settings.ts add repositories /home/me/api
 *   bun gui-settings.ts remove secretEnvironment AZURE_DEVOPS_EXT_PAT
 *   bun gui-settings.ts validate
 *
 * The file is `~/.config/lazy-workflow/gui.json` unless LAZY_WORKFLOW_GUI_SETTINGS
 * names another one — the same resolution as the GUI. A value is parsed as JSON
 * when it is valid JSON (`true`, `5`, `["a"]`) and taken as a string otherwise.
 * Exit 0 on success, 1 on a usage or validation error, with the reason on stderr.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Settings = Record<string, Json>;

export const SETTINGS_PATH_ENV = "LAZY_WORKFLOW_GUI_SETTINGS";

/** What the GUI writes for a missing key; mirrors `GuiSettings::default()` in gui/src-tauri/src/settings.rs. */
export const DEFAULTS: Settings = {
  schemaVersion: 1,
  lzCommand: "lz",
  inheritShellEnvironment: true,
  extraPath: [],
  environment: {},
  secretEnvironment: [],
  repositories: [],
  activeRepository: null,
  flagDefaults: {},
  commandDefaults: {},
  confirmWrites: true,
  theme: "system",
};

const LIST_KEYS = new Set(["extraPath", "secretEnvironment", "repositories"]);

/** Never stored in `environment`: the GUI resolves them through `lz credentials-get` (`secretEnvironment`). */
const SECRET_NAMES = new Set(["LAZY_WORKFLOW_OFF_PASSWORD", "AZURE_DEVOPS_EXT_PAT"]);
const SECRET_PATTERN = /(PASSWORD|TOKEN|SECRET|_PAT$|API_KEY)/;

export function settingsPath(env: Record<string, string | undefined> = process.env): string {
  const declared = env[SETTINGS_PATH_ENV];
  return declared && declared.length > 0 ? declared : join(homedir(), ".config", "lazy-workflow", "gui.json");
}

export function readSettings(path: string): Settings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (text.trim() === "") return {};
  const parsed = JSON.parse(text) as Json;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} no contiene un objeto JSON`);
  return parsed;
}

export function writeSettings(path: string, settings: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(temporary, path);
}

const isStringList = (value: Json): boolean => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const isStringMap = (value: Json): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === "string");
const isFlagValue = (value: Json): boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean" || isStringList(value);
const isFlagMap = (value: Json): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value)
  && Object.entries(value).every(([flag, entry]) => flag.startsWith("--") && isFlagValue(entry));

/** The problems that would make the GUI refuse the file, or store what it never should. */
export function problems(settings: Settings): string[] {
  const found: string[] = [];
  const check = (key: string, ok: (value: Json) => boolean, expected: string) => {
    if (key in settings && !ok(settings[key]!)) found.push(`${key} debe ser ${expected}`);
  };
  check("schemaVersion", (value) => typeof value === "number", "un numero");
  check("lzCommand", (value) => typeof value === "string", "un texto");
  check("inheritShellEnvironment", (value) => typeof value === "boolean", "true o false");
  check("confirmWrites", (value) => typeof value === "boolean", "true o false");
  check("theme", (value) => value === "system" || value === "light" || value === "dark", "system, light o dark");
  check("activeRepository", (value) => value === null || typeof value === "string", "un texto o null");
  for (const key of LIST_KEYS) check(key, isStringList, "una lista de textos");
  check("environment", isStringMap, "un objeto de textos");
  check("flagDefaults", isFlagMap, "un objeto { \"--flag\": valor }");
  check("commandDefaults", (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(isFlagMap), "un objeto { comando: { \"--flag\": valor } }");
  const environment = settings["environment"];
  if (isStringMap(environment ?? {})) {
    for (const name of Object.keys((environment ?? {}) as Record<string, string>)) {
      if (SECRET_NAMES.has(name) || SECRET_PATTERN.test(name)) {
        found.push(`environment.${name} parece un secreto: guardalo con \`lz credentials-set --name ${name}\` y agregalo a secretEnvironment`);
      }
    }
  }
  return found;
}

/** `flagDefaults.--cli` → ["flagDefaults", "--cli"]; a flag never contains a dot, an env var name neither. */
const pathOf = (key: string): string[] => key.split(".").filter(Boolean);

function getAt(settings: Settings, path: string[]): Json | undefined {
  let current: Json | undefined = { ...DEFAULTS, ...settings };
  for (const part of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = current[part];
  }
  return current;
}

function setAt(settings: Settings, path: string[], value: Json | undefined): Settings {
  const [head, ...rest] = path;
  if (head === undefined) throw new Error("falta la clave");
  if (!(head in DEFAULTS)) throw new Error(`clave desconocida: ${head} (conocidas: ${Object.keys(DEFAULTS).join(", ")})`);
  const next: Settings = { ...settings };
  if (rest.length === 0) {
    if (value === undefined) delete next[head];
    else next[head] = value;
    return next;
  }
  const container = (next[head] ?? DEFAULTS[head]) as Json;
  if (typeof container !== "object" || container === null || Array.isArray(container)) throw new Error(`${head} no admite claves anidadas`);
  next[head] = setNested({ ...container }, rest, value);
  return next;
}

function setNested(object: Record<string, Json>, path: string[], value: Json | undefined): Record<string, Json> {
  const [head, ...rest] = path as [string, ...string[]];
  if (rest.length === 0) {
    if (value === undefined) delete object[head];
    else object[head] = value;
    return object;
  }
  const child = object[head];
  const container = typeof child === "object" && child !== null && !Array.isArray(child) ? { ...child } : {};
  object[head] = setNested(container, rest, value);
  if (value === undefined && Object.keys(object[head] as object).length === 0) delete object[head];
  return object;
}

function parseValue(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

const USAGE = "uso: gui-settings.ts path | show | validate | get <clave> | set <clave> <valor> | unset <clave> | add <lista> <valor> | remove <lista> <valor>";

export function run(args: string[], env: Record<string, string | undefined> = process.env): { code: number; stdout: string; stderr: string } {
  const path = settingsPath(env);
  const out = (stdout: string) => ({ code: 0, stdout: `${stdout}\n`, stderr: "" });
  const fail = (stderr: string) => ({ code: 1, stdout: "", stderr: `gui-settings: ${stderr}\n` });
  const [command, key, ...rest] = args;
  try {
    const settings = command === "path" ? {} : readSettings(path);
    const save = (next: Settings) => {
      const found = problems(next);
      if (found.length > 0) return fail(found.join("; "));
      writeSettings(path, { schemaVersion: 1, ...next });
      return out(JSON.stringify({ ...DEFAULTS, ...next }, null, 2));
    };
    switch (command) {
      case "path":
        return out(path);
      case "show":
        return out(JSON.stringify({ ...DEFAULTS, ...settings }, null, 2));
      case "validate": {
        const found = problems(settings);
        return found.length > 0 ? fail(found.join("; ")) : out(`ok ${path}`);
      }
      case "get": {
        if (!key) return fail(USAGE);
        const value = getAt(settings, pathOf(key));
        return value === undefined ? fail(`${key} no esta definida`) : out(JSON.stringify(value, null, 2));
      }
      case "set": {
        if (!key || rest.length !== 1) return fail(USAGE);
        return save(setAt(settings, pathOf(key), parseValue(rest[0]!)));
      }
      case "unset": {
        if (!key) return fail(USAGE);
        return save(setAt(settings, pathOf(key), undefined));
      }
      case "add":
      case "remove": {
        if (!key || rest.length !== 1 || !LIST_KEYS.has(key)) return fail(`${command} acepta ${[...LIST_KEYS].join(", ")}; ${USAGE}`);
        const current = ((settings[key] ?? []) as string[]).filter((entry) => entry !== rest[0]);
        const next: Settings = { ...settings, [key]: command === "add" ? [...current, rest[0]!] : current };
        if (key === "repositories" && command === "add" && !next["activeRepository"]) next["activeRepository"] = rest[0]!;
        if (key === "repositories" && command === "remove" && next["activeRepository"] === rest[0]) next["activeRepository"] = (next[key] as string[])[0] ?? null;
        return save(next);
      }
      default:
        return fail(USAGE);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  const result = run(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
