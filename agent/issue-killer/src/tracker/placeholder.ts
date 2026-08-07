// Tracker adapter placeholder for issue-killer V2.
//
// The `tracker/github` module landed in issue #83 (M4). The Azure adapter
// and supervisor wiring land in issues #87, #88, and #85. This file
// remains so the package layout matches `docs/design/issue-killer.md`.

export const PLACEHOLDER_NOT_WIRED: unique symbol = Symbol("issue-killer/tracker.placeholder")

export const PLACEHOLDER_NO_GH_REQUIED: unique symbol = Symbol("issue-killer/tracker.no-gh")
