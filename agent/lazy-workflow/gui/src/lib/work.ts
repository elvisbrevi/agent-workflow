import type { CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import type { AssignedWork, AssignedWorkItem } from "../../../src/workspace/assigned-work.ts";
import { backend } from "./backend.ts";
import { isDesktop } from "./platform.ts";
import type { HistoryRun } from "./history.ts";

export type WorkItem = AssignedWorkItem & { tracker: AssignedWork["tracker"]; scope: string; repository: string };

export async function readTool<T>(catalog: CommandCatalog, name: string, values: Record<string, string> = {}): Promise<T> {
  const command = catalog.commands.find((command) => command.name === name && command.effect === "read");
  if (!command) throw new Error(`La instalación debe habilitar ${name} para consultar estos datos.`);
  const args = [name, ...Object.entries(values).flatMap(([flag, value]) => [flag, value])];
  if (isDesktop) args.push("--no-log-file");
  const result = await backend.captureLz(args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `No se pudo consultar ${name}.`);
  return JSON.parse(result.stdout) as T;
}

export const repositoryName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export function workPreset(item: WorkItem): { name: string; values: Record<string, string> } {
  const values: Record<string, string> = { "--working-directory": item.repository, "--hu": "", "--ticket": "", "--session": "" };
  if (item.tracker === "github") return { name: "github-issue-info", values: { ...values, "--issue": String(item.id) } };
  if (item.type === "Task" || item.type === "Bug") {
    if (!item.hu) return { name: "ticket-type-info", values: { ...values, "--ticket": String(item.id) } };
    return { name: "code", values: { ...values, "--hu": String(item.hu), "--ticket": String(item.id) } };
  }
  return { name: ["User Story", "Product Backlog Item", "Requirement"].includes(item.type) ? "plan" : "hu-info", values: { ...values, "--hu": String(item.id) } };
}

export function historyLabel(run: HistoryRun): string {
  const ids = [run.context.hu && `HU #${run.context.hu}`, run.context.ticket && `Task #${run.context.ticket}`, run.context.issue && `Issue #${run.context.issue}`].filter(Boolean);
  const action = run.command === "plan" ? "Planificación" : run.command === "code" ? "Implementación" : run.command;
  return `${action}${ids.length ? ` · ${ids.join(" · ")}` : ""}`;
}
