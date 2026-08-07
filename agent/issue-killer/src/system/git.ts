import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import type { CommandRunnerPort, GitPort } from "../domain/ports"

export type GitPortFailure =
  | { readonly kind: "not_a_repository"; readonly cwd: string }
  | { readonly kind: "common_dir_missing"; readonly cwd: string; readonly path: string }
  | { readonly kind: "detached_head"; readonly cwd: string }
  | { readonly kind: "base_branch_missing"; readonly cwd: string; readonly baseBranch: string }
  | { readonly kind: "git_unavailable"; readonly cwd: string; readonly error: string }
  | { readonly kind: "command_failed"; readonly cwd: string; readonly stderr: string }

export class GitPortError extends Error {
  readonly failure: GitPortFailure

  constructor(failure: GitPortFailure) {
    super(GitPortError.describe(failure))
    this.name = "GitPortError"
    this.failure = failure
  }

  static describe(failure: GitPortFailure): string {
    switch (failure.kind) {
      case "not_a_repository":
        return `not inside a Git repository: ${failure.cwd}`
      case "common_dir_missing":
        return `Git common directory not found at ${failure.path}`
      case "detached_head":
        return `repository is in detached HEAD state: ${failure.cwd}`
      case "base_branch_missing":
        return `base branch not found locally or at origin: ${failure.baseBranch}`
      case "git_unavailable":
        return `git command unavailable: ${failure.error}`
      case "command_failed":
        return `git command failed: ${failure.stderr.trim() || "<no stderr>"}`
      default: {
        const exhaustive: never = failure
        throw new Error(`unhandled git failure: ${(exhaustive as { kind: string }).kind}`)
      }
    }
  }
}

export type RunGitOptions = {
  readonly runner: CommandRunnerPort
  readonly env?: Readonly<Record<string, string>>
}

const runGit = async (
  runner: CommandRunnerPort,
  args: ReadonlyArray<string>,
  cwd: string,
  env?: Readonly<Record<string, string>>,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }> => {
  return runner.spawn({
    program: "git",
    args,
    cwd,
    env: env ?? {},
  })
}

const GIt_NOT_FOUND_PATTERN = /\bENOENT\b/

const isNotFound = (stderr: string): boolean => GIt_NOT_FOUND_PATTERN.test(stderr)

export const gitCommonDir = async (input: {
  readonly runner: CommandRunnerPort
  readonly cwd: string
}): Promise<string> => {
  const result = await runGit(input.runner, ["rev-parse", "--git-common-dir"], input.cwd)
  if (result.exitCode !== 0) {
    const stderr = result.stderr
    if (isNotFound(stderr)) {
      throw new GitPortError({ kind: "git_unavailable", cwd: input.cwd, error: stderr })
    }
    throw new GitPortError({ kind: "not_a_repository", cwd: input.cwd })
  }
  const raw = result.stdout.trim()
  if (raw.length === 0) {
    throw new GitPortError({ kind: "not_a_repository", cwd: input.cwd })
  }
  const absolute = raw.startsWith("/") ? raw : resolve(input.cwd, raw)
  let resolved: string
  try {
    resolved = await realpath(absolute)
  } catch {
    throw new GitPortError({ kind: "common_dir_missing", cwd: input.cwd, path: absolute })
  }
  return resolved
}

export const gitCurrentBranch = async (input: {
  readonly runner: CommandRunnerPort
  readonly cwd: string
}): Promise<string> => {
  const result = await runGit(
    input.runner,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    input.cwd,
  )
  if (result.exitCode !== 0) {
    if (isNotFound(result.stderr)) {
      throw new GitPortError({ kind: "git_unavailable", cwd: input.cwd, error: result.stderr })
    }
    throw new GitPortError({ kind: "detached_head", cwd: input.cwd })
  }
  const branch = result.stdout.trim()
  if (branch.length === 0) {
    throw new GitPortError({ kind: "detached_head", cwd: input.cwd })
  }
  return branch
}

export const gitCurrentBaseSha = async (input: {
  readonly runner: CommandRunnerPort
  readonly cwd: string
  readonly baseBranch: string
}): Promise<string> => {
  const localResult = await runGit(
    input.runner,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${input.baseBranch}^{commit}`],
    input.cwd,
  )
  if (localResult.exitCode === 0) {
    const sha = localResult.stdout.trim()
    if (sha.length > 0) {
      return sha
    }
  }
  const remoteResult = await runGit(
    input.runner,
    [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${input.baseBranch}^{commit}`,
    ],
    input.cwd,
  )
  if (remoteResult.exitCode === 0) {
    const sha = remoteResult.stdout.trim()
    if (sha.length > 0) {
      return sha
    }
  }
  throw new GitPortError({
    kind: "base_branch_missing",
    cwd: input.cwd,
    baseBranch: input.baseBranch,
  })
}

export const gitWorktreeIsClean = async (input: {
  readonly runner: CommandRunnerPort
  readonly cwd: string
}): Promise<boolean> => {
  const result = await runGit(
    input.runner,
    ["status", "--porcelain", "--untracked-files=all"],
    input.cwd,
  )
  if (result.exitCode !== 0) {
    throw new GitPortError({
      kind: "command_failed",
      cwd: input.cwd,
      stderr: result.stderr || "git status --porcelain failed",
    })
  }
  return result.stdout.trim().length === 0
}

const gitSwitchBranch = async (input: {
  readonly runner: CommandRunnerPort
  readonly cwd: string
  readonly branch: string
  readonly create: boolean
}): Promise<void> => {
  const args = input.create ? ["switch", "--create", input.branch] : ["switch", input.branch]
  const result = await runGit(input.runner, args, input.cwd)
  if (result.exitCode !== 0) {
    throw new GitPortError({ kind: "command_failed", cwd: input.cwd, stderr: result.stderr || result.stdout })
  }
}

export type SystemGitOptions = RunGitOptions

export const systemGitPort = (options: SystemGitOptions): GitPort => ({
  commonDir: async (input): Promise<string> =>
    gitCommonDir({ runner: options.runner, cwd: input.cwd }),
  currentBranch: async (input): Promise<string> =>
    gitCurrentBranch({ runner: options.runner, cwd: input.cwd }),
  currentBaseSha: async (input): Promise<string> =>
    gitCurrentBaseSha({
      runner: options.runner,
      cwd: input.cwd,
      baseBranch: input.baseBranch,
    }),
  worktreeIsClean: async (input): Promise<boolean> =>
    gitWorktreeIsClean({ runner: options.runner, cwd: input.cwd }),
  createBranch: async (input): Promise<void> =>
    gitSwitchBranch({ runner: options.runner, cwd: input.cwd, branch: input.branch, create: true }),
  checkoutBranch: async (input): Promise<void> =>
    gitSwitchBranch({ runner: options.runner, cwd: input.cwd, branch: input.branch, create: false }),
})
