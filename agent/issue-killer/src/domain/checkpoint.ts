import type { SessionId } from "./session-id"
import type { LifecycleState } from "./lifecycle"

export type IssueNumber = number & { readonly __brand: "IssueNumber" }
export type HuNumber = number & { readonly __brand: "HuNumber" }
export type TicketNumber = number & { readonly __brand: "TicketNumber" }

export const asIssueNumber = (value: number): IssueNumber | null =>
  Number.isInteger(value) && value > 0 ? (value as IssueNumber) : null

export const asHuNumber = (value: number): HuNumber | null =>
  Number.isInteger(value) && value > 0 ? (value as HuNumber) : null

export const asTicketNumber = (value: number): TicketNumber | null =>
  Number.isInteger(value) && value > 0 ? (value as TicketNumber) : null

export type CheckpointIssueIdentity =
  | { readonly kind: "github"; readonly number: IssueNumber }
  | { readonly kind: "azure_hu"; readonly hu: HuNumber; readonly ticket: TicketNumber }

export type CheckpointIdentity =
  | { readonly kind: "github"; readonly number: IssueNumber }
  | { readonly kind: "azure_hu"; readonly hu: HuNumber; readonly ticket?: TicketNumber }
  | { readonly kind: "unknown" }

export type Checkpoint = {
  readonly pid: number
  readonly iteration: number
  readonly identity: CheckpointIdentity
  readonly branch: string
  readonly baseBranch: string
  readonly baseSha: string
  readonly profileName: string
  readonly cli: string
  readonly model: string
  readonly command: string
  readonly sessionId?: SessionId
  readonly sessionCli?: string
  readonly selectedProfile?: string
  readonly fallbackChain: ReadonlyArray<string>
  readonly fallbackRemaining: ReadonlyArray<string>
  readonly fallbackPosition: number
  readonly failedProfile?: string
  readonly nextProfile?: string
  readonly fallbackFailure?: string
  readonly huBranch?: string
  readonly huBranchCategory?: "feature" | "hotfix" | "refactor"
  readonly huBranchOrigin?: string
  readonly huBranchOriginSha?: string
  readonly state: LifecycleState
  readonly updatedAt: string
  readonly formatVersion: 1 | 2
}

export const CHECKPOINT_FORMAT_VERSION: 1 | 2 = 2

export const emptyCheckpoint = (input: {
  readonly pid: number
  readonly iteration: number
  readonly branch: string
  readonly baseBranch: string
  readonly baseSha: string
  readonly profileName: string
  readonly cli: string
  readonly model: string
  readonly command: string
  readonly state: LifecycleState
  readonly updatedAt: string
}): Checkpoint => ({
  pid: input.pid,
  iteration: input.iteration,
  identity: { kind: "unknown" },
  branch: input.branch,
  baseBranch: input.baseBranch,
  baseSha: input.baseSha,
  profileName: input.profileName,
  cli: input.cli,
  model: input.model,
  command: input.command,
  fallbackChain: [],
  fallbackRemaining: [],
  fallbackPosition: 0,
  state: input.state,
  updatedAt: input.updatedAt,
  formatVersion: CHECKPOINT_FORMAT_VERSION,
})
