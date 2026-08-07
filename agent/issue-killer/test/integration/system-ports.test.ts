import { describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bunCommandRunner } from "../../src/system/command"
import { systemGitPort } from "../../src/system/git"
import { systemClock } from "../../src/system/clock"
import { createSignalCoordinator } from "../../src/system/signals"

const buildRepo = async (): Promise<{ worktree: string; cleanup(): Promise<void> }> => {
  const directory = await mkdtemp(join(tmpdir(), "ik-int-"))
  const runner = bunCommandRunner()
  const run = async (args: ReadonlyArray<string>): Promise<string> => {
    const out = await runner.spawn({ program: "git", args: [...args], cwd: directory, env: {} })
    if (out.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${out.stderr}`)
    }
    return out.stdout
  }
  await run(["init", "--quiet", "--initial-branch=main", directory])
  await run(["config", "user.email", "test@example.com"])
  await run(["config", "user.name", "Issue Killer Integration"])
  await run(["config", "commit.gpgsign", "false"])
  await writeFile(join(directory, "README.md"), "hello\n", "utf8")
  await run(["add", "README.md"])
  await run(["commit", "--quiet", "-m", "init"])
  return {
    worktree: directory,
    async cleanup() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

describe("system ports integration", () => {
  test("command runner + git + clock + signals compose against a real repository", async () => {
    const repo = await buildRepo()
    try {
      const runner = bunCommandRunner()
      const git = systemGitPort({ runner })
      const clock = systemClock({ now: () => new Date("2026-08-06T10:00:00Z") })

      const coordinator = createSignalCoordinator({
        emitter: { addListener: () => () => undefined, emit: () => undefined },
        installHandlers: false,
      })
      coordinator.registerHook(async () => {
        await clock.sleep({ millis: 1 })
      })

      const commonDir = await git.commonDir({ cwd: repo.worktree })
      const branch = await git.currentBranch({ cwd: repo.worktree })
      const sha = await git.currentBaseSha({ cwd: repo.worktree, baseBranch: "main" })
      const clean = await git.worktreeIsClean({ cwd: repo.worktree })

      expect(commonDir).toBe(await realpath(join(repo.worktree, ".git")))
      expect(branch).toBe("main")
      expect(sha.length).toBe(40)
      expect(clean).toBe(true)
      expect(coordinator.signal.aborted).toBe(false)

      await coordinator.cleanup()
      coordinator.dispose()
    } finally {
      await repo.cleanup()
    }
  })

  test("command runner reports a non-zero exit when the stub fails", async () => {
    const runner = bunCommandRunner()
    const result = await runner.spawn({
      program: "false",
      args: [],
      cwd: "/tmp",
      env: {},
    })
    expect(result.exitCode).not.toBe(0)
  })

  test("command runner captures stdout and stderr independently", async () => {
    const runner = bunCommandRunner()
    const result = await runner.spawn({
      program: "/bin/sh",
      args: ["-c", "printf stdout-value; printf stderr-value 1>&2"],
      cwd: "/tmp",
      env: {},
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("stdout-value")
    expect(result.stderr).toBe("stderr-value")
  })
})
