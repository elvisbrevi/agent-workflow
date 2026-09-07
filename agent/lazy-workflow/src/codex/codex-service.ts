/**
 * The Codex adapter: a third implementation of the coding-agent seam (ADR-0023).
 * Codex owns its session transcript and emits JSONL from `exec`, so this module
 * owns the command, stream decoder, authority home, and provider-specific errors.
 */

import { spawnAgentProcess, type AgentProcess, type AgentSpawner } from "../coding-agent/agent-process.ts";
import { join } from "node:path";
import { DEFAULT_IDLE_TIMEOUT_MINUTES, IdleWatchdog, describeIdleTimeout } from "../coding-agent/idle-watchdog.ts";
import { AgentResult, lastReasoning, type AgentTokens } from "../coding-agent/agent-result.ts";
import { asksForAzureLogin, runsAzureLogin } from "../coding-agent/azure-login.ts";
import {
  AgentExhaustionError,
  AgentSessionNotFoundError,
  describeExhaustion,
  type AgentAuthority,
  type AgentExecution,
  type AgentResumeOverrides,
  type AgentRunOptions,
  type CodingAgent,
  type ProviderExhaustion,
} from "../coding-agent/coding-agent.ts";
import {
  assembleCodexAuthorityHome,
  codexAuthorityHomePath,
  resolveOperatorCodexHome,
} from "../prompts/codex-authority-home.ts";
import type { AuthorityProfile } from "../prompts/authority-profile.ts";
import { renderToolCall, renderToolInput, renderToolOutput } from "../output/agent-tool-detail.ts";
import { getDefaultReporter } from "../output/operator-output.ts";
import type { Reporter } from "../output/reporter.ts";
import { openSessionStart, reportSessionEvent } from "../output/session-event.ts";

/** The effort levels accepted by Codex and exposed through `--variant`. */
export const CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const CLI_NAME = "codex";
const EFFORT_LEVELS = new Set<string>(CODEX_EFFORTS);
const CODEX_EXHAUSTION_REASONS = new Set([
  "usage_limit_exceeded",
  "rate_limit_exceeded",
  "session_budget_exceeded",
  "unauthorized",
]);
const absentSessionPattern = /(?:session|thread|sesion|sesión).*(?:not found|does not exist|no existe)|(?:not found|does not exist|no existe).*(?:session|thread|sesion|sesión)/i;

export type CodexProcess = AgentProcess;
export type CodexSpawner = AgentSpawner;
export type CodexAuthorityHomeAssembler = typeof assembleCodexAuthorityHome;
export type CodexAuthorityHomePath = typeof codexAuthorityHomePath;
export type CodexOperatorHomeResolver = typeof resolveOperatorCodexHome;

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  status?: string;
  aggregated_output?: string;
  output?: unknown;
  error?: unknown;
  path?: string;
  changes?: unknown;
  name?: string;
}

interface CodexUsage {
  total_tokens?: number;
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  reasoning_output_tokens?: number;
}

interface CodexEventData {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  error?: unknown;
  codex_error_info?: unknown;
  reason?: string;
  stop_reason?: string;
  status?: string;
  output_text?: string;
  result?: string;
  code?: string;
}

interface ReportedEvent {
  message: string;
  severity: "debug" | "info" | "error";
}

function parseEvent(line: string): CodexEventData | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as CodexEventData
      : null;
  } catch {
    return null;
  }
}

/** The session a `resume` command reopens: the only id known before the stream speaks. */
function resumedSessionId(command: string[]): string | undefined {
  const index = command.indexOf("resume");
  return index >= 0 ? command[index + 1] : undefined;
}

function parseEvents(output: string): CodexEventData[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(parseEvent)
    .filter((event): event is CodexEventData => event !== null);
}

function itemInput(item: CodexItem): Record<string, unknown> {
  return {
    ...(item.command ? { command: item.command } : {}),
    ...(item.path ? { path: item.path } : {}),
    ...(item.name ? { name: item.name } : {}),
  };
}

function prefixFor(event: CodexEventData, sessionId?: string): string {
  const id = event.thread_id ?? sessionId;
  return id ? `Codex [sesion ${id}]` : "Codex";
}

function renderItem(prefix: string, event: CodexEventData): ReportedEvent | null {
  const item = event.item;
  if (!item?.type) return null;
  if (item.type === "agent_message" && event.type === "item.completed" && item.text) {
    return { message: `${prefix}: ${item.text}`, severity: "info" };
  }
  if (item.type === "reasoning" && item.text) {
    return { message: `${prefix} razonando: ${item.text}`, severity: "debug" };
  }
  if (event.type === "item.started" && ["command_execution", "file_change", "mcp_tool_call", "web_search", "web_fetch"].includes(item.type)) {
    return { message: renderToolCall(prefix, item.type, item.status, itemInput(item)), severity: "debug" };
  }
  return null;
}

