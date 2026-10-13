/**
 * What Planificar lists: the work a plan slices, read at the tracker with
 * `lz work-plannable` rather than in a saved repository (ADR-0049). Pure, so
 * the list and its targets are tested without a window.
 */
import type { PlannableItem, PlannableWork, RemoteRepository } from "../../../src/workspace/plannable-work.ts";
import type { RunTarget } from "./run-request.ts";

export type { PlannableItem, PlannableWork, RemoteRepository };
export type PlanTracker = PlannableWork["tracker"];

export const TRACKER_LABELS: Record<PlanTracker, string> = { azure: "Azure DevOps", github: "GitHub" };

/** "HU #50", "Bug #70", or "owner/repo #12" for an epic. */
export function itemLabel(item: PlannableItem, tracker: PlanTracker): string {
  if (tracker === "github") return `${item.scope} #${item.id}`;
  return `${item.type === "Bug" ? "Bug" : "HU"} #${item.id}`;
}

/** The plan target of an item: an HU or Bug with `--hu`, an epic with `--issue`. Neither was read in a saved folder. */
export function plannableTarget(item: PlannableItem, tracker: PlanTracker): RunTarget {
  return tracker === "azure"
    ? { kind: "azure-hu", repository: null, hu: item.id, title: item.title, bug: item.type === "Bug", project: item.scope }
    : { kind: "github-epic", repository: null, nameWithOwner: item.scope, issue: item.id, title: item.title, url: item.url };
}

export function matchesPlannable(item: PlannableItem, query: string, scope: string): boolean {
  if (scope && item.scope !== scope) return false;
  const needle = query.trim().toLowerCase();
  return !needle || `#${item.id} ${item.title} ${item.type} ${item.state} ${item.scope}`.toLowerCase().includes(needle);
}

/** The projects or repositories in a listing, for its filter. */
export const scopesOf = (items: readonly PlannableItem[]): string[] => [...new Set(items.map((item) => item.scope))].sort((left, right) => left.localeCompare(right));
