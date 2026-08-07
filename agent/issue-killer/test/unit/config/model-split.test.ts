import { describe, expect, test } from "bun:test"
import { splitModel, type ModelSplitReason } from "../../../src/config/model-split"

const expectInvalid = (input: string, reason: ModelSplitReason): void => {
  const result = splitModel(input)
  expect(result.kind).toBe("invalid")
  if (result.kind === "invalid") {
    expect(result.reason).toBe(reason)
    expect(result.value).toBe(input)
  }
}

const expectValid = (input: string, provider: string, model: string): void => {
  const result = splitModel(input)
  expect(result.kind).toBe("ok")
  if (result.kind === "ok") {
    expect(result.providerID).toBe(provider)
    expect(result.modelID).toBe(model)
  }
}

describe("splitModel", () => {
  test("splits once on the first slash", () => {
    expectValid("provider/model", "provider", "model")
    expectValid("acme/anthropic/claude-1", "acme", "anthropic/claude-1")
  })

  test("rejects empty input", () => {
    expectInvalid("", "empty")
  })

  test("rejects strings without a slash", () => {
    expectInvalid("only-provider", "missing_separator")
  })

  test("rejects empty provider before slash", () => {
    expectInvalid("/model", "empty_provider")
  })

  test("rejects empty model after slash", () => {
    expectInvalid("provider/", "empty_model")
  })

  test("rejects control characters", () => {
    expectInvalid("prov\nider/model", "control_character")
    expectInvalid("provider/mo\rdel", "control_character")
    expectInvalid("provider/mo\u0000del", "control_character")
  })
})
