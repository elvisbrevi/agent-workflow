#!/usr/bin/env bun

import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import {
  expandHomePath,
  loadConfig,
  resolveConfigPath,
} from "../src/config/index"
import { createGithubTracker, preflightGithubTracker } from "../src/tracker/github"
import { createOpenCodeRuntime, runOpenCodeWorkerSession, type OpenCodeRuntime } from "../src/opencode/runtime"
import { createHarnessLog } from "../src/opencode/harness-log"
import { runVerticalSlice, type SupervisorResult } from "../src/app/compose"
import { parseCliArgs } from "../src/config/cli-args"
import { generateLockToken, repositoryLockPort } from "../src/state/repository-lock"
import { fileCheckpointStore } from "../src/state/checkpoint-store"
import { systemGitPort } from "../src/system/git"
import { bunCommandRunner } from "../src/system/command"
import { WORKER_STATUS_EXIT_CODE } from "../src/domain/outcome"
import type { ExecutionProfile } from "../src/domain/execution-profile"

const env = process.env as Readonly<Record<string, string | undefined>>
const commandRunner = bunCommandRunner()
const git = systemGitPort({ runner: commandRunner })

const environment = (argv: ReadonlyArray<string>, configPath: string, cwd: string) => ({
  argv,
  env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  home: env.HOME ?? "",
  cwd,
  configPath,
  fileExists: async (path: string): Promise<boolean> => {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  },
  expandHome: (path: string): string => expandHomePath(path, env.HOME ?? ""),
  fs: {
    mkdir: async (path: string): Promise<void> => { await mkdir(path, { recursive: true }) },
    writeFile: async (path: string, body: string): Promise<void> => { await writeFile(path, body) },
  },
})

const positiveEnv = (name: string, fallback: number): number => {
  const value = env[name]
  if (value === undefined || value === "") return fallback
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a positive integer or 0`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a positive integer or 0`)
  return parsed
}

class CliOutcome extends Error {
  readonly status: keyof typeof WORKER_STATUS_EXIT_CODE
  readonly reason?: string

  constructor(status: keyof typeof WORKER_STATUS_EXIT_CODE, reason?: string) {
    super(reason ?? status)
    this.name = "CliOutcome"
    this.status = status
    this.reason = reason
  }
}

const stop = (status: keyof typeof WORKER_STATUS_EXIT_CODE, reason: string): never => {
  throw new CliOutcome(status, reason)
}

const output = (status: keyof typeof WORKER_STATUS_EXIT_CODE, reason?: string, exitCode?: number): void => {
  if (reason !== undefined) process.stderr.write(`issue-killer V2: ${reason}\n`)
  process.stdout.write(`ISSUE_KILLER_STATUS=${status}\n`)
  process.exitCode = exitCode ?? WORKER_STATUS_EXIT_CODE[status]
}

const harnessLifecycleFor = (status: SupervisorResult["status"]): "issue_completed" | "queue_empty" | "blocked" | "failed" | "recovery_required" => {
  switch (status) {
    case "ISSUE_COMPLETED": return "issue_completed"
    case "QUEUE_EMPTY": return "queue_empty"
    case "BLOCKED": return "blocked"
    case "FAILED": return "failed"
    case "RECOVERY_REQUIRED": return "recovery_required"
  }
}

