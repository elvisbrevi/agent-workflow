// Splits a `providerID/modelID` string into its two halves exactly once.
//
// The TOML schema only stores a single `model = "provider/model"` scalar
// per profile. The runtime needs `providerID` and `modelID` separately to
// pass to the OpenCode runtime, and the contract requires the split to
// happen at config-load time so subsequent modules can rely on the typed
// fields. Splitting only once prevents surprising falls-through on model
// IDs that themselves contain `/` (for example `acme/anthropic/claude-1`
// resolves to `providerID=acme`, `modelID=anthropic/claude-1`).

import { CONTROL_SCALAR_REASONS, validateScalarString } from "./control-scalar"

export const MODEL_SPLIT_REASONS = [
  ...CONTROL_SCALAR_REASONS,
  "empty",
  "missing_separator",
  "empty_provider",
  "empty_model",
  "control_character",
] as const

export type ModelSplitReason = (typeof MODEL_SPLIT_REASONS)[number]

export type ModelSplit =
  | { readonly kind: "ok"; readonly providerID: string; readonly modelID: string }
  | { readonly kind: "invalid"; readonly reason: ModelSplitReason; readonly value: string }

const MODEL_CONTROL_REASONS = new Set<string>(["newline", "carriage_return", "nul"])

export const splitModel = (raw: string): ModelSplit => {
  const controlIssue = validateScalarString(raw, "model")
  if (controlIssue !== null && MODEL_CONTROL_REASONS.has(controlIssue.reason)) {
    return { kind: "invalid", reason: "control_character", value: raw }
  }
  if (raw.length === 0) {
    return { kind: "invalid", reason: "empty", value: raw }
  }
  const separator = raw.indexOf("/")
  if (separator < 0) {
    return { kind: "invalid", reason: "missing_separator", value: raw }
  }
  const provider = raw.slice(0, separator)
  const model = raw.slice(separator + 1)
  if (provider.length === 0) {
    return { kind: "invalid", reason: "empty_provider", value: raw }
  }
  if (model.length === 0) {
    return { kind: "invalid", reason: "empty_model", value: raw }
  }
  return { kind: "ok", providerID: provider, modelID: model }
}
