/**
 * The closed vocabulary a failure is classified into (ADR-0029), declared once
 * so a new failure kind is a single addition here rather than a string
 * sprinkled across call sites. `reportFailure` is the one call a failure site
 * makes: it routes the human line to `Reporter.warn`/`.error` (never `.info`)
 * and, in the same call, writes the run-log `event` record carrying the kind,
 * the phase and the context — so the two outputs can never disagree.
 *
 * The module is deliberately not GitHub-specific in name or shape: issue #264
 * only wires it into GitHub coordinated delivery, but a later ticket wiring
 * Azure failure sites reuses the same vocabulary and the same emitter.
 */

import { getDefaultReporter } from "./operator-output.ts";
import type { Reporter } from "./reporter.ts";
import type { RunLogContext } from "./run-log.ts";

/**
 * The closed vocabulary and its severity live in one declaration. Adding a
 * kind therefore updates one place and gives every caller the same type and
 * level without a second registry to keep in sync.
 */
export const FAILURE_KIND_SEVERITY = {
  "tracker-read-failure": "error",
  "claim-verification-failure": "error",
  "branch-preparation-failure": "error",
  "session-failure": "error",
  "manifest-not-verifiable": "error",
  "delivery-failure": "error",
  "pull-request-failure": "error",
  "reconciliation-required": "error",
  "parent-reconciliation-failure": "error",
  "deterministic-completion-failure": "error",
  "checkpoint-unreadable": "error",
  "lock-unavailable": "error",
  "argument-error": "error",
  "evidence-not-verifiable": "error",
  "manifest-mismatch": "error",
  "hu-transition-failure": "error",
  "ticket-branch-cleanup-failure": "error",
  "workspace-scope-failure": "error",
  "topology-preparation-failure": "error",
  "deployment-authentication-required": "error",
  "infrastructure-authentication-required": "error",
} as const satisfies Record<string, "warn" | "error">;

export type FailureKind = keyof typeof FAILURE_KIND_SEVERITY;

/** The Reporter level `kind` is emitted at, exposed so a call site can decide before building context no one asked for. */
export function failureKindSeverity(kind: FailureKind): "warn" | "error" {
  return FAILURE_KIND_SEVERITY[kind];
}

/**
 * One call, two outputs that can never disagree: the operator line at the
 * level the kind carries, and a run-log `event` record with the same kind,
 * phase and context. `reporter` defaults to the process' own default Reporter
 * so a call site never has to thread one through by hand, and a test can still
 * inject its own.
 */
export function reportFailure(
  kind: FailureKind,
  phase: string,
  context: RunLogContext,
  message: string,
  reporter: Reporter = getDefaultReporter(),
  checkpoint?: "preserved",
): void {
  const severity = failureKindSeverity(kind);
  reporter[severity](message, {
    failureKind: kind,
    phase,
    context,
    ...(checkpoint ? { checkpoint } : {}),
  });
}
