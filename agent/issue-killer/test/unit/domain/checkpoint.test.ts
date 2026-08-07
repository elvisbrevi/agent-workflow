import { describe, expect, test } from "bun:test"
import {
  CHECKPOINT_FORMAT_VERSION,
  Checkpoint,
  IssueNumber,
  asHuNumber,
  asIssueNumber,
  asTicketNumber,
  emptyCheckpoint,
} from "../../../src/domain/checkpoint"
import type { TrackerIdentity } from "../../../src/domain/tracker"
import { completionReasonLabel, identityLabel, selectionLabel } from "../../../src/domain/tracker"

const githubIssue = (): TrackerIdentity => {
  const number = asIssueNumber(91)
  if (number === null) throw new Error("expected valid issue number")
  return { kind: "github", number }
}

const azureTicket = (): TrackerIdentity => {
  const hu = asHuNumber(1234)
  const ticket = asTicketNumber(99)
  if (hu === null || ticket === null) throw new Error("expected valid identity")
  return { kind: "azure_ticket", hu, ticket }
}

describe("asIssueNumber", () => {
  test("accepts positive integers", () => {
    expect(asIssueNumber(1) as unknown as number).toBe(1)
    expect(asIssueNumber(500) as unknown as number).toBe(500)
  })

  test("rejects zero, negatives, and non-integers", () => {
    expect(asIssueNumber(0)).toBeNull()
    expect(asIssueNumber(-1)).toBeNull()
    expect(asIssueNumber(1.5)).toBeNull()
    expect(asIssueNumber(Number.NaN)).toBeNull()
  })
})

describe("asHuNumber / asTicketNumber", () => {
  test("share the same positive-integer contract", () => {
    expect(asHuNumber(1) as unknown as number).toBe(1)
    expect(asHuNumber(0)).toBeNull()
    expect(asTicketNumber(9000) as unknown as number).toBe(9000)
    expect(asTicketNumber(0)).toBeNull()
  })
})

describe("emptyCheckpoint", () => {
  test("creates a checkpoint with unknown identity and default format_version", () => {
    const created = emptyCheckpoint({
      pid: 1234,
      iteration: 0,
      branch: "feature/79-ts-scaffold",
      baseBranch: "main",
      baseSha: "0123456789abcdef",
      profileName: "opencode-main",
      cli: "opencode",
      model: "provider/model",
      command: "opencode",
      state: "starting",
      updatedAt: "2026-08-06 10:00:00 +0000",
    }) as Checkpoint
    expect(created.formatVersion).toBe(CHECKPOINT_FORMAT_VERSION)
    expect(created.identity.kind).toBe("unknown")
    expect(created.fallbackChain).toEqual([])
    expect(created.fallbackRemaining).toEqual([])
    expect(created.fallbackPosition).toBe(0)
  })
})

describe("identityLabel", () => {
  test("renders GitHub and Azure identities distinctly", () => {
    expect(identityLabel(githubIssue())).toBe("github issue 91")
    expect(identityLabel(azureTicket())).toBe("azure HU 1234 ticket 99")
  })
})

describe("selectionLabel", () => {
  test("renders selection outcomes across the discriminator", () => {
    expect(selectionLabel({ kind: "selected", identity: githubIssue() })).toBe(
      "selected github issue 91",
    )
    expect(selectionLabel({ kind: "empty", reason: "no ready-for-agent issues" })).toBe(
      "empty queue (no ready-for-agent issues)",
    )
    expect(selectionLabel({ kind: "blocked", reason: "operator confirmation missing" })).toBe(
      "blocked (operator confirmation missing)",
    )
    expect(
      selectionLabel({ kind: "recovery", reason: "checkpoint stale" }),
    ).toBe("recovery needed (checkpoint stale)")
  })
})

describe("completionReasonLabel", () => {
  test("labels verified outcomes by their evidence kind", () => {
    expect(
      completionReasonLabel({
        kind: "verified",
        identity: githubIssue(),
        evidence: { kind: "github_pr_merged", prNumber: 1, baseRef: "main", mergedAt: "2026-08-06" },
      }),
    ).toContain("github_pr_merged")
  })

  test("labels drift and failure outcomes with the discriminator value", () => {
    expect(
      completionReasonLabel({ kind: "drift", identity: githubIssue(), details: "head moved" }),
    ).toContain("head moved")
    expect(
      completionReasonLabel({
        kind: "wrong_base_branch",
        identity: githubIssue(),
        expected: "main",
        actual: "release/1",
      }),
    ).toContain("release/1")
  })
})

describe("IssueNumber brand", () => {
  test("preserves the nominal type after construction", () => {
    const value: IssueNumber | null = asIssueNumber(79)
    expect(value).not.toBeNull()
    if (value !== null) {
      const round: number = value
      expect(round).toBe(79)
    }
  })
})