function renderEvent(line: string, sessionId?: string): ReportedEvent[] {
  const event = parseEvent(line);
  if (!event) return [{ message: line, severity: "info" }];
  const prefix = prefixFor(event, sessionId);
  if (event.type === "thread.started") return [{ message: `${prefix} iniciada`, severity: "info" }];
  if (event.type === "turn.started") return [{ message: `${prefix} inicio un turno`, severity: "info" }];
  if (event.type === "turn.completed") return [{ message: `${prefix} termino un turno`, severity: "info" }];
  if (event.type === "turn.failed" || event.type === "error") {
    const message = typeof event.error === "string"
      ? event.error
      : typeof event.error === "object" && event.error !== null && "message" in event.error && typeof event.error.message === "string"
        ? event.error.message
        : "fallo del proveedor";
    return [{ message: `${prefix} error: ${message}`, severity: "error" }];
  }
  const item = renderItem(prefix, event);
  return item ? [item] : [];
}

/** The extra tool detail shown only by `--verbose-output`, plus the raw event. */
function renderEventTrace(line: string, event: CodexEventData | null, sessionId?: string): string[] {
  const traced: string[] = [];
  const item = event?.item;
  const prefix = event ? prefixFor(event, sessionId) : "Codex";
  if (item && ["command_execution", "file_change", "mcp_tool_call", "web_search", "web_fetch"].includes(item.type ?? "")) {
    const input = renderToolInput(item);
    if (input) traced.push(`${prefix} herramienta ${item.type} entrada: ${input}`);
    const output = renderToolOutput(item.aggregated_output ?? item.output ?? item.error ?? item.changes);
    if (output) traced.push(`${prefix} herramienta ${item.type} salida: ${output}`);
  }
  traced.push(`Codex evento crudo: ${line}`);
  return traced;
}

function requiresAzureLogin(events: CodexEventData[]): boolean {
  return events.some((event) => {
    const item = event.item;
    return runsAzureLogin(item?.command ?? "")
      || asksForAzureLogin(item?.text ?? "")
      || asksForAzureLogin(event.output_text ?? "")
      || asksForAzureLogin(event.result ?? "");
  });
}

function containsMarker(text: string, marker: string | undefined): boolean {
  return marker ? text.split(/\r?\n/).some((line) => line.trim() === marker) : false;
}

function typedReason(value: unknown): string | undefined {
  if (typeof value === "string") return CODEX_EXHAUSTION_REASONS.has(value) ? value : undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["code", "error_code", "reason"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && CODEX_EXHAUSTION_REASONS.has(candidate)) return candidate;
  }
  for (const key of ["codex_error_info", "error_info", "details", "error"]) {
    const reason = typedReason(record[key]);
    if (reason) return reason;
  }
  return undefined;
}

function classifyExhaustion(events: CodexEventData[], model: string | undefined, failed: boolean): ProviderExhaustion | undefined {
  if (!failed) return undefined;
  for (const event of events) {
    if (!event.type.endsWith(".failed") && event.type !== "error") continue;
    const reason = typedReason(event.error)
      ?? typedReason(event.item?.error)
      ?? typedReason({ code: event.code, reason: event.reason, codex_error_info: event.codex_error_info });
    if (reason) return { cli: "Codex", model: model ?? "con el que se abrio", cause: reason };
  }
  return undefined;
}

function decodeTokens(usage: CodexUsage | undefined): AgentTokens | undefined {
  if (!usage) return undefined;
  const tokens: AgentTokens = {};
  if (usage.total_tokens !== undefined) tokens.total = usage.total_tokens;
  if (usage.input_tokens !== undefined) tokens.input = usage.input_tokens;
  if (usage.output_tokens !== undefined) tokens.output = usage.output_tokens;
  const reasoning = usage.reasoning_tokens ?? usage.reasoning_output_tokens;
  if (reasoning !== undefined) tokens.reasoning = reasoning;
  if (usage.cached_input_tokens !== undefined) tokens.cache = { read: usage.cached_input_tokens };
  return tokens;
}

function messageText(events: CodexEventData[]): string {
  const completed = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item?.text)
    .filter((text): text is string => typeof text === "string");
  if (completed.length > 0) return completed.join("\n");

  const updates = new Map<string, string>();
  let anonymous = "";
  for (const event of events) {
    if (event.item?.type !== "agent_message" || typeof event.item.text !== "string") continue;
    if (event.item.id) updates.set(event.item.id, event.item.text);
    else anonymous = event.item.text;
  }
  const updated = [...updates.values(), ...(anonymous ? [anonymous] : [])];
  if (updated.length > 0) return updated.join("\n");

  const output = [...events].reverse().find((event) => typeof event.output_text === "string" || typeof event.result === "string");
  return output?.output_text ?? output?.result ?? "";
}

