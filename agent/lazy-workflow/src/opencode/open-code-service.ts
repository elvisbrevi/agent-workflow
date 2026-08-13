import { OpenCodeResult, type OpenCodeEventData } from "./open-code-result.ts";
import { getDefaultReporter } from "../output/operator-output.ts";
import type { Reporter } from "../output/reporter.ts";

export interface OpenCodeRunOptions {
  model: string;
  variant: string;
  session: string | null;
  prompt: string;
  workingDirectory?: string;
  terminalMarker?: string;
}

export interface OpenCodeExecution {
  result: OpenCodeResult;
  azureLoginRequired: boolean;
  failed?: boolean;
}

export interface OpenCodeProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export class OpenCodeSessionCloseError extends Error {
  constructor(
    readonly sessionId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OpenCodeSessionCloseError";
  }
}

export class OpenCodeSessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`La sesión OpenCode ${sessionId} ya no existe`);
    this.name = "OpenCodeSessionNotFoundError";
  }
}

export interface OpenCodeSpawnOptions {
  cwd?: string;
}

export type OpenCodeSpawner = (command: string[], options?: OpenCodeSpawnOptions) => OpenCodeProcess;

const spawnOpenCode: OpenCodeSpawner = (command, options) => {
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", ...options });
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    exited: process.exited,
    kill: (signal) => process.kill(signal),
  };
};

const loginInstructionPattern = /(?:please\s+run|run|ejecuta|execute).{0,40}\baz\s+login\b/i;
const absentSessionPattern = /(?:session|sesion|sesión).*(?:not found|does not exist|no existe)|(?:not found|does not exist|no existe).*(?:session|sesion|sesión)/i;
const SPINNER_RESTART_MS = 2_000;
const SPINNER_TEXT = "OpenCode ejecutándose";

function renderEvent(line: string): string {
  try {
    const event = JSON.parse(line) as OpenCodeEventData;
    const part = event.part;
    const prefix = event.sessionID ? `OpenCode [sesión ${event.sessionID}]` : "OpenCode";
    if (event.type === "text" && part?.text) return `${prefix}: ${part.text}`;
    if (event.type === "reasoning" && part?.text) return `${prefix} razonando: ${part.text}`;
    if (event.type === "step_start") return `${prefix} inició un paso`;
    if (event.type === "tool_use" || part?.type === "tool") {
      const status = part?.state?.status ? ` (${part.state.status})` : "";
      const detail = part?.state?.input?.command?.trim()
        ?? part?.input?.command?.trim()
        ?? part?.state?.input?.description?.trim()
        ?? part?.state?.title?.trim();
      return `${prefix} herramienta ${part?.tool ?? "desconocida"}${status}${detail ? `: ${JSON.stringify(detail)}` : ""}`;
    }
    if (event.type === "step_finish") {
      return `${prefix} terminó un paso${part?.reason ? ` (${part.reason})` : ""}`;
    }
    if (event.type === "session") return `${prefix} iniciada`;
    if (part?.error) return `${prefix} error: ${part.error}`;
    return `${prefix} evento: ${event.type}`;
  } catch {
    return line;
  }
}

function parseEvent(line: string): OpenCodeEventData | null {
  try {
    return JSON.parse(line) as OpenCodeEventData;
  } catch {
    return null;
  }
}

function eventSeverity(event: OpenCodeEventData | null): "debug" | "info" {
  if (event && (event.type === "reasoning" || event.type === "tool_use" || event.part?.type === "tool")) {
    return "debug";
  }
  return "info";
}

function requiresAzureLogin(line: string): boolean {
  let event: OpenCodeEventData;
  try {
    event = JSON.parse(line) as OpenCodeEventData;
  } catch {
    return loginInstructionPattern.test(line);
  }

  const command = event.part?.state?.input?.command ?? event.part?.input?.command ?? "";
  if (
    (event.type === "step_start" || event.type === "tool_use" || event.part?.type === "tool") &&
    (event.part?.tool === "bash" || event.part?.tool === "shell") &&
    /(?:^|[;&|]\s*)az\s+login\b/i.test(command)
  ) {
    return true;
  }

  if (event.type !== "text" && event.type !== "step_finish") {
    return false;
  }

  return loginInstructionPattern.test([
    event.part?.text,
    event.part?.output,
    event.part?.error,
  ].filter(Boolean).join(" "));
}

