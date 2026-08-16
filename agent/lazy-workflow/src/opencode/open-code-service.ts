import {
  spawnAgentProcess,
  type AgentProcess,
  type AgentSpawnOptions,
  type AgentSpawner,
} from "../coding-agent/agent-process.ts";
import { AgentResult, type OpenCodeEventData } from "../coding-agent/agent-result.ts";
import { asksForAzureLogin, runsAzureLogin } from "../coding-agent/azure-login.ts";
import {
  AgentExhaustionError,
  AgentSessionCloseError,
  AgentSessionNotFoundError,
  describeExhaustion,
  type AgentAuthority,
  type AgentExecution,
  type AgentResumeOverrides,
  type AgentRunOptions,
  type CodingAgent,
  type ProviderExhaustion,
} from "../coding-agent/coding-agent.ts";
import { renderToolCall, renderToolInput, renderToolOutput } from "../output/agent-tool-detail.ts";
import { getDefaultReporter } from "../output/operator-output.ts";
import type { Reporter } from "../output/reporter.ts";

export type OpenCodeProcess = AgentProcess;
export type OpenCodeSpawnOptions = AgentSpawnOptions;
export type OpenCodeSpawner = AgentSpawner;

// OPENCODE_CONFIG merges with the target repository's own configuration rather
// than replacing it, so injecting the authority profiles is additive.
const spawnOpenCode: OpenCodeSpawner = spawnAgentProcess;

const absentSessionPattern = /(?:session|sesion|sesión).*(?:not found|does not exist|no existe)|(?:not found|does not exist|no existe).*(?:session|sesion|sesión)/i;
const SPINNER_RESTART_MS = 2_000;
const SPINNER_TEXT = "OpenCode ejecutándose";

/**
 * The arguments of a tool call as OpenCode reports them. A call may carry them
 * on the part, on its state, or only as the title the state gave it; the state's
 * own input is the most specific, so it is the one that wins.
 */
function toolInputOf(part: OpenCodeEventData["part"]): Record<string, unknown> {
  return {
    ...(part?.state?.title ? { title: part.state.title } : {}),
    ...(part?.input ?? {}),
    ...(part?.state?.input ?? {}),
  };
}

