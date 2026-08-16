export interface AgentTokens {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: {
    write?: number;
    read?: number;
  };
}

/**
 * A tool call reports whatever arguments its own tool takes, so the shape stays
 * open: the keys named here are the ones coordination reads, and the rest are
 * what `--verbose-output` shows the operator — the edited file among them.
 */
export type AgentToolInput = Record<string, unknown> & {
  command?: string;
  description?: string;
  file_path?: string;
};

interface OpenCodePartData {
  type?: string;
  tool?: string;
  input?: AgentToolInput;
  state?: {
    status?: string;
    title?: string;
    input?: AgentToolInput;
    output?: string;
    error?: string;
    metadata?: Record<string, unknown>;
  };
  text?: string;
  output?: string;
  error?: string;
  reason?: string;
  tokens?: AgentTokens;
  cost?: number;
}

export interface OpenCodeEventData {
  type: string;
  sessionID?: string;
  part?: OpenCodePartData;
}

interface AgentResultData {
  sessionId: string;
  text: string;
  reason?: string;
  tokens?: AgentTokens;
  cost?: number;
}

/**
 * The normalized result of one coding agent session. Every CLI reduces to this
 * shape, so coordination reads one result regardless of which agent produced it.
 *
 * `fromJsonLines` decodes OpenCode's stream, the only one there is today; a
 * second CLI adds its own decoder rather than reshaping this one.
 */
export class AgentResult {
  readonly sessionId!: string;
  readonly text!: string;
  readonly reason?: string;
  readonly tokens?: AgentTokens;
  readonly cost?: number;

  constructor(data: AgentResultData) {
    Object.assign(this, data);
  }

  static fromJsonLines(output: string): AgentResult {
    const events = output
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as OpenCodeEventData);

    if (events.length === 0) {
      throw new Error("OpenCode no devolvió eventos JSON");
    }

    const finishEvent = [...events].reverse().find((event) => event.type === "step_finish");
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => event.part?.text ?? "")
      .join("\n");

    const sessionId = events.find((event) => typeof event.sessionID === "string")?.sessionID;
    if (!sessionId) {
      throw new Error("OpenCode no devolvio un identificador de sesion");
    }

    return new AgentResult({
      sessionId,
      text,
      reason: finishEvent?.part?.reason,
      tokens: finishEvent?.part?.tokens,
      cost: finishEvent?.part?.cost,
    });
  }
}
