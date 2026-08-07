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
import {
  classifyProviderFailure,
  isFallbackEligible,
  isTransportFailure,
  type ProviderFailureCategory,
} from "../domain/provider-failure"

export type WorkerRunInput = {
  readonly issue: number
  readonly branch: string
  readonly baseBranch: string
  readonly baseSha: string
  readonly profile: ExecutionProfile
  readonly promptText: string
  readonly resumeSessionId?: SessionId
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
  readonly profiles?: ReadonlyMap<string, ExecutionProfile>
  readonly adoptIssue?: TrackerIdentity
  readonly iterationLimit: number
  readonly retryDelaysMs?: ReadonlyArray<number>
  readonly retryLimit?: number
  readonly sleep?: (input: { readonly millis: number; readonly signal?: AbortSignal }) => Promise<void>
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

const trackerIdentityFromCheckpoint = (checkpoint: Checkpoint): TrackerIdentity | null => {
  switch (checkpoint.identity.kind) {
    case "github":
      return checkpoint.identity
    case "azure_hu":
      return checkpoint.identity.ticket === undefined
        ? null
        : { kind: "azure_ticket", hu: checkpoint.identity.hu, ticket: checkpoint.identity.ticket }
    case "unknown":
      return null
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

const profileForFallback = (
  supervisor: SupervisorInput,
  name: string,
): ExecutionProfile | null => supervisor.profiles?.get(name) ?? (name === supervisor.profile.name ? supervisor.profile : null)

const sameSequence = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

const checkpointConfigurationDrift = (
  supervisor: SupervisorInput,
  checkpoint: Checkpoint,
): string | null => {
  if (checkpoint.formatVersion === 1) return null
  const primary = profileForFallback(supervisor, checkpoint.profileName)
  if (primary === null) return "checkpoint profile is unavailable"
  if (checkpoint.cli !== primary.cli || checkpoint.command !== primary.command) {
    return "checkpoint profile configuration drifted"
  }
  if (!sameSequence(checkpoint.fallbackChain, primary.fallbacks)) {
    return "checkpoint fallback chain drifted"
  }
  if (checkpoint.fallbackPosition < 0 || checkpoint.fallbackPosition > checkpoint.fallbackChain.length) {
    return "checkpoint fallback position is invalid"
  }
  const expectedRemaining = checkpoint.fallbackChain.slice(checkpoint.fallbackPosition)
  if (!sameSequence(checkpoint.fallbackRemaining, expectedRemaining)) {
    return "checkpoint fallback position drifted"
  }
  const expectedProfile = checkpoint.fallbackPosition === 0
    ? primary.name
    : checkpoint.fallbackChain[checkpoint.fallbackPosition - 1]
  if (expectedProfile === undefined) return "checkpoint active profile is unavailable"
  const activeProfile = profileForFallback(supervisor, expectedProfile)
  if (activeProfile === null) return `checkpoint profile is unavailable: ${expectedProfile}`
  if (checkpoint.model !== `${activeProfile.providerID}/${activeProfile.modelID}`) {
    return "checkpoint profile configuration drifted"
  }
  if (checkpoint.selectedProfile !== undefined && checkpoint.selectedProfile !== expectedProfile) {
    return "checkpoint selected profile drifted"
  }
  if (checkpoint.nextProfile !== undefined && checkpoint.nextProfile !== expectedProfile) {
    return "checkpoint next profile drifted"
  }
  for (const name of checkpoint.fallbackChain) {
    if (profileForFallback(supervisor, name) === null) return `checkpoint profile is unavailable: ${name}`
  }
  return null
}

type WorkerAttempt = {
  readonly result?: WorkerRunResult
  readonly error?: unknown
  readonly failureCategory: ProviderFailureCategory
}

const runWorkerWithRetries = async (
  supervisor: SupervisorInput,
  input: WorkerRunInput,
): Promise<WorkerAttempt> => {
  const delays = supervisor.retryDelaysMs ?? []
  let retryIndex = 0
  let attemptCount = 0
  while (true) {
    attemptCount += 1
    try {
      return { result: await supervisor.worker(input), failureCategory: "none" }
    } catch (error) {
      const category = classifyProviderFailure(error)
      const belowAttemptLimit = supervisor.retryLimit === undefined || supervisor.retryLimit <= 0 || attemptCount < supervisor.retryLimit
      if (isTransportFailure(error) && belowAttemptLimit && retryIndex < delays.length) {
        const millis = delays[retryIndex] ?? 0
        retryIndex += 1
        await supervisor.sleep?.({ millis, signal: supervisor.signal })
        continue
      }
      return { error, failureCategory: category }
    }
  }
}

const fallbackReason = (category: ProviderFailureCategory, profile: string, next?: string): string =>
  next === undefined
    ? `fallback chain exhausted after ${profile} (${category})`
    : `provider failure ${category} in ${profile}; next profile ${next}`

const runFallbackAttempts = async (input: {
  readonly supervisor: SupervisorInput
  readonly issue: number
  readonly branch: string
  readonly baseBranch: string
  readonly baseSha: string
  readonly checkpoint: Checkpoint
}): Promise<{
  readonly result: WorkerRunResult
  readonly checkpoint: Checkpoint
} | { readonly failure: SupervisorResult; readonly checkpoint: Checkpoint }> => {
  let checkpoint = input.checkpoint
  let activeProfile = profileForFallback(
    input.supervisor,
    checkpoint.nextProfile ?? checkpoint.selectedProfile ?? checkpoint.profileName,
  )
  if (activeProfile === null) {
    return { failure: statusResult("RECOVERY_REQUIRED", input.issue, "checkpoint profile is unavailable"), checkpoint }
  }
  let resumeSessionId = checkpoint.sessionId
  let remaining = checkpoint.fallbackRemaining.length > 0
    ? [...checkpoint.fallbackRemaining]
    : checkpoint.fallbackChain.length > 0
      ? [...checkpoint.fallbackChain.slice(checkpoint.fallbackPosition)]
      : [...activeProfile.fallbacks]

  while (true) {
    const currentProfile = activeProfile
    const attempt = await runWorkerWithRetries(input.supervisor, {
      issue: input.issue,
      branch: input.branch,
      baseBranch: input.baseBranch,
      baseSha: input.baseSha,
      profile: currentProfile,
      promptText: input.supervisor.promptText ?? defaultPrompt,
      resumeSessionId,
      signal: input.supervisor.signal,
      onSessionCaptured: async (sessionId) => {
        checkpoint = await saveCheckpoint({
          supervisor: input.supervisor,
          checkpoint: { ...checkpoint, sessionId, selectedProfile: currentProfile.name },
          state: "mutating",
        })
      },
    })
    if (attempt.result !== undefined) return { result: attempt.result, checkpoint }

    const category = attempt.failureCategory
    if (!isFallbackEligible(category)) {
      return { failure: failureFromError(attempt.error, input.issue), checkpoint }
    }
    const nextName = remaining[0]
    if (nextName === undefined) {
      checkpoint = await saveCheckpoint({
        supervisor: input.supervisor,
        checkpoint: { ...checkpoint, failedProfile: activeProfile.name, fallbackFailure: category },
        state: "fallback_in_progress",
      }).catch(() => checkpoint)
      return {
        failure: statusResult("RECOVERY_REQUIRED", input.issue, fallbackReason(category, activeProfile.name)),
        checkpoint,
      }
    }
    const nextProfile = profileForFallback(input.supervisor, nextName)
    if (nextProfile === null) {
      return {
        failure: statusResult("RECOVERY_REQUIRED", input.issue, `fallback profile is unavailable: ${nextName}`),
        checkpoint,
      }
    }
    remaining = remaining.slice(1)
    checkpoint = await saveCheckpoint({
      supervisor: input.supervisor,
      checkpoint: {
        ...checkpoint,
        selectedProfile: nextProfile.name,
        model: `${nextProfile.providerID}/${nextProfile.modelID}`,
        cli: nextProfile.cli,
        command: nextProfile.command,
        failedProfile: activeProfile.name,
        nextProfile: nextProfile.name,
        fallbackRemaining: remaining,
        fallbackPosition: checkpoint.fallbackPosition + 1,
        fallbackFailure: category,
      },
      state: "fallback_in_progress",
    })
    activeProfile = nextProfile
    resumeSessionId = checkpoint.sessionId
  }
}

export const runVerticalSlice = async (input: SupervisorInput): Promise<SupervisorResult> => {
  const commonDir = await input.git.commonDir({ cwd: input.directory })
  const clean = await input.git.worktreeIsClean({ cwd: input.directory })
  if (!clean) return statusResult("RECOVERY_REQUIRED", undefined, "worktree is not clean")
  const existing = await input.checkpoint.load({ gitCommonDir: commonDir, runnerName: input.runnerName })
  const currentBranch = await input.git.currentBranch({ cwd: input.directory })
  if (existing === null && currentBranch !== input.baseBranch) {
    return statusResult("RECOVERY_REQUIRED", undefined, "current branch is not the configured base branch")
  }
  let recoveryCheckpoint = existing
  if (existing !== null) {
    const recoveredIdentity = trackerIdentityFromCheckpoint(existing) ?? input.adoptIssue
    if (recoveredIdentity === undefined) {
      return statusResult("RECOVERY_REQUIRED", undefined, "checkpoint identity is ambiguous; explicit issue adoption is required")
    }
    if (existing.baseBranch !== input.baseBranch) {
      return statusResult("RECOVERY_REQUIRED", undefined, "checkpoint base branch drifted")
    }
    const currentBaseSha = await input.git.currentBaseSha({ cwd: input.directory, baseBranch: input.baseBranch })
    if (currentBaseSha !== existing.baseSha) {
      return statusResult("RECOVERY_REQUIRED", undefined, "checkpoint base identity drifted")
    }
    if (currentBranch !== existing.branch) {
      return statusResult("RECOVERY_REQUIRED", undefined, "checkpoint branch drifted")
    }
    if (trackerIdentityFromCheckpoint(existing) === null && input.adoptIssue === undefined) {
      return statusResult("RECOVERY_REQUIRED", undefined, "legacy checkpoint requires explicit issue adoption")
    }
    const configurationDrift = checkpointConfigurationDrift(input, existing)
    if (configurationDrift !== null) return statusResult("RECOVERY_REQUIRED", undefined, configurationDrift)
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
      const priorCheckpoint = recoveryCheckpoint
      const selection: TrackerSelection = priorCheckpoint === null
        ? await input.tracker.selectEligibleIssue({
            baseBranch: input.baseBranch,
            currentState: "starting",
          })
        : {
            kind: "selected",
            identity: trackerIdentityFromCheckpoint(priorCheckpoint) ?? input.adoptIssue as TrackerIdentity,
          }
      recoveryCheckpoint = null
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
      let branch = priorCheckpoint?.branch ?? currentBranch
      if (priorCheckpoint === null && branch === input.baseBranch && input.git.createBranch !== undefined) {
        branch = `issue-${issue}`
        await input.git.createBranch({ cwd: input.directory, branch })
      }
      const baseSha = priorCheckpoint?.baseSha ?? await input.git.currentBaseSha({ cwd: input.directory, baseBranch: input.baseBranch })
      let checkpoint = priorCheckpoint ?? emptyCheckpoint({
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
      checkpoint = {
        ...checkpoint,
        identity: identityForCheckpoint(selection.identity),
        selectedProfile: checkpoint.selectedProfile ?? input.profile.name,
        fallbackChain: priorCheckpoint === null ? [...input.profile.fallbacks] : checkpoint.fallbackChain,
        fallbackRemaining: priorCheckpoint === null ? [...input.profile.fallbacks] : checkpoint.fallbackRemaining,
      }
      if (priorCheckpoint === null) {
        checkpoint = await saveCheckpoint({ supervisor: input, checkpoint, state: "issue_selected" })
        await input.tracker.claimIssue({ identity: selection.identity })
      }
      if (input.signal?.aborted) {
        await saveCheckpoint({ supervisor: input, checkpoint, state: "blocked" }).catch(() => undefined)
        return statusResult("BLOCKED", issue, "run was cancelled")
      }

      try {
        const startedAt = Date.now()
        const intervalSeconds = input.progressIntervalSeconds ?? 0
        const heartbeat = intervalSeconds > 0
          ? setInterval(() => input.onHeartbeat?.({ issue, elapsedMs: Date.now() - startedAt }), intervalSeconds * 1000)
          : undefined
        heartbeat?.unref?.()
        let workerAttempt: Awaited<ReturnType<typeof runFallbackAttempts>>
        try {
          workerAttempt = await runFallbackAttempts({
            supervisor: input,
            issue,
            branch,
            baseBranch: input.baseBranch,
            baseSha,
            checkpoint,
          })
        } finally {
          if (heartbeat !== undefined) clearInterval(heartbeat)
        }
        checkpoint = workerAttempt.checkpoint
        if ("failure" in workerAttempt) return workerAttempt.failure
        const worker = workerAttempt.result
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
