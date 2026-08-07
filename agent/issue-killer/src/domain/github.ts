// Pure domain rules for the GitHub tracker adapter.
//
// Eligibility and completion verification are split out from the adapter so
// the supervisor can reason about tracker decisions without touching `gh`,
// the filesystem, or any side effect. The adapter validates JSON shapes and
// hands already-shaped records to these helpers, which return structured
// decisions consumed by the host-owned selection and completion verification
// paths in `src/domain/host-owned-selection.ts` and `src/domain/tracker.ts`.
//
// All rules below reflect the GitHub tracker supplement documented in
// `docs/agents/issue-tracker.md` and the V2 contract matrix in
// `docs/design/issue-killer-v2-contract.md`.

import type { IssueNumber } from "./checkpoint"
import { asIssueNumber } from "./checkpoint"

export const GITHUB_READY_LABEL = "ready-for-agent"
export const GITHUB_EPIC_LABEL = "epic"
export const GITHUB_OPEN_STATE = "OPEN"
export const GITHUB_CLOSED_STATE = "CLOSED"
export const GITHUB_EPIC_TITLE_PREFIX = "[Epic]"
export const GITHUB_EPIC_TYPE_NAME = "Epic"

export type GithubLabel = { readonly name: string }

export type GithubIssueType =
  | { readonly name?: string }
  | null
  | undefined

export type GithubIssue = {
  readonly number: number
  readonly state?: string
  readonly title?: string
  readonly labels?: ReadonlyArray<GithubLabel>
  readonly assignees?: ReadonlyArray<unknown>
  readonly issueType?: GithubIssueType
}

export type GithubPullRequest = {
  readonly number?: number
  readonly state?: string
  readonly mergedAt?: string | null
  readonly baseRefName?: string
  readonly headRefName?: string
  readonly title?: string
}

export type GithubEligibility =
  | { readonly kind: "eligible"; readonly issueNumber: IssueNumber }
  | {
      readonly kind: "ineligible"
      readonly issueNumber: IssueNumber | null
      readonly reasons: ReadonlyArray<GithubEligibilityReason>
    }

export type GithubEligibilityReason =
  | "state_not_open"
  | "missing_ready_for_agent_label"
  | "assigned_to_user"
  | "epic_label_present"
  | "epic_type"
  | "epic_title_prefix"
  | "open_blocker_present"
  | "missing_issue_number"

const READY_LABEL_LOWER = GITHUB_READY_LABEL.toLowerCase()
const EPIC_LABEL_LOWER = GITHUB_EPIC_LABEL.toLowerCase()

export const issueHasReadyForAgentLabel = (issue: GithubIssue): boolean => {
  const labels = issue.labels
  if (labels === undefined) {
    return false
  }
  for (const label of labels) {
    if (label.name.toLowerCase() === READY_LABEL_LOWER) {
      return true
    }
  }
  return false
}

export const issueHasEpicLabel = (issue: GithubIssue): boolean => {
  const labels = issue.labels
  if (labels === undefined) {
    return false
  }
  for (const label of labels) {
    if (label.name.toLowerCase() === EPIC_LABEL_LOWER) {
      return true
    }
  }
  return false
}

export const issueIsEpicType = (issue: GithubIssue): boolean => {
  const typeName = issue.issueType?.name
  return typeof typeName === "string" && typeName === GITHUB_EPIC_TYPE_NAME
}

export const issueTitleStartsWithEpicPrefix = (issue: GithubIssue): boolean => {
  const title = issue.title
  return typeof title === "string" && title.startsWith(GITHUB_EPIC_TITLE_PREFIX)
}

export const issueIsOpen = (issue: GithubIssue): boolean =>
  typeof issue.state === "string" && issue.state === GITHUB_OPEN_STATE

export const issueIsClosed = (issue: GithubIssue): boolean =>
  typeof issue.state === "string" && issue.state === GITHUB_CLOSED_STATE

export const issueIsUnassigned = (issue: GithubIssue): boolean => {
  const assignees = issue.assignees
  return !(Array.isArray(assignees) && assignees.length > 0)
}

