// System primitives placeholder for issue-killer V2.
//
// The real `clock`, `command`, `git`, `redaction`, and `signals` modules
// land in issue #81 and #82 (M3). This file exists only so the package
// layout matches `docs/design/issue-killer.md`.

export const PLACEHOLDER_NOT_WIRED: unique symbol = Symbol("issue-killer/system.placeholder")

export const PLACEHOLDER_FILESYSTEM_SAFE: unique symbol = Symbol("issue-killer/system.fs-safe")
