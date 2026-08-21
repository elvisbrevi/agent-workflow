import { describe, expect, test } from "bun:test";
import { registerInterruptionHandlers, type InterruptionProcess } from "../src/output/run-interruption.ts";
import type { RunLogRecordInput, RunLogSink } from "../src/output/run-log.ts";

const base: Parameters<typeof registerInterruptionHandlers>[0]["base"] = {
  command: "code",
  workflow: "code",
  provider: "github",
  cli: "claudecode",
  model: "claude-sonnet-5",
  variant: "high",
  context: { issue: 266, ticket: null, hu: null, repository: "/repo", sessionId: "session-1", branch: "issue/266" },
};

/** A minimal, in-memory stand-in for `process`: real enough to drive the handlers, with no signal ever touching the test runner itself. */
class FakeProcess implements InterruptionProcess {
  readonly pid = 4242;
  readonly listeners = new Map<string, Set<(...args: never[]) => void>>();
  readonly killed: Array<{ pid: number; signal: string }> = [];
  readonly exitCodes: number[] = [];

  on(event: string, listener: (...args: never[]) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }

  removeListener(event: string, listener: (...args: never[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  kill(pid: number, signal: "SIGINT" | "SIGTERM"): void {
    this.killed.push({ pid, signal });
  }

  exit(code: number): never {
    this.exitCodes.push(code);
    return undefined as never;
  }

  emit(event: "SIGINT" | "SIGTERM" | "uncaughtException" | "unhandledRejection", ...args: never[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class RecordingRunLogSink implements RunLogSink {
  readonly records: RunLogRecordInput[] = [];
  write(record: RunLogRecordInput): void {
    this.records.push(record);
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("registerInterruptionHandlers", () => {
  test("SIGINT escribe un run.finished interrumpido y luego reenvia la senal por defecto", async () => {
    const proc = new FakeProcess();
    const runLog = new RecordingRunLogSink();
    registerInterruptionHandlers({
      runLog,
      base,
      startedAt: Date.now(),
      describeCheckpoint: async () => null,
      errorMessage: (error) => String(error),
      process: proc,
    });

    proc.emit("SIGINT");
    await flush();

    expect(runLog.records).toHaveLength(1);
    expect(runLog.records[0]).toMatchObject({
      event: "run.finished",
      outcome: "interrupted",
      failureKind: "run-interrupted-signal",
      checkpoint: null,
    });
    expect(proc.killed).toEqual([{ pid: proc.pid, signal: "SIGINT" }]);
    expect(proc.listenerCount("SIGINT")).toBe(0);
  });

  test("un checkpoint preservado queda nombrado en el mensaje y en el campo checkpoint", async () => {
    const proc = new FakeProcess();
    const runLog = new RecordingRunLogSink();
    registerInterruptionHandlers({
      runLog,
      base,
      startedAt: Date.now(),
      describeCheckpoint: async () => "github issue 266 (phase implementing)",
      errorMessage: (error) => String(error),
      process: proc,
    });

    proc.emit("SIGTERM");
    await flush();

    expect(runLog.records).toHaveLength(1);
    expect(runLog.records[0]?.checkpoint).toBe("preserved");
    expect(runLog.records[0]?.message).toContain("github issue 266 (phase implementing)");
  });

  test("una senal repetida o concurrente no produce un segundo run.finished ni cuelga el proceso", async () => {
    const proc = new FakeProcess();
    const runLog = new RecordingRunLogSink();
    registerInterruptionHandlers({
      runLog,
      base,
      startedAt: Date.now(),
      describeCheckpoint: async () => null,
      errorMessage: (error) => String(error),
      process: proc,
    });

    proc.emit("SIGINT");
    proc.emit("SIGINT");
    proc.emit("SIGTERM");
    await flush();

    expect(runLog.records).toHaveLength(1);
    expect(proc.killed).toHaveLength(1);
  });

  test("uncaughtException escribe el mensaje del error y sale con el mismo codigo que hoy (1)", async () => {
    const proc = new FakeProcess();
    const runLog = new RecordingRunLogSink();
    registerInterruptionHandlers({
      runLog,
      base,
      startedAt: Date.now(),
      describeCheckpoint: async () => null,
      errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
      process: proc,
    });

    proc.emit("uncaughtException", new Error("boom") as never);
    await flush();

    expect(runLog.records).toHaveLength(1);
    expect(runLog.records[0]).toMatchObject({ event: "run.finished", outcome: "interrupted", failureKind: "run-interrupted-failure" });
    expect(runLog.records[0]?.message).toContain("boom");
    expect(proc.exitCodes).toEqual([1]);
  });

  test("unhandledRejection escribe el motivo y sale con el mismo codigo que hoy (1)", async () => {
    const proc = new FakeProcess();
    const runLog = new RecordingRunLogSink();
    registerInterruptionHandlers({
      runLog,
      base,
      startedAt: Date.now(),
      describeCheckpoint: async () => null,
      errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
      process: proc,
    });

    proc.emit("unhandledRejection", new Error("rejected") as never);
    await flush();

    expect(runLog.records).toHaveLength(1);
    expect(runLog.records[0]).toMatchObject({ event: "run.finished", outcome: "interrupted", failureKind: "run-interrupted-failure" });
    expect(runLog.records[0]?.message).toContain("rejected");
    expect(proc.exitCodes).toEqual([1]);
  });

  test("una senal que tarda en confirmar el checkpoint no cuelga el registro (timeout del probe)", async () => {
    const proc = new FakeProcess();
    const runLog = new RecordingRunLogSink();
    registerInterruptionHandlers({
      runLog,
      base,
      startedAt: Date.now(),
      describeCheckpoint: () => new Promise(() => {}),
      errorMessage: (error) => String(error),
      process: proc,
    });

    proc.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 2100));

    expect(runLog.records).toHaveLength(1);
    expect(runLog.records[0]?.checkpoint).toBeNull();
  });

  test("el teardown quita exactamente los cuatro handlers y ninguno mas", () => {
    const proc = new FakeProcess();
    const runLog = new RecordingRunLogSink();
    const teardown = registerInterruptionHandlers({
      runLog,
      base,
      startedAt: Date.now(),
      describeCheckpoint: async () => null,
      errorMessage: (error) => String(error),
      process: proc,
    });

    expect(proc.listenerCount("SIGINT")).toBe(1);
    expect(proc.listenerCount("SIGTERM")).toBe(1);
    expect(proc.listenerCount("uncaughtException")).toBe(1);
    expect(proc.listenerCount("unhandledRejection")).toBe(1);

    teardown();

    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    expect(proc.listenerCount("uncaughtException")).toBe(0);
    expect(proc.listenerCount("unhandledRejection")).toBe(0);
  });
});
