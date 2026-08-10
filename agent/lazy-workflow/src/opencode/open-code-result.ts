export interface OpenCodeTokens {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: {
    write?: number;
    read?: number;
  };
}

interface OpenCodePartData {
  type?: string;
  tool?: string;
  input?: {
    command?: string;
  };
  text?: string;
  output?: string;
  error?: string;
  reason?: string;
  tokens?: OpenCodeTokens;
  cost?: number;
}

export interface OpenCodeEventData {
  type: string;
  sessionID: string;
  part?: OpenCodePartData;
}

interface OpenCodeResultData {
  sessionId: string;
  text: string;
  reason?: string;
  tokens?: OpenCodeTokens;
  cost?: number;
}

export class OpenCodeResult {
  readonly sessionId!: string;
  readonly text!: string;
  readonly reason?: string;
  readonly tokens?: OpenCodeTokens;
  readonly cost?: number;

  constructor(data: OpenCodeResultData) {
    Object.assign(this, data);
  }

  static fromJsonLines(output: string): OpenCodeResult {
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
      .join("");

    const sessionId = events.find((event) => typeof event.sessionID === "string")?.sessionID;
    if (!sessionId) {
      throw new Error("OpenCode no devolvio un identificador de sesion");
    }

    return new OpenCodeResult({
      sessionId,
      text,
      reason: finishEvent?.part?.reason,
      tokens: finishEvent?.part?.tokens,
      cost: finishEvent?.part?.cost,
    });
  }
}
