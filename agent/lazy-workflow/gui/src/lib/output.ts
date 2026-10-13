/**
 * Reading what a run printed. The CLI keeps its contract on two streams —
 * operator lines on stderr, the answer on stdout (JSON for the tools) — and a
 * few operator lines carry something the window can act on: the URL of a
 * planning interview, and the run id the CLI points at when a run fails.
 */

import { PLAN_READY_MARKER } from "../../../src/prompts/workflow-contract.ts";
import type { AgentResult } from "../../../src/coding-agent/agent-result.ts";
import type { PlanPublication } from "../../../src/azure/plan-publication-service.ts";
import type { GitHubPlanPublication } from "../../../src/github/plan-publication-service.ts";

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** Runs get `NO_COLOR=1`, but a coding agent may still print escapes of its own. */
export function stripAnsi(line: string): string {
  return line.replace(ANSI, "");
}

/** `Responde las preguntas del plan en http://127.0.0.1:PORT/i/TOKEN` and the round announcements. */
const INTERVIEW_URL = /(https?:\/\/(?:\[[0-9a-f:]+\]|[A-Za-z0-9.-]+):\d+\/i\/[A-Za-z0-9_-]+|\/api\/interviews\/[a-f0-9]{64})/i;

export function interviewUrl(lines: readonly string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = INTERVIEW_URL.exec(lines[index]!);
    if (match) return match[1]!;
  }
  return null;
}

/** `revisa el run log para el detalle del fallo: grep <run-id> <path>` */
const RUN_LOG_POINTER = /grep ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) (\S.*)$/i;

export function runLogPointer(lines: readonly string[]): { runId: string; path: string } | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = RUN_LOG_POINTER.exec(lines[index]!);
    if (match) return { runId: match[1]!, path: match[2]!.trim() };
  }
  return null;
}

/** A ticket the session planned, as it handed it to the coordinator behind `PLAN_READY`. */
export interface PlannedTicketView {
  readonly title: string;
  readonly body: string;
  readonly blockedBy: readonly string[];
  readonly estimate: number | null;
}

/** A tracker item a plan published, Azure or GitHub alike. */
export interface PublishedItemView {
  readonly id: number;
  readonly title: string;
  /** Azure's work item type; GitHub has none. */
  readonly type: string | null;
  /** False when publication found the item already there; null when the tracker does not say. */
  readonly created: boolean | null;
}

/** One part of what a run answered, in the shape a person reads it. */
export type ResultPart =
  | {
    readonly kind: "agent";
    /** What the session wrote for a person, without the plan it handed the coordinator. */
    readonly summary: string;
    /** The tickets behind `PLAN_READY`, when the session planned; empty for a plan with nothing to deliver. */
    readonly plan: readonly PlannedTicketView[] | null;
    readonly cost: number | null;
    readonly outputTokens: number | null;
  }
  | {
    readonly kind: "publication";
    readonly tracker: "azure" | "github";
    /** What the items hang from, when they hang from something: `HU 24663`, `épica #12`. */
    readonly parent: string | null;
    readonly items: readonly PublishedItemView[];
    readonly blockingLinks: number;
  }
  | { readonly kind: "text"; readonly text: string };

export interface RunResult {
  readonly parts: readonly ResultPart[];
  /** Every JSON document the run printed, as printed: what "Resultado técnico" shows. */
  readonly documents: readonly unknown[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The coordinator's own outcome lines; the header already names them. */
const OUTCOME_LINES = new Set(["QUEUE_EMPTY", "QUEUE_BLOCKED", "TICKET_COMPLETED", "RECONCILIATION_REQUIRED", "WORKFLOW_STEP_FINISHED"]);

/**
 * The document that opens at `start`, and the line it closes on. The CLI prints
 * each one with `JSON.stringify(value, null, 2)`, so it closes on the first
 * unindented `}` or `]` that makes it parse; a one-line document closes where it
 * opened.
 */
function documentAt(lines: readonly string[], start: number): { value: unknown; end: number } | null {
  for (let end = start; end < lines.length; end += 1) {
    if (end > start && !/^[}\]]/.test(lines[end]!)) continue;
    try {
      return { value: JSON.parse(lines.slice(start, end + 1).join("\n")), end };
    } catch {
      // Not closed yet.
    }
  }
  return null;
}

