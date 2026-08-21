/**
 * The operator-facing surface of a run.
 *
 * Two readings of the same run live here. The parsed one — the default — is a
 * timestamped, aligned stream styled after the Bagels TUI: its own tokyo-night
 * palette, a rounded panel for the run header, and a gutter every continuation
 * line hangs from, so a long run stays readable as a column rather than as
 * scrollback. The verbose ones widen what reaches that stream: `--verbose` adds
 * the reasoning and tool traffic as `debug`, and `--verbose-output` adds `trace`,
 * which is the agent stream itself, verbatim.
 */

import ora, { type Ora } from "ora";
import chalk from "chalk";
import { OPERATOR_TIMESTAMP_WIDTH, formatOperatorTimestamp } from "./timestamp.ts";
import type { FailureKind } from "./failure-kind.ts";
import type { RunLogContext } from "./run-log.ts";

export type ReporterStream = { write(chunk: string): void };

export type ReporterLevel = "info" | "warn" | "error" | "debug" | "trace";

/**
 * What a typed failure emission (ADR-0029) adds to a plain `warn`/`error` line:
 * the failure's classification, the phase it happened in, and the run's own
 * high-cardinality identifiers. Optional because most `warn`/`error` callers
 * still just report prose with nothing to classify.
 */
export interface ReporterFailureDetail {
  failureKind?: FailureKind | null;
  phase?: string | null;
  context?: RunLogContext;
  checkpoint?: "preserved";
}

export interface Reporter {
  info(message: string): void;
  warn(message: string, detail?: ReporterFailureDetail): void;
  error(message: string, detail?: ReporterFailureDetail): void;
  /** Visible with `--verbose`: what the agent reasoned and which tools it ran. */
  debug(message: string): void;
  /** Visible only with `--verbose-output`: the agent stream as it arrived. */
  trace(message: string): void;
  /**
   * Whether `trace` reaches the operator. A producer reads it before building
   * detail no one asked for — a tool call's whole input is not free to render.
   */
  readonly tracing: boolean;
  /** The rounded panel that opens a run, in the Bagels manner. */
  heading(title: string, details?: readonly string[]): void;
  start(message: string): Ora;
  stop(spinner?: Ora): void;
}

/** Forwards every `warn`/`error` the Reporter emits as a run-log `event` record (ADR-0029). Additive: it never gates what reaches the terminal. */
export interface ReporterRunLogSink {
  event(severity: "warn" | "error", message: string, detail?: ReporterFailureDetail): void;
}

export interface ReporterOptions {
  verbose: boolean;
  /** Implies `verbose`, and additionally lets `trace` through. */
  verboseOutput?: boolean;
  quiet?: boolean;
  noColor?: boolean;
  stream?: ReporterStream;
  /** Injected so a test reads a fixed clock instead of the wall one. */
  now?: () => Date;
  /** The run log seam; absent means no run log is attached, and nothing else changes. */
  runLog?: ReporterRunLogSink;
}

/**
 * Bagels' own default theme (tokyo-night). Naming the palette once keeps every
 * level, the gutter and the header panel on one coherent set of colors.
 */
export const BAGELS_PALETTE = {
  primary: "#bb9af7",
  secondary: "#7aa2f7",
  warning: "#e0af68",
  error: "#f7768e",
  success: "#9ece6a",
  accent: "#ff9e64",
  foreground: "#a9b1d6",
  muted: "#565f89",
  panel: "#414868",
} as const;

const GLYPHS: Record<ReporterLevel, string> = {
  info: "●",
  warn: "▲",
  error: "✖",
  debug: "·",
  trace: "⋮",
};

const GLYPH_COLOR: Record<ReporterLevel, string> = {
  info: BAGELS_PALETTE.primary,
  warn: BAGELS_PALETTE.warning,
  error: BAGELS_PALETTE.error,
  debug: BAGELS_PALETTE.secondary,
  trace: BAGELS_PALETTE.panel,
};

const TEXT_COLOR: Record<ReporterLevel, string> = {
  info: BAGELS_PALETTE.foreground,
  warn: BAGELS_PALETTE.warning,
  error: BAGELS_PALETTE.error,
  debug: BAGELS_PALETTE.muted,
  trace: BAGELS_PALETTE.muted,
};

