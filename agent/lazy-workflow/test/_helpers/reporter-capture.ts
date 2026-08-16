import type { createReporter, Reporter } from "../../src/output/reporter.ts";

/**
 * The reporter a test injects to read what the run told the operator, without a
 * stream or a terminal in the middle: `messages` holds each `reportOperator`
 * line exactly as it was written.
 */
export function captureReporter(): { reporterFn: typeof createReporter; messages: string[] } {
  const messages: string[] = [];
  const reporter: Reporter = {
    info: (message: string) => { messages.push(message); },
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    start: () => ({ stop: () => undefined }) as never,
    stop: () => undefined,
  };
  return { reporterFn: (() => reporter) as typeof createReporter, messages };
}
