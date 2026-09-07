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

/**
 * A session's start record, held open until the session names itself.
 *
 * No CLI knows its session id before it runs: Claude Code announces it on its
 * `system`/`init` event, Codex on `thread.started`, OpenCode on the first event
 * carrying a `sessionID`, and only a resumed session carries one on its own
 * command line. So `session_started` is written on the first id that turns up —
 * the resumed one when there is one, the stream's otherwise — and `settle()`
 * writes it anyway, with a null id, for a session that died before naming
 * itself. An attempt is never missing from the log, and a run's start and
 * finish records stay one for one.
 */
export interface SessionStart {
  /** Whatever id a stream line carried, if any; the first one present writes the record. */
  observed(sessionId: string | null | undefined): void;
  /** Writes the record with a null id if none ever turned up. Idempotent, so every exit path can call it. */
  settle(): void;
}

export function openSessionStart(
  message: string,
  rung: SessionRung,
  reporter: Reporter = getDefaultReporter(),
  resumedSessionId?: string | null,
): SessionStart {
  let written = false;
  const write = (sessionId: string | null): void => {
    if (written) return;
    written = true;
    reportSessionEvent("session_started", message, rung, { sessionId }, {}, reporter);
  };
  if (resumedSessionId) write(resumedSessionId);
  return {
    observed(sessionId) {
      if (sessionId) write(sessionId);
    },
    settle() {
      write(null);
    },
  };
}
