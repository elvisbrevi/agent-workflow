import type { ExecutionProfile } from "../domain/execution-profile"
import { WORKER_STATUS_EXIT_CODE, type WorkerOutcome, type WorkerStatus } from "../domain/outcome"
import type { Checkpoint, CheckpointIdentity } from "../domain/checkpoint"
import { emptyCheckpoint } from "../domain/checkpoint"
import type {
  CheckpointStorePort,
  GitPort,
  LockOwner,
  RepositoryLockPort,
  TrackerPort,
} from "../domain/ports"
import type { LifecycleState } from "../domain/lifecycle"
import type { SessionId } from "../domain/session-id"
import type { CompletionVerification, TrackerIdentity, TrackerSelection } from "../domain/tracker"
import { redactMultiline } from "../system/redaction"

export type WorkerRunInput = {
  readonly issue: number
  readonly branch: string
  readonly baseBranch: string
  readonly baseSha: string
  readonly profile: ExecutionProfile
  readonly promptText: string
  readonly signal?: AbortSignal
  readonly onSessionCaptured: (sessionId: SessionId) => Promise<void>
}

export type WorkerRunResult = {
  readonly sessionId: SessionId
  readonly outcome: WorkerOutcome | null
}

export type SupervisorInput = {
  readonly directory: string
  readonly baseBranch: string
  readonly profile: ExecutionProfile
  readonly iterationLimit: number
  readonly runnerName: string
  readonly owner: LockOwner
  readonly tracker: TrackerPort
  readonly git: GitPort
  readonly checkpoint: CheckpointStorePort
  readonly lock: RepositoryLockPort
  readonly now: () => string
  readonly worker: (input: WorkerRunInput) => Promise<WorkerRunResult>
  readonly deleteSession: (input: { readonly sessionId: SessionId; readonly directory: string }) => Promise<void>
  readonly promptText?: string
  readonly signal?: AbortSignal
  readonly progressIntervalSeconds?: number
  readonly onHeartbeat?: (input: { readonly issue?: number; readonly elapsedMs: number }) => void
}

export type SupervisorResult = {
  readonly status: WorkerStatus
  readonly exitCode: number
  readonly issue?: number
  readonly reason?: string
}

const lifecycleForStatus = (status: WorkerStatus): LifecycleState => {
  switch (status) {
    case "ISSUE_COMPLETED": return "issue_completed"
    case "QUEUE_EMPTY": return "queue_empty"
    case "BLOCKED": return "blocked"
    case "FAILED": return "failed"
    case "RECOVERY_REQUIRED": return "recovery_required"
  }
}

const identityForCheckpoint = (identity: TrackerIdentity): CheckpointIdentity => {
  switch (identity.kind) {
    case "github":
      return identity
    case "azure_ticket":
      return { kind: "azure_hu", hu: identity.hu, ticket: identity.ticket }
  }
}

const identityNumber = (identity: TrackerIdentity): number =>
  identity.kind === "github" ? identity.number : identity.ticket

const statusResult = (status: WorkerStatus, issue?: number, reason?: string, exitCode?: number): SupervisorResult => ({
  status,
  exitCode: exitCode ?? WORKER_STATUS_EXIT_CODE[status],
  ...(issue === undefined ? {} : { issue }),
  ...(reason === undefined ? {} : { reason: redactMultiline(reason).text.slice(0, 256) }),
})

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

const failureFromError = (error: unknown, issue: number): SupervisorResult => {
  const message = errorMessage(error)
  if (/cancel|abort|permission/i.test(message)) return statusResult("BLOCKED", issue, message)
  if (/malformed|invalid or contradictory worker outcome/i.test(message)) {
    return statusResult("FAILED", issue, message)
  }
  if (/drift|checkpoint|lock/i.test(message)) {
    return statusResult("RECOVERY_REQUIRED", issue, message)
  }
  return statusResult("FAILED", issue, message)
}

const completionIsVerified = (result: CompletionVerification): boolean => result.kind === "verified"

const saveCheckpoint = async (input: {
  readonly supervisor: SupervisorInput
  readonly checkpoint: Checkpoint
  readonly state: LifecycleState
}): Promise<Checkpoint> => {
  const value: Checkpoint = { ...input.checkpoint, state: input.state, updatedAt: input.supervisor.now() }
  await input.supervisor.checkpoint.save({
    gitCommonDir: await input.supervisor.git.commonDir({ cwd: input.supervisor.directory }),
    runnerName: input.supervisor.runnerName,
    checkpoint: value,
  })
  await input.supervisor.lock.writeStatus({
    gitCommonDir: await input.supervisor.git.commonDir({ cwd: input.supervisor.directory }),
    token: input.supervisor.owner.token,
    status: input.state,
    issueLabel: value.identity.kind === "github" ? String(value.identity.number) : undefined,
    updatedAt: value.updatedAt,
  })
  return value
}

