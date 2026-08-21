import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { AgentResult } from "../src/coding-agent/agent-result.ts";
import { createReporter, type ReporterOptions, type ReporterStream } from "../src/output/reporter.ts";
import { fakeGitHubCheckpointStore, fakeGitHubDelivery, fakeGitHubRepositoryLock } from "./_helpers/github-delivery-fixtures.ts";
import { fakeSelectedOutcome, queueAdapter } from "./_helpers/managed-queue-fixtures.ts";
import { parseReportedChunk, type ReportedLine } from "./_helpers/reported-lines.ts";

const readLines = async (path: string): Promise<Array<Record<string, unknown>>> =>
  (await Bun.file(path).text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

/**
 * ADR-0029's acceptance criterion is that one call at the failure site
 * produces both outputs: this reporter factory is real (`createReporter`, so
 * every level, `--quiet` gating and the `runLog` forwarding behave exactly as
 * in production) with only its stream swapped for one this test can read.
 */
function capturingReporterFactory(): { reporterFn: typeof createReporter; captured: ReportedLine[] } {
  const captured: ReportedLine[] = [];
  const stream: ReporterStream = { write: (chunk) => { captured.push(...parseReportedChunk(chunk)); } };
  const reporterFn = ((options: boolean | ReporterOptions) => {
    const opts: ReporterOptions = typeof options === "boolean" ? { verbose: options } : options;
    return createReporter({ ...opts, stream, noColor: true });
  }) as typeof createReporter;
  return { reporterFn, captured };
}

describe("emisión tipada de fallos GitHub (ADR-0029)", () => {
  test("un manifest no verificable en completeGitHubDelivery produce la línea de operador en error y un registro run-log con failure_kind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lazy-workflow-github-failure-"));
    const logFile = join(dir, "runs.jsonl");
    const { reporterFn, captured } = capturingReporterFactory();
    try {
      const delivery = fakeGitHubDelivery({
        // The checkpoint fixes issue 178; a manifest naming another issue makes
        // completeGitHubDelivery throw "El manifest no coincide..." — a real
        // manifest-not-verifiable failure, not a stubbed error message.
        readManifest: async () => ({
          issue: 999,
          branch: "refs/heads/issue/178",
          commit: "a".repeat(40),
          validation: [],
          clean: true,
          summary: "entrega completada",
        }),
      });
      const cli = new LazyWorkflowCli(
        { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
        {
          run: async () => ({
            result: AgentResult.fromJsonLines(JSON.stringify({
              type: "text", sessionID: "ses_178", part: { type: "text", text: "IMPLEMENTATION_READY" },
            })),
            azureLoginRequired: false,
          }),
          resume: async () => { throw new Error("must not resume"); },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        reporterFn,
        queueAdapter([fakeSelectedOutcome(178)]),
        fakeGitHubCheckpointStore(),
        fakeGitHubRepositoryLock(),
        delivery,
      );

       const exit = await cli.run(["code", "--quiet", "--working-directory", "/repo", "--log-file", logFile]);

      expect(exit).toBe(1);

      // The operator line: error level, the ✖ glyph, survives --quiet.
      const failureLine = captured.find((line) => line.message.includes("no se pudo completar determinísticamente el Issue #178"));
      expect(failureLine).toBeDefined();
      expect(failureLine!.level).toBe("error");

      // The run-log record: same failure, carrying its kind, phase and context.
       const lines = await readLines(logFile);
      const failureRecord = lines.find((line) => line["failure_kind"] === "manifest-not-verifiable");
      expect(failureRecord).toBeDefined();
      expect(failureRecord).toMatchObject({
        severity: "error",
        failure_kind: "manifest-not-verifiable",
        phase: "implementation-ready",
        context: expect.objectContaining({ issue: 178 }),
      });
      expect((failureRecord!["message"] as string)).toContain("no se pudo completar determinísticamente el Issue #178");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
