import type { HuNumber, TicketNumber } from "./checkpoint"
import { asHuNumber, asTicketNumber } from "./checkpoint"

export const AZURE_READY_TAG = "ready-for-agent"
export const AZURE_HIERARCHY_FORWARD = "System.LinkTypes.Hierarchy-Forward"

export type AzureMapping = {
  readonly organization: string
  readonly project: string
  readonly repository: string
  readonly eligibleWorkItemTypes: ReadonlyArray<string>
  readonly epicWorkItemTypes: ReadonlyArray<string>
  readonly deliveryHuWorkItemTypes: ReadonlyArray<string>
  readonly deliveryTicketWorkItemTypes: ReadonlyArray<string>
  readonly openStates: ReadonlyArray<string>
  readonly closedStates: ReadonlyArray<string>
  readonly readyTag: string
  readonly claimIdentity: string
  readonly predecessorRelation: string
  readonly closedState: string
  readonly completionEvidenceField: string
  readonly realEffortField: string
  readonly completionEvidenceFieldName?: string
  readonly realEffortFieldName?: string
}

export type AzureMappingValidation =
  | { readonly kind: "ok"; readonly mapping: AzureMapping }
  | { readonly kind: "invalid"; readonly reason: string }

export type AzureRelation = {
  readonly relation: string
  readonly targetId: number
}

export type AzureWorkItem = {
  readonly id: number
  readonly type: string
  readonly state: string
  readonly tags: ReadonlyArray<string>
  readonly title: string
  readonly description?: string
  readonly createdAt: string
  readonly assigned: boolean
  readonly relations: ReadonlyArray<AzureRelation>
}

export type AzureChildCandidate = {
  readonly item: AzureWorkItem
  readonly directChild: boolean
  readonly openPredecessor: boolean
}

export type AzureChildDecision =
  | { readonly kind: "eligible" }
  | { readonly kind: "ineligible"; readonly reason: string }

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export const validateAzureMapping = (input: unknown): AzureMappingValidation => {
  if (!isRecord(input)) return { kind: "invalid", reason: "Azure mapping must be an object" }
  const stringKeys = [
    "organization",
    "project",
    "repository",
    "readyTag",
    "claimIdentity",
    "predecessorRelation",
    "closedState",
    "completionEvidenceField",
    "realEffortField",
  ] as const
  for (const key of stringKeys) {
    if (!isNonEmptyString(input[key])) return { kind: "invalid", reason: `${key} must be a non-empty string` }
  }
  const arrayKeys = [
    "eligibleWorkItemTypes",
    "epicWorkItemTypes",
    "deliveryHuWorkItemTypes",
    "deliveryTicketWorkItemTypes",
    "openStates",
    "closedStates",
  ] as const
  for (const key of arrayKeys) {
    if (!isStringArray(input[key])) return { kind: "invalid", reason: `${key} must be a non-empty string array` }
  }
  const huTypes = input.deliveryHuWorkItemTypes as ReadonlyArray<string>
  const ticketTypes = input.deliveryTicketWorkItemTypes as ReadonlyArray<string>
  if (huTypes.some((type) => ticketTypes.includes(type))) {
    return { kind: "invalid", reason: "delivery HU and ticket types must be disjoint" }
  }
  const closedState = input.closedState as string
  if (!(input.closedStates as ReadonlyArray<string>).includes(closedState)) {
    return { kind: "invalid", reason: "closedState must be one of closedStates" }
  }
  if (!(input.eligibleWorkItemTypes as ReadonlyArray<string>).some((type) => huTypes.includes(type))) {
    return { kind: "invalid", reason: "delivery HU types must be eligible work-item types" }
  }
  if (!(input.eligibleWorkItemTypes as ReadonlyArray<string>).some((type) => ticketTypes.includes(type))) {
    return { kind: "invalid", reason: "delivery ticket types must be eligible work-item types" }
  }
  const optionalKeys = ["completionEvidenceFieldName", "realEffortFieldName"] as const
  for (const key of optionalKeys) {
    if (input[key] !== undefined && !isNonEmptyString(input[key])) {
      return { kind: "invalid", reason: `${key} must be a non-empty string when present` }
    }
  }
  return { kind: "ok", mapping: input as unknown as AzureMapping }
}

