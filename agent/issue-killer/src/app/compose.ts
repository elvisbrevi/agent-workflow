// Composition root placeholder for issue-killer V2.
//
// `app/` owns the top-level orchestration entrypoints. They depend on
// the pure domain modules in `../domain/` and on the injected ports; they
// must not call filesystem, SDK, or CLI APIs directly. Real run-queue /
// run-attempt / recover-attempt modules land in later milestones; this
// file exists only so the package layout matches
// `docs/design/issue-killer.md` and so `bun run typecheck` covers the
// directory without shipping a runnable entrypoint.

export const PLACEHOLDER_NOT_WIRED: unique symbol = Symbol("issue-killer/app.compose.placeholder")

export type Composed = {
  readonly state: "unwired"
}

export const compose = (): Composed => {
  throw new Error("issue-killer/app.compose: composition root not yet wired")
}
