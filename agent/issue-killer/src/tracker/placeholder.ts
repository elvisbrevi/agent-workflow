// Tracker adapter placeholder for issue-killer V2.
//
// The real `select-tracker` plus `tracker/github` and `tracker/azure`
// modules land in issues #83, #85, #87, and #88 (M4, M6, M8, M9). This
// file exists only so the package layout matches
// `docs/design/issue-killer.md`.

export const PLACEHOLDER_NOT_WIRED: unique symbol = Symbol("issue-killer/tracker.placeholder")

export const PLACEHOLDER_NO_GH_REQUIED: unique symbol = Symbol("issue-killer/tracker.no-gh")