function decodeStream(events: CodexEventData[]): AgentResult {
  const sessionId = events.find((event) => event.type === "thread.started" && typeof event.thread_id === "string")?.thread_id;
  if (!sessionId) throw new Error("Codex no devolvio un identificador de sesion");
  const finalEvent = [...events].reverse().find((event) => event.type === "turn.completed" || event.type === "turn.failed");
  return new AgentResult({
    sessionId,
    text: messageText(events),
    reasoning: lastReasoning(events
      .filter((event) => event.item?.type === "reasoning")
      .map((event) => event.item?.text ?? "")),
    reason: finalEvent?.reason ?? finalEvent?.stop_reason ?? finalEvent?.status,
    tokens: decodeTokens(finalEvent?.usage),
  });
}

async function readLines(stream: ReadableStream<Uint8Array>, reportLine: (line: string) => void, onChunk: () => void = () => undefined): Promise<string[]> {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      if (line.trim().length === 0) continue;
      lines.push(line);
      reportLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    lines.push(buffer);
    reportLine(buffer);
  }
  return lines;
}

export class CodexService implements CodingAgent {
  constructor(
    private readonly spawn: CodexSpawner = spawnAgentProcess,
    private readonly reporter: Reporter = getDefaultReporter(),
    private readonly assembleHome: CodexAuthorityHomeAssembler = assembleCodexAuthorityHome,
    private readonly operatorHome: CodexOperatorHomeResolver = resolveOperatorCodexHome,
    private readonly authorityHomePath: CodexAuthorityHomePath = codexAuthorityHomePath,
    /** El silencio que esta CLI puede pasar entre eventos antes de que se la termine (ADR-0039). */
    private readonly idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MINUTES * 60_000,
  ) {}

  async run(options: AgentRunOptions, detectAzureLogin = false): Promise<AgentExecution> {
    return this.execute(
      this.command(options.model, options.variant, options.prompt, options.session),
      options.workingDirectory,
      options.model,
      options.variant,
      detectAzureLogin,
      options.terminalMarker,
      options.agent,
    );
  }

  async resume(
    sessionId: string,
    prompt = "continue",
    workingDirectory?: string,
    terminalMarker?: string,
    overrides: AgentResumeOverrides = {},
  ): Promise<AgentResult> {
    this.reporter.info(`Codex reanuda la sesion ${sessionId} con el modelo ${overrides.model ?? "con el que se abrio"}`);
    const execution = await this.execute(
      this.command(overrides.model, overrides.variant, prompt, sessionId),
      workingDirectory,
      overrides.model,
      overrides.variant,
      true,
      terminalMarker,
      overrides.agent,
    );
    if (execution.azureLoginRequired) throw new Error("Azure sigue requiriendo autenticacion despues de reanudar Codex");
    if (execution.exhaustion) throw new AgentExhaustionError(execution.exhaustion, execution.result);
    if (execution.failed) throw new Error("Codex termino con error");
    return execution.result;
  }

  /** Codex keeps the local transcript; there is no remote session to close. */
  private command(model: string | undefined, variant: string | undefined, prompt: string, sessionId?: string | null): string[] {
    return [
      "codex",
      "-s",
      "danger-full-access",
      "--ask-for-approval",
      "never",
      "exec",
      ...(sessionId ? ["resume", sessionId] : []),
      "--json",
      ...(model ? ["--model", model] : []),
      ...(variant ? ["-c", `model_reasoning_effort=${variant}`] : []),
      prompt,
    ];
  }

  private effort(variant: string): string {
    if (!EFFORT_LEVELS.has(variant)) {
      throw new Error(`Codex no acepta el esfuerzo ${variant} (usa ${CODEX_EFFORTS.join(", ")})`);
    }
    return variant;
  }

  private async authorityEnvironment(authority: AgentAuthority, workingDirectory: string): Promise<Record<string, string>> {
    const profile = authority.profile as AuthorityProfile;
    const destination = this.authorityHomePath(profile, workingDirectory);
    const rulesPath = join(destination, "rules", `${profile}.rules`);
    if (!await Bun.file(rulesPath).exists()) {
      await this.assembleHome(profile, this.operatorHome(), destination);
    }
    return { CODEX_HOME: destination };
  }

