import { describe, expect, test } from "bun:test"
import {
  PROVIDER_FAILURE_CATEGORIES,
  ProviderFailureCategory,
  PROVIDER_FAILURE_CATEGORY_LABEL,
  isFallbackEligible,
  isProviderFailureCategory,
  providerFailureFromReason,
} from "../../../src/domain/provider-failure"

describe("isProviderFailureCategory", () => {
  test("accepts the closed set", () => {
    for (const category of PROVIDER_FAILURE_CATEGORIES) {
      expect(isProviderFailureCategory(category)).toBe(true)
    }
  })

  test("rejects unknowns", () => {
    expect(isProviderFailureCategory("transport")).toBe(false)
    expect(isProviderFailureCategory(null)).toBe(false)
    expect(isProviderFailureCategory(42)).toBe(false)
  })
})

describe("isFallbackEligible", () => {
  const ELIGIBLE: ReadonlyArray<ProviderFailureCategory> = [
    "provider_quota",
    "provider_rate_limit",
    "provider_model_unavailable",
  ]

  for (const category of PROVIDER_FAILURE_CATEGORIES) {
    test(`marks ${category} as ${ELIGIBLE.includes(category) ? "eligible" : "not eligible"}`, () => {
      expect(isFallbackEligible(category)).toBe(ELIGIBLE.includes(category))
    })
  }
})

describe("providerFailureFromReason", () => {
  test("always maps known reasons to `none` (implementation failures never consume fallbacks)", () => {
    expect(providerFailureFromReason("transport_disconnect")).toBe("none")
    expect(providerFailureFromReason("invalid_status")).toBe("none")
    expect(providerFailureFromReason("client_error")).toBe("none")
    expect(providerFailureFromReason("authorization_missing")).toBe("none")
    expect(providerFailureFromReason("permission_prompted")).toBe("none")
    expect(providerFailureFromReason("structured_output_failed")).toBe("none")
    expect(providerFailureFromReason("session_error")).toBe("none")
  })
})

describe("PROVIDER_FAILURE_CATEGORY_LABEL", () => {
  test("has a label for every category in the closed set", () => {
    expect(new Set(Object.keys(PROVIDER_FAILURE_CATEGORY_LABEL))).toEqual(new Set(PROVIDER_FAILURE_CATEGORIES))
    for (const category of PROVIDER_FAILURE_CATEGORIES) {
      expect(PROVIDER_FAILURE_CATEGORY_LABEL[category].length).toBeGreaterThan(0)
    }
  })
})