const GUTTER = "│";
/** The gutter, and the space on either side of the level glyph. */
const GLYPH_COLUMN_WIDTH = 3;
const HEADING_MAX_WIDTH = 78;

const envNoColor = (): boolean => process.env.NO_COLOR === "1";

type Paint = (text: string) => string;

const painter = (noColor: boolean) => (color: string): Paint =>
  (text) => (noColor ? text : chalk.hex(color)(text));

const consoleErrorStream: ReporterStream = {
  write(chunk: string) {
    console.error(chunk.replace(/\n$/, ""));
  },
};

export function createReporter(verbose: boolean): Reporter;
export function createReporter(options: ReporterOptions): Reporter;
export function createReporter(arg: boolean | ReporterOptions): Reporter {
  const options: ReporterOptions = typeof arg === "boolean" ? { verbose: arg } : arg;
  const stream = options.stream ?? consoleErrorStream;
  const noColor = options.noColor ?? envNoColor();
  const quiet = options.quiet ?? false;
  const verboseOutput = options.verboseOutput ?? false;
  // `--verbose-output` is the widest reading of a run, so it can never show less
  // than `--verbose` does.
  const verbose = options.verbose || verboseOutput;
  const now = options.now ?? (() => new Date());
  const runLog = options.runLog;

  const paint = painter(noColor);
  const paintGutter = paint(BAGELS_PALETTE.panel);
  const paintTimestamp = paint(BAGELS_PALETTE.muted);

  /**
   * One reported message, however many lines it carries: the first line is
   * stamped and glyphed, and the rest hang from the same gutter so a multi-line
   * message stays one visual block instead of several stray entries.
   */
  const render = (level: ReporterLevel, message: string): string => {
    const stamp = paintTimestamp(formatOperatorTimestamp(now()));
    const head = `${stamp} ${paintGutter(GUTTER)} ${paint(GLYPH_COLOR[level])(GLYPHS[level])} `;
    const hanging = `${" ".repeat(OPERATOR_TIMESTAMP_WIDTH)} ${paintGutter(GUTTER)}${" ".repeat(GLYPH_COLUMN_WIDTH)}`;
    const paintText = paint(TEXT_COLOR[level]);
    return message
      .split(/\r?\n/)
      .map((line, index) => `${index === 0 ? head : hanging}${paintText(line)}\n`)
      .join("");
  };

  const write = (level: ReporterLevel, message: string): void => {
    stream.write(render(level, message));
  };

  return {
    tracing: verboseOutput && !quiet,
    info(message) {
      if (quiet) return;
      write("info", message);
    },
    warn(message, detail) {
      // Reported to the run log regardless of `--quiet`: a dashboard needs the
      // record even on a run whose terminal is silenced.
      runLog?.event("warn", message, detail);
      if (quiet) return;
      write("warn", message);
    },
    error(message, detail) {
      runLog?.event("error", message, detail);
      write("error", message);
    },
    debug(message) {
      if (quiet || !verbose) return;
      write("debug", message);
    },
    trace(message) {
      if (quiet || !verboseOutput) return;
      write("trace", message);
    },
    heading(title, details = []) {
      if (quiet) return;
      const rows = [title, ...details].map((row) => row.slice(0, HEADING_MAX_WIDTH));
      const width = Math.max(...rows.map((row) => row.length));
      const border = paint(BAGELS_PALETTE.primary);
      const body = rows.map((row, index) => {
        const painted = index === 0
          ? paint(BAGELS_PALETTE.primary)(row.padEnd(width))
          : paint(BAGELS_PALETTE.muted)(row.padEnd(width));
        return `${border("│")} ${painted} ${border("│")}\n`;
      });
      stream.write([
        `${border(`╭${"─".repeat(width + 2)}╮`)}\n`,
        ...body,
        `${border(`╰${"─".repeat(width + 2)}╯`)}\n`,
      ].join(""));
    },
    start(message) {
      const spinner = ora({
        text: message,
        stream: stream as unknown as NodeJS.WritableStream,
        isSilent: noColor,
      });
      spinner.start();
      return spinner;
    },
    stop(spinner) {
      spinner?.stop();
    },
  };
}