export const evaluateGithubEligibility = (input: {
  readonly issue: GithubIssue
  readonly blockedByCount?: number | null
}): GithubEligibility => {
  const number = asIssueNumber(input.issue.number)
  const reasons: GithubEligibilityReason[] = []

  if (number === null) {
    reasons.push("missing_issue_number")
    return { kind: "ineligible", issueNumber: null, reasons }
  }
  if (!issueIsOpen(input.issue)) {
    reasons.push("state_not_open")
  }
  if (!issueHasReadyForAgentLabel(input.issue)) {
    reasons.push("missing_ready_for_agent_label")
  }
  if (!issueIsUnassigned(input.issue)) {
    reasons.push("assigned_to_user")
  }
  if (issueHasEpicLabel(input.issue)) {
    reasons.push("epic_label_present")
  }
  if (issueIsEpicType(input.issue)) {
    reasons.push("epic_type")
  }
  if (issueTitleStartsWithEpicPrefix(input.issue)) {
    reasons.push("epic_title_prefix")
  }
  if ((input.blockedByCount ?? 0) > 0) {
    reasons.push("open_blocker_present")
  }

  if (reasons.length > 0) {
    return { kind: "ineligible", issueNumber: number, reasons }
  }
  return { kind: "eligible", issueNumber: number }
}

export type GithubCompletion =
  | {
      readonly kind: "verified"
      readonly issueNumber: IssueNumber
      readonly prNumber: number
      readonly baseRef: string
      readonly mergedAt: string
    }
  | { readonly kind: "issue_still_open"; readonly issueNumber: IssueNumber }
  | { readonly kind: "no_attributable_pr"; readonly issueNumber: IssueNumber }
  | { readonly kind: "multiple_prs"; readonly issueNumber: IssueNumber; readonly count: number }
  | {
      readonly kind: "pr_unmerged"
      readonly issueNumber: IssueNumber
      readonly prNumber: number
    }
  | {
      readonly kind: "wrong_base_branch"
      readonly issueNumber: IssueNumber
      readonly prNumber: number
      readonly expected: string
      readonly actual: string
    }
  | { readonly kind: "malformed"; readonly reason: string }
  | { readonly kind: "missing_issue_number" }

const parseNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export const verifyGithubCompletion = (input: {
  readonly issue: GithubIssue
  readonly baseBranch: string
  readonly pullRequests: ReadonlyArray<GithubPullRequest>
}): GithubCompletion => {
  const expectedBase = parseNonEmptyString(input.baseBranch)
  if (expectedBase === null) {
    return { kind: "malformed", reason: "base branch is empty" }
  }
  const number = asIssueNumber(input.issue.number)
  if (number === null) {
    return { kind: "missing_issue_number" }
  }

  if (!issueIsClosed(input.issue)) {
    return { kind: "issue_still_open", issueNumber: number }
  }

  const attributable: GithubPullRequest[] = []
  for (const pr of input.pullRequests) {
    const mergedAt = parseNonEmptyString(pr.mergedAt)
    if (mergedAt === null) {
      continue
    }
    attributable.push(pr)
  }

  if (attributable.length === 0) {
    return { kind: "no_attributable_pr", issueNumber: number }
  }
  if (attributable.length > 1) {
    return { kind: "multiple_prs", issueNumber: number, count: attributable.length }
  }

  const pr = attributable[0]
  if (pr === undefined) {
    return { kind: "no_attributable_pr", issueNumber: number }
  }
  const prNumberRaw = typeof pr.number === "number" ? pr.number : Number(pr.number)
  const prNumber = Number.isInteger(prNumberRaw) && prNumberRaw > 0 ? prNumberRaw : null
  if (prNumber === null) {
    return { kind: "malformed", reason: "pull request number is invalid" }
  }
  const baseRef = parseNonEmptyString(pr.baseRefName)
  const mergedAt = parseNonEmptyString(pr.mergedAt)
  if (baseRef === null || mergedAt === null) {
    return { kind: "malformed", reason: "pull request base or merge timestamp missing" }
  }
  if (baseRef !== expectedBase) {
    return {
      kind: "wrong_base_branch",
      issueNumber: number,
      prNumber,
      expected: expectedBase,
      actual: baseRef,
    }
  }

  return {
    kind: "verified",
    issueNumber: number,
    prNumber,
    baseRef,
    mergedAt,
  }
}

