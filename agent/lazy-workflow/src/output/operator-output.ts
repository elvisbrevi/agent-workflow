import { createReporter, type Reporter } from "./reporter.ts";
import { OPERATOR_TIMESTAMP_WIDTH, formatOperatorTimestamp } from "./timestamp.ts";

export { OPERATOR_TIMESTAMP_WIDTH, formatOperatorTimestamp };

/**
 * A message already stamped in the operator format. The reporter stamps every
 * line it writes, so this stays for the callers that need the stamped text
 * itself rather than a reported line.
 */
export function operatorLine(message: string, date = new Date()): string {
  const prefix = `[${formatOperatorTimestamp(date)}]`;
  return message.split(/\r?\n/).map((line) => `${prefix} ${line}`).join("\n");
}

let defaultReporter: Reporter = createReporter(false);

export function getDefaultReporter(): Reporter {
  return defaultReporter;
}

export function setDefaultReporter(reporter: Reporter): void {
  defaultReporter = reporter;
}

export function reportOperator(message: string): void {
  defaultReporter.info(message);
}

/** The run header, in the Bagels manner: title first, then the run's own facts. */
export function reportOperatorHeading(title: string, details: readonly string[] = []): void {
  defaultReporter.heading(title, details);
}
