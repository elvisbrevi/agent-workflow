import { describe, expect, test } from "bun:test"
import {
  CONTROL_SCALAR_REASONS,
  validateScalarString,
  type ControlScalarIssue,
} from "../../../src/config/control-scalar"

const expectError = (input: unknown): ControlScalarIssue => {
  const result = validateScalarString(input, "test.field")
  expect(result).not.toBeNull()
  if (result === null) {
    throw new Error("expected control scalar rejection")
  }
  return result
}

describe("validateScalarString", () => {
  test("accepts clean plain strings", () => {
    expect(validateScalarString("opencode-main", "profiles.opencode.label")).toBeNull()
    expect(validateScalarString("", "profiles.x")).toBeNull()
    expect(validateScalarString("provider/model-2", "profiles.x.model")).toBeNull()
  })

  test("rejects embedded newline", () => {
    const issue = expectError("line1\nline2")
    expect(issue.path).toBe("test.field")
    expect(issue.reason).toBe("newline")
    expect(issue.value).toBe("\\x0a")
  })

  test("rejects embedded carriage return", () => {
    const issue = expectError("alpha\rbeta")
    expect(issue.reason).toBe("carriage_return")
    expect(issue.value).toBe("\\x0d")
  })

  test("rejects NUL byte", () => {
    const issue = expectError("alpha\u0000beta")
    expect(issue.reason).toBe("nul")
    expect(issue.value).toBe("\\x00")
  })

  test("normalizes reason to known set", () => {
    for (const reason of CONTROL_SCALAR_REASONS) {
      expect(typeof reason).toBe("string")
    }
  })
})

describe("non-string inputs", () => {
  test("non-string input is treated as missing scalar", () => {
    const issue = validateScalarString("not a string" as unknown as string, "x")
    expect(issue).toBeNull()
    const bad = validateScalarString(42 as unknown as string, "x")
    expect(bad).not.toBeNull()
    if (bad !== null) {
      expect(bad.reason).toBe("not_string")
    }
  })
})
