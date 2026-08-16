import { OPERATOR_TIMESTAMP_WIDTH } from "../../src/output/timestamp.ts";

/**
 * Reads the reporter's own rendering back into the messages that produced it.
 *
 * The parsed stream stamps every line and hangs its continuations from a gutter,
 * so a test that wants the message and its level has to undo exactly that. One
 * definition here keeps every test reading the format the reporter actually
 * writes.
 */

export type ReportedLevel = "info" | "warn" | "error" | "debug" | "trace";

export interface ReportedLine {
  level: ReportedLevel;
  message: string;
}

const GLYPH_LEVEL: Record<string, ReportedLevel> = {
  "●": "info",
  "▲": "warn",
  "✖": "error",
  "·": "debug",
  "⋮": "trace",
};

const stripAnsi = (text: string): string => text.replace(/\[[0-9;]*m/g, "");

const HEAD = /^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} │ (.) (.*)$/;
const HANGING = new RegExp(`^ {${OPERATOR_TIMESTAMP_WIDTH}} │ {3}(.*)$`);
/** The rounded panel of a run header, which is not a levelled line. */
const PANEL = /^[╭│╰]/;

/** Every levelled message a written chunk carries, panels excluded. */
export function parseReportedChunk(chunk: string): ReportedLine[] {
  const lines: ReportedLine[] = [];
  for (const raw of stripAnsi(chunk).replace(/\n$/, "").split("\n")) {
    const head = raw.match(HEAD);
    if (head) {
      const level = GLYPH_LEVEL[head[1] as string];
      if (level) lines.push({ level, message: head[2] ?? "" });
      continue;
    }
    const hanging = raw.match(HANGING);
    const previous = lines[lines.length - 1];
    if (hanging && previous) previous.message = `${previous.message}\n${hanging[1] ?? ""}`;
    else if (!hanging && !PANEL.test(raw) && previous) previous.message = `${previous.message}\n${raw}`;
  }
  return lines;
}

/** True when the chunk is the rounded header panel rather than a reported line. */
export function isPanelChunk(chunk: string): boolean {
  return PANEL.test(stripAnsi(chunk));
}
