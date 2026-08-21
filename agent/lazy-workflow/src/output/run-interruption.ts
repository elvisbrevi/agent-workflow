/**
 * SIGINT/SIGTERM/uncaughtException/unhandledRejection handlers that turn a run
 * interruption into a record instead of leaving nothing but a checkpoint on
 * disk (ADR-0029). Each handler writes one final `run.finished` record, naming
 * the preserved checkpoint if one exists, and then restores default behavior:
 * a signal is redelivered after the handler steps aside, and an unhandled
 * exception or rejection exits with the same code Bun already exits with when
 * no handler is installed at all. Nothing here changes what happens without it
 * — it only makes sure the run log sees it happen.
 */

import type { FailureKind } from "./failure-kind.ts";
import type { RunLogRecordInput, RunLogSink } from "./run-log.ts";

/** Best-effort, so a probe that itself hangs or throws never blocks the record it is only there to enrich. */
export type InterruptionCheckpointProbe = () => Promise<string | null>;

const CHECKPOINT_PROBE_TIMEOUT_MS = 2000;
/** Bun's own exit code for an uncaught exception or unhandled rejection with no handler installed. */
const UNHANDLED_FAILURE_EXIT_CODE = 1;

export interface InterruptionProcess {
  readonly pid: number;
  on(event: "SIGINT" | "SIGTERM" | "uncaughtException" | "unhandledRejection", listener: (...args: never[]) => void): void;
  removeListener(event: "SIGINT" | "SIGTERM" | "uncaughtException" | "unhandledRejection", listener: (...args: never[]) => void): void;
  kill(pid: number, signal: "SIGINT" | "SIGTERM"): void;
  exit(code: number): never;
}

export interface RegisterInterruptionHandlersOptions {
  runLog: RunLogSink;
  base: Pick<RunLogRecordInput, "command" | "workflow" | "provider" | "cli" | "model" | "variant" | "context">;
  startedAt: number;
  describeCheckpoint: InterruptionCheckpointProbe;
  errorMessage: (error: unknown) => string;
  process?: InterruptionProcess;
}

async function describeCheckpointSafely(probe: InterruptionCheckpointProbe): Promise<string | null> {
  try {
    return await Promise.race([
      probe(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CHECKPOINT_PROBE_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}

/**
 * Registers the four handlers and returns a teardown that removes exactly
 * them, so a run that ends normally leaves the process' own listeners as they
 * were found. A second signal, or a signal racing an exception, is guarded by
 * one `handled` flag set synchronously before anything asynchronous runs, so
 * at most one `run.finished` record is ever written and no path waits on the
 * one already in flight.
 */
export function registerInterruptionHandlers(options: RegisterInterruptionHandlersOptions): () => void {
  const proc = options.process ?? (process as unknown as InterruptionProcess);
  let handled = false;

  const writeFinished = async (failureKind: FailureKind, message: string): Promise<void> => {
    const checkpoint = await describeCheckpointSafely(options.describeCheckpoint);
    try {
      options.runLog.write({
        ...options.base,
        event: "run.finished",
        severity: "error",
        outcome: "interrupted",
        failureKind,
        checkpoint: checkpoint ? "preserved" : null,
        durationMs: Date.now() - options.startedAt,
        message: checkpoint ? `${message} (checkpoint conservado: ${checkpoint})` : message,
      });
    } catch {
      // The interruption record is itself best-effort: it must never become the crash it is recording.
    }
  };

  const onSignal = (signal: "SIGINT" | "SIGTERM", self: (...args: never[]) => void): void => {
    if (handled) return;
    handled = true;
    void writeFinished("run-interrupted-signal", `lazy-workflow interrumpido por ${signal}`).finally(() => {
      proc.removeListener(signal, self);
      proc.kill(proc.pid, signal);
    });
  };

  const onUncaughtException = (error: unknown): void => {
    if (handled) { proc.exit(UNHANDLED_FAILURE_EXIT_CODE); return; }
    handled = true;
    void writeFinished(
      "run-interrupted-failure",
      `lazy-workflow termino por una excepcion no capturada (${options.errorMessage(error)})`,
    ).finally(() => proc.exit(UNHANDLED_FAILURE_EXIT_CODE));
  };

  const onUnhandledRejection = (reason: unknown): void => {
    if (handled) { proc.exit(UNHANDLED_FAILURE_EXIT_CODE); return; }
    handled = true;
    void writeFinished(
      "run-interrupted-failure",
      `lazy-workflow termino por un rechazo de promesa no manejado (${options.errorMessage(reason)})`,
    ).finally(() => proc.exit(UNHANDLED_FAILURE_EXIT_CODE));
  };

  const onSigint = (): void => onSignal("SIGINT", onSigint);
  const onSigterm = (): void => onSignal("SIGTERM", onSigterm);

  proc.on("SIGINT", onSigint);
  proc.on("SIGTERM", onSigterm);
  proc.on("uncaughtException", onUncaughtException as (...args: never[]) => void);
  proc.on("unhandledRejection", onUnhandledRejection as (...args: never[]) => void);

  return () => {
    proc.removeListener("SIGINT", onSigint);
    proc.removeListener("SIGTERM", onSigterm);
    proc.removeListener("uncaughtException", onUncaughtException as (...args: never[]) => void);
    proc.removeListener("unhandledRejection", onUnhandledRejection as (...args: never[]) => void);
  };
}
