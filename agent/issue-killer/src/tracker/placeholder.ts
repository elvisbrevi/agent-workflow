// Tracker adapter placeholder for issue-killer V2.
//
// The concrete GitHub and Azure adapters live beside this scaffold. This file
// remains so the package layout matches `docs/design/issue-killer.md` while the
// remaining supervisor wiring lands in a later milestone.

export const PLACEHOLDER_NOT_WIRED: unique symbol = Symbol("issue-killer/tracker.placeholder")

export const PLACEHOLDER_NO_GH_REQUIED: unique symbol = Symbol("issue-killer/tracker.no-gh")
