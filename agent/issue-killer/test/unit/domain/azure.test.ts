import { describe, expect, test } from "bun:test"
import {
  AZURE_HIERARCHY_FORWARD,
  AZURE_READY_TAG,
  evaluateAzureChild,
  inferAzureHuCategory,
  normalizeAzureBranchSlug,
  selectAzureDeliveryTicket,
  validateAzureMapping,
  type AzureMapping,
  type AzureWorkItem,
} from "../../../src/domain/azure"
import { prepareAzureHuBranch } from "../../../src/tracker/azure"

const mapping = (): AzureMapping => ({
  organization: "example-org",
  project: "example-project",
  repository: "example-repo",
  eligibleWorkItemTypes: ["User Story", "Bug", "Task"],
  epicWorkItemTypes: ["Epic"],
  deliveryHuWorkItemTypes: ["User Story"],
  deliveryTicketWorkItemTypes: ["Task", "Bug"],
  openStates: ["New", "Active"],
  closedStates: ["Closed", "Done"],
  readyTag: AZURE_READY_TAG,
  claimIdentity: "operator@example.com",
  predecessorRelation: "System.LinkTypes.Dependency-Reverse",
  closedState: "Done",
  completionEvidenceField: "Completion Evidence",
  realEffortField: "Real Effort",
})

const item = (overrides: Partial<AzureWorkItem> = {}): AzureWorkItem => ({
  id: 100,
  type: "Task",
  state: "Active",
  tags: [AZURE_READY_TAG],
  title: "Implement payment flow",
  createdAt: "2026-08-01T10:00:00Z",
  assigned: false,
  relations: [],
  ...overrides,
})

describe("validateAzureMapping", () => {
  test("accepts a complete repository-owned mapping", () => {
    expect(validateAzureMapping(mapping())).toEqual({ kind: "ok", mapping: mapping() })
  })

  test("rejects missing role separation and an invalid closed state", () => {
    const invalid = {
      ...mapping(),
      deliveryHuWorkItemTypes: ["Task"],
      deliveryTicketWorkItemTypes: ["Task"],
      closedState: "Active",
    }
    const result = validateAzureMapping(invalid)
    expect(result.kind).toBe("invalid")
  })
})

describe("evaluateAzureChild", () => {
  test("accepts only an unassigned, ready direct child without open predecessor", () => {
    expect(evaluateAzureChild({ item: item(), mapping: mapping(), directChild: true, openPredecessor: false })).toEqual({
      kind: "eligible",
    })
  })

  test("excludes related links, indirect descendants, assigned, closed, and blocked children", () => {
    for (const input of [
      { directChild: false },
      { directChild: true, openPredecessor: true },
      { directChild: true, item: item({ assigned: true }) },
      { directChild: true, item: item({ state: "Done" }) },
      { directChild: false, item: item({ relations: [{ relation: "System.LinkTypes.Related", targetId: 9 }] }) },
    ]) {
      expect(evaluateAzureChild({ item: input.item ?? item(), mapping: mapping(), directChild: input.directChild, openPredecessor: input.openPredecessor ?? false }).kind).toBe("ineligible")
    }
  })
})

describe("selectAzureDeliveryTicket", () => {
  test("orders eligible direct children by creation time and then id", () => {
    const result = selectAzureDeliveryTicket({
      mapping: mapping(),
      children: [
        { item: item({ id: 20, createdAt: "2026-08-02T10:00:00Z" }), directChild: true, openPredecessor: false },
        { item: item({ id: 11, createdAt: "2026-08-01T10:00:00Z" }), directChild: true, openPredecessor: false },
        { item: item({ id: 10, createdAt: "2026-08-01T10:00:00Z" }), directChild: true, openPredecessor: false },
      ],
    })
    expect(result).toEqual({ kind: "selected", item: expect.objectContaining({ id: 10 }) })
  })

  test("returns blocked when pending children are all blocked", () => {
    const result = selectAzureDeliveryTicket({
      mapping: mapping(),
      children: [{ item: item(), directChild: true, openPredecessor: true }],
    })
    expect(result.kind).toBe("blocked")
  })
})

describe("Azure HU branches", () => {
  test("infers category and produces a safe deterministic branch", () => {
    expect(inferAzureHuCategory({ type: "Bug", title: "Payments", description: "" })).toBe("hotfix")
    expect(inferAzureHuCategory({ type: "User Story", title: "Refactor billing", description: "" })).toBe("refactor")
    expect(normalizeAzureBranchSlug("  Payments / HU: Q3  ")).toBe("payments-hu-q3")
  })

  test("refuses to guess an origin on a non-interactive first run and reuses a prepared branch", () => {
    const hu = 100 as never
    expect(prepareAzureHuBranch({
      hu,
      type: "User Story",
      title: "Payments HU",
      description: "",
      existingBranches: [],
      interactive: false,
    })).toEqual({ kind: "blocked", reason: "operator origin is required before creating an Azure HU integration branch" })
    expect(prepareAzureHuBranch({
      hu,
      type: "User Story",
      title: "Payments HU",
      description: "",
      existingBranches: ["feature/100-payments-hu"],
      interactive: false,
    })).toEqual({ kind: "ready", branch: "feature/100-payments-hu", category: "feature", origin: "existing", reused: true })
  })

  test("exports the hierarchy relation used for direct-child scope", () => {
    expect(AZURE_HIERARCHY_FORWARD).toBe("System.LinkTypes.Hierarchy-Forward")
  })
})