const readCompletionReason = (result: CompletionVerification): string => {
  switch (result.kind) {
    case "verified": return "completion verified"
    case "issue_still_open": return "issue is still open"
    case "no_attributable_pr": return "no attributable pull request found"
    case "multiple_prs": return `multiple pull requests found: ${result.count}`
    case "pr_unmerged": return `pull request ${result.prNumber} is not merged`
    case "wrong_base_branch": return `pull request targets ${result.actual}, expected ${result.expected}`
    case "tracker_unreachable": return result.error
    case "drift": return result.details
  }
}

const defaultPrompt = "Follow the worker contract in PROMPT.md."

export const runVerticalSlice = async (input: SupervisorInput): Promise<SupervisorResult> => {
  const commonDir = await input.git.commonDir({ cwd: input.directory })
  const clean = await input.git.worktreeIsClean({ cwd: input.directory })
  if (!clean) return statusResult("RECOVERY_REQUIRED", undefined, "worktree is not clean")
  if ((await input.git.currentBranch({ cwd: input.directory })) !== input.baseBranch) {
    return statusResult("RECOVERY_REQUIRED", undefined, "current branch is not the configured base branch")
  }

  const existing = await input.checkpoint.load({ gitCommonDir: commonDir, runnerName: input.runnerName })
  if (existing !== null) {
    return statusResult("RECOVERY_REQUIRED", undefined, "an existing checkpoint requires explicit recovery")
  }

  const acquired = await input.lock.acquire({ gitCommonDir: commonDir, owner: input.owner })
  if (!acquired.acquired) return statusResult("BLOCKED", undefined, "another issue-killer run owns the repository lock")

  let completed = 0
  let lastIssue: number | undefined
  try {
    await input.lock.writeStatus({
      gitCommonDir: commonDir,
      token: input.owner.token,
      status: "starting",
      updatedAt: input.now(),
    })

    while (input.iterationLimit === 0 || completed < input.iterationLimit) {
      if (input.signal?.aborted) {
        await input.lock.writeStatus({
          gitCommonDir: commonDir,
          token: input.owner.token,
          status: "blocked",
          updatedAt: input.now(),
        })
        return statusResult("BLOCKED", lastIssue, "run was cancelled")
      }
      const selection = await input.tracker.selectEligibleIssue({
        baseBranch: input.baseBranch,
        currentState: "starting",
      })
      if (selection.kind !== "selected") {
        const status = selection.kind === "empty" ? "QUEUE_EMPTY" : selection.kind === "blocked" ? "BLOCKED" : "RECOVERY_REQUIRED"
        await input.lock.writeStatus({
          gitCommonDir: commonDir,
          token: input.owner.token,
          status: lifecycleForStatus(status),
          updatedAt: input.now(),
        })
        await input.checkpoint.clear({ gitCommonDir: commonDir, runnerName: input.runnerName })
        return statusResult(status, lastIssue, selection.reason)
      }
      if (input.signal?.aborted) return statusResult("BLOCKED", lastIssue, "run was cancelled")

      const issue = identityNumber(selection.identity)
      lastIssue = issue
      let branch = await input.git.currentBranch({ cwd: input.directory })
      if (branch === input.baseBranch && input.git.createBranch !== undefined) {
        branch = `issue-${issue}`
        await input.git.createBranch({ cwd: input.directory, branch })
      }
      const baseSha = await input.git.currentBaseSha({ cwd: input.directory, baseBranch: input.baseBranch })
      let checkpoint = emptyCheckpoint({
        pid: input.owner.pid,
        iteration: completed + 1,
        branch,
        baseBranch: input.baseBranch,
        baseSha,
        profileName: input.profile.name,
        cli: input.profile.cli,
        model: `${input.profile.providerID}/${input.profile.modelID}`,
        command: input.profile.command,
        state: "issue_selected",
        updatedAt: input.now(),
      })
      checkpoint = { ...checkpoint, identity: identityForCheckpoint(selection.identity) }
      checkpoint = await saveCheckpoint({ supervisor: input, checkpoint, state: "issue_selected" })
      await input.tracker.claimIssue({ identity: selection.identity })
      if (input.signal?.aborted) {
        await saveCheckpoint({ supervisor: input, checkpoint, state: "blocked" }).catch(() => undefined)
        return statusResult("BLOCKED", issue, "run was cancelled")
      }

      try {
        const workerInput: WorkerRunInput = {
          issue,
          branch,
          baseBranch: input.baseBranch,
          baseSha,
          profile: input.profile,
          promptText: input.promptText ?? defaultPrompt,
          signal: input.signal,
          onSessionCaptured: async (sessionId) => {
            checkpoint = await saveCheckpoint({
              supervisor: input,
              checkpoint: { ...checkpoint, sessionId },
              state: "mutating",
            })
          },
        }
        const startedAt = Date.now()
        const intervalSeconds = input.progressIntervalSeconds ?? 0
        const heartbeat = intervalSeconds > 0
          ? setInterval(() => input.onHeartbeat?.({ issue, elapsedMs: Date.now() - startedAt }), intervalSeconds * 1000)
          : undefined
        heartbeat?.unref?.()
        let worker: WorkerRunResult
        try {
          worker = await input.worker(workerInput)
        } finally {
          if (heartbeat !== undefined) clearInterval(heartbeat)
        }
        checkpoint = { ...checkpoint, sessionId: worker.sessionId }
        if (input.signal?.aborted) {
          await saveCheckpoint({ supervisor: input, checkpoint, state: "blocked" }).catch(() => undefined)
          return statusResult("BLOCKED", issue, "run was cancelled")
        }
        if (worker.outcome === null || worker.outcome.issue !== issue) {
          await saveCheckpoint({ supervisor: input, checkpoint, state: "failed" }).catch(() => undefined)
          return statusResult("FAILED", issue, "worker did not emit a valid outcome for the pinned issue")
        }
        if (worker.outcome.status !== "ISSUE_COMPLETED") {
          if (worker.outcome.status === "QUEUE_EMPTY") {
            await saveCheckpoint({ supervisor: input, checkpoint, state: "failed" }).catch(() => undefined)
            return statusResult("FAILED", issue, "worker emitted QUEUE_EMPTY for a pinned issue")
          }
          await saveCheckpoint({
            supervisor: input,
            checkpoint,
            state: lifecycleForStatus(worker.outcome.status),
          }).catch(() => undefined)
          return statusResult(worker.outcome.status, issue, worker.outcome.summary)
        }

        const verification = await input.tracker.verifyCompletion({
          identity: selection.identity,
          branch,
          baseBranch: input.baseBranch,
        })
        if (!completionIsVerified(verification)) {
          await saveCheckpoint({ supervisor: input, checkpoint, state: "recovery_required" }).catch(() => undefined)
          return statusResult("RECOVERY_REQUIRED", issue, readCompletionReason(verification))
        }
        checkpoint = await saveCheckpoint({ supervisor: input, checkpoint, state: "verified" })
        if (input.signal?.aborted) {
          await saveCheckpoint({ supervisor: input, checkpoint, state: "blocked" }).catch(() => undefined)
          return statusResult("BLOCKED", issue, "run was cancelled after completion verification")
        }
        try {
          await input.deleteSession({ sessionId: worker.sessionId, directory: input.directory })
        } catch (error) {
          return statusResult("RECOVERY_REQUIRED", issue, `verified completion cleanup failed: ${errorMessage(error)}`)
        }
        if (!(await input.git.worktreeIsClean({ cwd: input.directory }))) {
          return statusResult("RECOVERY_REQUIRED", issue, "worktree is dirty after verified completion")
        }
        const currentBranch = await input.git.currentBranch({ cwd: input.directory })
        if (currentBranch !== input.baseBranch) {
          if (input.git.checkoutBranch === undefined) {
            return statusResult("RECOVERY_REQUIRED", issue, "unable to return to the configured base branch")
          }
          try {
            await input.git.checkoutBranch({ cwd: input.directory, branch: input.baseBranch })
          } catch (error) {
            return statusResult("RECOVERY_REQUIRED", issue, `unable to return to the configured base branch: ${errorMessage(error)}`)
          }
        }
        await input.checkpoint.clear({ gitCommonDir: commonDir, runnerName: input.runnerName })
        completed += 1
        if (input.iterationLimit > 0 && completed >= input.iterationLimit) {
          await input.lock.writeStatus({
            gitCommonDir: commonDir,
            token: input.owner.token,
            status: "issue_completed",
            issueLabel: String(issue),
            updatedAt: input.now(),
          })
          return statusResult("ISSUE_COMPLETED", issue, undefined, 3)
        }
      } catch (error) {
        const failure = failureFromError(error, issue)
        await saveCheckpoint({
          supervisor: input,
          checkpoint,
          state: lifecycleForStatus(failure.status),
        }).catch(() => undefined)
        return failure
      }
    }
    return statusResult("ISSUE_COMPLETED", lastIssue)
  } finally {
    await input.lock.release({ gitCommonDir: commonDir, token: input.owner.token }).catch(() => false)
  }
}
