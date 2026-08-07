import { expect, test } from "bun:test"
import { join } from "node:path"

test("V2 command reports malformed CLI input through the public status protocol", async () => {
  const child = Bun.spawn(
    [process.execPath, "run", join(import.meta.dir, "../..", "bin", "issue-killer.ts"), "--iteration-limit"],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  expect(exitCode).toBe(1)
  expect(stdout.trim()).toBe("ISSUE_KILLER_STATUS=FAILED")
  expect(stderr).toContain("--iteration-limit requires a value")
})
