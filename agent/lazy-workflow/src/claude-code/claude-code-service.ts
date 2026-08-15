/**
 * The Claude Code adapter: one more implementation of the coding agent seam, so
 * a run may execute its session with `--cli claudecode` (ADR-0023).
 *
 * The authority profile a run carries is not injected here yet: Claude Code takes
 * its deny rules from a settings file that does not exist until the authority
 * mirror lands, so sessions are bounded by the flow the coordinator allows rather
 * than by provider-enforced rules.
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
import { AgentResult, type AgentTokens } from "../coding-agent/agent-result.ts";
import type {
  AgentExecution,
  AgentResumeOverrides,
  AgentRunOptions,
  CodingAgent,
} from "../coding-agent/coding-agent.ts";
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
  input?: { command?: string; description?: string };
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
  severity: "debug" | "info";
}

function renderBlock(prefix: string, block: ClaudeCodeContentBlock): ReportedEvent | null {
  if (block.type === "text" && block.text) return { message: `${prefix}: ${block.text}`, severity: "info" };
  if (block.type === "thinking" && block.thinking) {
    return { message: `${prefix} razonando: ${block.thinking}`, severity: "debug" };
  }
  if (block.type === "tool_use") {
    const detail = block.input?.command?.trim() ?? block.input?.description?.trim();
    return {
      message: `${prefix} herramienta ${block.name ?? "desconocida"}${detail ? `: ${JSON.stringify(detail)}` : ""}`,
      severity: "debug",
    };
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

function decodeStream(output: string): AgentResult {
  const events = output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map(parseEvent)
    .filter((event): event is ClaudeCodeEventData => event !== null);

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

export class ClaudeCodeService implements CodingAgent {
  constructor(
    private readonly spawn: AgentSpawner = spawnAgentProcess,
    private readonly reporter: Reporter = getDefaultReporter(),
  ) {}

  async run(options: AgentRunOptions): Promise<AgentExecution> {
    return this.execute(
      [
        ...this.sessionCommand(),
        ...(options.session ? ["--resume", options.session] : []),
        "--model",
        options.model,
        "--effort",
        this.effort(options.variant),
        options.prompt,
      ],
      options.workingDirectory,
    );
  }

  async resume(
    sessionId: string,
    prompt = "continue",
    workingDirectory?: string,
    _terminalMarker?: string,
    overrides: AgentResumeOverrides = {},
  ): Promise<AgentResult> {
    const execution = await this.execute(
      [
        ...this.sessionCommand(),
        "--resume",
        sessionId,
        ...(overrides.model ? ["--model", overrides.model] : []),
        ...(overrides.variant ? ["--effort", this.effort(overrides.variant)] : []),
        prompt,
      ],
      workingDirectory,
    );
    if (execution.failed) throw new Error("Claude Code terminó con error");
    return execution.result;
  }

  /**
   * `--permission-mode bypassPermissions` is the analogue of OpenCode's `--auto`:
   * prompts are skipped while deny rules still block, because Claude Code
   * evaluates deny before allow in every mode (ADR-0023).
   */
  private sessionCommand(): string[] {
    return [
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
    ];
  }

  private effort(variant: string): string {
    if (!EFFORT_LEVELS.has(variant)) {
      throw new Error(`Claude Code no acepta el esfuerzo ${variant} (usa ${CLAUDE_CODE_EFFORTS.join(", ")})`);
    }
    return variant;
  }

  private async execute(command: string[], workingDirectory?: string): Promise<AgentExecution> {
    this.reporter.info(`Claude Code iniciado en ${workingDirectory ?? globalThis.process.cwd()}`);
    const child: AgentProcess = this.spawn(command, { cwd: workingDirectory });
    const reportStdout = (line: string) => {
      for (const { message, severity } of renderEvent(line)) {
        if (severity === "debug") this.reporter.debug(message);
        else this.reporter.info(message);
      }
    };
    const reportStderr = (line: string) => this.reporter.info(`Claude Code stderr: ${line}`);

    const [lines, , exitCode] = await Promise.all([
      readLines(child.stdout, reportStdout),
      readLines(child.stderr, reportStderr),
      child.exited,
    ]);

    return {
      result: decodeStream(lines.join("\n")),
      // Provider exhaustion and the Azure login handshake are classified where
      // their own issues land; today every Claude Code session reports neither.
      azureLoginRequired: false,
      failed: exitCode !== 0,
    };
  }
}
