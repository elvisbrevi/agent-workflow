// OpenCode runtime adapter placeholder for issue-killer V2.
//
// The real `create-runtime`, `event-pump`, `normalize-event`,
// `provider-failure`, and `session` modules land in issue #84 (M5). The
// spike already pinned the SDK surface in
// `test/contract/opencode-sdk*` and `test/fixtures/opencode-sdk-contract.ts`,
// but no runtime code is shipped yet. This file exists only so the
// package layout matches `docs/design/issue-killer.md`.

export const PLACEHOLDER_NOT_WIRED: unique symbol = Symbol("issue-killer/opencode.placeholder")

export const opencodeRuntimePath = (): string => "opencode"
