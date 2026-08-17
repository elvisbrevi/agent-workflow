/**
 * The Claude Code adapter: one more implementation of the coding agent seam, so
 * a run may execute its session with `--cli claudecode` (ADR-0023).
 *
 * The authority profile a run carries arrives as the settings file Claude Code
 * validates, injected by path with `--settings`, so a prohibition is enforced by
 * the provider rather than by prose the model may ignore (ADR-0021, ADR-0023).
 *
 * Claude Code streams its own JSONL, so this module owns both the command it
 * builds and the decoding of that stream into the shared `AgentResult`. Sessions
 * start without `--bare`, because bare mode never reads the operator's OAuth
 * login nor the target repository's `CLAUDE.md`.
 */

import {
  spawnAgentProcess,
  type AgentProcess,
  type AgentSpawner,
} from "../coding-agent/agent-process.ts";
import { AgentResult, type AgentTokens, type AgentToolInput } from "../coding-agent/agent-result.ts";
import { asksForAzureLogin, runsAzureLogin } from "../coding-agent/azure-login.ts";
import {
  AgentExhaustionError,
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

/** The effort levels Claude Code accepts; `--variant` is passed through as one. */
export const CLAUDE_CODE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const EFFORT_LEVELS = new Set<string>(CLAUDE_CODE_EFFORTS);

interface ClaudeCodeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  /** Whatever arguments the named tool takes; the edited file is one of them. */
  input?: AgentToolInput;
  /** Present on `tool_result` blocks, which arrive on `user` events. */
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeCodeEventData {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  message?: { content?: ClaudeCodeContentBlock[] };
  /** Only on `system`/`api_retry` events: the categorized cause the stream itself assigned the retry. */
  error?: string;
}

/**
 * The causes Claude Code's own `api_retry` events categorize as the provider itself
 * running out, rather than a transient or ordinary failure (per the SDK's
 * `SDKAssistantMessageError` union). `overloaded` is a busy server, not exhaustion.
 */
const PROVIDER_EXHAUSTION_CAUSES = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "rate_limit",
]);

/**
 * Claude Code's own plan/session limit has nothing to retry, so it never raises the
 * `api_retry` event the causes above come from — it just ends the turn as ordinary assistant
 * text ("You've hit your session limit · resets ..."). The phrase is Anthropic's own fixed
 * wording for that refusal, specific enough that code or prose discussing session limits as a
 * topic is not expected to open with it verbatim.
 */
const SESSION_LIMIT_TEXT = /you've hit your (?:session|usage) limit/i;

/**
 * `api_retry` only announces a retry in flight — the stream may still recover and the
 * run may still succeed — so this only applies once the run has actually failed.
 */
function classifyExhaustion(
  events: ClaudeCodeEventData[],
  model: string | undefined,
  failed: boolean,
): ProviderExhaustion | undefined {
  if (!failed) return undefined;
  const retry = events.find((event) =>
    event.type === "system"
    && event.subtype === "api_retry"
    && event.error
    && PROVIDER_EXHAUSTION_CAUSES.has(event.error));
  if (retry) return { cli: "Claude Code", model: model ?? "con el que se abrió", cause: retry.error! };
  const limited = events.some((event) =>
    event.type === "assistant" && assistantText(event).some((text) => SESSION_LIMIT_TEXT.test(text)));
  return limited ? { cli: "Claude Code", model: model ?? "con el que se abrió", cause: "session_limit" } : undefined;
}

function parseEvent(line: string): ClaudeCodeEventData | null {
  try {
    return JSON.parse(line) as ClaudeCodeEventData;
  } catch {
    return null;
  }
}

function blocks(event: ClaudeCodeEventData): ClaudeCodeContentBlock[] {
  return event.message?.content ?? [];
}

function assistantText(event: ClaudeCodeEventData): string[] {
  return blocks(event)
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!);
}

/** One reportable line of a stream event, already carrying the severity it deserves. */
interface ReportedEvent {
  message: string;
  severity: "debug" | "info" | "trace";
}

