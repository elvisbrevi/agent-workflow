#!/usr/bin/env bun
// V2 entrypoint stub for issue-killer. The TypeScript + Bun runtime is
// added in milestone M2 but is intentionally not installed yet: the public
// command continues to resolve to the Bash V1 runner while the V2 binary
// proves itself through cutover milestones M10-M12. This stub exists only
// so the package layout matches `docs/design/issue-killer.md` and so the
// `bun run typecheck` + `bun test` commands can cover `bin/` without
// shipping a runnable entrypoint.

const exit = (code: number, message: string): never => {
  process.stderr.write(`issue-killer V2: ${message}\n`)
  process.exit(code)
}

const installHint = [
  "the V2 entrypoint is not yet installed in this repository migration.",
  "Use the Bash V1 runner for now: ./agent/issue-killer/run.sh",
  "Cutover is tracked by issue #90 (parity + canary + public cutover).",
].join(" ")

exit(1, installHint)
