import ora, { type Ora } from "ora";
import chalk, { type ChalkInstance } from "chalk";

export type ReporterStream = { write(chunk: string): void };

export interface Reporter {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
  start(message: string): Ora;
  stop(spinner?: Ora): void;
}

export interface ReporterOptions {
  verbose: boolean;
  quiet?: boolean;
  noColor?: boolean;
  stream?: ReporterStream;
}

const ICONS = {
  info: "ℹ",
  warn: "⚠",
  error: "✗",
  debug: "·",
} as const;

type IconName = keyof typeof ICONS;

const envNoColor = (): boolean => process.env.NO_COLOR === "1";

const paint = (color: "blue" | "yellow" | "red" | "gray", noColor: boolean) =>
  (line: string): string => (noColor ? line : (chalk[color] as ChalkInstance)(line));

const format = (icon: IconName, message: string): string => `${ICONS[icon]} ${message}`;

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

  const write = (text: string): void => {
    stream.write(text);
  };

  const coloredInfo = paint("blue", noColor);
  const coloredWarn = paint("yellow", noColor);
  const coloredError = paint("red", noColor);
  const coloredDebug = paint("gray", noColor);

  return {
    info(message) {
      if (quiet) return;
      write(`${coloredInfo(format("info", message))}\n`);
    },
    warn(message) {
      if (quiet) return;
      write(`${coloredWarn(format("warn", message))}\n`);
    },
    error(message) {
      write(`${coloredError(format("error", message))}\n`);
    },
    debug(message) {
      if (quiet) return;
      if (!options.verbose) return;
      write(`${coloredDebug(format("debug", message))}\n`);
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