function plannedTickets(tail: string): PlannedTicketView[] | null {
  const start = tail.indexOf("{");
  if (start < 0) return null;
  try {
    const tickets = (JSON.parse(tail.slice(start).replace(/```[\s\S]*$/, "").trim()) as { tickets?: unknown }).tickets;
    if (!Array.isArray(tickets)) return null;
    return tickets.filter(isRecord).map((ticket) => ({
      title: typeof ticket.title === "string" ? ticket.title : "",
      body: typeof ticket.body === "string" ? ticket.body : "",
      blockedBy: Array.isArray(ticket.blockedBy) ? ticket.blockedBy.filter((title): title is string => typeof title === "string") : [],
      estimate: typeof ticket.estimate === "number" ? ticket.estimate : null,
    }));
  } catch {
    return null;
  }
}

function agentPart(value: Record<string, unknown>): ResultPart | null {
  if (typeof value.text !== "string" || !("sessionId" in value)) return null;
  const result = value as unknown as AgentResult;
  const marker = result.text.lastIndexOf(PLAN_READY_MARKER);
  return {
    kind: "agent",
    summary: (marker >= 0 ? result.text.slice(0, marker) : result.text).trim(),
    plan: marker >= 0 ? plannedTickets(result.text.slice(marker + PLAN_READY_MARKER.length)) : null,
    cost: typeof result.cost === "number" ? result.cost : null,
    outputTokens: typeof result.tokens?.output === "number" ? result.tokens.output : null,
  };
}

function publicationPart(value: Record<string, unknown>): ResultPart | null {
  const links = (entries: unknown): number => Array.isArray(entries) ? entries.length : 0;
  if (typeof value.hu === "number" && Array.isArray(value.tickets) && value.tickets.every((entry) => isRecord(entry) && typeof entry.ticket === "number")) {
    const publication = value as unknown as PlanPublication;
    return {
      kind: "publication",
      tracker: "azure",
      parent: `HU ${publication.hu}`,
      items: publication.tickets.map(({ ticket, title, type, created }) => ({ id: ticket, title, type, created })),
      blockingLinks: links(publication.blockingLinks),
    };
  }
  if (Array.isArray(value.issues) && Array.isArray(value.blockingLinks) && value.issues.every((entry) => isRecord(entry) && typeof entry.issue === "number")) {
    const publication = value as unknown as GitHubPlanPublication;
    return {
      kind: "publication",
      tracker: "github",
      parent: publication.epic ? `épica ${publication.epic.repository ?? ""}#${publication.epic.issue}` : null,
      items: publication.issues.map(({ issue, title }) => ({ id: issue, title, type: null, created: null })),
      blockingLinks: links(publication.blockingLinks),
    };
  }
  return null;
}

/**
 * What a run answered on stdout, read for a person: a session's closing text
 * and the plan it returned, the items a plan published, and any prose — a
 * setup report — as it was written. The JSON documents stay available as
 * printed, and one this reader does not know is shown only there.
 */
export function readResult(lines: readonly string[]): RunResult {
  const parts: ResultPart[] = [];
  const documents: unknown[] = [];
  let prose: string[] = [];
  const flush = () => {
    const text = prose.join("\n").trim();
    if (text) parts.push({ kind: "text", text });
    prose = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const document = /^[{[]/.test(line) ? documentAt(lines, index) : null;
    if (document) {
      flush();
      documents.push(document.value);
      const part = isRecord(document.value) ? agentPart(document.value) ?? publicationPart(document.value) : null;
      if (part) parts.push(part);
      index = document.end;
      continue;
    }
    if (!OUTCOME_LINES.has(line.trim())) prose.push(line);
  }
  flush();
  return { parts, documents };
}

/** The markers a workflow ends on, named for the run header. */
const MARKERS: Record<string, string> = {
  QUEUE_EMPTY: "Cola vacia",
  QUEUE_BLOCKED: "Cola bloqueada",
  TICKET_COMPLETED: "Ticket completado",
  RECONCILIATION_REQUIRED: "Requiere reconciliacion",
};

export function finalMarker(lines: readonly string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const label = MARKERS[lines[index]!.trim()];
    if (label) return label;
  }
  return null;
}

export interface FeedEntry {
  /** `HH:MM:SS` of a stamped line; null for a line the reporter did not stamp. */
  readonly time: string | null;
  readonly level: "info" | "warn" | "error" | "detail";
  readonly text: string;
}

const STAMPED = /^\d\d\/\d\d\/\d\d (\d\d:\d\d:\d\d) │ (\S) ?(.*)$/;
/** The reporter hangs a message's further lines from the gutter: 18 spaces, the gutter, 3 spaces. */
const HANGING = /^ {18}│ {3}(.*)$/;
const LEVELS: Record<string, FeedEntry["level"]> = { "●": "info", "▲": "warn", "✖": "error", "·": "detail", "⋮": "detail" };

/**
 * What a run told its operator, as entries a person reads: the time, the level
 * and the message, with the run's heading panel and the gutters left out. A line
 * the reporter did not stamp (a coding agent's own output) is kept as is.
 */
export function operatorFeed(lines: readonly string[]): FeedEntry[] {
  const entries: Array<{ time: string | null; level: FeedEntry["level"]; text: string }> = [];
  for (const line of lines) {
    if (/^\s*[╭╰]/.test(line) || /^│.*│\s*$/.test(line)) continue;
    const stamped = STAMPED.exec(line);
    if (stamped) {
      entries.push({ time: stamped[1]!, level: LEVELS[stamped[2]!] ?? "info", text: stamped[3]! });
      continue;
    }
    const hanging = HANGING.exec(line);
    if (hanging && entries.length > 0) {
      entries[entries.length - 1]!.text += `\n${hanging[1]}`;
      continue;
    }
    if (line.trim()) entries.push({ time: null, level: "info", text: line.trim() });
  }
  return entries;
}
