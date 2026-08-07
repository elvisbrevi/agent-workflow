import { describe, expect, test } from "bun:test"
import {
  SESSION_ID_MAX_LENGTH,
  SESSION_ID_PATTERN,
  isSessionId,
  parseSessionId,
  sessionIdEquals,
  sessionIdPrefix,
} from "../../../src/domain/session-id"

describe("SESSION_ID_PATTERN", () => {
  test("allows letters, digits, underscores, and hyphens", () => {
    expect(SESSION_ID_PATTERN.test("ses_abc-123")).toBe(true)
    expect(SESSION_ID_PATTERN.test("a")).toBe(true)
    expect(SESSION_ID_PATTERN.test("0123456789abc-_")).toBe(true)
  })

  test("rejects path traversal and control characters", () => {
    expect(SESSION_ID_PATTERN.test("../../../etc/passwd")).toBe(false)
    expect(SESSION_ID_PATTERN.test("ses/abc")).toBe(false)
    expect(SESSION_ID_PATTERN.test("ses\\abc")).toBe(false)
    expect(SESSION_ID_PATTERN.test("ses\0abc")).toBe(false)
    expect(SESSION_ID_PATTERN.test("ses\nabc")).toBe(false)
    expect(SESSION_ID_PATTERN.test("ses abc")).toBe(false)
    expect(SESSION_ID_PATTERN.test("ses.abc")).toBe(false)
    expect(SESSION_ID_PATTERN.test("ses:abc")).toBe(false)
  })
})

describe("parseSessionId", () => {
  test("accepts strings within length and pattern", () => {
    const session = parseSessionId("ses_ABC-123")
    expect(session).not.toBeNull()
    expect(session as unknown as string).toBe("ses_ABC-123")
  })

  test("rejects empty strings", () => {
    expect(parseSessionId("")).toBeNull()
  })

  test(`rejects strings longer than ${SESSION_ID_MAX_LENGTH} chars`, () => {
    const long = "a".repeat(SESSION_ID_MAX_LENGTH + 1)
    expect(parseSessionId(long)).toBeNull()
  })

  test("accepts strings of exactly the ceiling", () => {
    const boundary = "a".repeat(SESSION_ID_MAX_LENGTH)
    expect(parseSessionId(boundary) as unknown as string).toBe(boundary)
  })

  test("rejects path traversal payloads", () => {
    expect(parseSessionId("../../../etc/passwd")).toBeNull()
    expect(parseSessionId("/root")).toBeNull()
  })
})

describe("isSessionId", () => {
  test("narrows brand types correctly", () => {
    const value: unknown = "ses_xyz_1"
    if (isSessionId(value)) {
      expect(typeof value).toBe("string")
    } else {
      throw new Error("expected value to be a valid session id")
    }
  })

  test("rejects unknown values", () => {
    expect(isSessionId(null)).toBe(false)
    expect(isSessionId(123)).toBe(false)
  })
})

describe("sessionIdEquals", () => {
  test("compares by value", () => {
    const a = parseSessionId("ses_AAA")
    const b = parseSessionId("ses_AAA")
    const c = parseSessionId("ses_BBB")
    if (a === null || b === null || c === null) {
      throw new Error("expected valid session ids")
    }
    expect(sessionIdEquals(a, b)).toBe(true)
    expect(sessionIdEquals(a, c)).toBe(false)
  })
})

describe("sessionIdPrefix", () => {
  test("returns the full value when shorter than the limit", () => {
    const value = parseSessionId("ses_id")
    if (value === null) throw new Error("expected valid session id")
    expect(sessionIdPrefix(value)).toBe("ses_id")
  })

  test("truncates long values with an ellipsis marker", () => {
    const value = parseSessionId("a".repeat(20))
    if (value === null) throw new Error("expected valid session id")
    expect(sessionIdPrefix(value, 4)).toBe("aaaa…")
  })

  test("custom limit is honored on shorter values", () => {
    const value = parseSessionId("ses_short")
    if (value === null) throw new Error("expected valid session id")
    expect(sessionIdPrefix(value, 12)).toBe("ses_short")
  })
})
