import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import chalk from "chalk";
import {
  createReporter,
  type Reporter,
  type ReporterStream,
} from "../src/output/reporter.ts";
import { OpenCodeService } from "../src/opencode/open-code-service.ts";
import { AgentExhaustionError } from "../src/coding-agent/coding-agent.ts";
import { parseReportedChunk } from "./_helpers/reported-lines.ts";

beforeAll(() => {
  chalk.level = 1;
});

type Captured = {
  info: string[];
  warn: string[];
  error: string[];
  debug: string[];
  trace: string[];
};

const captureStream = (): { stream: ReporterStream; captured: Captured } => {
  const captured: Captured = { info: [], warn: [], error: [], debug: [], trace: [] };
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const { level, message } of parseReportedChunk(chunk.toString())) {
        captured[level].push(message);
      }
      callback();
    },
  }) as unknown as ReporterStream;
  return { stream, captured };
};

const captureReporter = (verbose: boolean): { reporter: Reporter; captured: Captured } => {
  const { stream, captured } = captureStream();
  const reporter = createReporter({ verbose, stream });
  return { reporter, captured };
};

const standardOptions = {
  model: "provider/model",
  variant: "high",
  session: null,
  prompt: "trabaja",
} as const;

const jsonEvent = (event: Record<string, unknown>): string => JSON.stringify(event);

