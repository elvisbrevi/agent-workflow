import type { CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import { buildArgs } from "./command-line.ts";

export interface UpdateStatus {
  installedCommit: string | null;
  activeRuns: number;
  updating: boolean;
  job: { id: string; status: "queued" | "running" | "succeeded" | "failed"; message: string } | null;
  log: string;
}

/** Maintenance uses the catalog without the workflow's saved agent/repository flags. */
export function prepareUpdate(catalog: CommandCatalog) {
  const command = catalog.commands.find((entry) => entry.name === "update" && entry.effect === "maintenance");
  return command ? { command, args: buildArgs(catalog, command, {}) } : null;
}

export function updateBusy(status: UpdateStatus | null): boolean {
  return status?.updating === true || status?.job?.status === "queued" || status?.job?.status === "running";
}

/** An interrupted start response must never mistake an older result for this update. */
export function matchesPendingUpdate(id: string, pending: string | null): boolean {
  return pending === id || (!!pending?.startsWith("scheduling:") && pending.slice("scheduling:".length) !== id);
}
