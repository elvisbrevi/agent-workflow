import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import type { InterruptionProcess } from "../src/output/run-interruption.ts";
import type { DeterministicToolServices } from "../src/cli/deterministic-tools.ts";

const readLines = (path: string): Array<Record<string, unknown>> =>
  readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** A minimal, in-memory stand-in for `process`, so a test can raise a signal without touching the real process running the suite (mirrors test/run-interruption.test.ts). */
class FakeProcess implements InterruptionProcess {
  readonly pid = 4242;
  private readonly listeners = new Map<string, Set<(...args: never[]) => void>>();

  on(event: string, listener: (...args: never[]) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }

  removeListener(event: string, listener: (...args: never[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  kill(): void {
    // A test process must never actually receive the redelivered signal.
  }

  exit(code: number): never {
    this.exitCode = code;
    return undefined as never;
  }

  exitCode: number | null = null;

  emit(event: "SIGINT" | "SIGTERM" | "uncaughtException" | "unhandledRejection", ...args: never[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}

const withTempLog = async (fn: (logFile: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "lazy-workflow-interruption-cli-"));
  try {
    await fn(join(dir, "runs.jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("LazyWorkflowCli interruption handling", () => {
  test("una senal durante un run en curso escribe run.finished interrumpido con el checkpoint pendiente y no rompe el exit code por defecto", async () => {
    await withTempLog(async (logFile) => {
      const proc = new FakeProcess();
      const hang = new Promise<never>(() => {}); // deliberately never resolves: the run is still "in flight" when the signal arrives
      let reachedHang: (() => void) | null = null;
      const reached = new Promise<void>((resolve) => { reachedHang = resolve; });

      const deterministicToolServices: DeterministicToolServices = {
        azure: {},
        queue: {
          verifyAuthentication: async () => ({ login: "octocat" }),
          verifyRepository: async () => ({ nameWithOwner: "o/r" }),
          listManagedIssues: async () => { reachedHang?.(); return hang; },
          readIssueDetail: async () => { throw new Error("not used"); },
          selectEligibleIssue: async () => { throw new Error("not used"); },
          claimSelectedIssue: async () => { throw new Error("not used"); },
          releaseOwnClaim: async () => { throw new Error("not used"); },
        },
        delivery: {
          prepareBranch: async () => { throw new Error("not used"); },
          checkoutBranch: async () => { throw new Error("not used"); },
          verifyBranch: async () => { throw new Error("not used"); },
          cleanupBranch: async () => { throw new Error("not used"); },
          readManifest: async () => { throw new Error("not used"); },
          pushCommit: async () => { throw new Error("not used"); },
          createOrReusePullRequest: async () => { throw new Error("not used"); },
          mergePullRequest: async () => { throw new Error("not used"); },
          closeIssue: async () => { throw new Error("not used"); },
        },
        branches: { deleteTicketBranch: async () => { throw new Error("not used"); } },
      };

      const cli = new LazyWorkflowCli(
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined,
        deterministicToolServices,
        undefined,
        proc,
      );

      void cli.run(["github-issue-list", "--working-directory", "/tmp", "--log-file", logFile]);
      await reached;

      proc.emit("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 20));

      const lines = readLines(logFile);
      expect(lines[0]).toMatchObject({ event: "run.started", command: "github-issue-list" });
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatchObject({
        event: "run.finished",
        outcome: "interrupted",
        failure_kind: "run-interrupted-signal",
      });
      expect(proc.exitCode).toBeNull(); // SIGINT restores default behavior via redelivery, not process.exit
    });
  });

  test("un rechazo de promesa no manejado durante un run en curso escribe run.finished interrumpido y sale con exit code 1", async () => {
    await withTempLog(async (logFile) => {
      const proc = new FakeProcess();
      let reachedHang: (() => void) | null = null;
      const reached = new Promise<void>((resolve) => { reachedHang = resolve; });
      const hang = new Promise<never>(() => {}); // still "in flight" when the rejection escapes

      const deterministicToolServices: DeterministicToolServices = {
        azure: {},
        queue: {
          verifyAuthentication: async () => ({ login: "octocat" }),
          verifyRepository: async () => ({ nameWithOwner: "o/r" }),
          listManagedIssues: async () => { reachedHang?.(); return hang; },
          readIssueDetail: async () => { throw new Error("not used"); },
          selectEligibleIssue: async () => { throw new Error("not used"); },
          claimSelectedIssue: async () => { throw new Error("not used"); },
          releaseOwnClaim: async () => { throw new Error("not used"); },
        },
        delivery: {
          prepareBranch: async () => { throw new Error("not used"); },
          checkoutBranch: async () => { throw new Error("not used"); },
          verifyBranch: async () => { throw new Error("not used"); },
          cleanupBranch: async () => { throw new Error("not used"); },
          readManifest: async () => { throw new Error("not used"); },
          pushCommit: async () => { throw new Error("not used"); },
          createOrReusePullRequest: async () => { throw new Error("not used"); },
          mergePullRequest: async () => { throw new Error("not used"); },
          closeIssue: async () => { throw new Error("not used"); },
        },
        branches: { deleteTicketBranch: async () => { throw new Error("not used"); } },
      };

      const cli = new LazyWorkflowCli(
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined,
        deterministicToolServices,
        undefined,
        proc,
      );

      void cli.run(["github-issue-list", "--working-directory", "/tmp", "--log-file", logFile]);
      await reached;

      // Simulates a rejection that truly escapes every catch, delivered directly
      // to the handler exactly as Bun would deliver it to `process`.
      proc.emit("unhandledRejection", new Error("escaped rejection") as never);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const lines = readLines(logFile);
      const finished = lines.filter((line) => line["event"] === "run.finished" && line["outcome"] === "interrupted");
      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({ failure_kind: "run-interrupted-failure" });
      expect(String(finished[0]!["message"])).toContain("escaped rejection");
      expect(proc.exitCode).toBe(1);
    });
  });
});
