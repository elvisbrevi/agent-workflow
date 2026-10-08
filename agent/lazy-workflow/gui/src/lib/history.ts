/**
 * The run log's records folded into runs for the history view. Every record a
 * run writes carries its `run_id` (ADR-0029): one `run.started`, any number of
 * `event`s, and one `run.finished` — absent while the run is still going or
 * when the process died without writing it.
 */

export interface RunLogRecord {
  readonly run_id: string;
  readonly ts: string;
  readonly severity: "info" | "warn" | "error";
  readonly event: "run.started" | "run.finished" | "event";
  readonly command: string;
  readonly workflow: string;
  readonly provider: string | null;
  readonly cli: string;
  readonly model: string;
  readonly variant: string;
  readonly failure_kind?: string;
  readonly phase?: string;
  readonly checkpoint?: string;
  readonly outcome?: "success" | "failure" | "interrupted";
  readonly exit_code?: number;
  readonly duration_ms?: number;
  readonly session_event?: string;
  readonly reason?: string;
  readonly from_cli?: string;
  readonly context?: {
    readonly issue?: number | null;
    readonly ticket?: number | null;
    readonly hu?: number | null;
    readonly repository?: string | null;
    readonly session_id?: string | null;
    readonly branch?: string | null;
  };
  readonly message: string;
}

export type HistoryOutcome = "success" | "failure" | "interrupted" | "unfinished";

export interface HistoryRun {
  readonly runId: string;
  readonly command: string;
  readonly workflow: string;
  readonly provider: string | null;
  readonly cli: string;
  readonly model: string;
  readonly variant: string;
  readonly startedAt: string;
  readonly outcome: HistoryOutcome;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  /** The identifiers any record named: the issue, HU, ticket, repository, session. */
  readonly context: Record<string, string | number>;
  readonly events: readonly RunLogRecord[];
  readonly warnings: number;
  readonly errors: number;
}

const isRecord = (value: unknown): value is RunLogRecord =>
  typeof value === "object" && value !== null && typeof (value as RunLogRecord).run_id === "string";

/** Newest run first; records of one run keep the order they were written in. */
export function foldRuns(records: readonly unknown[]): HistoryRun[] {
  const byRun = new Map<string, RunLogRecord[]>();
  for (const record of records) {
    if (!isRecord(record)) continue;
    const list = byRun.get(record.run_id);
    if (list) list.push(record);
    else byRun.set(record.run_id, [record]);
  }
  const runs = [...byRun.entries()].map(([runId, list]): HistoryRun => {
    const first = list[0]!;
    const finished = [...list].reverse().find((record) => record.event === "run.finished");
    const context: Record<string, string | number> = {};
    for (const record of list) {
      for (const [key, value] of Object.entries(record.context ?? {})) {
        if (value !== null && value !== undefined && value !== "") context[key] = value;
      }
    }
    return {
      runId,
      command: first.command,
      workflow: first.workflow,
      provider: first.provider,
      cli: first.cli,
      model: first.model,
      variant: first.variant,
      startedAt: first.ts,
      outcome: finished?.outcome ?? "unfinished",
      exitCode: finished?.exit_code ?? null,
      durationMs: finished?.duration_ms ?? null,
      context,
      events: list.filter((record) => record.event === "event"),
      warnings: list.filter((record) => record.severity === "warn").length,
      errors: list.filter((record) => record.severity === "error" && record.event === "event").length,
    };
  });
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return "—";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
