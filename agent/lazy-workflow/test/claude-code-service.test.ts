import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import chalk from "chalk";
import {
  createReporter,
  type Reporter,
  type ReporterStream,
} from "../src/output/reporter.ts";
import { ClaudeCodeService } from "../src/claude-code/claude-code-service.ts";
import { AUTHORITY_PROFILES, authorityConfigPath } from "../src/prompts/authority-profile.ts";

beforeAll(() => {
  chalk.level = 1;
});

type Captured = {
  info: string[];
  warn: string[];
  error: string[];
  debug: string[];
};

const captureStream = (): { stream: ReporterStream; captured: Captured } => {
  const captured: Captured = { info: [], warn: [], error: [], debug: [] };
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      const stripped = text.replace(/\[[0-9;]*m/g, "").replace(/\n$/, "");
      const match = stripped.match(/^[^\s]+(\s|$)/);
      const icon = match ? match[0].trimEnd() : "";
      const rest = stripped.replace(/^[^\s]+\s?/, "");
      if (icon === "ℹ") captured.info.push(rest);
      else if (icon === "⚠") captured.warn.push(rest);
      else if (icon === "✗") captured.error.push(rest);
      else if (icon === "·") captured.debug.push(rest);
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
  model: "claude-opus-5",
  variant: "high",
  session: null,
  prompt: "planifica",
} as const;

const jsonEvent = (event: Record<string, unknown>): string => JSON.stringify(event);

const initEvent = (sessionId: string) =>
  jsonEvent({ type: "system", subtype: "init", session_id: sessionId, model: "claude-opus-5" });

const assistantText = (sessionId: string, text: string) =>
  jsonEvent({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text }] } });

const stubProcess = (stdout: string, stderr = "", exitCode = 0) => ({
  stdout: new Blob([stdout]).stream(),
  stderr: new Blob([stderr]).stream(),
  exited: Promise.resolve(exitCode),
  kill: () => undefined,
});

describe("ClaudeCodeService comando construido", () => {
  test("ejecuta en modo no interactivo con stream JSON, modelo y esfuerzo", async () => {
    const commands: string[][] = [];
    const options: Array<{ cwd?: string } | undefined> = [];
    const service = new ClaudeCodeService((command, spawnOptions) => {
      commands.push(command);
      options.push(spawnOptions);
      return stubProcess([initEvent("ses_cmd"), assistantText("ses_cmd", "ok")].join("\n"));
    });

    await service.run({ ...standardOptions, workingDirectory: "/repo" });

    expect(commands[0]).toEqual([
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "claude-opus-5",
      "--effort",
      "high",
      "planifica",
    ]);
    expect(options[0]?.cwd).toBe("/repo");
  });

  test("cada perfil inyecta por ruta su propia autoridad junto al modo que no pregunta", async () => {
    const commands: string[][] = [];
    const service = new ClaudeCodeService((command) => {
      commands.push(command);
      return stubProcess([initEvent("ses_auth"), assistantText("ses_auth", "ok")].join("\n"));
    });

    for (const profile of AUTHORITY_PROFILES) {
      await service.run({
        ...standardOptions,
        agent: { profile, configPath: authorityConfigPath("claudecode", profile) },
      });
    }

    AUTHORITY_PROFILES.forEach((profile, index) => {
      const command = commands[index]!;
      expect(`${profile}: ${command[command.indexOf("--settings") + 1]}`)
        .toBe(`${profile}: ${authorityConfigPath("claudecode", profile)}`);
      expect(`${profile}: ${command[command.indexOf("--permission-mode") + 1]}`)
        .toBe(`${profile}: bypassPermissions`);
    });
  });

  test("una sesion reanudada conserva la autoridad con la que arranco", async () => {
    const commands: string[][] = [];
    const service = new ClaudeCodeService((command) => {
      commands.push(command);
      return stubProcess([initEvent("ses_auth"), assistantText("ses_auth", "ok")].join("\n"));
    });

    await service.resume("ses_auth", "continue", "/repo", undefined, {
      agent: { profile: "lazy-review", configPath: "/cfg/lazy-review.json" },
    });

    expect(commands[0]?.[commands[0].indexOf("--settings") + 1]).toBe("/cfg/lazy-review.json");
  });

  test("un run sin autoridad no inyecta ninguna configuracion", async () => {
    const commands: string[][] = [];
    const service = new ClaudeCodeService((command) => {
      commands.push(command);
      return stubProcess([initEvent("ses_libre"), assistantText("ses_libre", "ok")].join("\n"));
    });

    await service.run(standardOptions);

    expect(commands[0]).not.toContain("--settings");
  });

  test("la sesion nunca arranca en modo bare", async () => {
    const commands: string[][] = [];
    const service = new ClaudeCodeService((command) => {
      commands.push(command);
      return stubProcess([initEvent("ses_bare"), assistantText("ses_bare", "ok")].join("\n"));
    });

    await service.run(standardOptions);

    expect(commands[0]).not.toContain("--bare");
  });

  test("un esfuerzo fuera del conjunto aceptado falla sin abrir la sesion", async () => {
    let spawned = false;
    const service = new ClaudeCodeService(() => {
      spawned = true;
      return stubProcess(initEvent("ses_nunca"));
    });

    await expect(service.run({ ...standardOptions, variant: "turbo" })).rejects.toThrow(/turbo/);
    expect(spawned).toBeFalse();
  });

  test("resume reanuda la sesion y aplica solo los overrides proporcionados", async () => {
    const commands: string[][] = [];
    const service = new ClaudeCodeService((command) => {
      commands.push(command);
      return stubProcess([initEvent("ses_resume"), assistantText("ses_resume", "ok")].join("\n"));
    });

    await service.resume("ses_resume", "continue", "/repo", undefined, {
      model: "claude-sonnet-5",
      variant: "medium",
    });
    await service.resume("ses_resume");

    expect(commands[0]).toEqual([
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--resume",
      "ses_resume",
      "--model",
      "claude-sonnet-5",
      "--effort",
      "medium",
      "continue",
    ]);
    expect(commands[1]).toEqual([
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--resume",
      "ses_resume",
      "continue",
    ]);
  });
});

