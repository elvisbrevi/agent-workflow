/**
 * The models each coding agent CLI can run right now, read from the CLI itself
 * rather than from a list written here: `opencode models` prints every
 * provider/model the operator has connected, `codex debug models` prints Codex's
 * own catalog, and Claude Code keeps the catalog it last fetched in its config
 * directory. A front end offers these instead of the single default per CLI the
 * command catalog knows (ADR-0034 keeps that default; this only widens the menu).
 *
 * Read-only and best effort per CLI: one that is missing or fails to answer is
 * reported with its error and its default model, never a reason to fail the
 * others. Efforts are narrowed to the ones the adapter accepts, so a model never
 * offers a `--variant` the parser would reject.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { AGENT_CLI_PROFILES, type AgentCli } from "./agent-cli.ts";
import { resolveAgentBinary } from "./agent-process.ts";
import type { AgentModel, AgentModels } from "./agent-models-schema.ts";

export type { AgentModel, AgentModels };

export interface AgentModelSources {
  which(binary: string): string | null;
  /** Runs a command and answers its stdout, or throws naming why it failed. */
  run(command: readonly string[]): Promise<string>;
  /** The Claude Code catalog documents cached on this machine, as raw JSON text. */
  claudeCatalogs(): Promise<string[]>;
}

/** Claude Code resolves these aliases to the newest model of each family. */
const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;

const narrow = (cli: AgentCli, efforts: readonly string[]): string[] | null => {
  const accepted = AGENT_CLI_PROFILES[cli].efforts;
  const kept = accepted ? efforts.filter((effort) => accepted.includes(effort)) : [...efforts];
  return kept.length > 0 ? kept : null;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** `provider/model` per line, as `opencode models` prints them. */
export function parseOpenCodeModels(output: string): AgentModel[] {
  const seen = new Set<string>();
  const models: AgentModel[] = [];
  for (const line of output.split(/\r?\n/)) {
    const id = line.trim();
    if (!/^[^\s/]+\/\S+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const separator = id.indexOf("/");
    models.push({ id, name: id.slice(separator + 1), provider: id.slice(0, separator), efforts: null, defaultEffort: null });
  }
  return models;
}

/** `codex debug models`: the models Codex lists in its own picker, hidden ones left out. */
export function parseCodexModels(output: string): AgentModel[] {
  const entries = record(JSON.parse(output)).models;
  if (!Array.isArray(entries)) return [];
  const listed = entries.map(record).filter((entry) => text(entry.slug) !== null);
  const visible = listed.filter((entry) => entry.visibility === undefined || entry.visibility === "list");
  return visible.map((entry) => {
    const levels = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels.map((level) => text(record(level).effort)).filter((level): level is string => level !== null)
      : [];
    const efforts = narrow("codex", levels);
    const preferred = text(entry.default_reasoning_level);
    return {
      id: text(entry.slug)!,
      name: text(entry.display_name) ?? text(entry.slug)!,
      provider: "openai",
      efforts,
      defaultEffort: preferred && (efforts ?? []).includes(preferred) ? preferred : null,
    };
  });
}

/**
 * The newest Claude Code catalog cached on this machine: its main models first,
 * then the older ones it keeps under "more models". A document that does not
 * parse is skipped, never fatal — it is a cache the CLI rewrites on its own.
 */
export function parseClaudeCatalogs(documents: readonly string[]): AgentModel[] {
  let newest: { fetchedAt: number; models: unknown[] } | null = null;
  for (const document of documents) {
    try {
      const parsed = record(JSON.parse(document));
      const models = record(record(record(parsed.catalog).config)).models;
      const fetchedAt = typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0;
      if (Array.isArray(models) && (newest === null || fetchedAt > newest.fetchedAt)) newest = { fetchedAt, models };
    } catch {
      // A partially written cache file is the CLI's to replace.
    }
  }
  if (newest === null) return [];
  const entries = newest.models.map(record).filter((entry) => text(entry.id) !== null);
  const ordered = [...entries.filter((entry) => entry.section === "main"), ...entries.filter((entry) => entry.section !== "main")];
  return ordered.map((entry) => {
    const options = record(entry.thinking).effort_options;
    const levels = Array.isArray(options) ? options.map((option) => text(record(option).id)).filter((id): id is string => id !== null) : [];
    return { id: text(entry.id)!, name: text(entry.name) ?? text(entry.id)!, provider: "anthropic", efforts: narrow("claudecode", levels), defaultEffort: null };
  });
}

const claudeAliasModels = (): AgentModel[] =>
  CLAUDE_ALIASES.map((alias) => ({ id: alias, name: `${alias} (último)`, provider: "anthropic", efforts: null, defaultEffort: null }));

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function readModels(cli: AgentCli, sources: AgentModelSources): Promise<AgentModel[]> {
  const binary = AGENT_CLI_PROFILES[cli].binary;
  if (cli === "opencode") {
    // The first call after boot can answer before OpenCode's background service
    // has loaded its providers; one retry is enough for it to settle.
    const first = parseOpenCodeModels(await sources.run([binary, "models"]));
    return first.length > 0 ? first : parseOpenCodeModels(await sources.run([binary, "models"]));
  }
  if (cli === "codex") return parseCodexModels(await sources.run([binary, "debug", "models"]));
  const cached = parseClaudeCatalogs(await sources.claudeCatalogs());
  return cached.length > 0 ? cached : claudeAliasModels();
}

export async function listAgentModels(sources: AgentModelSources = productionAgentModelSources): Promise<AgentModels[]> {
  return Promise.all((Object.keys(AGENT_CLI_PROFILES) as AgentCli[]).map(async (cli): Promise<AgentModels & { cli: AgentCli }> => {
    const { binary, defaultModel } = AGENT_CLI_PROFILES[cli];
    if (sources.which(binary) === null) return { cli, installed: false, defaultModel, models: [], error: `${binary} no esta en el PATH` };
    try {
      return { cli, installed: true, defaultModel, models: await readModels(cli, sources), error: null };
    } catch (error) {
      return { cli, installed: true, defaultModel, models: cli === "claudecode" ? claudeAliasModels() : [], error: errorText(error) };
    }
  }));
}

async function runCommand(command: readonly string[]): Promise<string> {
  const child = Bun.spawn([resolveAgentBinary(command[0]!) ?? command[0]!, ...command.slice(1)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(`${command.join(" ")} fallo (${stderr.trim().split("\n").at(-1) || `exit ${exitCode}`})`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

async function readClaudeCatalogs(): Promise<string[]> {
  const directory = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "cache", "model-catalog");
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return Promise.all(names.map((name) => Bun.file(join(directory, name)).text().catch(() => "")));
}

export const productionAgentModelSources: AgentModelSources = {
  which: resolveAgentBinary,
  run: runCommand,
  claudeCatalogs: readClaudeCatalogs,
};