describe("OpenCodeService reporter routing", () => {
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
  });

  afterEach(() => {
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  });

  test("el constructor acepta un Reporter y lo usa para el mensaje de inicio", async () => {
    const { reporter, captured } = captureReporter(false);
    const service = new OpenCodeService((command) => {
      return {
        stdout: new Blob([jsonEvent({ type: "text", sessionID: "ses", part: { type: "text", text: "ok" } })]).stream(),
        stderr: new Blob([]).stream(),
        exited: Promise.resolve(0),
        kill: () => undefined,
      };
    }, reporter);

    await service.run(standardOptions);

    expect(captured.info.some((line) => line.startsWith("OpenCode iniciado en"))).toBeTrue();
    expect(captured.info.some((line) => line.includes("OpenCode [sesión ses]: ok"))).toBeTrue();
  });

  test("reasoning y tool_use se silencian por defecto y solo aparecen en info cuando verbose=true", async () => {
    const quiet = captureReporter(false);
    const loud = captureReporter(true);
    const output = [
      jsonEvent({ type: "session", sessionID: "ses_debug" }),
      jsonEvent({ type: "reasoning", sessionID: "ses_debug", part: { type: "reasoning", text: "Pensando" } }),
      jsonEvent({
        type: "tool_use",
        sessionID: "ses_debug",
        part: { type: "tool", tool: "bash", state: { status: "running", input: { command: "ls" } } },
      }),
      jsonEvent({ type: "text", sessionID: "ses_debug", part: { type: "text", text: "avance" } }),
    ].join("\n");
    const spawn = (command: string[]) => ({
      stdout: new Blob([output]).stream(),
      stderr: new Blob([]).stream(),
      exited: Promise.resolve(0),
      kill: () => undefined,
    });

    await new OpenCodeService(spawn, quiet.reporter).run(standardOptions);
    await new OpenCodeService(spawn, loud.reporter).run(standardOptions);

    expect(quiet.captured.info.find((line) => line.includes("razonando"))).toBeUndefined();
    expect(quiet.captured.info.find((line) => line.includes("herramienta bash"))).toBeUndefined();
    expect(quiet.captured.debug).toEqual([]);

    expect(loud.captured.debug.some((line) => line.includes("razonando: Pensando"))).toBeTrue();
    expect(loud.captured.debug.some((line) => line.includes("herramienta bash"))).toBeTrue();
  });

  test("step_start y step_finish siempre emiten líneas info", async () => {
    const { reporter, captured } = captureReporter(false);
    const output = [
      jsonEvent({ type: "session", sessionID: "ses_step" }),
      jsonEvent({ type: "step_start", sessionID: "ses_step", part: { type: "step", reason: "agent" } }),
      jsonEvent({ type: "step_finish", sessionID: "ses_step", part: { type: "step", reason: "stop" } }),
      jsonEvent({ type: "text", sessionID: "ses_step", part: { type: "text", text: "fin" } }),
    ].join("\n");
    const service = new OpenCodeService((command) => {
      return {
        stdout: new Blob([output]).stream(),
        stderr: new Blob([]).stream(),
        exited: Promise.resolve(0),
        kill: () => undefined,
      };
    }, reporter);

    await service.run(standardOptions);

    expect(captured.info.some((line) => line.includes("inició un paso"))).toBeTrue();
    expect(captured.info.some((line) => line.includes("terminó un paso"))).toBeTrue();
  });

  test("el texto final del asistente emite línea info", async () => {
    const { reporter, captured } = captureReporter(false);
    const output = [
      jsonEvent({ type: "session", sessionID: "ses_text" }),
      jsonEvent({ type: "text", sessionID: "ses_text", part: { type: "text", text: "primer av" } }),
      jsonEvent({ type: "text", sessionID: "ses_text", part: { type: "text", text: "TICKET_COMPLETED" } }),
    ].join("\n");
    const service = new OpenCodeService((command) => {
      return {
        stdout: new Blob([output]).stream(),
        stderr: new Blob([]).stream(),
        exited: Promise.resolve(0),
        kill: () => undefined,
      };
    }, reporter);

    await service.run(standardOptions);

    expect(captured.info).toContain("OpenCode [sesión ses_text]: TICKET_COMPLETED");
    expect(captured.info).toContain("OpenCode [sesión ses_text]: primer av");
  });

  test("stderr se enruta a info", async () => {
    const { reporter, captured } = captureReporter(false);
    const output = [
      jsonEvent({ type: "session", sessionID: "ses_err" }),
      jsonEvent({ type: "text", sessionID: "ses_err", part: { type: "text", text: "ok" } }),
    ].join("\n");
    const service = new OpenCodeService((command) => {
      return {
        stdout: new Blob([output]).stream(),
        stderr: new Blob(["línea de error"]).stream(),
        exited: Promise.resolve(0),
        kill: () => undefined,
      };
    }, reporter);

    await service.run(standardOptions);

    expect(captured.info).toContain("OpenCode stderr: línea de error");
  });

  test("resume aplica solo los overrides de modelo proporcionados", async () => {
    const commands: string[][] = [];
    const service = new OpenCodeService((command) => {
      commands.push(command);
      return {
        stdout: new Blob([jsonEvent({ type: "text", sessionID: "ses_resume", part: { type: "text", text: "ok" } })]).stream(),
        stderr: new Blob([]).stream(),
        exited: Promise.resolve(0),
        kill: () => undefined,
      };
    });

    await service.resume("ses_resume", "continue", undefined, undefined, {
      model: "openai/gpt-5.6-luna",
      variant: "high",
    });
    await service.resume("ses_resume");

    expect(commands[0]).toEqual([
      "opencode", "run", "--auto", "--session", "ses_resume",
      "--model", "openai/gpt-5.6-luna", "--variant", "high",
      "--format", "json", "--thinking", "continue",
    ]);
    expect(commands[1]).toEqual([
      "opencode", "run", "--auto", "--session", "ses_resume",
      "--format", "json", "--thinking", "continue",
    ]);
  });

  test("no emite el heartbeat 'sin eventos hace Xs' aunque el run sea largo", async () => {
    const { reporter, captured } = captureReporter(false);
    const output = [
      jsonEvent({ type: "session", sessionID: "ses_quiet" }),
      jsonEvent({ type: "text", sessionID: "ses_quiet", part: { type: "text", text: "ok" } }),
    ].join("\n");
    const service = new OpenCodeService((command) => {
      return {
        stdout: new Blob([output]).stream(),
        stderr: new Blob([]).stream(),
        exited: Promise.resolve(0),
        kill: () => undefined,
      };
    }, reporter);

    await service.run(standardOptions);

    expect(captured.info.find((line) => line.includes("sin eventos hace"))).toBeUndefined();
    expect(captured.debug.find((line) => line.includes("sin eventos hace"))).toBeUndefined();
  });

  test("con verbose=true las reasoning y tool_use aparecen visibles", async () => {
    const { reporter, captured } = captureReporter(true);
    const output = [
      jsonEvent({ type: "session", sessionID: "ses_verbose" }),
      jsonEvent({ type: "reasoning", sessionID: "ses_verbose", part: { type: "reasoning", text: "analizando" } }),
      jsonEvent({
        type: "tool_use",
        sessionID: "ses_verbose",
        part: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "git status" } } },
      }),
      jsonEvent({ type: "text", sessionID: "ses_verbose", part: { type: "text", text: "fin" } }),
    ].join("\n");
    const service = new OpenCodeService((command) => {
      return {
        stdout: new Blob([output]).stream(),
        stderr: new Blob([]).stream(),
        exited: Promise.resolve(0),
        kill: () => undefined,
      };
    }, reporter);

    await service.run(standardOptions);

    expect(captured.debug.find((line) => line.includes("razonando: analizando"))).toBeDefined();
    expect(captured.debug.find((line) => line.includes("herramienta bash"))).toBeDefined();
  });

  test("un run GitHub por defecto emite menos de 20 líneas en stdout", async () => {
    const { reporter, captured } = captureReporter(false);
    const events: string[] = [];
    for (let i = 0; i < 30; i++) {
      events.push(jsonEvent({
        type: "tool_use",
        sessionID: "ses_volume",
        part: { type: "tool", tool: "bash", state: { status: "completed", input: { command: `echo ${i}` } } },
      }));
    }
    events.push(jsonEvent({ type: "step_finish", sessionID: "ses_volume", part: { type: "step", reason: "stop" } }));
    events.push(jsonEvent({ type: "text", sessionID: "ses_volume", part: { type: "text", text: "terminado" } }));
    const output = events.join("\n");
    const service = new OpenCodeService((command) => {
      return {
        stdout: new Blob([output]).stream(),
        stderr: new Blob([]).stream(),
        exited: Promise.resolve(0),
        kill: () => undefined,
      };
    }, reporter);

    await service.run(standardOptions);

    const totalLines = captured.info.length + captured.warn.length + captured.error.length;
    expect(totalLines).toBeLessThan(20);
  });

  test("default reporter se obtiene cuando el constructor no recibe uno", async () => {
    let originalReporter: Reporter | undefined;
    const { setDefaultReporter, getDefaultReporter } = await import("../src/output/operator-output.ts");
    originalReporter = getDefaultReporter();
    const { stream, captured } = captureStream();
    const injected = createReporter({ verbose: false, stream });
    setDefaultReporter(injected);
    try {
      const output = [
        jsonEvent({ type: "session", sessionID: "ses_default" }),
        jsonEvent({ type: "text", sessionID: "ses_default", part: { type: "text", text: "ok" } }),
      ].join("\n");
      const service = new OpenCodeService((command) => {
        return {
          stdout: new Blob([output]).stream(),
          stderr: new Blob([]).stream(),
          exited: Promise.resolve(0),
          kill: () => undefined,
        };
      });
      await service.run(standardOptions);
      expect(captured.info.some((line) => line.startsWith("OpenCode iniciado en"))).toBeTrue();
    } finally {
      setDefaultReporter(originalReporter);
    }
  });

  test("el spinner se reinicia tras un silencio y lo detiene el siguiente evento", async () => {
    let started = 0;
    let stopped = 0;
    const ticks: string[] = [];
    const trackingReporter: Reporter = {
      tracing: false,
      info: (message: string) => ticks.push(`info:${message}`),
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
      heading: () => undefined,
      start: (message: string) => {
        started += 1;
        return { text: message, stop: () => { stopped += 1; } };
      },
      stop: (spinner) => spinner?.stop(),
    };

    const firstEvent = jsonEvent({ type: "session", sessionID: "ses_spin" });
    const secondEvent = jsonEvent({ type: "text", sessionID: "ses_spin", part: { type: "text", text: "ok" } });
    const output = `${firstEvent}\n${secondEvent}`;
    const service = new OpenCodeService(() => ({
      stdout: new Blob([output]).stream(),
      stderr: new Blob([]).stream(),
      exited: Promise.resolve(0),
      kill: () => undefined,
    }), trackingReporter);

    await service.run(standardOptions);

    expect(started).toBeGreaterThanOrEqual(1);
    expect(stopped).toBeGreaterThanOrEqual(1);
    expect(ticks.some((line) => line.includes("OpenCode iniciado en"))).toBeTrue();
    expect(ticks.some((line) => line.includes("OpenCode [sesión ses_spin]: ok"))).toBeTrue();
  });

  test("reconoce el marcador terminal cuando llega en un segundo evento de texto tras ':'", async () => {
    const encoder = new TextEncoder();
    let closeStdout: () => void = () => undefined;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        closeStdout = () => controller.close();
        controller.enqueue(encoder.encode(`${jsonEvent({ type: "session", sessionID: "ses_ready_split" })}\n`));
        controller.enqueue(encoder.encode(`${jsonEvent({ type: "text", sessionID: "ses_ready_split", part: { type: "text", text: "Trabajo completado:" } })}\n`));
        controller.enqueue(encoder.encode(`${jsonEvent({ type: "text", sessionID: "ses_ready_split", part: { type: "text", text: "IMPLEMENTATION_READY" } })}\n`));
      },
    });
    let closeStderr: () => void = () => undefined;
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        closeStderr = () => controller.close();
      },
    });
    let resolveExit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    const signals: string[] = [];
    const service = new OpenCodeService((command) => command[1] === "session"
      ? {
        stdout: new Blob([]).stream(),
        stderr: new Blob([]).stream(),
        exited: Promise.resolve(0),
        kill: () => undefined,
      }
      : {
        stdout,
        stderr,
        exited,
        kill: (signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") resolveExit(137);
        },
      }, undefined, 5);

    const execution = service.run({
      ...standardOptions,
      terminalMarker: "IMPLEMENTATION_READY",
    }, true);
    const outcome = await Promise.race([
      execution.then(() => "completed" as const),
      Bun.sleep(50).then(() => "timeout" as const),
    ]);
    if (outcome === "timeout") {
      closeStdout();
      closeStderr();
      resolveExit(0);
      await execution;
    }

    expect(outcome).toBe("completed");
    const finalResult = await execution;
    expect(finalResult.azureLoginRequired).toBeFalse();
    expect(finalResult.failed).toBeFalse();
    expect(finalResult.result.text).toBe("Trabajo completado:\nIMPLEMENTATION_READY");
    expect(finalResult.result.text.split(/\r?\n/).map((line) => line.trim()))
      .toContain("IMPLEMENTATION_READY");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("no emite el marcador terminal cuando solo aparece conversacionalmente", async () => {
    const output = [
      jsonEvent({ type: "session", sessionID: "ses_chat" }),
      jsonEvent({ type: "text", sessionID: "ses_chat", part: { type: "text", text: "Voy a emitir IMPLEMENTATION_READY pronto" } }),
    ].join("\n");
    const service = new OpenCodeService((command) => command[1] === "session"
      ? {
        stdout: new Blob([]).stream(),
        stderr: new Blob([]).stream(),
        exited: Promise.resolve(0),
        kill: () => undefined,
      }
      : {
        stdout: new Blob([output]).stream(),
        stderr: new Blob([]).stream(),
        exited: Promise.resolve(0),
        kill: () => undefined,
      });

    const execution = await service.run({
      ...standardOptions,
      terminalMarker: "IMPLEMENTATION_READY",
    }, true);

    expect(execution.azureLoginRequired).toBeFalse();
    expect(execution.failed).toBeFalse();
    expect(execution.result.text).toBe("Voy a emitir IMPLEMENTATION_READY pronto");
  });
});