const hasTag = (tags: ReadonlyArray<string>, expected: string): boolean =>
  tags.some((tag) => tag.toLowerCase() === expected.toLowerCase())

export const evaluateAzureChild = (input: {
  readonly item: AzureWorkItem
  readonly mapping: AzureMapping
  readonly directChild: boolean
  readonly openPredecessor: boolean
}): AzureChildDecision => {
  const { item, mapping } = input
  if (!input.directChild) return { kind: "ineligible", reason: "not a direct hierarchical child" }
  if (!mapping.deliveryTicketWorkItemTypes.includes(item.type)) {
    return { kind: "ineligible", reason: "work-item type is not a delivery ticket" }
  }
  if (!mapping.openStates.includes(item.state) || mapping.closedStates.includes(item.state)) {
    return { kind: "ineligible", reason: "work item is not open" }
  }
  if (!hasTag(item.tags, mapping.readyTag)) return { kind: "ineligible", reason: "ready tag is missing" }
  if (item.assigned) return { kind: "ineligible", reason: "work item is assigned" }
  if (input.openPredecessor) return { kind: "ineligible", reason: "open predecessor exists" }
  if (Number.isNaN(Date.parse(item.createdAt))) return { kind: "ineligible", reason: "created date is invalid" }
  return { kind: "eligible" }
}

export type AzureTicketSelection =
  | { readonly kind: "selected"; readonly item: AzureWorkItem }
  | { readonly kind: "empty"; readonly reason: string }
  | { readonly kind: "blocked"; readonly reason: string }

export const selectAzureDeliveryTicket = (input: {
  readonly mapping: AzureMapping
  readonly children: ReadonlyArray<AzureChildCandidate>
}): AzureTicketSelection => {
  const eligible: AzureWorkItem[] = []
  let pending = 0
  let blocked = 0
  for (const candidate of input.children) {
    const decision = evaluateAzureChild({
      item: candidate.item,
      mapping: input.mapping,
      directChild: candidate.directChild,
      openPredecessor: candidate.openPredecessor,
    })
    if (decision.kind === "eligible") {
      eligible.push(candidate.item)
    } else if (candidate.directChild && input.mapping.deliveryTicketWorkItemTypes.includes(candidate.item.type)) {
      if (candidate.item.state !== input.mapping.closedState && !candidate.item.assigned) {
        pending += 1
        if (candidate.openPredecessor) blocked += 1
      }
    }
  }
  eligible.sort((left, right) => {
    const dateOrder = Date.parse(left.createdAt) - Date.parse(right.createdAt)
    return dateOrder !== 0 ? dateOrder : left.id - right.id
  })
  const selected = eligible[0]
  if (selected !== undefined) return { kind: "selected", item: selected }
  if (pending > 0 && blocked === pending) return { kind: "blocked", reason: "all pending direct tickets have open predecessors" }
  return { kind: "empty", reason: "no eligible direct delivery tickets remain" }
}

export type AzureHuCategory = "feature" | "hotfix" | "refactor"

export const inferAzureHuCategory = (input: {
  readonly type: string
  readonly title: string
  readonly description: string
}): AzureHuCategory => {
  const type = input.type.toLowerCase()
  const title = input.title.toLowerCase()
  const description = input.description.toLowerCase()
  if (type === "bug") return "hotfix"
  if (/^(refactor|cleanup|restructure)/.test(title) || /(refactor|cleanup|restructure)/.test(description)) return "refactor"
  if (/^(fix|hotfix|bug)/.test(title) || /(defect|outage)/.test(description)) return "hotfix"
  return "feature"
}

export const normalizeAzureBranchSlug = (title: string): string => {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "")
  return normalized || "hu"
}

export const computeAzureHuBranch = (input: {
  readonly hu: HuNumber
  readonly category: AzureHuCategory
  readonly title: string
}): string => `${input.category}/${input.hu}-${normalizeAzureBranchSlug(input.title)}`

export const azureIdentity = (hu: number, ticket: number): { readonly hu: HuNumber; readonly ticket: TicketNumber } | null => {
  const huNumber = asHuNumber(hu)
  const ticketNumber = asTicketNumber(ticket)
  return huNumber === null || ticketNumber === null ? null : { hu: huNumber, ticket: ticketNumber }
}
