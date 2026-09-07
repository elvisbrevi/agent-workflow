import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCli, type CliBoundaries } from "./_helpers/create-cli.ts";
import { createReporter, type ReporterOptions, type ReporterStream } from "../src/output/reporter.ts";
import { parseReportedChunk, type ReportedLine } from "./_helpers/reported-lines.ts";

const readLines = (path: string): Array<Record<string, unknown>> =>
  readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

describe("LazyWorkflowCli run log integration", () => {
  test("un run que falla por regla de negocio escribe run.started y run.finished con exit_code no cero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lazy-workflow-cli-run-log-"));
    const logFile = join(dir, "runs.jsonl");
    try {
      const cli = createCli();
      const exit = await cli.run([
        "code", "--branch", "foo", "--working-directory", "/tmp", "--log-file", logFile,
      ]);

      expect(exit).toBe(1);
      const lines = readLines(logFile);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatchObject({ event: "run.started", command: "code" });
      expect(lines[1]).toMatchObject({ event: "event", failure_kind: "argument-error", severity: "error" });
      expect(lines[2]).toMatchObject({ event: "run.finished", command: "code", outcome: "failure", exit_code: 1 });
      expect(typeof lines[2]!["duration_ms"]).toBe("number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--no-log-file no crea ningun archivo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lazy-workflow-cli-run-log-"));
    const logFile = join(dir, "runs.jsonl");
    try {
      const cli = createCli();
      await cli.run(["code", "--branch", "foo", "--working-directory", "/tmp", "--no-log-file"]);

      expect(() => readFileSync(logFile, "utf8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The production reporter with only its stream swapped, so `--quiet` gating and
 * the run-log forwarding a failure kind travels on behave exactly as they do in
 * a real run — a double that skipped the forwarding would never set the
 * argument-error flag the pointer reads.
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

/** A queue boundary whose every operation is a mistake to call, named one by one so a test declares only the ones its case reaches. */
const queueBoundary = (
  overrides: Partial<NonNullable<CliBoundaries["deterministicToolServices"]>["queue"]>,
): NonNullable<CliBoundaries["deterministicToolServices"]> => {
  const unused = (name: string) => async (): Promise<never> => { throw new Error(`no usado en este test: ${name}`); };
  return {
    azure: {},
    queue: {
      verifyAuthentication: unused("verifyAuthentication"),
      verifyRepository: unused("verifyRepository"),
      listManagedIssues: unused("listManagedIssues"),
      readIssueDetail: unused("readIssueDetail"),
      selectEligibleIssue: unused("selectEligibleIssue"),
      claimSelectedIssue: unused("claimSelectedIssue"),
      releaseOwnClaim: unused("releaseOwnClaim"),
      ...overrides,
    },
    delivery: {
      prepareBranch: unused("prepareBranch"),
      checkoutBranch: unused("checkoutBranch"),
      verifyBranch: unused("verifyBranch"),
      cleanupBranch: unused("cleanupBranch"),
      verifySession: unused("verifySession"),
      pushCommit: unused("pushCommit"),
      createOrReusePullRequest: unused("createOrReusePullRequest"),
      mergePullRequest: unused("mergePullRequest"),
      closeIssue: unused("closeIssue"),
    },
    branches: { deleteTicketBranch: unused("deleteTicketBranch") },
  };
};

describe("LazyWorkflowCli puntero al run log", () => {
  const pointer = (captured: ReportedLine[]): ReportedLine | undefined =>
    captured.find((line) => line.message.includes("revisa el run log"));

  const withTempLog = async (fn: (logFile: string) => Promise<void>): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), "lazy-workflow-cli-run-log-"));
    try {
      await fn(join(dir, "runs.jsonl"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("un run que falla manda al operador a su propio registro, nombrando el run", async () => {
    await withTempLog(async (logFile) => {
      const { reporterFn, captured } = capturingReporterFactory();
      const cli = createCli({
        createReporterFn: reporterFn,
        deterministicToolServices: queueBoundary({
          verifyAuthentication: async () => { throw new Error("gh no esta autenticado"); },
        }),
      });

      const exit = await cli.run(["github-issue-list", "--working-directory", "/tmp", "--log-file", logFile])
        .catch(() => 1);

      expect(exit).toBe(1);
      const runId = readLines(logFile)[0]!["run_id"];
      expect(typeof runId).toBe("string");
      expect(pointer(captured)?.message)
        .toBe(`lazy-workflow: revisa el run log para el detalle del fallo: grep ${runId} ${logFile}`);
    });
  });

  test("un run que termina bien no manda a leer nada", async () => {
    await withTempLog(async (logFile) => {
      const { reporterFn, captured } = capturingReporterFactory();
      const cli = createCli({
        createReporterFn: reporterFn,
        deterministicToolServices: queueBoundary({
          verifyAuthentication: async () => ({ login: "octocat" }),
          verifyRepository: async () => ({ nameWithOwner: "o/r" }),
          listManagedIssues: async () => [],
        }),
      });

      const exit = await cli.run(["github-issue-list", "--working-directory", "/tmp", "--log-file", logFile]);

      expect(exit).toBe(0);
      expect(pointer(captured)).toBeUndefined();
    });
  });

  test("un error de argumentos no manda a leer nada: el operador esta frente a la pantalla", async () => {
    await withTempLog(async (logFile) => {
      const { reporterFn, captured } = capturingReporterFactory();
      const cli = createCli({ createReporterFn: reporterFn });

      const exit = await cli.run(["code", "--branch", "foo", "--working-directory", "/tmp", "--log-file", logFile]);

      expect(exit).toBe(1);
      expect(readLines(logFile)[1]).toMatchObject({ failure_kind: "argument-error" });
      expect(pointer(captured)).toBeUndefined();
    });
  });

  test("sin run log no hay a donde mandar al operador", async () => {
    const { reporterFn, captured } = capturingReporterFactory();
    const cli = createCli({
      createReporterFn: reporterFn,
      deterministicToolServices: queueBoundary({
        verifyAuthentication: async () => { throw new Error("gh no esta autenticado"); },
      }),
    });

    await cli.run(["github-issue-list", "--working-directory", "/tmp", "--no-log-file"]).catch(() => 1);

    expect(pointer(captured)).toBeUndefined();
  });
});