function renderBlock(prefix: string, block: ClaudeCodeContentBlock): ReportedEvent | null {
  if (block.type === "text" && block.text) return { message: `${prefix}: ${block.text}`, severity: "info" };
  if (block.type === "thinking" && block.thinking) {
    return { message: `${prefix} razonando: ${block.thinking}`, severity: "debug" };
  }
  if (block.type === "tool_use") {
    return { message: renderToolCall(prefix, block.name, undefined, block.input), severity: "debug" };
  }
  return null;
}

function renderEvent(line: string): ReportedEvent[] {
  const event = parseEvent(line);
  if (!event) return [{ message: line, severity: "info" }];
  const prefix = event.session_id ? `Claude Code [sesión ${event.session_id}]` : "Claude Code";
  if (event.type === "system" && event.subtype === "init") {
    return [{ message: `${prefix} iniciada`, severity: "info" }];
  }
  if (event.type === "result") {
    return [{ message: `${prefix} terminó${event.subtype ? ` (${event.subtype})` : ""}`, severity: "info" }];
  }
  if (event.type === "assistant") {
    return blocks(event)
      .map((block) => renderBlock(prefix, block))
      .filter((rendered): rendered is ReportedEvent => rendered !== null);
  }
  return [];
}

/**
 * What the parsed stream leaves out, for `--verbose-output`: the whole input of
 * every tool call, the result each one returned — both of which arrive on
 * events the parsed stream drops entirely — and the raw line itself.
 */
function renderEventTrace(line: string, event: ClaudeCodeEventData | null): string[] {
  const traced: string[] = [];
  const prefix = event?.session_id ? `Claude Code [sesión ${event.session_id}]` : "Claude Code";
  for (const block of event ? blocks(event) : []) {
    const tool = block.name ?? "desconocida";
    if (block.type === "tool_use") {
      const input = renderToolInput(block.input);
      if (input) traced.push(`${prefix} herramienta ${tool} entrada: ${input}`);
    }
    if (block.type === "tool_result") {
      const output = renderToolOutput(block.content);
      if (output) traced.push(`${prefix} herramienta${block.is_error ? " (error)" : ""} resultado: ${output}`);
    }
  }
  traced.push(`Claude Code evento crudo: ${line}`);
  return traced;
}

/**
 * The Azure login handshake as Claude Code emits it: the session either called
 * the shell to authenticate, or said in its own text that the operator must.
 */
function requiresAzureLogin(events: ClaudeCodeEventData[]): boolean {
  return events.some((event) => blocks(event).some((block) =>
    (block.type === "tool_use" && runsAzureLogin(block.input?.command ?? ""))
    || (block.type === "text" && asksForAzureLogin(block.text ?? ""))
  ) || asksForAzureLogin(event.result ?? ""));
}

function parseEvents(output: string): ClaudeCodeEventData[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(parseEvent)
    .filter((event): event is ClaudeCodeEventData => event !== null);
}

function decodeStream(events: ClaudeCodeEventData[]): AgentResult {
  const sessionId = events.find((event) => event.type === "system" && event.subtype === "init")?.session_id;
  if (!sessionId) throw new Error("Claude Code no devolvió un identificador de sesión");

  const finalEvent = [...events].reverse().find((event) => event.type === "result");
  const streamedText = events.filter((event) => event.type === "assistant").flatMap(assistantText);

  return new AgentResult({
    sessionId,
    // The final answer is what the coordinator reads; only a stream that never
    // reached its result event falls back to the assistant messages themselves.
    text: finalEvent?.result ?? streamedText.join("\n"),
    reason: finalEvent?.subtype,
    tokens: decodeTokens(finalEvent),
    cost: finalEvent?.total_cost_usd,
  });
}