const main = async (): Promise<SupervisorResult> => {
  const argv = process.argv.slice(2)
  const parsed = parseCliArgs(argv)
  if (parsed.kind === "error") return stop("FAILED", parsed.message)
  const args = parsed.args
  if (args.extras.length > 1) return stop("FAILED", "at most one repository path may be supplied")
  const directory = resolve(args.extras[0] ?? process.cwd())
  const home = env.HOME ?? ""
  const configPath = resolveConfigPath({ argv, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)), home })
  const loaded = await loadConfig(environment(argv, configPath, directory))
  if (loaded.kind === "error") return stop("FAILED", loaded.message)
  if (args.hu !== null) return stop("FAILED", "--hu is only supported for Azure DevOps")
  if (!loaded.config.destructiveAuthorized) {
    return stop("BLOCKED", "destructive execution requires --assume-yes and a profile with auto_approve=true")
  }

  const profile = loaded.config.profiles.get(loaded.config.defaultProfile) as ExecutionProfile | undefined
  if (profile === undefined) return stop("FAILED", "default execution profile is unavailable")
  const baseBranch = args.baseBranch ?? env.ISSUE_RUNNER_BASE_BRANCH ?? "main"
  const iterationLimit = args.iterationLimit ?? positiveEnv("ISSUE_RUNNER_MAX_ITERATIONS", 0)
  const preflight = await preflightGithubTracker({ runner: commandRunner, git, cwd: directory })
  if (preflight.kind !== "ok") return stop("BLOCKED", preflight.message)
  const tracker = createGithubTracker({ runner: commandRunner, git, cwd: directory, slug: preflight.slug })
  const clock = { now: (): string => new Date().toISOString() }
  const checkpoint = fileCheckpointStore({ clock })
  const lock = repositoryLockPort()
  const harness = createHarnessLog({ logDir: loaded.config.expandedLogDir })
  const promptAsset = await readFile(new URL("../PROMPT.md", import.meta.url), "utf8")
  const runId = `issue-killer-${randomUUID()}`
  let runtime: OpenCodeRuntime | null = null
  let harnessStarted = false
  let harnessEnded = false
  const abortController = new AbortController()
  const onInterrupt = (): void => abortController.abort()
  process.once("SIGINT", onInterrupt)
  process.once("SIGTERM", onInterrupt)

  try {
    await harness.startRun({ runId, repository: directory })
    harnessStarted = true
    runtime = await createOpenCodeRuntime({ directory, autonomous: true })
    const activeRuntime = runtime
    const result = await runVerticalSlice({
      directory,
      baseBranch,
      profile,
      iterationLimit,
      runnerName: "issue-killer",
      owner: {
        pid: process.pid,
        token: generateLockToken(process.pid),
        repository: directory,
        startedAt: clock.now(),
      },
      tracker,
      git,
      checkpoint,
      lock,
      now: clock.now,
      signal: abortController.signal,
      progressIntervalSeconds: positiveEnv("ISSUE_RUNNER_PROGRESS_INTERVAL", 30),
      onHeartbeat: ({ issue, elapsedMs }) => {
        process.stderr.write(`[issue-killer] heartbeat: ${issue === undefined ? "starting" : `issue ${issue}`} (${Math.floor(elapsedMs / 1000)}s)\n`)
      },
      worker: async (input) => {
        const promptText = [
          promptAsset,
          "",
          `The host has pinned GitHub issue #${input.issue}; work on exactly this issue and no other issue.`,
          `Read only issue #${input.issue} for its acceptance criteria.`,
          `Use exactly one source branch (prefer ${input.branch}) and one pull request targeting ${input.baseBranch}.`,
          "Use /implement, /tdd where a suitable seam exists, and /code-review in that order.",
          "Do not print ISSUE_COMPLETED until the pull request is merged into the configured base branch.",
        ].join("\n")
        const session = await runOpenCodeWorkerSession({
          runtime: activeRuntime,
          directory,
          scope: {
            issue: input.issue,
            branch: input.branch,
            baseBranch: input.baseBranch,
            baseSha: input.baseSha,
            profile: input.profile.name,
          },
          expectedIssue: input.issue,
          model: { providerID: input.profile.providerID, modelID: input.profile.modelID },
          variant: input.profile.variant,
          promptText,
          autonomous: true,
          signal: input.signal,
          harnessLog: harness,
          runId,
          harnessLifecycle: false,
          onSessionCaptured: input.onSessionCaptured,
        })
        return { sessionId: session.sessionId, outcome: session.events.outcome }
      },
      deleteSession: async (input) => activeRuntime.deleteSession(input),
      promptText: promptAsset,
    })
    await harness.endRun({ runId, status: harnessLifecycleFor(result.status) })
    harnessEnded = true
    return result
  } finally {
    if (harnessStarted && !harnessEnded) await harness.endRun({ runId, status: "failed" }).catch(() => undefined)
    process.removeListener("SIGINT", onInterrupt)
    process.removeListener("SIGTERM", onInterrupt)
    await runtime?.close().catch(() => undefined)
  }
}

try {
  const result = await main()
  output(result.status, result.reason, result.exitCode)
} catch (error: unknown) {
  if (error instanceof CliOutcome) {
    output(error.status, error.reason)
  } else {
    output("FAILED", error instanceof Error ? error.message : String(error))
  }
}
