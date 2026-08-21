import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";

const readLines = (path: string): Array<Record<string, unknown>> =>
  readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

describe("LazyWorkflowCli run log integration", () => {
  test("un run que falla por regla de negocio escribe run.started y run.finished con exit_code no cero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lazy-workflow-cli-run-log-"));
    const logFile = join(dir, "runs.jsonl");
    try {
      const cli = new LazyWorkflowCli();
      const exit = await cli.run([
        "code", "--branch", "foo", "--working-directory", "/tmp", "--log-file", logFile,
      ]);

      expect(exit).toBe(1);
      const lines = readLines(logFile);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ event: "run.started", command: "code" });
      expect(lines[1]).toMatchObject({ event: "run.finished", command: "code", outcome: "failure", exit_code: 1 });
      expect(typeof lines[1]!["duration_ms"]).toBe("number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--no-log-file no crea ningun archivo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lazy-workflow-cli-run-log-"));
    const logFile = join(dir, "runs.jsonl");
    try {
      const cli = new LazyWorkflowCli();
      await cli.run(["code", "--branch", "foo", "--working-directory", "/tmp", "--no-log-file"]);

      expect(() => readFileSync(logFile, "utf8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
