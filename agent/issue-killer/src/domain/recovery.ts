import type { LifecycleState } from "./lifecycle"
import type { ProviderFailureCategory } from "./provider-failure"
import type { SessionId } from "./session-id"
import type { TrackerIdentity } from "./tracker"
import { identityLabel } from "./tracker"
import { asHuNumber, asIssueNumber, asTicketNumber } from "./checkpoint"

export type SessionResumeCheck =
  | {
      readonly kind: "resumable"
      readonly sessionId: SessionId
      readonly identity: TrackerIdentity
      readonly directory: string
      readonly branch: string
      readonly baseSha: string
      readonly profileName: string
      readonly runtime: "opencode"
    }
  | { readonly kind: "directory_mismatch"; readonly expected: string; readonly actual: string }
  | { readonly kind: "identity_mismatch"; readonly expected: string; readonly actual: string }
  | { readonly kind: "branch_drift"; readonly expected: string; readonly actual: string }
  | { readonly kind: "base_drift"; readonly expected: string; readonly actual: string }
  | { readonly kind: "profile_drift"; readonly expected: string; readonly actual: string }
  | { readonly kind: "wrong_runtime"; readonly expected: string; readonly actual: string }
  | { readonly kind: "missing"; readonly identity: TrackerIdentity }

export const isResumable = (
  check: SessionResumeCheck,
): check is Extract<SessionResumeCheck, { kind: "resumable" }> => check.kind === "resumable"

export const resumeCheckLabel = (check: SessionResumeCheck): string => {
  switch (check.kind) {
    case "resumable":
      return "session is resumable"
    case "directory_mismatch":
      return `directory mismatch (expected ${check.expected}; got ${check.actual})`
    case "identity_mismatch":
      return `identity mismatch (expected ${check.expected}; got ${check.actual})`
    case "branch_drift":
      return `branch drift (expected ${check.expected}; got ${check.actual})`
    case "base_drift":
      return `base drift (expected ${check.expected}; got ${check.actual})`
    case "profile_drift":
      return `profile drift (expected ${check.expected}; got ${check.actual})`
    case "wrong_runtime":
      return `runtime drift (expected ${check.expected}; got ${check.actual})`
    case "missing":
      return `session missing for ${identityLabel(check.identity)}`
    default: {
      const exhaustive: never = check
      throw new Error(`unhandled resume check: ${(exhaustive as { kind: string }).kind}`)
    }
  }
}

export type ResumeMode =
  | { readonly kind: "resume"; readonly sessionId: SessionId }
  | { readonly kind: "fresh_worker" }
  | { readonly kind: "drift_detected"; readonly reasons: ReadonlyArray<string> }

export const resumeModeFromCheck = (check: SessionResumeCheck): ResumeMode => {
  switch (check.kind) {
    case "resumable":
      return { kind: "resume", sessionId: check.sessionId }
    case "directory_mismatch":
    case "identity_mismatch":
    case "branch_drift":
    case "base_drift":
    case "profile_drift":
    case "wrong_runtime":
      return {
        kind: "drift_detected",
        reasons: [`${check.kind}: expected ${check.expected}; got ${check.actual}`],
      }
    case "missing":
      return { kind: "fresh_worker" }
    default: {
      const exhaustive: never = check
      throw new Error(`unhandled resume check: ${(exhaustive as { kind: string }).kind}`)
    }
  }
}

export type RecoveryDecision =
  | { readonly kind: "resume"; readonly sessionId: SessionId }
  | { readonly kind: "fresh_worker_constrained" }
  | { readonly kind: "adopt"; readonly identity: TrackerIdentity }
  | { readonly kind: "drift_recovery_required"; readonly reasons: ReadonlyArray<string> }
  | { readonly kind: "blocked"; readonly reason: string }
  | {
      readonly kind: "fallback_consume"
      readonly category: ProviderFailureCategory
      readonly nextProfile?: string
      readonly fromProfile: string
    }

