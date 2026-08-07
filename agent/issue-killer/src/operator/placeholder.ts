// Operator (TTY + installer) placeholder for issue-killer V2.
//
// The actual `arguments` and `terminal-session` modules land in
// issue #89 (M10). This file exists only so the package layout matches
// `docs/design/issue-killer.md`.

export const PLACEHOLDER_NOT_WIRED: unique symbol = Symbol("issue-killer/operator.placeholder")

export const operatorIsInteractive = (): boolean => Boolean(process?.stdout?.isTTY)