function renderEvent(line: string): string {
  try {
    const event = JSON.parse(line) as OpenCodeEventData;
    const part = event.part;
    const prefix = event.sessionID ? `OpenCode [sesión ${event.sessionID}]` : "OpenCode";
    if (event.type === "text" && part?.text) return `${prefix}: ${part.text}`;
    if (event.type === "reasoning" && part?.text) return `${prefix} razonando: ${part.text}`;
    if (event.type === "step_start") return `${prefix} inició un paso`;
    if (event.type === "tool_use" || part?.type === "tool") {
      return renderToolCall(prefix, part?.tool, part?.state?.status, toolInputOf(part));
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

/**
 * Everything one event carries beyond the line the parsed stream shows: the
 * whole tool input, the output the tool returned, and the raw event itself.
 * Only `--verbose-output` asks for it, so it is built only when it is wanted.
 */
function renderEventTrace(line: string, event: OpenCodeEventData | null): string[] {
  const traced: string[] = [];
  const part = event?.part;
  const prefix = event?.sessionID ? `OpenCode [sesión ${event.sessionID}]` : "OpenCode";
  if (part && (event?.type === "tool_use" || part.type === "tool")) {
    const tool = part.tool ?? "desconocida";
    const input = renderToolInput(toolInputOf(part));
    if (input) traced.push(`${prefix} herramienta ${tool} entrada: ${input}`);
    const output = renderToolOutput(part.state?.output ?? part.output);
    if (output) traced.push(`${prefix} herramienta ${tool} salida: ${output}`);
  }
  traced.push(`OpenCode evento crudo: ${line}`);
  return traced;
}

function parseEvent(line: string): OpenCodeEventData | null {
  try {
    return JSON.parse(line) as OpenCodeEventData;
  } catch {
    return null;
  }
}

interface OpenCodeErrorEvent {
  type?: string;
  sessionID?: string;
  error?: { name?: string; data?: { statusCode?: number } };
}

// HTTP status codes captured on a real `opencode run --format json` invocation
// (see test/opencode-service.test.ts for the raw fragments): 401/403 mean the
// credential itself is rejected, 402 is billing, 429 is the usage/rate limit.
const EXHAUSTION_STATUS_CAUSES = new Map<number, string>([
  [401, "authentication"],
  [403, "authentication"],
  [402, "billing"],
  [429, "rate_limit"],
]);

function classifyExhaustion(lines: string[], model: string | undefined, failed: boolean): ProviderExhaustion | undefined {
  if (!failed) return undefined;
  for (const line of lines) {
    let event: OpenCodeErrorEvent;
    try {
      event = JSON.parse(line) as OpenCodeErrorEvent;
    } catch {
      continue;
    }
    if (event.type !== "error" || !event.error) continue;
    const cause = event.error.name === "ProviderAuthError"
      ? "authentication"
      : EXHAUSTION_STATUS_CAUSES.get(event.error.data?.statusCode ?? -1);
    if (cause) return { cli: "OpenCode", model: model ?? "con el que se abrió", cause };
  }
  return undefined;
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
    return asksForAzureLogin(line);
  }

  const command = event.part?.state?.input?.command ?? event.part?.input?.command ?? "";
  if (
    (event.type === "step_start" || event.type === "tool_use" || event.part?.type === "tool") &&
    (event.part?.tool === "bash" || event.part?.tool === "shell") &&
    runsAzureLogin(command)
  ) {
    return true;
  }

  if (event.type !== "text" && event.type !== "step_finish") {
    return false;
  }

  return asksForAzureLogin([
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

export class OpenCodeService implements CodingAgent {
  constructor(
    private readonly spawn: OpenCodeSpawner = spawnOpenCode,
    private readonly reporter: Reporter = getDefaultReporter(),
    private readonly shutdownGraceMs = 5_000,
  ) {}

  async run(options: AgentRunOptions, detectAzureLogin = false): Promise<AgentExecution> {
    return this.execute([
      "opencode",
      "run",
      "--auto",
      ...(options.agent ? ["--agent", options.agent.profile] : []),
      "--model",
      options.model,
      "--variant",
      options.variant,
      ...(options.session ? ["--session", options.session] : []),
      "--format",
      "json",
      "--thinking",
      options.prompt,
    ], detectAzureLogin, options.workingDirectory, options.terminalMarker, options.agent, options.model);
  }

  async resume(
    sessionId: string,
    prompt = "continue",
    workingDirectory?: string,
    terminalMarker?: string,
    overrides: AgentResumeOverrides = {},
  ): Promise<AgentResult> {
    // A resumed session keeps the model it was opened with unless the run
    // overrides it, so the operator is told which of the two is running.
    this.reporter.info(
      `OpenCode reanuda la sesión ${sessionId} con el modelo ${overrides.model ?? "con el que se abrió"}`,
    );
    const execution = await this.execute([
      "opencode",
      "run",
      "--auto",
      "--session",
      sessionId,
      // A resumed session keeps the authority it started with, so the profile and
      // its config must travel with the resume too.
      ...(overrides.agent ? ["--agent", overrides.agent.profile] : []),
      ...(overrides.model ? ["--model", overrides.model] : []),
      ...(overrides.variant ? ["--variant", overrides.variant] : []),
      "--format",
      "json",
      "--thinking",
      prompt,
    ], true, workingDirectory, terminalMarker, overrides.agent, overrides.model);
    if (execution.azureLoginRequired) {
      throw new Error("Azure sigue requiriendo autenticacion despues de reanudar OpenCode");
    }
    if (execution.exhaustion) throw new AgentExhaustionError(execution.exhaustion, execution.result);
    if (execution.failed) throw new Error("OpenCode termino con error");
    return execution.result;
  }

  private async execute(
    command: string[],
    detectAzureLogin: boolean,
    workingDirectory?: string,
    terminalMarker?: string,
    authority?: AgentAuthority,
    model?: string,
  ): Promise<AgentExecution> {
    this.reporter.info(`OpenCode iniciado en ${workingDirectory ?? globalThis.process.cwd()}${model ? ` con el modelo ${model}` : ""}`);
    const child = this.spawn(command, {
      cwd: workingDirectory,
      ...(authority ? { env: { OPENCODE_CONFIG: authority.configPath } } : {}),
    });
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
      if (this.reporter.tracing) {
        for (const traced of renderEventTrace(line, event)) this.reporter.trace(traced);
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
        && (streamed.lines.some(requiresAzureLogin) || asksForAzureLogin(stderr));
      const terminalMarkerReceived = streamed.lines.some((line) => containsTerminalMarker(line, terminalMarker));
      if (exitCode !== 0 && !azureLoginRequired && streamed.lines.length === 0) {
        const sessionIndex = command.indexOf("--session");
        const sessionId = sessionIndex >= 0 ? command[sessionIndex + 1] : undefined;
        if (sessionId && absentSessionPattern.test(stderr)) {
          throw new AgentSessionNotFoundError(sessionId, `La sesión OpenCode ${sessionId} ya no existe`);
        }
        throw new Error("OpenCode no devolvio eventos");
      }

      const result = AgentResult.fromJsonLines(streamed.lines.join("\n"));
      if (terminalMarkerReceived) await this.closeSession(result.sessionId, workingDirectory);

      const failed = exitCode !== 0 && !azureLoginRequired && !terminalMarkerReceived;
      const exhaustion = classifyExhaustion(streamed.lines, model, failed);
      if (exhaustion) this.reporter.warn(describeExhaustion(exhaustion));

      return { result, azureLoginRequired, failed, exhaustion };
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
      if (error instanceof AgentSessionCloseError) throw error;
      throw new AgentSessionCloseError(
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
