/**
 * Reading what a run printed. The CLI keeps its contract on two streams —
 * operator lines on stderr, the answer on stdout (JSON for the tools) — and a
 * few operator lines carry something the window can act on: the URL of a
 * planning interview, and the run id the CLI points at when a run fails.
 */

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

export type ParsedStdout =
  | { kind: "empty" }
  | { kind: "json"; value: unknown }
  | { kind: "text"; text: string };

/**
 * A tool prints one JSON document; a workflow prints several, plus its markers.
 * Only an output that is one whole document is shown as a tree.
 */
export function parseStdout(lines: readonly string[]): ParsedStdout {
  const text = lines.join("\n").trim();
  if (text.length === 0) return { kind: "empty" };
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return { kind: "json", value: JSON.parse(text) };
    } catch {
      // Several documents or a document plus markers: shown as text.
    }
  }
  return { kind: "text", text };
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
