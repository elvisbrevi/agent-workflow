import type { createReporter, Reporter } from "../../src/output/reporter.ts";

/**
 * The reporter a test injects to read what the run told the operator, without a
 * stream or a terminal in the middle: `messages` holds each `reportOperator`
 * line exactly as it was written, and `headings` the run panels it opened.
 */
export function captureReporter(): { reporterFn: typeof createReporter; messages: string[]; headings: string[] } {
  const messages: string[] = [];
  const headings: string[] = [];
  const reporter: Reporter = {
    tracing: false,
    info: (message: string) => { messages.push(message); },
    warn: () => undefined,
    error: (message: string) => { messages.push(message); },
    debug: () => undefined,
    trace: () => undefined,
    heading: (title: string) => { headings.push(title); },
    start: () => ({ stop: () => undefined }) as never,
    stop: () => undefined,
  };
  return { reporterFn: (() => reporter) as typeof createReporter, messages, headings };
}
