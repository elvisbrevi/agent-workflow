import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRunLogSink,
  defaultRunLogPath,
  resolveRunLogPath,
  RUN_LOG_SCHEMA_VERSION,
  type RunLogFs,
  type RunLogRecordInput,
} from "../src/output/run-log.ts";

const FIXED_DATE = new Date(2026, 7, 20, 10, 0, 0);
const clock = { now: () => FIXED_DATE };

const readLines = (path: string): unknown[] =>
  readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

const withTempDir = <T>(fn: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "lazy-workflow-run-log-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const baseRecord: Omit<RunLogRecordInput, "event" | "severity" | "message"> = {
  command: "code",
  workflow: "code",
  provider: "github",
  cli: "claudecode",
  model: "claude-sonnet-5",
  variant: "high",
  context: { issue: 263, ticket: null, hu: null, repository: "/repo", sessionId: null, branch: "issue/263" },
};

describe("resolveRunLogPath", () => {
  test("--log-file gana sobre todo lo demas", () => {
    const path = resolveRunLogPath({ logFile: "/tmp/explicit.jsonl", noLogFile: false }, { LAZY_WORKFLOW_LOG_FILE: "/tmp/env.jsonl" });
    expect(path).toBe("/tmp/explicit.jsonl");
  });

  test("LAZY_WORKFLOW_LOG_FILE se usa cuando no hay --log-file", () => {
    const path = resolveRunLogPath({ logFile: null, noLogFile: false }, { LAZY_WORKFLOW_LOG_FILE: "/tmp/env.jsonl" });
    expect(path).toBe("/tmp/env.jsonl");
  });

  test("el default es ~/.local/state/lazy-workflow/runs.jsonl", () => {
    const path = resolveRunLogPath({ logFile: null, noLogFile: false }, {});
    expect(path).toBe(defaultRunLogPath());
  });

  test("--no-log-file deshabilita el sink sin importar el resto", () => {
    const path = resolveRunLogPath({ logFile: "/tmp/explicit.jsonl", noLogFile: true }, { LAZY_WORKFLOW_LOG_FILE: "/tmp/env.jsonl" });
    expect(path).toBeNull();
  });
});

