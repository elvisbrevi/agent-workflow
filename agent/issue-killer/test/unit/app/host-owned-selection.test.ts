import { describe, expect, test } from "bun:test"
import { selectAndClaimHostOwnedIssue } from "../../../src/app/host-owned-selection"
import { asIssueNumber } from "../../../src/domain/checkpoint"

describe("selectAndClaimHostOwnedIssue", () => {
  test("claims the exact selected identity before returning it", async () => {
    const issue = asIssueNumber(83)
    if (issue === null) throw new Error("expected issue number")
    const events: string[] = []
    const selection = await selectAndClaimHostOwnedIssue({
      tracker: {
        selectEligibleIssue: async () => {
          events.push("select")
          return { kind: "selected", identity: { kind: "github", number: issue } }
        },
        claimIssue: async ({ identity }) => {
          if (identity.kind !== "github") throw new Error("expected GitHub identity")
          events.push(`claim:${identity.kind}:${identity.number}`)
        },
      },
      baseBranch: "main",
      currentState: "starting",
    })

    expect(selection).toEqual({ kind: "selected", identity: { kind: "github", number: issue } })
    expect(events).toEqual(["select", "claim:github:83"])
  })

  test("does not claim an empty queue", async () => {
    let claimed = false
    const selection = await selectAndClaimHostOwnedIssue({
      tracker: {
        selectEligibleIssue: async () => ({ kind: "empty", reason: "no eligible issue" }),
        claimIssue: async () => {
          claimed = true
        },
      },
      baseBranch: "main",
      currentState: "starting",
    })

    expect(selection.kind).toBe("empty")
    expect(claimed).toBe(false)
  })
})
