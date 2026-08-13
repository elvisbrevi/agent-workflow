import { createReporter, type Reporter } from "./reporter.ts";

const pad = (value: number): string => value.toString().padStart(2, "0");

export function formatOperatorTimestamp(date = new Date()): string {
  return [
    `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${pad(date.getFullYear() % 100)}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(" ");
}

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
