// Repository lock, checkpoint, and atomic-file placeholders for
// issue-killer V2.
//
// The real `atomic-file`, `checkpoint-store`, and `repository-lock`
// modules land in issue #81 (M3). This file exists only so the package
// layout matches `docs/design/issue-killer.md`.

export const PLACEHOLDER_NOT_WIRED: unique symbol = Symbol("issue-killer/state.placeholder")

export const PLACEHOLDER_LOCK_HELD: unique symbol = Symbol("issue-killer/state.lock-held")
