import { describe, expect, test } from "bun:test"
import {
  HostOwnedDecision,
  SelectionContext,
  buildSelectionContext,
  decideHostOwned,
  hostOwnedIdentityLabel,
  identityEquals,
} from "../../../src/domain/host-owned-selection"
import { asHuNumber, asIssueNumber } from "../../../src/domain/checkpoint"
import { parseSessionId } from "../../../src/domain/session-id"
import { TrackerIdentity } from "../../../src/domain/tracker"

const identity91 = (): TrackerIdentity => {
  const value = asIssueNumber(91)
  if (value === null) throw new Error("expected valid identity")
  return { kind: "github", number: value }
}

const identity79 = (): TrackerIdentity => {
  const value = asIssueNumber(79)
  if (value === null) throw new Error("expected valid identity")
  return { kind: "github", number: value }
}

const hu1234 = (): TrackerIdentity => {
  const hu = asHuNumber(1234)
  const ticket = asHuNumber(1)
  if (hu === null || ticket === null) throw new Error("expected valid HU")
  return { kind: "azure_ticket", hu, ticket: ticket as never }
}

describe("buildSelectionContext", () => {
  test("marks the context as host-owned and exposes the tracker kind", () => {
    const context: SelectionContext = buildSelectionContext({
      repository: "elvisbrevi/agent-workflow",
      tracker: "github",
      baseBranch: "main",
      currentState: "starting",
    })
    expect(context.hostOwned).toBe(true)
    expect(context.tracker).toBe("github")
    expect(context.hu).toBeUndefined()
  })

  test("includes the HU override when provided", () => {
    const context = buildSelectionContext({
      repository: "elvisbrevi/agent-workflow",
      tracker: "azure",
      hu: 1234,
      baseBranch: "feature/hu-1234",
      currentState: "starting",
    })
    expect(context.hu).toBe(1234)
    expect(context.tracker).toBe("azure")
  })
})

describe("decideHostOwned", () => {
  test("returns `use_supervisor` when the supervisor pins an identity", () => {
    const decision: HostOwnedDecision = decideHostOwned({
      supervisorIdentity: identity91(),
    })
    expect(decision.kind).toBe("use_supervisor")
  })

  test("returns `use_supervisor` when the supervisor matches adoption and checkpoint", () => {
    const identity = identity91()
    const session = parseSessionId("ses_host_owned")
    if (session === null) throw new Error("expected valid session id")
    const decision = decideHostOwned({
      supervisorIdentity: identity,
      adoptionRaw: "91",
      parsedAdoption: { kind: "ok", identity },
      checkpointIdentity: identity,
      checkpointSession: session,
    })
    expect(decision.kind).toBe("use_supervisor")
  })

  test("returns `use_adoption` when the supervisor abstains and adoption is present", () => {
    const identity = identity91()
    const decision = decideHostOwned({
      adoptionRaw: "91",
      parsedAdoption: { kind: "ok", identity },
    })
    expect(decision.kind).toBe("use_adoption")
  })

  test("returns `use_checkpoint` when only the checkpoint identity is available", () => {
    const identity = identity91()
    const session = parseSessionId("ses_host_owned")
    if (session === null) throw new Error("expected valid session id")
    const decision = decideHostOwned({
      checkpointIdentity: identity,
      checkpointSession: session,
    })
    expect(decision.kind).toBe("use_checkpoint")
  })

  test("returns `ambiguous` when supervisor and checkpoint disagree", () => {
    const decision = decideHostOwned({
      supervisorIdentity: identity91(),
      checkpointIdentity: identity79(),
    })
    expect(decision.kind).toBe("ambiguous")
  })

  test("returns `none` when nothing is supplied", () => {
    expect(decideHostOwned({}).kind).toBe("none")
  })

  test("returns `ambiguous` when adoption and checkpoint disagree on identity", () => {
    const session = parseSessionId("ses_host_owned")
    if (session === null) throw new Error("expected valid session id")
    const decision = decideHostOwned({
      adoptionRaw: "91",
      parsedAdoption: { kind: "ok", identity: identity91() },
      checkpointIdentity: identity79(),
      checkpointSession: session,
    })
    expect(decision.kind).toBe("ambiguous")
  })
})

describe("identityEquals", () => {
  test("compares by kind and number", () => {
    expect(identityEquals(identity91(), identity91())).toBe(true)
    expect(identityEquals(identity91(), identity79())).toBe(false)
  })

  test("compares azure tuples by hu and ticket", () => {
    const a = { kind: "azure_ticket" as const, hu: 1 as never, ticket: 2 as never }
    const b = { kind: "azure_ticket" as const, hu: 1 as never, ticket: 2 as never }
    const c = { kind: "azure_ticket" as const, hu: 1 as never, ticket: 9 as never }
    expect(identityEquals(a, b)).toBe(true)
    expect(identityEquals(a, c)).toBe(false)
  })

  test("rejects cross-kind comparisons", () => {
    expect(identityEquals(identity91(), hu1234())).toBe(false)
  })
})

describe("hostOwnedIdentityLabel", () => {
  const session = parseSessionId("ses_label")
  if (session === null) throw new Error("expected valid session id")

  test("covers every source variant", () => {
    expect(
      hostOwnedIdentityLabel({ source: "supervisor", identity: identity91() }),
    ).toBe("supervisor pinned github issue 91")
    expect(
      hostOwnedIdentityLabel({ source: "adoption", identity: identity91(), raw: "91" }),
    ).toBe("adoption 91 → github issue 91")
    expect(
      hostOwnedIdentityLabel({ source: "checkpoint", identity: identity91(), sessionId: session }),
    ).toBe("checkpoint github issue 91 session ses_label")
  })
})