function containsTerminalMarker(line: string, marker: string | undefined): boolean {
  if (!marker) return false;
  try {
    const event = JSON.parse(line) as OpenCodeEventData;
    return event.type === "text"
      && event.part?.text?.split(/\r?\n/).some((text) => text.trim() === marker) === true;
  } catch {
    return line.split(/\r?\n/).some((text) => text.trim() === marker);
  }
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => boolean,
  reportLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<{ lines: string[]; stopped: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buffer = "";
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    if (!signal) return;
    abortListener = () => resolve("aborted");
    if (signal.aborted) abortListener();
    else signal.addEventListener("abort", abortListener, { once: true });
  });

  try {
    while (true) {
      const next = await Promise.race([
        reader.read().then((value) => ({ type: "read" as const, value })),
        aborted.then(() => ({ type: "aborted" as const })),
      ]);
      if (next.type === "aborted") {
        try { await reader.cancel(); } catch { /* stream already closed */ }
        return { lines, stopped: false };
      }
      const { done, value } = next.value;
      buffer += decoder.decode(value, { stream: !done });
      const parts = buffer.split(/\r?\n/);
      buffer = done ? "" : parts.pop() ?? "";

      for (const line of parts) {
        if (line.trim().length === 0) continue;
        lines.push(line);
        reportLine?.(line);
        if (onLine(line)) {
          await reader.cancel();
          return { lines, stopped: true };
        }
      }

      if (done) {
        if (buffer.trim().length > 0) {
          lines.push(buffer);
          reportLine?.(buffer);
          if (onLine(buffer)) return { lines, stopped: true };
        }
        return { lines, stopped: false };
      }
    }
  } finally {
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

export class OpenCodeService {
  constructor(
    private readonly spawn: OpenCodeSpawner = spawnOpenCode,
    private readonly reporter: Reporter = getDefaultReporter(),
    private readonly shutdownGraceMs = 5_000,
  ) {}

  async run(options: OpenCodeRunOptions, detectAzureLogin = false): Promise<OpenCodeExecution> {
    return this.execute([
      "opencode",
      "run",
      "--auto",
      "--model",
      options.model,
      "--variant",
      options.variant,
      ...(options.session ? ["--session", options.session] : []),
      "--format",
      "json",
      "--thinking",
      options.prompt,
    ], detectAzureLogin, options.workingDirectory, options.terminalMarker);
  }

  async resume(sessionId: string, prompt = "continue", workingDirectory?: string, terminalMarker?: string): Promise<OpenCodeResult> {
    const execution = await this.execute([
      "opencode",
      "run",
      "--auto",
      "--session",
      sessionId,
      "--format",
      "json",
      "--thinking",
      prompt,
    ], true, workingDirectory, terminalMarker);
    if (execution.azureLoginRequired) {
      throw new Error("Azure sigue requiriendo autenticacion despues de reanudar OpenCode");
    }
    if (execution.failed) throw new Error("OpenCode termino con error");
    return execution.result;
  }

  private async execute(
    command: string[],
    detectAzureLogin: boolean,
    workingDirectory?: string,
    terminalMarker?: string,
  ): Promise<OpenCodeExecution> {
    this.reporter.info(`OpenCode iniciado en ${workingDirectory ?? globalThis.process.cwd()}`);
    const child = this.spawn(command, { cwd: workingDirectory });
    let spinner: ReturnType<Reporter["start"]> | null = this.reporter.start(SPINNER_TEXT);
    let restartTimer: ReturnType<typeof setTimeout> | null = null;
    const stopSpinner = () => {
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (spinner) {
        this.reporter.stop(spinner);
        spinner = null;
      }
    };
    const scheduleSpinner = () => {
      if (restartTimer || spinner) return;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!spinner) spinner = this.reporter.start(SPINNER_TEXT);
      }, SPINNER_RESTART_MS);
    };
    const emitEvent = (line: string) => {
      const event = parseEvent(line);
      const rendered = renderEvent(line);
      if (eventSeverity(event) === "debug") {
        this.reporter.debug(rendered);
      } else {
        this.reporter.info(rendered);
      }
    };
    const reportStdout = (line: string) => {
      stopSpinner();
      emitEvent(line);
      scheduleSpinner();
    };
    const reportStderr = (line: string) => {
      stopSpinner();
      this.reporter.info(`OpenCode stderr: ${line}`);
      scheduleSpinner();
    };

    try {
      const stderrAbort = new AbortController();
      const stderrPromise = readLines(child.stderr, () => false, reportStderr, stderrAbort.signal);
      const streamed = await readLines(
        child.stdout,
        (line) => (detectAzureLogin && requiresAzureLogin(line)) || containsTerminalMarker(line, terminalMarker),
        reportStdout,
      );
      let exitCode: number;
      let stderrOutput: Awaited<ReturnType<typeof readLines>>;
      if (streamed.stopped) {
        exitCode = await this.terminate(child);
        stderrAbort.abort();
        stderrOutput = await stderrPromise;
      } else {
        [exitCode, stderrOutput] = await Promise.all([child.exited, stderrPromise]);
      }
      const stderr = stderrOutput.lines.join("\n");
      const azureLoginRequired = detectAzureLogin
        && (streamed.lines.some(requiresAzureLogin) || loginInstructionPattern.test(stderr));
      const terminalMarkerReceived = streamed.lines.some((line) => containsTerminalMarker(line, terminalMarker));
      if (exitCode !== 0 && !azureLoginRequired && streamed.lines.length === 0) {
        const sessionIndex = command.indexOf("--session");
        const sessionId = sessionIndex >= 0 ? command[sessionIndex + 1] : undefined;
        if (sessionId && absentSessionPattern.test(stderr)) {
          throw new OpenCodeSessionNotFoundError(sessionId);
        }
        throw new Error("OpenCode no devolvio eventos");
      }

      const result = OpenCodeResult.fromJsonLines(streamed.lines.join("\n"));
      if (terminalMarkerReceived) await this.closeSession(result.sessionId, workingDirectory);

      return {
        result,
        azureLoginRequired,
        failed: exitCode !== 0 && !azureLoginRequired && !terminalMarkerReceived,
      };
    } finally {
      stopSpinner();
    }
  }

  private async closeSession(sessionId: string, workingDirectory?: string): Promise<void> {
    try {
      const process = this.spawn(["opencode", "session", "delete", sessionId], { cwd: workingDirectory });
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      const output = `${stdout}\n${stderr}`.trim();
      if (exitCode === 0 || absentSessionPattern.test(output)) return;
      throw new Error(output || `opencode session delete terminó con código ${exitCode}`);
    } catch (error) {
      if (error instanceof OpenCodeSessionCloseError) throw error;
      throw new OpenCodeSessionCloseError(
        sessionId,
        `No se pudo cerrar la sesión OpenCode ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private async terminate(child: OpenCodeProcess): Promise<number> {
    try { child.kill("SIGTERM"); } catch { /* process already exited */ }
    const gracefulExit = await this.waitForExit(child.exited);
    if (gracefulExit !== null) return gracefulExit;
    try { child.kill("SIGKILL"); } catch { /* process exited during escalation */ }
    return await this.waitForExit(child.exited) ?? 137;
  }

  private async waitForExit(exited: Promise<number>): Promise<number | null> {
    return Promise.race([
      exited,
      Bun.sleep(this.shutdownGraceMs).then(() => null),
    ]);
  }
}
