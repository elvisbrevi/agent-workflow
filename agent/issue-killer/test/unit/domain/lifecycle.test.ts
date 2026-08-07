import { describe, expect, test } from "bun:test"
import {
  LIFECYCLE_STATES,
  LifecycleState,
  isLifecycleState,
  isProgressedLifecycleState,
  isTerminalLifecycleState,
  mostProgressedLifecycleState,
} from "../../../src/domain/lifecycle"

describe("isLifecycleState", () => {
  test("accepts the closed set", () => {
    for (const state of LIFECYCLE_STATES) {
      expect(isLifecycleState(state)).toBe(true)
    }
  })

  test("rejects unknowns", () => {
    expect(isLifecycleState("paused")).toBe(false)
    expect(isLifecycleState(42)).toBe(false)
    expect(isLifecycleState(undefined)).toBe(false)
    expect(isLifecycleState(null)).toBe(false)
  })
})

describe("isTerminalLifecycleState", () => {
  const TERMINAL: LifecycleState[] = [
    "issue_completed",
    "queue_empty",
    "blocked",
    "failed",
    "recovery_required",
  ]

  for (const state of LIFECYCLE_STATES) {
    test(`returns ${TERMINAL.includes(state)} for ${state}`, () => {
      expect(isTerminalLifecycleState(state)).toBe(TERMINAL.includes(state))
    })
  }
})

describe("isProgressedLifecycleState", () => {
  test("treating `starting` as the only non-progressed state", () => {
    for (const state of LIFECYCLE_STATES) {
      expect(isProgressedLifecycleState(state)).toBe(state !== "starting")
    }
  })
})

describe("mostProgressedLifecycleState", () => {
  test("returns the terminal state when current is `starting`", () => {
    expect(mostProgressedLifecycleState("starting", "issue_completed")).toBe("issue_completed")
    expect(mostProgressedLifecycleState("starting", "failed")).toBe("failed")
  })

  test("preserves the progressed current state over a terminal fallback", () => {
    expect(mostProgressedLifecycleState("pr_merged", "failed")).toBe("pr_merged")
    expect(mostProgressedLifecycleState("branch_pushed", "issue_completed")).toBe("branch_pushed")
  })
})
