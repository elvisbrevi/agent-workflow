import type { HuNumber, IssueNumber, TicketNumber } from "./checkpoint"

export type TrackerKind = "github" | "azure"

export type TrackerIdentity =
  | { readonly kind: "github"; readonly number: IssueNumber }
  | { readonly kind: "azure_ticket"; readonly hu: HuNumber; readonly ticket: TicketNumber }

export type TrackerClaim = {
  readonly identity: TrackerIdentity
  readonly claimToken: string
}

export type TrackerSelection =
  | { readonly kind: "selected"; readonly identity: TrackerIdentity }
  | { readonly kind: "empty"; readonly reason: string }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "recovery"; readonly reason: string }

export const identityLabel = (identity: TrackerIdentity): string => {
  switch (identity.kind) {
    case "github":
      return `github issue ${identity.number}`
    case "azure_ticket":
      return `azure HU ${identity.hu} ticket ${identity.ticket}`
    default: {
      const exhaustive: never = identity
      throw new Error(`unhandled tracker identity: ${(exhaustive as { kind: string }).kind}`)
    }
  }
}

export const selectionLabel = (selection: TrackerSelection): string => {
  switch (selection.kind) {
    case "selected":
      return `selected ${identityLabel(selection.identity)}`
    case "empty":
      return `empty queue (${selection.reason})`
    case "blocked":
      return `blocked (${selection.reason})`
    case "recovery":
      return `recovery needed (${selection.reason})`
    default: {
      const exhaustive: never = selection
      throw new Error(`unhandled tracker selection: ${(exhaustive as { kind: string }).kind}`)
    }
  }
}

export const selectionKindOf = (selection: TrackerSelection): TrackerSelection["kind"] => selection.kind

export type CompletionEvidence =
  | {
      readonly kind: "github_pr_merged"
      readonly prNumber: number
      readonly baseRef: string
      readonly mergedAt: string
    }
  | {
      readonly kind: "azure_ticket_completed"
      readonly ticket: TicketNumber
      readonly hu: HuNumber
      readonly integrationBranch: string
      readonly evidence: ReadonlyArray<string>
      readonly effortHours: number
    }

export type CompletionVerification =
  | { readonly kind: "verified"; readonly identity: TrackerIdentity; readonly evidence: CompletionEvidence }
  | { readonly kind: "issue_still_open"; readonly identity: TrackerIdentity }
  | { readonly kind: "no_attributable_pr"; readonly identity: TrackerIdentity }
  | { readonly kind: "multiple_prs"; readonly identity: TrackerIdentity; readonly count: number }
  | { readonly kind: "pr_unmerged"; readonly identity: TrackerIdentity; readonly prNumber: number }
  | {
      readonly kind: "wrong_base_branch"
      readonly identity: TrackerIdentity
      readonly expected: string
      readonly actual: string
    }
  | { readonly kind: "tracker_unreachable"; readonly identity: TrackerIdentity; readonly error: string }
  | { readonly kind: "drift"; readonly identity: TrackerIdentity; readonly details: string }

export const isCompletionVerified = (result: CompletionVerification): boolean => result.kind === "verified"

export const completionReasonLabel = (result: CompletionVerification): string => {
  switch (result.kind) {
    case "verified":
      return `verified (${result.evidence.kind})`
    case "issue_still_open":
      return "issue is still open"
    case "no_attributable_pr":
      return "no attributable pull request found"
    case "multiple_prs":
      return `multiple pull requests found (${result.count})`
    case "pr_unmerged":
      return `pull request ${result.prNumber} is not merged`
    case "wrong_base_branch":
      return `pull request points to ${result.actual}; expected ${result.expected}`
    case "tracker_unreachable":
      return `tracker unreachable: ${result.error}`
    case "drift":
      return `drift detected: ${result.details}`
    default: {
      const exhaustive: never = result
      throw new Error(`unhandled completion verification result: ${(exhaustive as { kind: string }).kind}`)
    }
  }
}

export type AzureDeliveryScope = {
  readonly hu: HuNumber
  readonly tickets: ReadonlyArray<TicketNumber>
  readonly integrationBranch: string
  readonly category: "feature" | "hotfix" | "refactor"
}
