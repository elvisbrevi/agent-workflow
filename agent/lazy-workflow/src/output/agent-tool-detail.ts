/**
 * What a tool call is doing, read off the input the agent CLI reports.
 *
 * Both adapters stream tool calls, and both name their arguments the way their
 * own provider does. Reading them here once means the operator sees the same
 * thing either way — above all *which file* an edit is touching, which is the
 * question a watched run is usually asking (issue: verbose output).
 */

/** Keys that name the artifact a tool acts on, most identifying first. */
const TARGET_KEYS = [
  "file_path",
  "filePath",
  "filepath",
  "notebook_path",
  "notebookPath",
  "path",
  "filename",
  "file",
  "url",
  "pattern",
  "glob",
] as const;

/** Keys that carry the short human-readable summary of the call. */
const DETAIL_KEYS = ["command", "description", "title", "query", "prompt"] as const;

/** A long value is quoted evidence, not a payload to reprint in full. */
const MAX_VALUE_LENGTH = 400;
const MAX_RENDERED_LENGTH = 4_000;

export interface ToolDescription {
  /** The file, path, URL or pattern the call names, when it names one. */
  target: string | null;
  /** The shell command, description or title the call carries. */
  detail: string | null;
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
}

function readText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The target and the summary of one tool call, or nulls when the input says neither. */
export function describeToolInput(input: unknown): ToolDescription {
  const record = asRecord(input);
  if (!record) return { target: null, detail: null };
  const target = TARGET_KEYS.map((key) => readText(record, key)).find((value) => value !== null) ?? null;
  const detail = DETAIL_KEYS.map((key) => readText(record, key)).find((value) => value !== null) ?? null;
  return { target, detail };
}

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

function shorten(value: unknown): unknown {
  if (typeof value === "string") return truncate(value, MAX_VALUE_LENGTH);
  if (Array.isArray(value)) return value.map(shorten);
  const record = asRecord(value);
  if (record) return Object.fromEntries(Object.entries(record).map(([key, nested]) => [key, shorten(nested)]));
  return value;
}

/**
 * The whole input of a tool call, for `--verbose-output`. Every string is
 * shortened first, so a file rewrite is reported as a call with its arguments
 * rather than as the file printed back to the terminal.
 */
export function renderToolInput(input: unknown): string | null {
  const record = asRecord(input);
  if (!record || Object.keys(record).length === 0) return null;
  try {
    return truncate(JSON.stringify(shorten(record)), MAX_RENDERED_LENGTH);
  } catch {
    return null;
  }
}

/** The output a tool reported back, shortened the same way its input is. */
export function renderToolOutput(output: unknown): string | null {
  if (typeof output === "string") {
    const trimmed = output.trim();
    return trimmed.length > 0 ? truncate(trimmed, MAX_RENDERED_LENGTH) : null;
  }
  if (output === undefined || output === null) return null;
  try {
    return truncate(JSON.stringify(shorten(output)), MAX_RENDERED_LENGTH);
  } catch {
    return null;
  }
}

/**
 * The one sentence a tool call gets in the parsed and `--verbose` streams:
 * the tool, its status, the artifact it touches, and its own summary.
 */
export function renderToolCall(
  prefix: string,
  tool: string | undefined,
  status: string | undefined,
  input: unknown,
): string {
  const { target, detail } = describeToolInput(input);
  return [
    `${prefix} herramienta ${tool ?? "desconocida"}`,
    status ? ` (${status})` : "",
    target ? ` en ${target}` : "",
    detail && detail !== target ? `: ${JSON.stringify(truncate(detail, MAX_VALUE_LENGTH))}` : "",
  ].join("");
}