describe("createRunLogSink", () => {
  test("path null devuelve un sink deshabilitado que nunca escribe", () => {
    const sink = createRunLogSink({ path: null });
    expect(() => sink.write({ ...baseRecord, event: "run.started", severity: "info", message: "x" })).not.toThrow();
  });

  test("run.started y run.finished llevan el contrato de campos", () => {
    withTempDir((dir) => {
      const path = join(dir, "runs.jsonl");
      const sink = createRunLogSink({ path, clock, runId: "run-1" });
      sink.write({ ...baseRecord, event: "run.started", severity: "info", message: "iniciado" });
      sink.write({
        ...baseRecord,
        event: "run.finished",
        severity: "error",
        outcome: "failure",
        exitCode: 1,
        durationMs: 4200,
        message: "finalizado",
      });

      const lines = readLines(path) as Array<Record<string, unknown>>;
      const started = lines[0]!;
      const finished = lines[1]!;
      expect(started).toMatchObject({
        schema_version: RUN_LOG_SCHEMA_VERSION,
        run_id: "run-1",
        ts: FIXED_DATE.toISOString(),
        severity: "info",
        event: "run.started",
        command: "code",
        workflow: "code",
        provider: "github",
        cli: "claudecode",
        model: "claude-sonnet-5",
        variant: "high",
        context: { issue: 263, ticket: null, hu: null, repository: "/repo", session_id: null, branch: "issue/263" },
        message: "iniciado",
      });
      expect(started["outcome"]).toBeUndefined();
      expect(started["exit_code"]).toBeUndefined();

      expect(finished).toMatchObject({
        event: "run.finished",
        outcome: "failure",
        exit_code: 1,
        duration_ms: 4200,
        message: "finalizado",
      });
    });
  });

  test("un registro de sesion (issue #267) lleva session_event, reason y from_cli, y usa el cli/model/variant del escalon", () => {
    withTempDir((dir) => {
      const path = join(dir, "runs.jsonl");
      const sink = createRunLogSink({ path, clock, runId: "run-1" });
      sink.write({
        ...baseRecord,
        cli: "opencode",
        model: "provider/respaldo",
        variant: "medium",
        event: "event",
        severity: "info",
        sessionEvent: "fallback_descent",
        reason: "rate_limit",
        fromCli: "claudecode",
        durationMs: 1500,
        outcome: "failure",
        message: "desciendo",
      });

      const [descent] = readLines(path) as Array<Record<string, unknown>>;
      expect(descent).toMatchObject({
        event: "event",
        cli: "opencode",
        model: "provider/respaldo",
        variant: "medium",
        session_event: "fallback_descent",
        reason: "rate_limit",
        from_cli: "claudecode",
        duration_ms: 1500,
        outcome: "failure",
      });
    });
  });

  test("una sesion finalizada (issue #267) lleva su stop reason en el context, no como label", () => {
    withTempDir((dir) => {
      const path = join(dir, "runs.jsonl");
      const sink = createRunLogSink({ path, clock, runId: "run-1" });
      sink.write({
        ...baseRecord,
        cli: "opencode",
        event: "event",
        severity: "info",
        sessionEvent: "session_finished",
        durationMs: 900,
        outcome: "success",
        context: { ...baseRecord.context, sessionId: "ses_1", stopReason: "stop" },
        message: "finalizada",
      });

      const [finished] = readLines(path) as Array<Record<string, unknown>>;
      expect(finished?.["reason"]).toBeUndefined();
      expect(finished).toMatchObject({
        session_event: "session_finished",
        duration_ms: 900,
        outcome: "success",
        context: { session_id: "ses_1", stop_reason: "stop" },
      });
    });
  });

  test("cada escritura le pertenece a un unico run_id", () => {
    withTempDir((dir) => {
      const path = join(dir, "runs.jsonl");
      const sink = createRunLogSink({ path, clock, runId: "shared-run" });
      sink.write({ ...baseRecord, event: "run.started", severity: "info", message: "a" });
      sink.write({ ...baseRecord, event: "event", severity: "warn", message: "b" });

      const lines = readLines(path) as Array<{ run_id: string }>;
      expect(lines.map((line) => line.run_id)).toEqual(["shared-run", "shared-run"]);
    });
  });

  test("una escritura que falla emite el error una sola vez y deshabilita el sink", () => {
    withTempDir((dir) => {
      const path = join(dir, "runs.jsonl");
      let calls = 0;
      const failingFs: RunLogFs = {
        existsSync: () => false,
        mkdirSync: () => undefined,
        statSync: (() => { throw new Error("no debería llamarse"); }) as RunLogFs["statSync"],
        renameSync: () => undefined,
        unlinkSync: () => undefined,
        appendFileSync: () => { throw new Error("disco lleno"); },
      };
      const failures: unknown[] = [];
      const sink = createRunLogSink({ path, clock, fs: failingFs, onWriteFailure: (error) => failures.push(error) });

      sink.write({ ...baseRecord, event: "run.started", severity: "info", message: "a" });
      sink.write({ ...baseRecord, event: "run.finished", severity: "info", outcome: "success", exitCode: 0, durationMs: 1, message: "b" });

      expect(failures.length).toBe(1);
      calls = failures.length;
      expect(calls).toBe(1);
    });
  });

  test("write nunca lanza aunque el sistema de archivos falle", () => {
    const failingFs: RunLogFs = {
      existsSync: () => { throw new Error("permiso denegado"); },
      mkdirSync: () => undefined,
      statSync: (() => { throw new Error("no debería llamarse"); }) as RunLogFs["statSync"],
      renameSync: () => undefined,
      unlinkSync: () => undefined,
      appendFileSync: () => undefined,
    };
    const sink = createRunLogSink({ path: "/no/existe/runs.jsonl", fs: failingFs });
    expect(() => sink.write({ ...baseRecord, event: "run.started", severity: "info", message: "a" })).not.toThrow();
  });

  test("rotacion: al alcanzar el tope conserva exactamente una generacion previa", () => {
    withTempDir((dir) => {
      const path = join(dir, "runs.jsonl");
      const sink = createRunLogSink({ path, clock, maxBytes: 10 });

      sink.write({ ...baseRecord, event: "run.started", severity: "info", message: "primero" });
      const firstGenerationLine = readFileSync(path, "utf8");

      sink.write({ ...baseRecord, event: "run.started", severity: "info", message: "segundo" });

      expect(readFileSync(`${path}.1`, "utf8")).toBe(firstGenerationLine);
      const current = readLines(path) as Array<{ message: string }>;
      expect(current).toHaveLength(1);
      expect(current[0]!.message).toBe("segundo");

      sink.write({ ...baseRecord, event: "run.started", severity: "info", message: "tercero" });
      expect(readFileSync(`${path}.1`, "utf8").trim()).toContain("segundo");
    });
  });
});
