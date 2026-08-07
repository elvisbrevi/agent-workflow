import { describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bunCommandRunner } from "../../../src/system/command"
import {
  GitPortError,
  gitCommonDir,
  gitCurrentBaseSha,
  gitCurrentBranch,
  gitWorktreeIsClean,
  systemGitPort,
} from "../../../src/system/git"

type RepoFixture = {
  readonly worktree: string
  readonly commonDir: string
  readonly baseSha: string
  cleanup(): Promise<void>
}

const makeRepo = async (): Promise<RepoFixture> => {
  const directory = await mkdtemp(join(tmpdir(), "ik-repo-"))
  const result = bunCommandRunner()
  const run = async (args: ReadonlyArray<string>): Promise<string> => {
    const out = await result.spawn({
      program: "git",
      args: [...args],
      cwd: directory,
      env: {},
    })
    if (out.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${out.stderr}`)
    }
    return out.stdout
  }
  await run(["init", "--quiet", "--initial-branch=main", directory])
  await run(["config", "user.email", "test@example.com"])
  await run(["config", "user.name", "Issue Killer Test"])
  await run(["config", "commit.gpgsign", "false"])
  await writeFile(join(directory, "README.md"), "hello\n", "utf8")
  await run(["add", "README.md"])
  await run(["commit", "--quiet", "-m", "init"])
  const baseSha = (await run(["rev-parse", "HEAD"])).trim()
  return {
    worktree: directory,
    commonDir: await realpath(join(directory, ".git")),
    baseSha,
    async cleanup() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

describe("gitCommonDir", () => {
  test("resolves the absolute common dir from a real Git repo", async () => {
    const repo = await makeRepo()
    try {
      const runner = bunCommandRunner()
      const commonDir = await gitCommonDir({ runner, cwd: repo.worktree })
      expect(commonDir).toBe(repo.commonDir)
    } finally {
      await repo.cleanup()
    }
  })

  test("throws not_a_repository when the directory is not a Git repo", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ik-git-"))
    try {
      const runner = bunCommandRunner()
      await expect(gitCommonDir({ runner, cwd: directory })).rejects.toBeInstanceOf(GitPortError)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("throws git_unavailable when git binary is missing", async () => {
    const repo = await makeRepo()
    try {
      const runner = bunCommandRunner({
        spawn: async ({ program, args }) => {
          if (program === "git" && args[0] === "rev-parse") {
            return { stdout: "", stderr: "ENOENT: git not found", exitCode: 127 }
          }
          return { stdout: "", stderr: "", exitCode: 0 }
        },
      })
      await expect(gitCommonDir({ runner, cwd: repo.worktree })).rejects.toMatchObject({
        failure: { kind: "git_unavailable" },
      })
    } finally {
      await repo.cleanup()
    }
  })
})

describe("gitCurrentBranch", () => {
  test("returns the symbolic-ref HEAD branch", async () => {
    const repo = await makeRepo()
    try {
      const runner = bunCommandRunner()
      const branch = await gitCurrentBranch({ runner, cwd: repo.worktree })
      expect(branch).toBe("main")
    } finally {
      await repo.cleanup()
    }
  })

  test("throws detached_head when HEAD has no symbolic ref", async () => {
    const repo = await makeRepo()
    try {
      const runner = bunCommandRunner({
        spawn: async ({ program, args }) => {
          if (program === "git" && args[0] === "symbolic-ref") {
            return { stdout: "", stderr: "fatal: not a symbolic ref", exitCode: 1 }
          }
          return { stdout: "", stderr: "", exitCode: 0 }
        },
      })
      await expect(gitCurrentBranch({ runner, cwd: repo.worktree })).rejects.toMatchObject({
        failure: { kind: "detached_head" },
      })
    } finally {
      await repo.cleanup()
    }
  })
})

describe("gitCurrentBaseSha", () => {
  test("prefers the local refs/heads/<base> sha when available", async () => {
    const repo = await makeRepo()
    try {
      const runner = bunCommandRunner()
      const sha = await gitCurrentBaseSha({ runner, cwd: repo.worktree, baseBranch: "main" })
      expect(sha).toBe(repo.baseSha)
    } finally {
      await repo.cleanup()
    }
  })

  test("falls back to refs/remotes/origin/<base> when the local ref is missing", async () => {
    const repo = await makeRepo()
    let observedRemoteSha = ""
    try {
      const runner = bunCommandRunner({
        spawn: async ({ program, args }) => {
          if (program === "git" && args[0] === "rev-parse") {
            const ref = args[3] ?? ""
            if (ref.startsWith("refs/heads/")) {
              return { stdout: "", stderr: "", exitCode: 1 }
            }
            if (ref.startsWith("refs/remotes/origin/")) {
              observedRemoteSha = repo.baseSha
              return { stdout: `${repo.baseSha}\n`, stderr: "", exitCode: 0 }
            }
          }
          return { stdout: "", stderr: "", exitCode: 0 }
        },
      })
      const sha = await gitCurrentBaseSha({ runner, cwd: repo.worktree, baseBranch: "main" })
      expect(sha).toBe(repo.baseSha)
      expect(observedRemoteSha).toBe(repo.baseSha)
    } finally {
      await repo.cleanup()
    }
  })

  test("throws base_branch_missing when neither ref resolves", async () => {
    const repo = await makeRepo()
    try {
      const runner = bunCommandRunner({
        spawn: async ({ program, args }) => {
          if (program === "git" && args[0] === "rev-parse") {
            return { stdout: "", stderr: "", exitCode: 1 }
          }
          return { stdout: "", stderr: "", exitCode: 0 }
        },
      })
      await expect(
        gitCurrentBaseSha({ runner, cwd: repo.worktree, baseBranch: "main" }),
      ).rejects.toMatchObject({
        failure: { kind: "base_branch_missing", baseBranch: "main" },
      })
    } finally {
      await repo.cleanup()
    }
  })
})

describe("gitWorktreeIsClean", () => {
  test("returns true when status is empty", async () => {
    const repo = await makeRepo()
    try {
      const runner = bunCommandRunner()
      const clean = await gitWorktreeIsClean({ runner, cwd: repo.worktree })
      expect(clean).toBe(true)
    } finally {
      await repo.cleanup()
    }
  })

  test("returns false when status has uncommitted entries", async () => {
    const repo = await makeRepo()
    try {
      await writeFile(join(repo.worktree, "README.md"), "dirty\n", "utf8")
      const runner = bunCommandRunner()
      const clean = await gitWorktreeIsClean({ runner, cwd: repo.worktree })
      expect(clean).toBe(false)
    } finally {
      await repo.cleanup()
    }
  })
})

describe("systemGitPort", () => {
  test("returns a port object exposing the four helpers", () => {
    const port = systemGitPort({ runner: bunCommandRunner() })
    expect(typeof port.commonDir).toBe("function")
    expect(typeof port.currentBranch).toBe("function")
    expect(typeof port.currentBaseSha).toBe("function")
    expect(typeof port.worktreeIsClean).toBe("function")
  })

  test("composes the helpers against a real repository", async () => {
    const repo = await makeRepo()
    try {
      const port = systemGitPort({ runner: bunCommandRunner() })
      const commonDir = await port.commonDir({ cwd: repo.worktree })
      const branch = await port.currentBranch({ cwd: repo.worktree })
      const sha = await port.currentBaseSha({ cwd: repo.worktree, baseBranch: "main" })
      const clean = await port.worktreeIsClean({ cwd: repo.worktree })
      expect(commonDir).toBe(repo.commonDir)
      expect(branch).toBe("main")
      expect(sha).toBe(repo.baseSha)
      expect(clean).toBe(true)
    } finally {
      await repo.cleanup()
    }
  })
})
