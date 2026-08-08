import { describe, expect, test } from "bun:test"
import {
  classifyProviderFailure,
  isTransportFailure,
} from "../../../src/domain/provider-failure"

describe("classifyProviderFailure", () => {
  test("prefers a typed rate-limit HTTP status", () => {
    expect(classifyProviderFailure({ name: "RateLimitError", status: 429, message: "busy" })).toBe("provider_rate_limit")
  })

  test("recognizes quota errors from typed status before message text", () => {
    expect(classifyProviderFailure({ name: "QuotaError", status: 402, message: "unavailable" })).toBe("provider_quota")
  })

  test("recognizes model-unavailable provider responses", () => {
    expect(classifyProviderFailure({ status: 404, code: "model_not_found", message: "not found" })).toBe("provider_model_unavailable")
  })

  test("reads typed SDK status and message fields nested in API errors", () => {
    expect(classifyProviderFailure({ name: "APIError", data: { statusCode: 429, message: "busy" } })).toBe("provider_rate_limit")
    expect(classifyProviderFailure({ name: "APIError", data: { statusCode: 402, message: "quota exhausted" } })).toBe("provider_quota")
  })

  test("uses diagnostics only after structured fields", () => {
    expect(classifyProviderFailure(new Error("provider quota exhausted"))).toBe("provider_quota")
    expect(classifyProviderFailure(new Error("implementation assertion failed"))).toBe("none")
  })
})

describe("isTransportFailure", () => {
  test("identifies retryable transport failures without making them fallback failures", () => {
    expect(isTransportFailure({ code: "ECONNRESET" })).toBe(true)
    expect(isTransportFailure({ name: "APIError", data: { statusCode: 503 } })).toBe(true)
    expect(isTransportFailure({ name: "AbortError" })).toBe(false)
  })
})