export const parseGithubIssue = (value: unknown): GithubIssue | null => {
  if (typeof value !== "object" || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  if (typeof record["number"] !== "number" || !Number.isInteger(record["number"])) {
    return null
  }
  const issue: GithubIssue = {
    number: record["number"],
    state: typeof record["state"] === "string" ? (record["state"] as string) : undefined,
    title: typeof record["title"] === "string" ? (record["title"] as string) : undefined,
    labels: parseGithubLabels(record["labels"]),
    assignees: parseGithubAssignees(record["assignees"]),
    issueType: parseGithubIssueType(record["issueType"]),
  }
  return issue
}

const parseGithubLabels = (value: unknown): ReadonlyArray<GithubLabel> | undefined => {
  if (!Array.isArray(value)) return undefined
  const labels: GithubLabel[] = []
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record["name"] !== "string") continue
    labels.push({ name: record["name"] })
  }
  return labels
}

const parseGithubAssignees = (value: unknown): ReadonlyArray<unknown> | undefined => {
  if (!Array.isArray(value)) return undefined
  return value
}

const parseGithubIssueType = (value: unknown): GithubIssueType => {
  if (value === null) return null
  if (typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const name = typeof record["name"] === "string" ? (record["name"] as string) : undefined
  return { name }
}

export const parseGithubPullRequest = (value: unknown): GithubPullRequest | null => {
  if (typeof value !== "object" || value === null) return null
  const record = value as Record<string, unknown>
  const numberRaw = record["number"]
  if (typeof numberRaw !== "number" || !Number.isInteger(numberRaw) || numberRaw <= 0) {
    return null
  }
  return {
    number: numberRaw,
    state: typeof record["state"] === "string" ? (record["state"] as string) : undefined,
    mergedAt:
      typeof record["mergedAt"] === "string" || record["mergedAt"] === null
        ? (record["mergedAt"] as string | null)
        : undefined,
    baseRefName: typeof record["baseRefName"] === "string" ? (record["baseRefName"] as string) : undefined,
    headRefName: typeof record["headRefName"] === "string" ? (record["headRefName"] as string) : undefined,
    title: typeof record["title"] === "string" ? (record["title"] as string) : undefined,
  }
}

export const parseGithubPullRequestList = (value: unknown): ReadonlyArray<GithubPullRequest> | null => {
  if (!Array.isArray(value)) return null
  const list: GithubPullRequest[] = []
  for (const entry of value) {
    const pr = parseGithubPullRequest(entry)
    if (pr === null) return null
    list.push(pr)
  }
  return list
}

export const eligibilityReasonLabel = (reason: GithubEligibilityReason): string => {
  switch (reason) {
    case "state_not_open":
      return "issue is not open"
    case "missing_ready_for_agent_label":
      return "ready-for-agent label missing"
    case "assigned_to_user":
      return "issue has assignees"
    case "epic_label_present":
      return "epic label present"
    case "epic_type":
      return "issue type is Epic"
    case "epic_title_prefix":
      return "title starts with [Epic]"
    case "open_blocker_present":
      return "open blocker present"
    case "missing_issue_number":
      return "issue number missing or invalid"
    default: {
      const exhaustive: never = reason
      throw new Error(`unhandled eligibility reason: ${(exhaustive as string)}`)
    }
  }
}

export const completionLabel = (completion: GithubCompletion): string => {
  switch (completion.kind) {
    case "verified":
      return `verified PR #${completion.prNumber} merged into ${completion.baseRef} at ${completion.mergedAt}`
    case "issue_still_open":
      return `issue ${completion.issueNumber} is still open`
    case "no_attributable_pr":
      return `no attributable PR found for issue ${completion.issueNumber}`
    case "multiple_prs":
      return `multiple PRs found for issue ${completion.issueNumber} (${completion.count})`
    case "pr_unmerged":
      return `PR #${completion.prNumber} for issue ${completion.issueNumber} is unmerged`
    case "wrong_base_branch":
      return `PR #${completion.prNumber} targets ${completion.actual}; expected ${completion.expected}`
    case "malformed":
      return `malformed completion input: ${completion.reason}`
    case "missing_issue_number":
      return "issue number missing or invalid"
    default: {
      const exhaustive: never = completion
      throw new Error(`unhandled completion result: ${(completion as { kind: string }).kind}`)
    }
  }
}