  private async execute(
    command: string[],
    workingDirectory: string | undefined,
    model: string | undefined,
    variant: string | undefined,
    detectAzureLogin: boolean,
    terminalMarker?: string,
    authority?: AgentAuthority,
  ): Promise<AgentExecution> {
    if (variant !== undefined) this.effort(variant);
    const cwd = workingDirectory ?? process.cwd();
    const env = authority ? await this.authorityEnvironment(authority, cwd) : undefined;
    const rung = { cli: CLI_NAME, model, variant };
    const startedAt = Date.now();
    this.reporter.info(`Codex iniciado en ${cwd}${model ? ` con el modelo ${model}` : ""}`);
    const resumedSession = resumedSessionId(command);
    const start = openSessionStart("Codex inicia sesion", rung, this.reporter, resumedSession);
    const child: CodexProcess = this.spawn(command, { cwd: workingDirectory, ...(env ? { env } : {}) });
    let sessionId: string | undefined;
    const reportStdout = (line: string) => {
      const event = parseEvent(line);
      // `thread.started` names the session, so the start record is written the
      // moment the stream reveals which one this is.
      if (event?.thread_id) {
        sessionId = event.thread_id;
        start.observed(sessionId);
      }
      for (const reported of renderEvent(line, sessionId)) {
        if (reported.severity === "debug") this.reporter.debug(reported.message);
        else if (reported.severity === "error") this.reporter.error(reported.message);
        else this.reporter.info(reported.message);
      }
      if (this.reporter.tracing) {
        for (const traced of renderEventTrace(line, event, sessionId)) this.reporter.trace(traced);
      }
    };
    const reportStderr = (line: string) => this.reporter.info(`Codex stderr: ${line}`);
    // Una sesión que deja de emitir se termina, y el resultado lo dice para que el bucle
    // descienda al escalón siguiente (ADR-0039).
    const watchdog = new IdleWatchdog(this.idleTimeoutMs, () => { try { child.kill("SIGTERM"); } catch { /* ya salió */ } });
    watchdog.touch();
    const [lines, errorLines, exitCode] = await Promise.all([
      readLines(child.stdout, reportStdout, () => watchdog.touch()),
      readLines(child.stderr, reportStderr),
      child.exited,
    ]).finally(() => {
      watchdog.disarm();
      // A session that died before naming its thread still leaves a start record.
      start.settle();
    });
    const stderr = errorLines.join("\n");
    const events = parseEvents(lines.join("\n"));
    if (events.length === 0) {
      if (exitCode !== 0 && resumedSession && absentSessionPattern.test(stderr)) {
        reportSessionEvent(
          "session_not_found",
          `La sesion Codex ${resumedSession} ya no existe`,
          rung,
          { sessionId: resumedSession },
          { durationMs: Date.now() - startedAt },
          this.reporter,
        );
        throw new AgentSessionNotFoundError(resumedSession, `La sesion Codex ${resumedSession} ya no existe`);
      }
      throw new Error("Codex no devolvio eventos");
    }

    const result = decodeStream(events);
    const azureLoginRequired = detectAzureLogin && (requiresAzureLogin(events) || asksForAzureLogin(stderr));
    const markerReceived = containsMarker(result.text, terminalMarker);
    const failed = watchdog.fired || (exitCode !== 0 && !azureLoginRequired && !markerReceived);
    if (watchdog.fired) this.reporter.warn(`${describeIdleTimeout("Codex", this.idleTimeoutMs)}; se desciende al escalón siguiente.`);
    const exhaustion = watchdog.fired ? undefined : classifyExhaustion(events, model, failed);
    if (exhaustion) this.reporter.warn(describeExhaustion(exhaustion));
    const context = { sessionId: result.sessionId };
    const durationMs = Date.now() - startedAt;
    if (exhaustion) {
      reportSessionEvent("provider_exhausted", describeExhaustion(exhaustion), rung, context, { durationMs, reason: exhaustion.cause }, this.reporter);
    } else if (terminalMarker && !markerReceived) {
      reportSessionEvent("terminal_marker_missing", `Codex termino sin ${terminalMarker}`, rung, context, { durationMs, outcome: failed ? "failure" : "success" }, this.reporter);
    } else if (failed) {
      reportSessionEvent("session_failed", "Codex termino con error", rung, context, { durationMs, outcome: "failure" }, this.reporter);
    } else {
      reportSessionEvent("session_finished", "Codex finalizo la sesion", rung, { ...context, stopReason: result.reason }, { durationMs, outcome: "success" }, this.reporter);
    }
    return { result, azureLoginRequired, failed, exhaustion, ...(watchdog.fired ? { idleTimedOut: true, idleMs: watchdog.idleMs } : {}) };
  }
}
