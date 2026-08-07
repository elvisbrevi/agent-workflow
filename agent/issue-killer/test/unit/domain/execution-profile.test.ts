import { describe, expect, test } from "bun:test"
import type { ExecutionProfile } from "../../../src/domain/execution-profile"
import {
  advanceFallback,
  detectCycle,
  fallbackPosition,
  isValidProfileName,
  validateExecutionProfile,
  validateFallbackChain,
} from "../../../src/domain/execution-profile"

const profile = (overrides: Partial<ExecutionProfile> = {}): ExecutionProfile => ({
  name: "opencode-main",
  label: "OpenCode main",
  cli: "opencode",
  command: "opencode",
  providerID: "provider",
  modelID: "model",
  autoApprove: true,
  options: {},
  fallbacks: [],
  ...overrides,
})

describe("isValidProfileName", () => {
  test("accepts identifier-safe names", () => {
    expect(isValidProfileName("opencode-main")).toBe(true)
    expect(isValidProfileName("opencode_main")).toBe(true)
    expect(isValidProfileName("opencodeBackup")).toBe(true)
    expect(isValidProfileName("a1b2c3")).toBe(true)
  })

  test("rejects names with spaces or punctuation", () => {
    expect(isValidProfileName("opencode main")).toBe(false)
    expect(isValidProfileName("opencode.main")).toBe(false)
    expect(isValidProfileName("opencode/main")).toBe(false)
    expect(isValidProfileName("")).toBe(false)
  })
})

describe("validateFallbackChain", () => {
  test("accepts an empty chain", () => {
    const result = validateFallbackChain("opencode-main", [], new Set(["opencode-main"]))
    expect(result).toEqual({ kind: "ok", chain: [] })
  })

  test("rejects references to unknown profiles", () => {
    const result = validateFallbackChain("opencode-main", ["ghost"], new Set(["opencode-main"]))
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") {
      expect(result.reason).toBe("unknown_reference")
      expect(result.offending).toBe("ghost")
    }
  })

  test("rejects self-references", () => {
    const result = validateFallbackChain(
      "opencode-main",
      ["opencode-main"],
      new Set(["opencode-main"]),
    )
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") {
      expect(result.reason).toBe("self_reference")
      expect(result.offending).toBe("opencode-main")
    }
  })

  test("rejects duplicate entries", () => {
    const result = validateFallbackChain(
      "opencode-main",
      ["opencode-backup", "opencode-backup"],
      new Set(["opencode-main", "opencode-backup"]),
    )
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") {
      expect(result.reason).toBe("duplicate_entry")
      expect(result.offending).toBe("opencode-backup")
    }
  })

  test("accepts an acyclic chain", () => {
    const result = validateFallbackChain(
      "opencode-main",
      ["opencode-backup", "opencode-cold"],
      new Set(["opencode-main", "opencode-backup", "opencode-cold"]),
    )
    expect(result.kind).toBe("ok")
  })
})

describe("detectCycle", () => {
  test("returns null for acyclic graphs", () => {
    expect(detectCycle({ a: [], b: [] })).toBeNull()
    expect(detectCycle({ a: ["b"], b: [] })).toBeNull()
  })

  test("returns the cycle entry node for cyclic graphs", () => {
    const cyclic = { a: ["b"], b: ["a"] } as const
    expect(detectCycle(cyclic)).toBe("a")
  })
})

describe("validateExecutionProfile", () => {
  test("rejects disallowed runtimes", () => {
    const result = validateExecutionProfile(
      profile({ cli: "claude" as "opencode" }),
      new Set(["opencode-main"]),
    )
    expect(result.kind).toBe("invalid")
  })

  test("rejects disallowed commands", () => {
    const result = validateExecutionProfile(
      profile({ command: "codex" as "opencode" }),
      new Set(["opencode-main"]),
    )
    expect(result.kind).toBe("invalid")
  })

  test("rejects empty model identifiers", () => {
    const result = validateExecutionProfile(
      profile({ providerID: "" }),
      new Set(["opencode-main"]),
    )
    expect(result.kind).toBe("invalid")
  })

  test("accepts a minimal primary profile", () => {
    const result = validateExecutionProfile(profile(), new Set(["opencode-main"]))
    expect(result.kind).toBe("ok")
  })
})

describe("fallbackPosition", () => {
  test("returns the primary index when there are no remaining fallbacks", () => {
    const result = fallbackPosition("opencode-main", ["opencode-backup"], [])
    expect(result).toEqual({ chain: ["opencode-main", "opencode-backup"], index: 0 })
  })

  test("returns the index of the next pending fallback when present", () => {
    const result = fallbackPosition(
      "opencode-main",
      ["opencode-backup", "opencode-cold"],
      ["opencode-cold"],
    )
    expect(result.index).toBe(2)
  })

  test("falls back to the primary when the first remaining entry is unknown", () => {
    const result = fallbackPosition(
      "opencode-main",
      ["opencode-backup"],
      ["opencode-ghost"],
    )
    expect(result.index).toBe(0)
  })
})

describe("advanceFallback", () => {
  test("returns the next entry for fallback-eligible categories", () => {
    const result = advanceFallback(
      ["opencode-backup", "opencode-cold"],
      "opencode-backup",
      "provider_quota",
    )
    expect(result.next).toBe("opencode-cold")
    expect(result.remaining).toEqual(["opencode-cold"])
  })

  test("preserves the chain when the category is not fallback-eligible", () => {
    const result = advanceFallback(
      ["opencode-backup"],
      "opencode-backup",
      "none",
    )
    expect(result.next).toBeUndefined()
    expect(result.remaining).toEqual(["opencode-backup"])
  })

  test("returns undefined when the failed profile is not in the chain", () => {
    const result = advanceFallback(
      ["opencode-backup"],
      "opencode-ghost",
      "provider_quota",
    )
    expect(result.next).toBeUndefined()
    expect(result.remaining).toEqual(["opencode-backup"])
  })
})
