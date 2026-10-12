/**
 * `agent-models` lee los modelos de cada CLI en vez de una lista escrita aquí,
 * y `setup` abre una sola sesión bajo su propia autoridad. Las fuentes se
 * inyectan: ningún test depende de lo que tenga instalado la máquina.
 */
import { expect, test } from "bun:test";
import { listAgentModels, parseClaudeCatalogs, parseCodexModels, parseOpenCodeModels, type AgentModelSources } from "../src/coding-agent/agent-models.ts";
import { runDeterministicTool, type DeterministicToolServices } from "../src/cli/deterministic-tools.ts";
import { AgentResult } from "../src/coding-agent/agent-result.ts";
import type { AgentRunOptions } from "../src/coding-agent/coding-agent.ts";
import { createCli } from "./_helpers/create-cli.ts";
import { buildCli } from "../src/cli/parse-cli-options.ts";

const codexCatalog = JSON.stringify({
  models: [
    { slug: "gpt-new", display_name: "GPT New", visibility: "list", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "ultra" }] },
    { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide", supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "gpt-old", visibility: "list", default_reasoning_level: "ultra", supported_reasoning_levels: [{ effort: "ultra" }] },
  ],
});

const claudeCatalog = (fetchedAt: number, models: unknown[]) => JSON.stringify({ version: 2, fetchedAt, catalog: { config: { models } } });

test("OpenCode: cada provider/model una vez, con su proveedor y esfuerzo libre", () => {
  expect(parseOpenCodeModels("deepseek/v4-pro\nopencode-go/kimi\n\nruido sin barra\ndeepseek/v4-pro\n")).toEqual([
    { id: "deepseek/v4-pro", name: "v4-pro", provider: "deepseek", efforts: null, defaultEffort: null },
    { id: "opencode-go/kimi", name: "kimi", provider: "opencode-go", efforts: null, defaultEffort: null },
  ]);
});

test("Codex: solo los modelos listados, con los esfuerzos que --variant acepta", () => {
  expect(parseCodexModels(codexCatalog)).toEqual([
    { id: "gpt-new", name: "GPT New", provider: "openai", efforts: ["low", "medium"], defaultEffort: "medium" },
    // Un esfuerzo que lz rechaza no se ofrece, ni como default.
    { id: "gpt-old", name: "gpt-old", provider: "openai", efforts: null, defaultEffort: null },
  ]);
});

test("Claude Code: el catalogo mas reciente, los principales primero; uno roto se ignora", () => {
  const older = claudeCatalog(1, [{ id: "claude-old", name: "Old", section: "main" }]);
  const newer = claudeCatalog(2, [
    { id: "claude-legacy", name: "Legacy", section: "overflow" },
    { id: "claude-main", name: "Main", section: "main", thinking: { effort_options: [{ id: "low" }, { id: "max" }, { id: "turbo" }] } },
  ]);
  expect(parseClaudeCatalogs([older, "{roto", newer])).toEqual([
    { id: "claude-main", name: "Main", provider: "anthropic", efforts: ["low", "max"], defaultEffort: null },
    { id: "claude-legacy", name: "Legacy", provider: "anthropic", efforts: null, defaultEffort: null },
  ]);
  expect(parseClaudeCatalogs(["{roto"])).toEqual([]);
});

test("un servicio de OpenCode en frio tiene tiempo de cargar antes de darse por vacio", async () => {
  const waits: number[] = [];
  let calls = 0;
  const sources: AgentModelSources = {
    which: (binary) => (binary === "opencode" ? "/bin/opencode" : null),
    run: async () => (++calls < 3 ? "" : "opencode-go/kimi\n"),
    claudeCatalogs: async () => [],
    wait: async (milliseconds) => { waits.push(milliseconds); },
  };
  const opencode = (await listAgentModels(sources)).find((entry) => entry.cli === "opencode")!;
  expect(opencode.models.map((model) => model.id)).toEqual(["opencode-go/kimi"]);
  expect(waits).toEqual([1000, 2000]);
  // Still empty after the last wait: an empty list is the answer, not an error.
  calls = -10;
  waits.length = 0;
  expect((await listAgentModels(sources)).find((entry) => entry.cli === "opencode")).toMatchObject({ models: [], error: null });
  expect(waits).toEqual([1000, 2000]);
});

