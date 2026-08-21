/**
 * A CLI test that never declares `--log-file`/`--no-log-file` still resolves
 * the run log's default path, which is the developer's real home directory.
 * Redirecting `LAZY_WORKFLOW_LOG_FILE` here, once, keeps every such test from
 * writing into `~/.local/state/lazy-workflow` on the machine running them.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["LAZY_WORKFLOW_LOG_FILE"] ??= join(
  mkdtempSync(join(tmpdir(), "lazy-workflow-test-run-log-")),
  "runs.jsonl",
);
