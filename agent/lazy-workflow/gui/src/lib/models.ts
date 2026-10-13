/**
 * The agent, model and effort menus. `lz agent-models` says what each installed
 * CLI offers right now; the catalog only knows each CLI's default model and its
 * accepted efforts, which is what the menus fall back to when the list cannot
 * be read (an older lz, a server that does not allow the read, a CLI that fails).
 */
import type { CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import type { AgentModel, AgentModels } from "../../../src/coding-agent/agent-models-schema.ts";

export type { AgentModel, AgentModels };

export const CLI_LABELS: Record<string, string> = { opencode: "OpenCode", claudecode: "Claude Code", codex: "Codex" };
export const cliLabel = (cli: string): string => CLI_LABELS[cli] ?? cli;

const PROVIDER_LABELS: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", "opencode-go": "OpenCode Go", opencode: "OpenCode Zen" };
export const providerLabel = (provider: string): string => PROVIDER_LABELS[provider] ?? provider;

export interface ModelGroup {
  readonly provider: string;
  readonly models: readonly AgentModel[];
}

/** The CLI a form runs: the one it names, else the catalog's default. */
export const cliOf = (catalog: CommandCatalog, cli: string | undefined): string => cli || catalog.defaultCli;

export function defaultModelOf(catalog: CommandCatalog, models: readonly AgentModels[] | null, cli: string): string {
  return models?.find((entry) => entry.cli === cli)?.defaultModel ?? catalog.agents.find((agent) => agent.cli === cli)?.defaultModel ?? "";
}

/**
 * The models of one CLI grouped by provider, in the order the CLI listed them.
 * The default model and the one already chosen are always present, even when
 * the CLI did not list them, so a saved choice never silently disappears.
 */
export function modelGroups(catalog: CommandCatalog, models: readonly AgentModels[] | null, cli: string, current: string): ModelGroup[] {
  const listed = [...(models?.find((entry) => entry.cli === cli)?.models ?? [])];
  const vendor = cli === "claudecode" ? "anthropic" : cli === "codex" ? "openai" : "";
  for (const id of [defaultModelOf(catalog, models, cli), current]) {
    if (id && !listed.some((model) => model.id === id)) {
      const separator = id.indexOf("/");
      listed.push({ id, name: separator > 0 ? id.slice(separator + 1) : id, provider: separator > 0 ? id.slice(0, separator) : vendor, efforts: null, defaultEffort: null });
    }
  }
  const groups = new Map<string, AgentModel[]>();
  for (const model of listed) groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
  return [...groups].map(([provider, entries]) => ({ provider, models: entries }));
}

/**
 * The efforts a model accepts: its own list when the CLI gave one, else the
 * CLI's fixed set from the catalog, else (OpenCode) the usual suggestions.
 */
export function effortChoices(catalog: CommandCatalog, models: readonly AgentModels[] | null, cli: string, model: string): readonly string[] {
  const own = models?.find((entry) => entry.cli === cli)?.models.find((candidate) => candidate.id === model)?.efforts;
  return own ?? catalog.agents.find((agent) => agent.cli === cli)?.efforts ?? ["low", "medium", "high", "max"];
}

/** Whether `--variant` is free-form for this CLI: OpenCode passes it through as a provider variant. */
export const freeEffort = (catalog: CommandCatalog, cli: string): boolean =>
  catalog.agents.find((agent) => agent.cli === cli)?.efforts === null;

/** Which CLIs can run here: installed per `agent-models`, or every one the catalog names when that is unknown. */
export function installedClis(catalog: CommandCatalog, models: readonly AgentModels[] | null): string[] {
  if (!models) return catalog.agents.map((agent) => agent.cli);
  return catalog.agents.map((agent) => agent.cli).filter((cli) => models.find((entry) => entry.cli === cli)?.installed !== false);
}

/** The model and effort last left on each CLI, so going back to its tab finds them again. */
export type AgentMemory = Readonly<Record<string, { readonly model: string; readonly variant: string }>>;

/**
 * Switches a picker to another CLI: remembers what the current one had and
 * restores what the next one had, or its defaults the first time.
 */
export function switchCli(catalog: CommandCatalog, memory: AgentMemory, value: { readonly cli: string; readonly model: string; readonly variant: string }, next: string) {
  const remembered = { ...memory, [cliOf(catalog, value.cli)]: { model: value.model, variant: value.variant } };
  const { model, variant } = remembered[next] ?? { model: "", variant: "" };
  return { memory: remembered, choice: { cli: next === catalog.defaultCli ? "" : next, model, variant } };
}
