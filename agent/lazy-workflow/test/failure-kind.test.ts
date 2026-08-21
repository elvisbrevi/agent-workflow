import { describe, expect, test } from "bun:test";
import { FAILURE_KIND_SEVERITY, failureKindSeverity, reportFailure, type FailureKind } from "../src/output/failure-kind.ts";
import type { Reporter, ReporterFailureDetail } from "../src/output/reporter.ts";
import type { RunLogContext } from "../src/output/run-log.ts";

/** Records what a Reporter was told, level and detail together, without a stream in the middle. */
function captureReporter(): { reporter: Reporter; calls: Array<{ level: "info" | "warn" | "error"; message: string; detail?: ReporterFailureDetail }> } {
  const calls: Array<{ level: "info" | "warn" | "error"; message: string; detail?: ReporterFailureDetail }> = [];
  const reporter: Reporter = {
    tracing: false,
    info: (message) => { calls.push({ level: "info", message }); },
    warn: (message, detail) => { calls.push({ level: "warn", message, detail }); },
    error: (message, detail) => { calls.push({ level: "error", message, detail }); },
    debug: () => undefined,
    trace: () => undefined,
    heading: () => undefined,
    start: () => ({ stop: () => undefined }) as never,
    stop: () => undefined,
  };
  return { reporter, calls };
}

const ALL_KINDS = Object.keys(FAILURE_KIND_SEVERITY) as FailureKind[];

describe("reportFailure", () => {
  test("nunca rutea a info: cada kind cerrado va a warn o a error", () => {
    for (const kind of ALL_KINDS) {
      expect(["warn", "error"]).toContain(failureKindSeverity(kind));
    }
  });

  test.each(ALL_KINDS)("%s rutea al Reporter y al run log en una sola llamada, con el mismo kind, fase y contexto", (kind) => {
    const { reporter, calls } = captureReporter();
    const context: RunLogContext = { issue: 264, repository: "/repo", sessionId: "ses_1", branch: "issue/264" };

    reportFailure(kind, "implementing", context, "algo fallo", reporter);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
     const expectedSeverity = FAILURE_KIND_SEVERITY[kind];
    expect(call.level).toBe(expectedSeverity);
    expect(call.message).toBe("algo fallo");
    expect(call.detail).toEqual({ failureKind: kind, phase: "implementing", context });
  });

   test("cada kind de fallo se emite como error para que --quiet conserve la línea", () => {
     for (const kind of ALL_KINDS) {
       expect(failureKindSeverity(kind)).toBe("error");
     }
   });

  test("sin reporter explicito usa el reporter por defecto del proceso", async () => {
    const { setDefaultReporter, getDefaultReporter } = await import("../src/output/operator-output.ts");
    const previous = getDefaultReporter();
    const { reporter, calls } = captureReporter();
    setDefaultReporter(reporter);
    try {
      reportFailure("delivery-failure", "coordinating", {}, "no se pudo coordinar");
      expect(calls).toEqual([
        { level: "error", message: "no se pudo coordinar", detail: { failureKind: "delivery-failure", phase: "coordinating", context: {} } },
      ]);
    } finally {
      setDefaultReporter(previous);
    }
  });
});
