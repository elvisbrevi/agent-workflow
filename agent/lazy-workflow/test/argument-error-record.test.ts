/**
 * El run record que deja un `argument-error`, fijado en su seam público.
 *
 * Las validaciones de argumentos ya estaban cubiertas solo por su exit code, así
 * que el contexto que cada una publica —lo que un servicio de monitoreo agrupa
 * (ADR-0029)— podía cambiar sin que ningún test lo notara. Los dos casos de aquí
 * son uno por cada forma de contexto que el CLI emite: la de un comando que abre
 * sesión, que identifica el trabajo por `issue`, y la de un comando de tool de
 * Azure, que lo identifica por `ticket` y `branch`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";

/** El único run record de severidad `event` que dejó la invocación. */
function failureRecord(logFile: string): Record<string, unknown> {
  const lines = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const events = lines.filter((line) => line["event"] === "event");
  expect(events).toHaveLength(1);
  return events[0] as Record<string, unknown>;
}

async function runWithLog(args: string[]): Promise<{ exit: number; record: Record<string, unknown> }> {
  const dir = mkdtempSync(join(tmpdir(), "lazy-workflow-argument-error-"));
  const logFile = join(dir, "runs.jsonl");
  try {
    const exit = await new LazyWorkflowCli().run([...args, "--log-file", logFile]);
    return { exit, record: failureRecord(logFile) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("el run record de un argument-error", () => {
  test("un comando de sesión identifica el trabajo por issue", async () => {
    const { exit, record } = await runWithLog(["architecture-review-sag", "--hu", "123", "--issue", "45"]);

    expect(exit).toBe(1);
    expect(record["failure_kind"]).toBe("argument-error");
    expect(record["phase"]).toBe("validating");
    expect(record["severity"]).toBe("error");
    expect(record["message"]).toBe("architecture-review-sag no permite combinar --hu y --issue");
    expect(record["context"]).toEqual({
      issue: 45,
      ticket: null,
      hu: 123,
      repository: process.cwd(),
      session_id: null,
      branch: null,
      stop_reason: null,
    });
  });

  test("un comando de tool de Azure identifica el trabajo por ticket y branch", async () => {
    const { exit, record } = await runWithLog([
      "ticket-branch-set", "--hu", "999", "--ticket", "7", "--branch", "refs/heads/ticket/7",
    ]);

    expect(exit).toBe(1);
    expect(record["failure_kind"]).toBe("argument-error");
    expect(record["phase"]).toBe("validating");
    expect(record["severity"]).toBe("error");
    expect(record["message"]).toBe("ticket-branch-set requiere --working-directory <path>");
    expect(record["context"]).toEqual({
      issue: null,
      ticket: 7,
      hu: 999,
      repository: process.cwd(),
      session_id: null,
      branch: "refs/heads/ticket/7",
      stop_reason: null,
    });
  });
});
