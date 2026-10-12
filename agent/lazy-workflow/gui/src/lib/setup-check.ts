/**
 * What is missing before Plan or Code can run, read from what the window
 * already knows: the machine diagnostics (binaries on the run PATH, lz's stored
 * variables), which trackers the saved repositories use, and which agent CLIs
 * are installed. Nothing here edits configuration — a problem is either fixed by
 * an `lz setup` session or explained to the operator.
 */
import type { CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import type { AgentModels } from "./models.ts";
import { cliLabel, installedClis } from "./models.ts";
import type { Diagnostics } from "./backend.ts";
import { repositoryName, type Tracker } from "./work.ts";

export interface SetupProblem {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  /** Whether an `lz setup` session can attempt it; without lz or an agent nothing can. */
  readonly fixable: boolean;
}

/** One saved repository as the work read left it: its tracker when the read worked, its error when not. */
export interface RepositoryState {
  readonly repository: string;
  readonly tracker: Tracker | null;
  readonly error: string | null;
}

const AZURE_ORGANIZATION = "LAZY_WORKFLOW_AZURE_ORGANIZATION";

const missingBinary = (diagnostics: Diagnostics | null, binary: string): boolean =>
  diagnostics?.binaries.some((entry) => entry.name === binary && entry.path === null) === true;

/** The agent CLIs that can run: `agent-models` knows; without it, the binaries on the run PATH; without both, all. */
export function availableClis(catalog: CommandCatalog, models: readonly AgentModels[] | null, diagnostics: Diagnostics | null): string[] {
  if (models) return installedClis(catalog, models);
  return catalog.agents.filter((agent) => !missingBinary(diagnostics, agent.binary)).map((agent) => agent.cli);
}

export function setupProblems(input: {
  catalog: CommandCatalog;
  diagnostics: Diagnostics | null;
  models: readonly AgentModels[] | null;
  repositories: readonly RepositoryState[];
  preferredCli: string;
}): SetupProblem[] {
  const { catalog, diagnostics, models, repositories, preferredCli } = input;
  const problems: SetupProblem[] = [];
  if (diagnostics?.lzError) problems.push({ id: "lz", title: "No se encuentra lz", detail: diagnostics.lzError, fixable: false });
  const missing = (binary: string) => missingBinary(diagnostics, binary);
  const agents = availableClis(catalog, models, diagnostics);
  if (agents.length === 0) {
    problems.push({ id: "agents", title: "No hay un agente de código instalado", detail: "Instala y autentica OpenCode, Claude Code o Codex: Plan, Code y la reparación automática lo necesitan.", fixable: false });
  } else if (!agents.includes(preferredCli)) {
    problems.push({ id: `agent-${preferredCli}`, title: `${cliLabel(preferredCli)} no está instalado`, detail: `Es el agente predeterminado; instálalo y autentícalo, o elige ${agents.map(cliLabel).join(" o ")} en Ajustes.`, fixable: true });
  }
  if (diagnostics?.credentialsError) problems.push({ id: "credentials", title: "No se pudo leer la configuración guardada de lz", detail: diagnostics.credentialsError, fixable: true });
  if (missing("git")) problems.push({ id: "git", title: "Falta git", detail: "Plan y Code trabajan sobre repositorios git.", fixable: true });
  const uses = (tracker: Tracker) => repositories.some((repository) => repository.tracker === tracker);
  if (uses("github") && missing("gh")) problems.push({ id: "gh", title: "Falta GitHub CLI (gh)", detail: "Lo usan Plan y Code para leer y publicar issues y pull requests.", fixable: true });
  if (uses("azure") && missing("az")) problems.push({ id: "az", title: "Falta Azure CLI (az)", detail: "Lo usan Plan y Code para leer y actualizar HU y tareas de Azure DevOps.", fixable: true });
  const organization = diagnostics?.variables.find((variable) => variable.name === AZURE_ORGANIZATION);
  if (uses("azure") && organization && !organization.present) {
    problems.push({ id: "azure-organization", title: "Falta la organización de Azure DevOps", detail: `${AZURE_ORGANIZATION} debe ser https://dev.azure.com/<organización>.`, fixable: true });
  }
  for (const { repository, error } of repositories) {
    if (error) problems.push({ id: `read:${repository}`, title: `No se pudo leer el trabajo de ${repositoryName(repository)}`, detail: error, fixable: true });
  }
  return problems;
}

/** The CLI a repair session runs with: the preferred one when installed, else any installed one. */
export function repairCli(catalog: CommandCatalog, models: readonly AgentModels[] | null, diagnostics: Diagnostics | null, preferredCli: string): string | null {
  const installed = availableClis(catalog, models, diagnostics);
  return installed.includes(preferredCli) ? preferredCli : installed[0] ?? null;
}

/** The problems as the repair session reads them: one line each, title and detail. */
export function repairPrompt(problems: readonly SetupProblem[]): string {
  return problems.filter((problem) => problem.fixable).map((problem) => `- ${problem.title}: ${problem.detail}`).join("\n");
}
