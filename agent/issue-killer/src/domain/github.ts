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
  | "malformed_issue_shape"

const READY_LABEL_LOWER = GITHUB_READY_LABEL.toLowerCase()
const EPIC_LABEL_LOWER = GITHUB_EPIC_LABEL.toLowerCase()
const INVALID_GITHUB_FIELD = Symbol("invalid-github-field")

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
  return Array.isArray(assignees) && assignees.length === 0
}

const issueHasValidShape = (issue: GithubIssue): boolean =>
  typeof issue.state === "string" &&
  typeof issue.title === "string" &&
  Array.isArray(issue.labels) &&
  Array.isArray(issue.assignees) &&
  Object.prototype.hasOwnProperty.call(issue, "issueType")

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
  if (!issueHasValidShape(input.issue)) {
    return { kind: "ineligible", issueNumber: number, reasons: ["malformed_issue_shape"] }
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

const parseExactNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return null
  return value
}

export const verifyGithubCompletion = (input: {
  readonly issue: GithubIssue
  readonly baseBranch: string
  readonly sourceBranch?: string
  readonly pullRequests: ReadonlyArray<GithubPullRequest>
}): GithubCompletion => {
  if (input.baseBranch.length === 0 || input.baseBranch.trim() !== input.baseBranch) {
    return { kind: "malformed", reason: "base branch is empty" }
  }
  const number = asIssueNumber(input.issue.number)
  if (number === null) {
    return { kind: "missing_issue_number" }
  }

  if (!issueIsClosed(input.issue)) {
    return { kind: "issue_still_open", issueNumber: number }
  }

  if (input.pullRequests.length === 0) {
    return { kind: "no_attributable_pr", issueNumber: number }
  }
  if (input.pullRequests.length > 1) {
    return { kind: "multiple_prs", issueNumber: number, count: input.pullRequests.length }
  }

  const pr = input.pullRequests[0]
  if (pr === undefined) {
    return { kind: "no_attributable_pr", issueNumber: number }
  }
  const prNumberRaw = typeof pr.number === "number" ? pr.number : Number(pr.number)
  const prNumber = Number.isInteger(prNumberRaw) && prNumberRaw > 0 ? prNumberRaw : null
  if (prNumber === null) {
    return { kind: "malformed", reason: "pull request number is invalid" }
  }
  if (pr.state !== "MERGED") {
    return { kind: "pr_unmerged", issueNumber: number, prNumber }
  }
  const mergedAt = parseNonEmptyString(pr.mergedAt)
  if (mergedAt === null) {
    return { kind: "pr_unmerged", issueNumber: number, prNumber }
  }
  const baseRef = parseExactNonEmptyString(pr.baseRefName)
  if (baseRef === null || mergedAt === null) {
    return { kind: "malformed", reason: "pull request base or merge timestamp missing" }
  }
  if (input.sourceBranch !== undefined && pr.headRefName !== input.sourceBranch) {
    return { kind: "malformed", reason: "pull request source branch does not match the pinned branch" }
  }
  if (baseRef !== input.baseBranch) {
    return {
      kind: "wrong_base_branch",
      issueNumber: number,
      prNumber,
      expected: input.baseBranch,
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
  if (
    typeof record["number"] !== "number" ||
    !Number.isInteger(record["number"]) ||
    record["number"] <= 0
  ) {
    return null
  }
  const labels = parseGithubLabels(record["labels"])
  const assignees = parseGithubAssignees(record["assignees"])
  const issueType = parseGithubIssueType(record["issueType"])
  if (
    record["state"] === undefined ||
    record["title"] === undefined ||
    record["labels"] === undefined ||
    record["assignees"] === undefined ||
    record["issueType"] === undefined ||
    labels === INVALID_GITHUB_FIELD ||
    assignees === INVALID_GITHUB_FIELD ||
    issueType === INVALID_GITHUB_FIELD
  ) {
    return null
  }
  if (record["state"] !== undefined && typeof record["state"] !== "string") return null
  if (record["title"] !== undefined && typeof record["title"] !== "string") return null
  const issue: GithubIssue = {
    number: record["number"],
    state: typeof record["state"] === "string" ? (record["state"] as string) : undefined,
    title: typeof record["title"] === "string" ? (record["title"] as string) : undefined,
    labels,
    assignees,
    issueType,
  }
  return issue
}

const parseGithubLabels = (
  value: unknown,
): ReadonlyArray<GithubLabel> | undefined | typeof INVALID_GITHUB_FIELD => {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return INVALID_GITHUB_FIELD
  const labels: GithubLabel[] = []
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return INVALID_GITHUB_FIELD
    const record = entry as Record<string, unknown>
    if (typeof record["name"] !== "string") return INVALID_GITHUB_FIELD
    labels.push({ name: record["name"] })
  }
  return labels
}

const parseGithubAssignees = (
  value: unknown,
): ReadonlyArray<unknown> | undefined | typeof INVALID_GITHUB_FIELD => {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return INVALID_GITHUB_FIELD
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return INVALID_GITHUB_FIELD
  }
  return value
}

const parseGithubIssueType = (value: unknown): GithubIssueType | typeof INVALID_GITHUB_FIELD => {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== "object") return INVALID_GITHUB_FIELD
  const record = value as Record<string, unknown>
  if (typeof record["name"] !== "string") return INVALID_GITHUB_FIELD
  return { name: record["name"] }
}

export const parseGithubPullRequest = (value: unknown): GithubPullRequest | null => {
  if (typeof value !== "object" || value === null) return null
  const record = value as Record<string, unknown>
  const numberRaw = record["number"]
  if (typeof numberRaw !== "number" || !Number.isInteger(numberRaw) || numberRaw <= 0) {
    return null
  }
  if (record["state"] !== undefined && typeof record["state"] !== "string") return null
  if (
    record["mergedAt"] !== undefined &&
    record["mergedAt"] !== null &&
    typeof record["mergedAt"] !== "string"
  ) {
    return null
  }
  if (record["baseRefName"] !== undefined && typeof record["baseRefName"] !== "string") return null
  if (record["headRefName"] !== undefined && typeof record["headRefName"] !== "string") return null
  if (record["title"] !== undefined && typeof record["title"] !== "string") return null
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
    case "malformed_issue_shape":
      return "issue payload has an invalid shape"
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
