/**
 * The run log: one JSON Lines file a metrics or monitoring service tails,
 * carrying a fixed record contract rather than operator prose (ADR-0029).
 *
 * A record splits into low-cardinality labels — flattened at the top level, the
 * axes a dashboard groups by — and a nested `context` for the high-cardinality
 * identifiers a single run carries (an issue, a ticket, a session, a branch).
 * `message` is the human line and is never the thing a dashboard groups by.
 *
 * Writing is best-effort by construction: a full disk, a read-only home, or a
 * path that cannot be created must never change a run's exit code or durable
 * state. `createRunLogSink` disables itself for the remainder of the run on the
 * first write failure instead of retrying a path that will keep failing.
 */

import * as nodeFs from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { FailureKind } from "./failure-kind.ts";

export const RUN_LOG_SCHEMA_VERSION = 1;
export const RUN_LOG_FILENAME = "runs.jsonl";
/** 5 MiB: generous for a laptop, small enough that an unbounded file never becomes the reason logging gets switched off. */
export const DEFAULT_RUN_LOG_MAX_BYTES = 5 * 1024 * 1024;

export type RunLogSeverity = "info" | "warn" | "error";
export type RunLogEventKind = "run.started" | "run.finished" | "event";
export type RunLogOutcome = "success" | "failure" | "interrupted";

/**
 * The closed vocabulary a coding-agent session lifecycle record is labelled
 * with (issue #267): one rung's worth of a run, never the whole run itself,
 * so a dashboard can histogram a session's duration independently of the
 * process that carried it.
 */
export const RUN_LOG_SESSION_EVENTS = [
  "session_started",
  "session_finished",
  "session_failed",
  "terminal_marker_missing",
  "provider_exhausted",
  "fallback_descent",
  "chain_exhausted",
  "chain_retry",
  "session_close_failed",
  "session_not_found",
  "cross_cli_handoff",
] as const;
export type RunLogSessionEvent = typeof RUN_LOG_SESSION_EVENTS[number];

/** High-cardinality identifiers of a single run; never labels (ADR-0029). */
export interface RunLogContext {
  issue?: number | null;
  ticket?: number | null;
  hu?: number | null;
  repository?: string | null;
  sessionId?: string | null;
  branch?: string | null;
  /**
   * A finished session's own stop reason (a Claude Code `result` subtype, an
   * OpenCode `step_finish` reason), passed through verbatim from whichever CLI
   * produced it. Context, not a label (ADR-0029): the vocabulary is the
   * provider's own and not one this repo declares or bounds, unlike
   * `reason`'s closed exhaustion-cause set.
   */
  stopReason?: string | null;
}

/** What a call site knows before the sink stamps `schema_version`, `run_id` and `ts`. */
export interface RunLogRecordInput {
  event: RunLogEventKind;
  severity: RunLogSeverity;
  command: string;
  workflow: string;
  provider: string | null;
  cli: string;
  model: string;
  variant: string;
  failureKind?: FailureKind | null;
  phase?: string | null;
  checkpoint?: "preserved" | null;
  outcome?: RunLogOutcome | null;
  exitCode?: number | null;
  durationMs?: number | null;
  /** Set only on a session-lifecycle record (issue #267); absent on a run-level or failure-kind one. */
  sessionEvent?: RunLogSessionEvent | null;
  /** The closed exhaustion-cause vocabulary this repo already bounds (`rate_limit`, `billing`, `authentication`, `session_limit`) — a label, unlike a finished session's own stop reason, which travels in `context.stopReason` (ADR-0029). */
  reason?: string | null;
  /** Set only on a cross-CLI handoff: the CLI the work yielded from, while `cli` names the one that adopted it. */
  fromCli?: string | null;
  context: RunLogContext;
  /** The human line; deliberately not a label, and never a credential, a prompt or a diff. */
  message: string;
}

export interface RunLogSink {
  write(record: RunLogRecordInput): void;
}

/** The no-op sink `--no-log-file` resolves to, so every call site writes unconditionally. */
export const disabledRunLogSink: RunLogSink = { write(): void {} };

/** `~/.local/state/lazy-workflow/runs.jsonl`, consistent with the `~/.cache/agent-workflow` and `~/.local/bin` paths the installer already uses. */
export function defaultRunLogPath(): string {
  return join(homedir(), ".local", "state", "lazy-workflow", RUN_LOG_FILENAME);
}

