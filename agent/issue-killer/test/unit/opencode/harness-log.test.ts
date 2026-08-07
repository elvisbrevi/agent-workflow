import { expect, test } from "bun:test"
import { readFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessLog } from "../../../src/opencode/harness-log"

test("writes one redacted JSONL harness log under the configured directory", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "issue-killer-harness-"))

  try {
    const log = createHarnessLog({ logDir })
    await log.startRun({ runId: "run_1", repository: "agent-workflow" })
    await log.appendEvent({
      runId: "run_1",
      payload: {
        kind: "command",
        command: "gh issue view 84",
        output: "Authorization: Bearer super-secret-token",
      },
    })
    await log.appendEvent({
      runId: "run_1",
      payload: { kind: "file_edit", file: "src/example.ts" },
    })
    await log.endRun({ runId: "run_1", status: "verified" })

    const path = log.readRunPath({ runId: "run_1" })
    expect(path.startsWith(logDir)).toBe(true)
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(lines).toHaveLength(4)
    expect(lines[1].payload.output).toContain("<redacted:authorization>")
    expect(lines[1].payload.output).not.toContain("super-secret-token")
    expect(lines[2].payload.kind).toBe("file_edit")
    expect(lines[3].status).toBe("verified")
  } finally {
    await rm(logDir, { recursive: true, force: true })
  }
})
