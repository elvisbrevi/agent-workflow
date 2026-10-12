/**
 * The operator's assigned work, shaped the way it is acted on: an Azure HU with
 * the tasks of it assigned to them, or a GitHub issue. Grouping only rearranges
 * what `lz work-assigned` answered; which unit `code` delivers stays the
 * coordinator's decision.
 */
import type { CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import type { AssignedWork, AssignedWorkItem } from "../../../src/workspace/assigned-work.ts";
import { backend } from "./backend.ts";
import { isDesktop } from "./platform.ts";
import type { HistoryRun } from "./history.ts";
import { stripAnsi } from "./output.ts";
import { ISSUE_PLAN_PREFIX } from "./run-request.ts";

export type Tracker = AssignedWork["tracker"];
export type WorkItem = AssignedWorkItem & { tracker: Tracker; scope: string; repository: string };

/** The Azure work item types a plan slices and a `code --hu` drains. */
export const STORY_TYPES = ["User Story", "Product Backlog Item", "Requirement"];
export const DELIVERY_TYPES = ["Task", "Bug"];
/** The title prefixes the GitHub queue already reads as an epic or a spec. */
const EPIC_PREFIXES = ["[Epic]", "[Spec]", "Epic:", "Spec:"];

export async function readTool<T>(catalog: CommandCatalog, name: string, values: Record<string, string> = {}): Promise<T> {
  const command = catalog.commands.find((command) => command.name === name && command.effect === "read");
  if (!command) throw new Error(`Este servidor no habilita la consulta ${name}.`);
  const args = [name, ...Object.entries(values).flatMap(([flag, value]) => [flag, value])];
  if (isDesktop) args.push("--no-log-file");
  const result = await backend.captureLz(args);
  if (result.code !== 0) throw new Error(lastLine(result.stderr) || `No se pudo consultar ${name}.`);
  return JSON.parse(result.stdout) as T;
}

/**
 * The CLI ends a failure on its reason; the panel and stamps before it are noise in a card.
 * A reason that wraps continues on gutter lines: its marked first line names it, the rest is detail.
 */
export function lastLine(text: string): string {
  const lines = stripAnsi(text).split("\n")
    .filter((line) => !/^\s*[╭╰]/.test(line) && !line.includes("revisa el run log"));
  const reason = lines.findLast((line) => /│\s*[✖✗⚠]/.test(line));
  return (reason ? [reason] : lines)
    .map((line) => line.replace(/^.*[│✖✗⚠]\s*/, "").replace(/^lazy-workflow:\s*/, "").trim())
    .filter(Boolean).at(-1) ?? "";
}

export const repositoryName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** A server path as a phone shows it: `~` for the home of the account lz runs under. */
export const homePath = (path: string, home: string | null): string =>
  !home ? path : path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;

export const isEpic = (item: Pick<WorkItem, "tracker" | "title">): boolean =>
  item.tracker === "github" && EPIC_PREFIXES.some((prefix) => item.title.startsWith(prefix));

/** What the list shows: an HU with my tasks under it, or an item that stands alone. */
export type WorkEntry =
  | { kind: "hu"; key: string; repository: string; scope: string; hu: number; story: WorkItem | null; tasks: WorkItem[] }
  | { kind: "item"; key: string; repository: string; scope: string; item: WorkItem };

export interface WorkSection {
  readonly key: string;
  readonly tracker: Tracker;
  readonly scope: string;
  readonly repository: string;
  readonly entries: WorkEntry[];
}

/** What `work-assigned` answered for one saved repository, or why it could not. */
export interface RepositoryWork {
  readonly repository: string;
  readonly tracker: Tracker | null;
  readonly scope: string;
  readonly items: readonly WorkItem[];
  readonly truncated: boolean;
  readonly error: string | null;
}

export const entryKey = (tracker: Tracker, scope: string, id: number): string => `${tracker}:${scope}:${id}`;
export const sectionKey = (tracker: Tracker, scope: string): string => `${tracker}:${scope}`;

/**
 * One section per tracker scope (a GitHub repository, an Azure project), in the
 * order the repositories were read, even when nothing in it is assigned: its
 * repository-level runs still apply. Two folders of one Azure project ask the
 * same project; the first one keeps the section and the work.
 */
export function groupWork(results: readonly RepositoryWork[]): WorkSection[] {
  const sections = new Map<string, WorkSection>();
  const stories = new Map<string, Extract<WorkEntry, { kind: "hu" }>>();
  const seen = new Set<string>();
  for (const result of results) {
    if (!result.tracker) continue;
    const key = sectionKey(result.tracker, result.scope);
    let section = sections.get(key);
    if (!section) sections.set(key, section = { key, tracker: result.tracker, scope: result.scope, repository: result.repository, entries: [] });
    const storyOf = (hu: number) => {
      const storyKey = entryKey("azure", section!.scope, hu);
      let story = stories.get(storyKey);
      if (!story) {
        story = { kind: "hu", key: storyKey, repository: section!.repository, scope: section!.scope, hu, story: null, tasks: [] };
        stories.set(storyKey, story);
        section!.entries.push(story);
      }
      return story;
    };
    for (const item of result.items) {
      const itemKey = entryKey(section.tracker, section.scope, item.id);
      if (seen.has(itemKey)) continue;
      seen.add(itemKey);
      if (section.tracker === "azure" && STORY_TYPES.includes(item.type)) storyOf(item.id).story = item;
      else if (section.tracker === "azure" && item.hu !== null && DELIVERY_TYPES.includes(item.type)) storyOf(item.hu).tasks.push(item);
      else section.entries.push({ kind: "item", key: itemKey, repository: section.repository, scope: section.scope, item });
    }
  }
  return [...sections.values()];
}

export function matchesQuery(entry: WorkEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const items = entry.kind === "hu" ? [...(entry.story ? [entry.story] : []), ...entry.tasks] : [entry.item];
  const text = [entry.kind === "hu" ? `#${entry.hu}` : "", ...items.map((item) => `#${item.id} ${item.title} ${item.type} ${item.state}`)].join(" ");
  return text.toLowerCase().includes(needle);
}

/** A child of an HU as `hu-children-info` describes it. */
export interface HuChild {
  readonly id: number;
  readonly type: string;
  readonly state: string;
  readonly title?: string;
}

/** `hu-children-info` answers `{ hu, children }`; an older fixture answered the bare list. */
export function deliveryChildren(answer: unknown): HuChild[] {
  const children = Array.isArray(answer) ? answer : (answer as { children?: unknown } | null)?.children;
  return Array.isArray(children) ? (children as HuChild[]).filter((child) => DELIVERY_TYPES.includes(child.type)) : [];
}

/** The Azure states a delivery is finished in; anything else is still work. */
const DONE_STATES = ["Done", "Closed", "Resolved", "Removed", "Completed", "Cerrado", "Terminado", "Hecho"];
export const isDone = (state: string): boolean => DONE_STATES.some((done) => done.toLowerCase() === state.toLowerCase());

export function progressOf(children: readonly HuChild[]): { done: number; total: number } {
  return { done: children.filter((child) => isDone(child.state)).length, total: children.length };
}

/** `github-issue-list`: the managed queue `code` would drain, and why it skips the rest. */
export interface GitHubQueue {
  readonly managed: number;
  readonly eligible: ReadonlyArray<{ number: number; title: string }>;
  readonly blocked: ReadonlyArray<{ number: number; title: string; reasons: string[] }>;
}

export const QUEUE_REASONS: Record<string, string> = {
  "epic-or-spec": "épica o spec",
  closed: "cerrada",
  assigned: "asignada",
  "has-blocker": "bloqueada",
  "wrong-label": "sin ready-for-agent",
};

const ACTIONS: Record<string, string> = { plan: "Plan", code: "Code", setup: "Configuración" };

/** "Code · HU #50 · Task #51", or the repository when the run names no unit (a GitHub plan or queue). */
export function historyLabel(run: Pick<HistoryRun, "command" | "context">): string {
  const ids = [run.context.hu && `HU #${run.context.hu}`, run.context.ticket && `Task #${run.context.ticket}`, run.context.issue && `Issue #${run.context.issue}`].filter(Boolean);
  const repository = run.command === "setup" ? "" : String(run.context.repository ?? "").split(",")[0]!.trim();
  const scope = ids.length ? ids.join(" · ") : repository ? repositoryName(repository) : "";
  return [ACTIONS[run.command] ?? run.command, scope].filter(Boolean).join(" · ");
}

/** The identifiers a run's own arguments name, in the run log's vocabulary. */
export function argsContext(args: readonly string[]): Record<string, string> {
  const context: Record<string, string> = {};
  for (const [flag, key] of [["--hu", "hu"], ["--ticket", "ticket"], ["--working-directory", "repository"]] as const) {
    const index = args.indexOf(flag);
    if (index >= 0 && args[index + 1]) context[key] = args[index + 1]!;
  }
  const prompt = args[args.indexOf("--prompt") + 1] ?? "";
  const issue = args.includes("--prompt") && prompt.startsWith(ISSUE_PLAN_PREFIX) ? /^\d+/.exec(prompt.slice(ISSUE_PLAN_PREFIX.length))?.[0] : undefined;
  if (issue) context.issue = issue;
  return context;
}

export const runTitle = (command: string, args: readonly string[]): string => historyLabel({ command, context: argsContext(args) });

/** Whether a recorded run worked on this HU, ticket or issue. */
export function runConcerns(run: Pick<HistoryRun, "context">, target: { hu?: number; ticket?: number; issue?: number }): boolean {
  if (target.ticket !== undefined) return Number(run.context.ticket) === target.ticket;
  if (target.hu !== undefined) return Number(run.context.hu) === target.hu;
  return target.issue !== undefined && Number(run.context.issue) === target.issue;
}
