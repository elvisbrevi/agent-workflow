// Configuration loader placeholder for issue-killer V2.
//
// TOML parsing, validation, and credential-free fail-closed semantics are
// introduced in issue #80 (M3). This file exists only so the package
// layout matches `docs/design/issue-killer.md`.

export const PLACEHOLDER_NOT_WIRED: unique symbol = Symbol("issue-killer/config.placeholder")

export const loadConfigPath = (): string => ""
