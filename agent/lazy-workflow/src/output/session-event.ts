/**
 * Session-lifecycle telemetry (issue #267): one call per coding-agent session
 * milestone, always additive to whatever the operator already sees on the
 * terminal — `Reporter.session` never reaches the stream, only the run log,
 * so wiring a new call site changes no operator-visible output.
 */
import { getDefaultReporter } from "./operator-output.ts";
import type { Reporter } from "./reporter.ts";
import type { RunLogContext, RunLogOutcome, RunLogSessionEvent } from "./run-log.ts";

/** The CLI/model/variant the session in question actually ran on, which may differ from the run's own declared rung after a descent. */
export interface SessionRung {
  cli: string;
  model?: string | null;
  variant?: string | null;
}

export interface SessionEventExtra {
  durationMs?: number | null;
  outcome?: RunLogOutcome | null;
  /** The closed exhaustion-cause vocabulary (`rate_limit`, `billing`, ...) — a session's own stop reason travels in `context.stopReason` instead, since that vocabulary is the provider's own and unbounded (ADR-0029). */
  reason?: string | null;
  /** Set only on a cross-CLI handoff: the CLI the work yielded from. */
  fromCli?: string | null;
  checkpoint?: "preserved";
}

export function reportSessionEvent(
  kind: RunLogSessionEvent,
  message: string,
  rung: SessionRung,
  context: RunLogContext = {},
  extra: SessionEventExtra = {},
  reporter: Reporter = getDefaultReporter(),
): void {
  reporter.session(kind, message, {
    cli: rung.cli,
    model: rung.model,
    variant: rung.variant,
    context,
    ...extra,
  });
}
