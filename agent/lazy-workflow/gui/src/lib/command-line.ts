/**
 * The form values of one command turned into the `lz` argument vector, and the
 * checks a form runs before it lets the operator press Run.
 *
 * The catalog `lz catalog` prints is the only description of the CLI here: a
 * flag is emitted when it has a value, its `requires` are met and the value is
 * not the catalog's own default, so the command a run executes is the shortest
 * one with the same meaning — the one the preview shows and the operator could
 * paste into a terminal. Validation mirrors only what the parser would reject
 * anyway (a missing required flag, a malformed number or commit, two flags that
 * exclude each other); the parser stays the authority and its message reaches
 * the run's output when something gets past these checks.
 */

import type { CatalogCommand, CatalogFlag, CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";

export type FlagValue = string | boolean | readonly string[] | undefined;
export type FlagValues = Record<string, FlagValue>;

export interface FlagIssue {
  readonly flag: string;
  readonly severity: "error" | "warning";
  readonly message: string;
}

/** The command's own flags followed by those of every shared group it accepts, in display order. */
export function applicableFlags(catalog: CommandCatalog, command: CatalogCommand): CatalogFlag[] {
  const groups = command.groups.flatMap((id) => catalog.groups.find((group) => group.id === id)?.flags ?? []);
  return [...command.flags, ...groups];
}

/** Whether a value counts as declared: an empty text, `false` or an empty list do not. */
export function isSet(value: FlagValue): boolean {
  if (value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((entry) => entry.trim().length > 0);
  return true;
}

/** `--hu` is met by any value; `--interview=http` only by that exact one. */
export function requirementMet(requirement: string, values: FlagValues): boolean {
  const [flag, expected] = requirement.split("=", 2) as [string, string | undefined];
  const value = values[flag];
  if (!isSet(value)) return false;
  return expected === undefined || value === expected;
}

/** A conflict names a flag or a `--flag=value`; it applies only when that exact form is declared. */
function declares(form: string, values: FlagValues): boolean {
  return requirementMet(form, values);
}

/** The pairs of declared flags that exclude each other, each pair named once. */
export function conflictsOf(catalog: CommandCatalog, command: CatalogCommand, values: FlagValues): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const flag of applicableFlags(catalog, command)) {
    if (!isSet(values[flag.flag])) continue;
    for (const other of flag.conflicts ?? []) {
      if (!declares(other, values)) continue;
      const key = [flag.flag, other.split("=")[0]!].sort().join(" ");
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([flag.flag, other]);
    }
  }
  return pairs;
}

const sameAsDefault = (flag: CatalogFlag, value: FlagValue): boolean =>
  flag.default !== undefined && typeof value !== "boolean" && !Array.isArray(value) && `${flag.default}` === `${value}`.trim();

/** The arguments after `lz`, command first. Flags whose requirements are unmet are left out, as the form greys them out. */
export function buildArgs(catalog: CommandCatalog, command: CatalogCommand, values: FlagValues): string[] {
  const args = [command.name];
  for (const flag of applicableFlags(catalog, command)) {
    const value = values[flag.flag];
    if (!isSet(value)) continue;
    if (!(flag.requires ?? []).every((requirement) => requirementMet(requirement, values))) continue;
    if (Array.isArray(value)) {
      for (const entry of value) if (entry.trim()) args.push(flag.flag, entry.trim());
      continue;
    }
    if (value === true) {
      args.push(flag.flag);
      continue;
    }
    if (flag.kind === "boolean") continue;
    if (sameAsDefault(flag, value)) continue;
    args.push(flag.flag, `${value}`.trim());
  }
  return args;
}

const INTEGER = /^\d+$/;
const COMMIT = /^[0-9a-f]{40,64}$/i;

/** What keeps the command from running (`error`) or what the run will ignore (`warning`). */
export function validateFlags(catalog: CommandCatalog, command: CatalogCommand, values: FlagValues): FlagIssue[] {
  const issues: FlagIssue[] = [];
  for (const flag of applicableFlags(catalog, command)) {
    const value = values[flag.flag];
    if (!isSet(value)) {
      if (flag.required) issues.push({ flag: flag.flag, severity: "error", message: `Falta ${flag.label} (${flag.flag}).` });
      continue;
    }
    const unmet = (flag.requires ?? []).filter((requirement) => !requirementMet(requirement, values));
    if (unmet.length > 0) {
      issues.push({ flag: flag.flag, severity: "warning", message: `${flag.flag} se ignora sin ${unmet.join(" y ")}.` });
      continue;
    }
    const entries = Array.isArray(value) ? value.filter((entry) => entry.trim()) : typeof value === "string" ? [value.trim()] : [];
    for (const entry of entries) {
      if (flag.kind === "integer" && !INTEGER.test(entry)) {
        issues.push({ flag: flag.flag, severity: "error", message: `${flag.flag} requiere un entero (recibido: ${entry}).` });
      } else if (flag.kind === "number" && !(entry !== "" && Number.isFinite(Number(entry)) && Number(entry) >= 0)) {
        issues.push({ flag: flag.flag, severity: "error", message: `${flag.flag} requiere un numero no negativo (recibido: ${entry}).` });
      } else if (flag.kind === "commit" && !COMMIT.test(entry)) {
        issues.push({ flag: flag.flag, severity: "error", message: `${flag.flag} requiere el nombre de objeto completo del commit.` });
      } else if (flag.kind === "choice" && flag.choices && !flag.choices.includes(entry)) {
        issues.push({ flag: flag.flag, severity: "error", message: `${flag.flag} acepta ${flag.choices.join(", ")}.` });
      }
    }
  }
  for (const [flag, other] of conflictsOf(catalog, command, values)) {
    issues.push({ flag, severity: "error", message: `${flag} y ${other} no pueden combinarse.` });
  }
  return issues;
}

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX quoting for the preview, so the line pastes into Bash or Zsh unchanged. */
export function shellQuote(word: string): string {
  if (word.length > 0 && SAFE_WORD.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

export const MASK = "••••••";

/**
 * The command as the operator would type it, with every secret value masked:
 * the preview is something people copy into tickets and chats.
 */
export function renderCommandLine(catalog: CommandCatalog, command: CatalogCommand, args: readonly string[], binary = "lz"): string {
  const secrets = new Set(applicableFlags(catalog, command).filter((flag) => flag.kind === "secret").map((flag) => flag.flag));
  const words = args.map((word, index) => (index > 0 && secrets.has(args[index - 1]!) && !word.startsWith("--") ? MASK : shellQuote(word)));
  return [binary, ...words].join(" ");
}