export interface RunLogPathOptions {
  logFile: string | null;
  noLogFile: boolean;
}

/** `--log-file`, then `LAZY_WORKFLOW_LOG_FILE`, then the default path; `null` means the sink is disabled. */
export function resolveRunLogPath(options: RunLogPathOptions, env: NodeJS.ProcessEnv = process.env): string | null {
  if (options.noLogFile) return null;
  if (options.logFile) return options.logFile;
  const fromEnv = env["LAZY_WORKFLOW_LOG_FILE"]?.trim();
  if (fromEnv) return fromEnv;
  return defaultRunLogPath();
}

/** The subset of `node:fs` the sink needs, injected so a test drives rotation and failure without touching the real filesystem. */
export type RunLogFs = Pick<
  typeof nodeFs,
  "existsSync" | "mkdirSync" | "statSync" | "renameSync" | "unlinkSync" | "appendFileSync"
>;

export interface RunLogClock {
  now(): Date;
}

export interface CreateRunLogSinkOptions {
  /** `null` (an explicit `--no-log-file`) returns the disabled sink outright. */
  path: string | null;
  maxBytes?: number;
  clock?: RunLogClock;
  runId?: string;
  fs?: RunLogFs;
  /** Called exactly once, on the write that first fails; the sink is disabled from then on. */
  onWriteFailure?: (error: unknown) => void;
}

/** Rotation keeps exactly one previous generation: a file at or over the cap is renamed to `<path>.1`, replacing whichever one was there. */
function rotateIfNeeded(fs: RunLogFs, path: string, maxBytes: number): void {
  if (!fs.existsSync(path)) return;
  if (fs.statSync(path).size < maxBytes) return;
  const previous = `${path}.1`;
  if (fs.existsSync(previous)) fs.unlinkSync(previous);
  fs.renameSync(path, previous);
}

function buildLine(record: RunLogRecordInput, runId: string, ts: Date): Record<string, unknown> {
  const line: Record<string, unknown> = {
    schema_version: RUN_LOG_SCHEMA_VERSION,
    run_id: runId,
    ts: ts.toISOString(),
    severity: record.severity,
    event: record.event,
    command: record.command,
    workflow: record.workflow,
    provider: record.provider,
    cli: record.cli,
    model: record.model,
    variant: record.variant,
  };
  if (record.failureKind != null) line["failure_kind"] = record.failureKind;
  if (record.phase != null) line["phase"] = record.phase;
  if (record.checkpoint != null) line["checkpoint"] = record.checkpoint;
  if (record.outcome != null) line["outcome"] = record.outcome;
  if (record.exitCode != null) line["exit_code"] = record.exitCode;
  if (record.durationMs != null) line["duration_ms"] = record.durationMs;
  if (record.sessionEvent != null) line["session_event"] = record.sessionEvent;
  if (record.reason != null) line["reason"] = record.reason;
  if (record.fromCli != null) line["from_cli"] = record.fromCli;
  line["context"] = {
    issue: record.context.issue ?? null,
    ticket: record.context.ticket ?? null,
    hu: record.context.hu ?? null,
    repository: record.context.repository ?? null,
    session_id: record.context.sessionId ?? null,
    branch: record.context.branch ?? null,
    stop_reason: record.context.stopReason ?? null,
  };
  line["message"] = record.message;
  return line;
}

/**
 * The JSON Lines writer. One `run_id` is minted per sink, so every record a run
 * produces — its `run.started`, its `event`s and its `run.finished` — carries
 * the same identity. A write failure disables the sink for good: the run's exit
 * code, checkpoints and stdout payloads are never touched by what happens here.
 */
export function createRunLogSink(options: CreateRunLogSinkOptions): RunLogSink {
  if (options.path === null) return disabledRunLogSink;

  const path = options.path;
  const maxBytes = options.maxBytes ?? DEFAULT_RUN_LOG_MAX_BYTES;
  const clock = options.clock ?? { now: () => new Date() };
  const fs = options.fs ?? nodeFs;
  const runId = options.runId ?? crypto.randomUUID();
  let disabled = false;

  return {
    write(record) {
      if (disabled) return;
      try {
        const dir = dirname(path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        rotateIfNeeded(fs, path, maxBytes);
        fs.appendFileSync(path, `${JSON.stringify(buildLine(record, runId, clock.now()))}\n`);
      } catch (error) {
        disabled = true;
        options.onWriteFailure?.(error);
      }
    },
  };
}