// Fragments captured from a real `opencode run --format json` invocation against
// live providers (invalid credentials / unsupported model), see
// src/opencode/open-code-service.ts for the citation of each shape.
describe("OpenCodeService agotamiento del proveedor", () => {
  const stub = (output: string, exitCode = 1) => ({
    stdout: new Blob([output]).stream(),
    stderr: new Blob([]).stream(),
    exited: Promise.resolve(exitCode),
    kill: () => undefined,
  });

  test("un ProviderAuthError real se clasifica como agotamiento por autenticacion", async () => {
    // Captured running `opencode run` with DEEPSEEK_API_KEY set to an invalid value:
    // {"type":"error","sessionID":"ses_x","error":{"name":"APIError","data":{"message":"Authentication Fails, Your api key: ****-000 is invalid","statusCode":401,"isRetryable":false}}}
    const output = jsonEvent({
      type: "error",
      sessionID: "ses_auth",
      error: { name: "APIError", data: { message: "Authentication Fails, Your api key: ****-000 is invalid", statusCode: 401, isRetryable: false } },
    });
    const { reporter, captured } = captureReporter(false);
    const service = new OpenCodeService(() => stub(output), reporter);

    const execution = await service.run(standardOptions);

    expect(execution.exhaustion).toEqual({ cli: "OpenCode", model: standardOptions.model, cause: "authentication" });
    expect(execution.failed).toBeTrue();
    expect(captured.warn.some((line) =>
      line.includes("OpenCode") && line.includes(standardOptions.model) && line.includes("authentication"),
    )).toBeTrue();
  });

  test("un APIError con statusCode 429 se clasifica como agotamiento por limite de uso", async () => {
    const output = jsonEvent({
      type: "error",
      sessionID: "ses_rate",
      error: { name: "APIError", data: { message: "Too Many Requests", statusCode: 429, isRetryable: true } },
    });
    const service = new OpenCodeService(() => stub(output));

    const execution = await service.run(standardOptions);

    expect(execution.exhaustion).toEqual({ cli: "OpenCode", model: standardOptions.model, cause: "rate_limit" });
  });

  test("un APIError con statusCode 402 se clasifica como agotamiento por facturacion", async () => {
    const output = jsonEvent({
      type: "error",
      sessionID: "ses_billing",
      error: { name: "APIError", data: { message: "Payment Required", statusCode: 402, isRetryable: false } },
    });
    const service = new OpenCodeService(() => stub(output));

    const execution = await service.run(standardOptions);

    expect(execution.exhaustion).toEqual({ cli: "OpenCode", model: standardOptions.model, cause: "billing" });
  });

  test("un error ambiguo del proveedor no se clasifica como agotamiento", async () => {
    // Captured running `opencode run --model openai/gpt-4o-fake-model-xyz`:
    // {"type":"error","sessionID":"ses_x","error":{"name":"UnknownError","data":{"message":"Model not found: openai/gpt-4o-fake-model-xyz..."}}}
    const output = jsonEvent({
      type: "error",
      sessionID: "ses_unknown",
      error: { name: "UnknownError", data: { message: "Model not found: openai/gpt-4o-fake-model-xyz." } },
    });
    const service = new OpenCodeService(() => stub(output));

    const execution = await service.run(standardOptions);

    expect(execution.exhaustion).toBeUndefined();
    expect(execution.failed).toBeTrue();
  });

  test("un APIError con statusCode 500 no se clasifica como agotamiento", async () => {
    const output = jsonEvent({
      type: "error",
      sessionID: "ses_server",
      error: { name: "APIError", data: { message: "Unexpected server error.", statusCode: 500, isRetryable: true } },
    });
    const service = new OpenCodeService(() => stub(output));

    const execution = await service.run(standardOptions);

    expect(execution.exhaustion).toBeUndefined();
  });

  test("una sesion exitosa no tiene agotamiento del proveedor", async () => {
    const output = jsonEvent({ type: "text", sessionID: "ses_ok", part: { type: "text", text: "listo" } });
    const service = new OpenCodeService(() => stub(output, 0));

    const execution = await service.run(standardOptions);

    expect(execution.exhaustion).toBeUndefined();
    expect(execution.failed).toBeFalse();
  });

  test("un evento de error que no impide terminar con exito no se clasifica como agotamiento", async () => {
    const output = [
      jsonEvent({ type: "error", sessionID: "ses_recovered", error: { name: "APIError", data: { statusCode: 429 } } }),
      jsonEvent({ type: "text", sessionID: "ses_recovered", part: { type: "text", text: "se recupero" } }),
    ].join("\n");
    const service = new OpenCodeService(() => stub(output, 0));

    const execution = await service.run(standardOptions);

    expect(execution.failed).toBeFalse();
    expect(execution.exhaustion).toBeUndefined();
  });

  test("una reanudacion agotada lanza el error tipado que lleva el agotamiento", async () => {
    const output = jsonEvent({
      type: "error",
      sessionID: "ses_resumed",
      error: { name: "APIError", data: { message: "Too Many Requests", statusCode: 429 } },
    });
    const service = new OpenCodeService(() => stub(output));

    const error = await service
      .resume("ses_resumed", "continue", undefined, undefined, { model: "provider/respaldo" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AgentExhaustionError);
    expect((error as AgentExhaustionError).exhaustion).toEqual({
      cli: "OpenCode",
      model: "provider/respaldo",
      cause: "rate_limit",
    });
  });

  test("una reanudacion que falla sin agotamiento no lanza el error de agotamiento", async () => {
    const output = jsonEvent({
      type: "error",
      sessionID: "ses_broken",
      error: { name: "UnknownError", data: { message: "Model not found" } },
    });
    const service = new OpenCodeService(() => stub(output));

    const error = await service.resume("ses_broken").catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AgentExhaustionError);
  });

  test("un agotamiento durante una reanudacion sin modelo explicito nombra igual el modelo con el que abrio", async () => {
    const output = jsonEvent({ type: "error", sessionID: "ses_resumed", error: { name: "ProviderAuthError" } });
    const { reporter, captured } = captureReporter(false);
    const service = new OpenCodeService(() => stub(output), reporter);

    await expect(service.resume("ses_resumed")).rejects.toThrow();

    expect(captured.warn.some((line) =>
      line.includes("OpenCode") && line.includes("authentication") && !line.includes("modelo ,"),
    )).toBeTrue();
  });
});
