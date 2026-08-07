import type { Checkpoint } from "./checkpoint"
import type { ExecutionProfile } from "./execution-profile"
import type { LifecycleState } from "./lifecycle"
import type { ProviderFailureCategory } from "./provider-failure"
import type { SessionId } from "./session-id"
import type {
  AzureDeliveryScope,
  CompletionEvidence,
  CompletionVerification,
  TrackerIdentity,
  TrackerSelection,
} from "./tracker"

export type TrackerPort = {
  readonly kind: "github" | "azure"
  selectEligibleIssue(input: {
    readonly hu?: number
    readonly baseBranch: string
    readonly currentState: LifecycleState
  }): Promise<TrackerSelection>
  claimIssue(input: { readonly identity: TrackerIdentity }): Promise<void>
  verifyCompletion(input: {
    readonly identity: TrackerIdentity
    readonly branch: string
    readonly baseBranch: string
  }): Promise<CompletionVerification>
  closeIssue(input: { readonly identity: TrackerIdentity }): Promise<void>
  readEvidenceScope(input: { readonly hu: number }): Promise<AzureDeliveryScope>
  evidenceForCompletion(input: {
    readonly identity: TrackerIdentity
    readonly evidence: CompletionEvidence
  }): Promise<void>
}

export type OpenCodeRuntimePort = {
  readonly host: "127.0.0.1"
  readonly ephemeralPort: true
  health(): Promise<{ readonly version: string }>
  createSession(input: {
    readonly directory: string
    readonly scope?: OpenCodeSessionScope
  }): Promise<{ readonly sessionId: SessionId; readonly directory: string }>
  getSession(input: {
    readonly sessionId: SessionId
    readonly directory: string
    readonly scope?: OpenCodeSessionScope
  }): Promise<{ readonly sessionId: SessionId; readonly directory: string; readonly title: string }>
  abortSession(input: { readonly sessionId: SessionId; readonly directory: string }): Promise<void>
  deleteSession(input: { readonly sessionId: SessionId; readonly directory: string }): Promise<void>
  sendPrompt(input: {
    readonly sessionId: SessionId
    readonly directory: string
    readonly model: { readonly providerID: string; readonly modelID: string }
    readonly variant?: string
    readonly promptText: string
  }): Promise<{ readonly runId: string }>
  subscribeEvents(input: {
    readonly directory: string
    readonly sessionId: SessionId
  }): AsyncIterable<unknown>
  close(): Promise<void>
}

export type OpenCodeSessionScope = {
  readonly issue: number
  readonly branch: string
  readonly baseBranch: string
  readonly baseSha: string
  readonly profile: string
}

export type GitPort = {
  commonDir(input: { readonly cwd: string }): Promise<string>
  currentBranch(input: { readonly cwd: string }): Promise<string>
  currentBaseSha(input: { readonly cwd: string; readonly baseBranch: string }): Promise<string>
  worktreeIsClean(input: { readonly cwd: string }): Promise<boolean>
}

export type CheckpointStorePort = {
  load(input: {
    readonly gitCommonDir: string
    readonly runnerName: string
  }): Promise<Checkpoint | null>
  save(input: {
    readonly gitCommonDir: string
    readonly runnerName: string
    readonly checkpoint: Checkpoint
  }): Promise<void>
  clear(input: { readonly gitCommonDir: string; readonly runnerName: string }): Promise<void>
}

export type LockOwner = {
  readonly pid: number
  readonly token: string
  readonly repository: string
  readonly startedAt: string
}

export type LockSnapshot = {
  readonly owner: LockOwner
  readonly state: LifecycleState
  readonly issueLabel?: string
  readonly updatedAt: string
}

export type RepositoryLockPort = {
  acquire(input: {
    readonly gitCommonDir: string
    readonly owner: LockOwner
  }): Promise<{ readonly acquired: true } | { readonly acquired: false; readonly holder: LockSnapshot | null }>
  release(input: { readonly gitCommonDir: string; readonly token: string }): Promise<boolean>
  read(input: { readonly gitCommonDir: string }): Promise<LockSnapshot | null>
  isStale(input: { readonly gitCommonDir: string; readonly now: string }): Promise<boolean>
  writeStatus(input: {
    readonly gitCommonDir: string
    readonly token: string
    readonly status: LifecycleState
    readonly issueLabel?: string
    readonly updatedAt: string
  }): Promise<void>
}

export type ClockPort = {
  now(): string
  sleep(input: { readonly millis: number; readonly signal?: AbortSignal }): Promise<void>
}

export type CommandRunnerPort = {
  spawn(input: {
    readonly program: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly signal?: AbortSignal
    readonly timeoutMs?: number
  }): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>
}

export type ProviderFailureClassifierPort = {
  classify(input: { readonly error: unknown }): ProviderFailureCategory
  readonly knownStatuses: ReadonlySet<number>
}

export type ProfileCatalogPort = {
  resolveDefaultProfile(input: { readonly defaultProfile: string }): ExecutionProfile | null
  resolveProfile(input: { readonly profileName: string }): ExecutionProfile | null
  listProfileNames(): ReadonlyArray<string>
}

export type HarnessLogPort = {
  startRun(input: { readonly runId: string; readonly repository: string }): Promise<void>
  appendEvent(input: { readonly runId: string; readonly payload: Readonly<Record<string, unknown>> }): Promise<void>
  endRun(input: { readonly runId: string; readonly status: LifecycleState }): Promise<void>
  readRunPath(input: { readonly runId: string }): string
}

export type TerminalPort = {
  confirmDestructive(input: {
    readonly prompt: string
    readonly confirmationToken: string
    readonly profiles: ReadonlyArray<{ readonly name: string; readonly label: string }>
  }): Promise<boolean>
  selectProfile(input: {
    readonly defaultProfile: string
    readonly profiles: ReadonlyArray<{ readonly name: string; readonly label: string }>
  }): Promise<string>
  isInteractive(): boolean
}
