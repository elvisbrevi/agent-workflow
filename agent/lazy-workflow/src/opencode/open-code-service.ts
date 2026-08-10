import { OpenCodeResult, type OpenCodeEventData } from "./open-code-result.ts";

export interface OpenCodeRunOptions {
  model: string;
  variant: string;
  session: string | null;
  prompt: string;
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

export type OpenCodeSpawner = (command: string[]) => OpenCodeProcess;

const spawnOpenCode: OpenCodeSpawner = (command) => {
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    exited: process.exited,
    kill: () => process.kill("SIGTERM"),
  };
};

const loginInstructionPattern = /(?:please\s+run|run|ejecuta|execute).{0,40}\baz\s+login\b/i;

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
      if (onLine(line)) {
        await reader.cancel();
        return { lines, stopped: true };
      }
    }

    if (done) {
      if (buffer.trim().length > 0) {
        lines.push(buffer);
        if (onLine(buffer)) return { lines, stopped: true };
      }
      return { lines, stopped: false };
    }
  }
}

export class OpenCodeService {
  constructor(private readonly spawn: OpenCodeSpawner = spawnOpenCode) {}

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
    ], detectAzureLogin);
  }

  async resume(sessionId: string, prompt = "continue"): Promise<OpenCodeResult> {
    const execution = await this.execute([
      "opencode",
      "run",
      "--auto",
      "--session",
      sessionId,
      "--format",
      "json",
      prompt,
    ], true);
    if (execution.azureLoginRequired) {
      throw new Error("Azure sigue requiriendo autenticacion despues de reanudar OpenCode");
    }
    if (execution.failed) throw new Error("OpenCode termino con error");
    return execution.result;
  }

  private async execute(command: string[], detectAzureLogin: boolean): Promise<OpenCodeExecution> {
    const process = this.spawn(command);
    const stderrPromise = new Response(process.stderr).text();
    const streamed = await readLines(process.stdout, detectAzureLogin ? requiresAzureLogin : () => false);
    if (streamed.stopped) process.kill();

    const [exitCode, stderr] = await Promise.all([process.exited, stderrPromise]);
    const azureLoginRequired = detectAzureLogin && (streamed.stopped || loginInstructionPattern.test(stderr));
    if (exitCode !== 0 && !azureLoginRequired && streamed.lines.length === 0) {
      throw new Error("OpenCode no devolvio eventos");
    }

    return {
      result: OpenCodeResult.fromJsonLines(streamed.lines.join("\n")),
      azureLoginRequired,
      failed: exitCode !== 0,
    };
  }
}