export const recoveryDecisionLabel = (decision: RecoveryDecision): string => {
  switch (decision.kind) {
    case "resume":
      return `resume session ${decision.sessionId}`
    case "fresh_worker_constrained":
      return "fresh worker constrained to checkpointed issue"
    case "adopt":
      return `adopt ${identityLabel(decision.identity)}`
    case "drift_recovery_required":
      return `drift recovery required (${decision.reasons.join("; ")})`
    case "blocked":
      return `blocked: ${decision.reason}`
    case "fallback_consume":
      return `consume fallback ${decision.nextProfile ?? "<none>"} for ${decision.category} from ${decision.fromProfile}`
    default: {
      const exhaustive: never = decision
      throw new Error(`unhandled recovery decision: ${(exhaustive as { kind: string }).kind}`)
    }
  }
}

export type AdoptionParse =
  | {
      readonly kind: "ok"
      readonly identity: TrackerIdentity
    }
  | { readonly kind: "empty" }
  | { readonly kind: "malformed"; readonly reason: string }
  | { readonly kind: "missing_value"; readonly variable: string }

const ADOPTION_ALLOWED_CHARACTERS = /^[A-Za-z0-9_:/.-]+$/

const parsePositiveInt = (token: string): number | null => {
  if (!/^[1-9][0-9]*$/.test(token)) {
    return null
  }
  const parsed = Number.parseInt(token, 10)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export const parseAdoptionValue = (input: string | undefined): AdoptionParse => {
  if (input === undefined) {
    return { kind: "missing_value", variable: "ISSUE_RUNNER_ADOPT_ISSUE" }
  }
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return { kind: "empty" }
  }
  if (!ADOPTION_ALLOWED_CHARACTERS.test(trimmed)) {
    return {
      kind: "malformed",
      reason: `value contains disallowed characters: ${JSON.stringify(trimmed)}`,
    }
  }
  if (trimmed.includes("/")) {
    const parts = trimmed.split("/")
    if (parts.length !== 2) {
      return { kind: "malformed", reason: "Azure adoption value must be HU/TICKET" }
    }
    const huPart = parts[0] ?? ""
    const ticketPart = parts[1] ?? ""
    if (huPart.length === 0 || ticketPart.length === 0) {
      return { kind: "malformed", reason: "Azure adoption value must be HU/TICKET" }
    }
    const huNumber = parsePositiveInt(huPart)
    if (huNumber === null) {
      return { kind: "malformed", reason: `invalid HU number: ${JSON.stringify(huPart)}` }
    }
    const ticketNumber = parsePositiveInt(ticketPart)
    if (ticketNumber === null) {
      return { kind: "malformed", reason: `invalid ticket number: ${JSON.stringify(ticketPart)}` }
    }
    const hu = asHuNumber(huNumber)
    const ticket = asTicketNumber(ticketNumber)
    if (hu === null || ticket === null) {
      return { kind: "malformed", reason: "HU/ticket integer out of range" }
    }
    return {
      kind: "ok",
      identity: { kind: "azure_ticket", hu, ticket },
    }
  }
  const githubNumber = parsePositiveInt(trimmed)
  if (githubNumber === null) {
    return { kind: "malformed", reason: `value is not a positive integer: ${JSON.stringify(trimmed)}` }
  }
  const issueNumber = asIssueNumber(githubNumber)
  if (issueNumber === null) {
    return { kind: "malformed", reason: "issue integer out of range" }
  }
  return { kind: "ok", identity: { kind: "github", number: issueNumber } }
}

export type RecoveryActionContext = {
  readonly currentState: LifecycleState
  readonly identity: TrackerIdentity
  readonly branch: string
  readonly baseBranch: string
  readonly baseSha: string
  readonly fallbackChain: ReadonlyArray<string>
}

export const decideRecovery = (
  _context: RecoveryActionContext,
  sessionId: SessionId | undefined,
): RecoveryDecision => {
  if (sessionId === undefined) {
    return { kind: "fresh_worker_constrained" }
  }
  return {
    kind: "resume",
    sessionId,
  }
}

export type Drift = {
  readonly reasons: ReadonlyArray<string>
}

export const summarizeDrift = (drift: Drift): string => drift.reasons.join("; ")
