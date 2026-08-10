import { OpenCodeResult, type OpenCodeEventData } from "./open-code-result.ts";

export interface OpenCodeRunOptions {
  model: string;
  variant: string;
  session: string | null;
  prompt: string;
  workingDirectory?: string;
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
  kill(): void;
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
    kill: () => process.kill("SIGTERM"),
  };
};

const loginInstructionPattern = /(?:please\s+run|run|ejecuta|execute).{0,40}\baz\s+login\b/i;
const HEARTBEAT_INTERVAL_MS = 30_000;

function renderEvent(line: string): string {
  try {
    const event = JSON.parse(line) as OpenCodeEventData;
    const part = event.part;
    if (event.type === "text" && part?.text) return `OpenCode: ${part.text}`;
    if (event.type === "step_start") {
      return `OpenCode ejecutando herramienta: ${part?.tool ?? "desconocida"}`;
    }
    if (event.type === "step_finish") {
      return `OpenCode terminó un paso${part?.reason ? ` (${part.reason})` : ""}`;
    }
    if (event.type === "session") return `OpenCode sesión: ${event.sessionID}`;
    if (part?.error) return `OpenCode error: ${part.error}`;
    return `OpenCode evento: ${event.type}`;
  } catch {
    return line;
  }
}

function requiresAzureLogin(line: string): boolean {
  let event: OpenCodeEventData;
  try {
    event = JSON.parse(line) as OpenCodeEventData;
  } catch {
    return loginInstructionPattern.test(line);
  }

  const command = event.part?.input?.command ?? "";
  if (
    event.type === "step_start" &&
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

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => boolean,
  reportLine?: (line: string) => void,
): Promise<{ lines: string[]; stopped: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
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
}

export class OpenCodeService {
  constructor(
    private readonly spawn: OpenCodeSpawner = spawnOpenCode,
    private readonly report: (message: string) => void = (message) => console.error(message),
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
      options.prompt,
    ], detectAzureLogin, options.workingDirectory);
  }

  async resume(sessionId: string, prompt = "continue", workingDirectory?: string): Promise<OpenCodeResult> {
    const execution = await this.execute([
      "opencode",
      "run",
      "--auto",
      "--session",
      sessionId,
      "--format",
      "json",
      prompt,
    ], true, workingDirectory);
    if (execution.azureLoginRequired) {
      throw new Error("Azure sigue requiriendo autenticacion despues de reanudar OpenCode");
    }
    if (execution.failed) throw new Error("OpenCode termino con error");
    return execution.result;
  }

  private async execute(command: string[], detectAzureLogin: boolean, workingDirectory?: string): Promise<OpenCodeExecution> {
    this.report(`OpenCode iniciado en ${workingDirectory ?? globalThis.process.cwd()}`);
    const child = this.spawn(command, { cwd: workingDirectory });
    let lastEventAt = Date.now();
    const reportStdout = (line: string) => {
      lastEventAt = Date.now();
      this.report(renderEvent(line));
    };
    const reportStderr = (line: string) => {
      lastEventAt = Date.now();
      this.report(`OpenCode stderr: ${line}`);
    };
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - lastEventAt) / 1000);
      this.report(`OpenCode sigue ejecutándose; sin eventos hace ${elapsed}s.`);
    }, HEARTBEAT_INTERVAL_MS);

    try {
      const stderrPromise = readLines(child.stderr, () => false, reportStderr);
      const streamed = await readLines(
        child.stdout,
        detectAzureLogin ? requiresAzureLogin : () => false,
        reportStdout,
      );
      if (streamed.stopped) child.kill();

      const [exitCode, stderrOutput] = await Promise.all([child.exited, stderrPromise]);
      const stderr = stderrOutput.lines.join("\n");
      const azureLoginRequired = detectAzureLogin && (streamed.stopped || loginInstructionPattern.test(stderr));
      if (exitCode !== 0 && !azureLoginRequired && streamed.lines.length === 0) {
        throw new Error("OpenCode no devolvio eventos");
      }

      return {
        result: OpenCodeResult.fromJsonLines(streamed.lines.join("\n")),
        azureLoginRequired,
        failed: exitCode !== 0,
      };
    } finally {
      clearInterval(heartbeat);
    }
  }
}
