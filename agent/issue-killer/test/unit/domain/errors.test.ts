import { describe, expect, test } from "bun:test"
import { IssueKillerError, issueKillerErrorMessage } from "../../../src/domain/errors"

describe("IssueKillerError", () => {
  test("captures the code, message, and details", () => {
    const error = new IssueKillerError("malformed_outcome", "outcome missing status", {
      received: "null",
    })
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe("malformed_outcome")
    expect(error.message).toBe("outcome missing status")
    expect(error.details).toEqual({ received: "null" })
    expect(error.name).toBe("IssueKillerError")
  })

  test("withDetail returns a new error carrying additional context", () => {
    const base = new IssueKillerError("invalid_session_id", "session id failed validation")
    const enriched = base.withDetail("value", "../../../etc/passwd")
    expect(enriched.code).toBe("invalid_session_id")
    expect(enriched.message).toBe("session id failed validation")
    expect(enriched.details).toEqual({ value: "../../../etc/passwd" })
    expect(base.details).toEqual({})
  })
})

describe("issueKillerErrorMessage", () => {
  test("renders context entries in declared order", () => {
    const message = issueKillerErrorMessage("drift_detected", {
      expected: "main",
      actual: "feature/91",
      reason: "branch moved",
    })
    expect(message).toBe('issue-killer: drift_detected expected="main" actual="feature/91" reason="branch moved"')
  })

  test("renders primitive values without quoting", () => {
    const message = issueKillerErrorMessage("command_failed", {
      exitCode: 7,
      succeeded: false,
      nonce: 12_345n,
    })
    expect(message).toContain("exitCode=7")
    expect(message).toContain("succeeded=false")
    expect(message).toContain("nonce=12345")
  })
})