test("un CLI ausente o que falla se informa sin tumbar a los demas", async () => {
  const commands: string[][] = [];
  const sources: AgentModelSources = {
    which: (binary) => (binary === "claude" ? null : `/bin/${binary}`),
    run: async (command) => {
      commands.push([...command]);
      if (command[0] === "codex") throw new Error("codex debug models fallo (sin login)");
      // La primera respuesta llega vacía mientras el servicio de OpenCode arranca.
      return commands.filter((entry) => entry[0] === "opencode").length === 1 ? "" : "opencode-go/kimi\n";
    },
    claudeCatalogs: async () => [],
    wait: async () => undefined,
  };
  const listed = await listAgentModels(sources);
  expect(listed.map(({ cli, installed, error, models }) => ({ cli, installed, error, models: models.map((model) => model.id) }))).toEqual([
    { cli: "opencode", installed: true, error: null, models: ["opencode-go/kimi"] },
    { cli: "claudecode", installed: false, error: "claude no esta en el PATH", models: [] },
    { cli: "codex", installed: true, error: "codex debug models fallo (sin login)", models: [] },
  ]);
  expect(listed.every((entry) => entry.defaultModel.length > 0)).toBe(true);
});

test("Claude Code sin catalogo en cache ofrece sus alias", async () => {
  const listed = await listAgentModels({ which: () => "/bin/x", run: async () => "", claudeCatalogs: async () => [], wait: async () => undefined });
  expect(listed.find((entry) => entry.cli === "claudecode")!.models.map((model) => model.id)).toEqual(["fable", "opus", "sonnet", "haiku"]);
});

test("lz agent-models imprime lo que la frontera respondio", async () => {
  const printed: string[] = [];
  const services = { agentModels: async () => [{ cli: "codex", installed: true, defaultModel: "gpt-new", models: [], error: null }] } as unknown as DeterministicToolServices;
  const parsed = buildCli(() => true)(["agent-models"], { onHelp: () => 0, onError: () => 1 });
  if (parsed.kind !== "options") throw new Error("agent-models debe parsear sin opciones");
  expect(await runDeterministicTool("agent-models", parsed.options, services, (line) => printed.push(line))).toBe(0);
  expect(JSON.parse(printed.join("\n"))[0].defaultModel).toBe("gpt-new");
});

test("lz setup abre una sola sesion bajo lazy-setup con los problemas nombrados", async () => {
  const runs: AgentRunOptions[] = [];
  const agent = {
    run: async (options: AgentRunOptions) => {
      runs.push(options);
      return { result: new AgentResult({ sessionId: "ses_setup", text: "✓ gh autenticado" }), azureLoginRequired: false, failed: false };
    },
    resume: async () => { throw new Error("setup no reanuda sesiones"); },
  };
  const output: string[] = [];
  const log = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));
  try {
    const exit = await createCli({ agentSource: agent, cliParser: buildCli(() => true) })
      .run(["setup", "--cli", "claudecode", "--working-directory", "/repo", "--prompt", "gh no esta autenticado", "--no-log-file"]);
    expect(exit).toBe(0);
  } finally {
    console.log = log;
  }
  expect(runs).toHaveLength(1);
  expect(runs[0]!.agent?.profile).toBe("lazy-setup");
  expect(runs[0]!.agent?.configPath.endsWith("claudecode/lazy-setup.json")).toBe(true);
  expect(runs[0]!.workingDirectory).toBe("/repo");
  expect(runs[0]!.prompt).toContain("gh no esta autenticado");
  expect(runs[0]!.prompt).toContain("Never print, echo, or write a secret value");
  expect(output).toContain("✓ gh autenticado");
});