describe("ClaudeCodeService normalizacion del stream", () => {
  test("toma el identificador de sesion del evento de inicializacion", async () => {
    const service = new ClaudeCodeService(() =>
      stubProcess([initEvent("ses_init"), assistantText("ses_init", "avance")].join("\n")));

    const execution = await service.run(standardOptions);

    expect(execution.result.sessionId).toBe("ses_init");
  });

  test("un stream sin evento de inicializacion falla nombrando el CLI", async () => {
    const service = new ClaudeCodeService(() => stubProcess(assistantText("ses_x", "avance")));

    await expect(service.run(standardOptions)).rejects.toThrow(/Claude Code/);
  });

  test("normaliza texto final, razon de termino, tokens y costo", async () => {
    const output = [
      initEvent("ses_result"),
      assistantText("ses_result", "avance intermedio"),
      jsonEvent({
        type: "result",
        subtype: "success",
        session_id: "ses_result",
        result: "plan final",
        total_cost_usd: 0.42,
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 5,
        },
      }),
    ].join("\n");
    const service = new ClaudeCodeService(() => stubProcess(output));

    const execution = await service.run(standardOptions);

    expect(execution.result.text).toBe("plan final");
    expect(execution.result.reason).toBe("success");
    expect(execution.result.cost).toBe(0.42);
    expect(execution.result.tokens).toEqual({
      input: 120,
      output: 30,
      cache: { write: 10, read: 5 },
    });
    expect(execution.failed).toBeFalse();
  });

  test("sin evento de resultado el texto son los mensajes del asistente", async () => {
    const output = [
      initEvent("ses_partial"),
      assistantText("ses_partial", "primer avance"),
      assistantText("ses_partial", "segundo avance"),
    ].join("\n");
    const service = new ClaudeCodeService(() => stubProcess(output));

    const execution = await service.run(standardOptions);

    expect(execution.result.text).toBe("primer avance\nsegundo avance");
  });

  test("un codigo de salida distinto de cero marca la ejecucion como fallida", async () => {
    const service = new ClaudeCodeService(() =>
      stubProcess([initEvent("ses_fail"), assistantText("ses_fail", "algo")].join("\n"), "", 1));

    const execution = await service.run(standardOptions);

    expect(execution.failed).toBeTrue();
  });
});

describe("ClaudeCodeService enrutado por el Reporter", () => {
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
  });

  afterEach(() => {
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  });

  test("el texto del asistente se emite en info", async () => {
    const { reporter, captured } = captureReporter(false);
    const service = new ClaudeCodeService(
      () => stubProcess([initEvent("ses_text"), assistantText("ses_text", "avance")].join("\n")),
      reporter,
    );

    await service.run(standardOptions);

    expect(captured.info.some((line) => line.startsWith("Claude Code iniciado en"))).toBeTrue();
    expect(captured.info).toContain("Claude Code [sesión ses_text]: avance");
  });

  test("razonamiento y herramientas solo se ven con verbose", async () => {
    const output = [
      initEvent("ses_debug"),
      jsonEvent({
        type: "assistant",
        session_id: "ses_debug",
        message: { content: [{ type: "thinking", thinking: "Pensando" }] },
      }),
      jsonEvent({
        type: "assistant",
        session_id: "ses_debug",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      }),
      assistantText("ses_debug", "avance"),
    ].join("\n");
    const quiet = captureReporter(false);
    const loud = captureReporter(true);
    const spawn = () => stubProcess(output);

    await new ClaudeCodeService(spawn, quiet.reporter).run(standardOptions);
    await new ClaudeCodeService(spawn, loud.reporter).run(standardOptions);

    expect(quiet.captured.info.find((line) => line.includes("razonando"))).toBeUndefined();
    expect(quiet.captured.info.find((line) => line.includes("herramienta Bash"))).toBeUndefined();
    expect(quiet.captured.debug).toEqual([]);

    expect(loud.captured.debug.some((line) => line.includes("razonando: Pensando"))).toBeTrue();
    expect(loud.captured.debug.some((line) => line.includes("herramienta Bash"))).toBeTrue();
  });

  test("stderr se enruta a info", async () => {
    const { reporter, captured } = captureReporter(false);
    const service = new ClaudeCodeService(
      () => stubProcess([initEvent("ses_err"), assistantText("ses_err", "ok")].join("\n"), "línea de error"),
      reporter,
    );

    await service.run(standardOptions);

    expect(captured.info).toContain("Claude Code stderr: línea de error");
  });
});
