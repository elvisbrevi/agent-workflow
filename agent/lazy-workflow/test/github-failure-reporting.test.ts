import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubSessionNotVerifiedError } from "../src/github/github-delivery-service.ts";
import { createCli } from "./_helpers/create-cli.ts";
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
  test("una sesión no verificada en completeGitHubDelivery produce la línea de operador en error y un registro run-log con failure_kind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lazy-workflow-github-failure-"));
    const logFile = join(dir, "runs.jsonl");
    const { reporterFn, captured } = capturingReporterFactory();
    try {
      const delivery = fakeGitHubDelivery({
        // La rama fijada no lleva commits sobre su base: un fallo de verificación real
        // (ADR-0035), no un mensaje de error simulado.
        verifySession: async () => { throw new GitHubSessionNotVerifiedError("la rama refs/heads/issue/178 no tiene commits sobre refs/heads/main"); },
      });
      const cli = createCli({
        huInfoService: { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
        agentSource: {
          run: async () => ({
            result: AgentResult.fromJsonLines(JSON.stringify({
              type: "text", sessionID: "ses_178", part: { type: "text", text: "IMPLEMENTATION_READY" },
            })),
            azureLoginRequired: false,
          }),
          resume: async () => { throw new Error("must not resume"); },
        },
        createReporterFn: reporterFn,
        githubManagedQueue: queueAdapter([fakeSelectedOutcome(178)]),
        githubCheckpointStore: fakeGitHubCheckpointStore(),
        githubRepositoryLock: fakeGitHubRepositoryLock(),
        githubDelivery: delivery,
      });

       const exit = await cli.run(["code", "--quiet", "--working-directory", "/repo", "--log-file", logFile]);

      expect(exit).toBe(1);

      // The operator line: error level, the ✖ glyph, survives --quiet.
      const failureLine = captured.find((line) => line.message.includes("no se pudo completar determinísticamente el Issue #178"));
      expect(failureLine).toBeDefined();
      expect(failureLine!.level).toBe("error");

      // The run-log record: same failure, carrying its kind, phase and context.
       const lines = await readLines(logFile);
      const failureRecord = lines.find((line) => line["failure_kind"] === "session-not-verified");
      expect(failureRecord).toBeDefined();
      expect(failureRecord).toMatchObject({
        severity: "error",
        failure_kind: "session-not-verified",
        phase: "implementation-ready",
        context: expect.objectContaining({ issue: 178 }),
      });
      expect((failureRecord!["message"] as string)).toContain("no se pudo completar determinísticamente el Issue #178");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