function decodeTokens(event: ClaudeCodeEventData | undefined): AgentTokens | undefined {
  const usage = event?.usage;
  if (!usage) return undefined;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cache: {
      write: usage.cache_creation_input_tokens,
      read: usage.cache_read_input_tokens,
    },
  };
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  reportLine: (line: string) => void,
): Promise<string[]> {
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

/**
 * Closing a session is a documented no-op here: Claude Code keeps no remote
 * session to release, so a run that reached its terminal marker releases
 * nothing, where OpenCode still deletes its own session (ADR-0023).
 */
export class ClaudeCodeService implements CodingAgent {
  constructor(
    private readonly spawn: AgentSpawner = spawnAgentProcess,
    private readonly reporter: Reporter = getDefaultReporter(),
  ) {}

  async run(options: AgentRunOptions, detectAzureLogin = false): Promise<AgentExecution> {
    return this.execute(
      [
        ...this.sessionCommand(options.agent),
        ...(options.session ? ["--resume", options.session] : []),
        "--model",
        options.model,
        "--effort",
        this.effort(options.variant),
        options.prompt,
      ],
      options.workingDirectory,
      options.model,
      detectAzureLogin,
    );
  }

  async resume(
    sessionId: string,
    prompt = "continue",
    workingDirectory?: string,
    _terminalMarker?: string,
    overrides: AgentResumeOverrides = {},
  ): Promise<AgentResult> {
    // A resumed session keeps the model it was opened with unless the run
    // overrides it, so the operator is told which of the two is running.
    this.reporter.info(
      `Claude Code reanuda la sesión ${sessionId} con el modelo ${overrides.model ?? "con el que se abrió"}`,
    );
    const execution = await this.execute(
      [
        // A resumed session keeps the authority it started with, so the profile
        // and its config travel with the resume too.
        ...this.sessionCommand(overrides.agent),
        "--resume",
        sessionId,
        ...(overrides.model ? ["--model", overrides.model] : []),
        ...(overrides.variant ? ["--effort", this.effort(overrides.variant)] : []),
        prompt,
      ],
      workingDirectory,
      overrides.model,
      true,
    );
    if (execution.azureLoginRequired) {
      throw new Error("Azure sigue requiriendo autenticacion despues de reanudar Claude Code");
    }
    if (execution.exhaustion) throw new AgentExhaustionError(execution.exhaustion, execution.result);
    if (execution.failed) throw new Error("Claude Code terminó con error");
    return execution.result;
  }

  /**
   * `--permission-mode bypassPermissions` is the analogue of OpenCode's `--auto`:
   * prompts are skipped while deny rules still block, because Claude Code
   * evaluates deny before allow in every mode (ADR-0023).
   */
  private sessionCommand(authority?: AgentAuthority): string[] {
    return [
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      ...(authority ? ["--settings", authority.configPath] : []),
    ];
  }

  private effort(variant: string): string {
    if (!EFFORT_LEVELS.has(variant)) {
      throw new Error(`Claude Code no acepta el esfuerzo ${variant} (usa ${CLAUDE_CODE_EFFORTS.join(", ")})`);
    }
    return variant;
  }

  private async execute(
    command: string[],
    workingDirectory?: string,
    model?: string,
    detectAzureLogin = false,
  ): Promise<AgentExecution> {
    this.reporter.info(`Claude Code iniciado en ${workingDirectory ?? globalThis.process.cwd()}${model ? ` con el modelo ${model}` : ""}`);
    const child: AgentProcess = this.spawn(command, { cwd: workingDirectory });
    const reportStdout = (line: string) => {
      for (const { message, severity } of renderEvent(line)) {
        if (severity === "debug") this.reporter.debug(message);
        else this.reporter.info(message);
      }
      if (this.reporter.tracing) {
        for (const message of renderEventTrace(line, parseEvent(line))) this.reporter.trace(message);
      }
    };
    const reportStderr = (line: string) => this.reporter.info(`Claude Code stderr: ${line}`);

    const [lines, errorLines, exitCode] = await Promise.all([
      readLines(child.stdout, reportStdout),
      readLines(child.stderr, reportStderr),
      child.exited,
    ]);

    const events = parseEvents(lines.join("\n"));
    const exhaustion = classifyExhaustion(events, model, exitCode !== 0);
    if (exhaustion) this.reporter.warn(describeExhaustion(exhaustion));
    return {
      result: decodeStream(events),
      azureLoginRequired: detectAzureLogin
        && (requiresAzureLogin(events) || asksForAzureLogin(errorLines.join("\n"))),
      failed: exitCode !== 0,
      exhaustion,
    };
  }
}
