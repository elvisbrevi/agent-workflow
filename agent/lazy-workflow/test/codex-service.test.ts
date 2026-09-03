import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexService } from "../src/codex/codex-service.ts";
import { AgentExhaustionError, AgentSessionNotFoundError } from "../src/coding-agent/coding-agent.ts";
import type { AgentProcess } from "../src/coding-agent/agent-process.ts";
import type { Reporter } from "../src/output/reporter.ts";

type Captured = { info: string[]; warn: string[]; error: string[]; debug: string[]; trace: string[] };

function reporter(captured: Captured = { info: [], warn: [], error: [], debug: [], trace: [] }): Reporter {
  return {
    info: (message) => captured.info.push(message),
    warn: (message) => captured.warn.push(message),
    error: (message) => captured.error.push(message),
    debug: (message) => captured.debug.push(message),
    trace: (message) => captured.trace.push(message),
    tracing: true,
    heading: () => undefined,
    start: () => undefined as never,
    stop: () => undefined,
    session: () => undefined,
  };
}

function event(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function processFor(stdout: string, stderr = "", exitCode = 0): AgentProcess {
  return {
    stdout: new Blob([stdout]).stream(),
    stderr: new Blob([stderr]).stream(),
    exited: Promise.resolve(exitCode),
    kill: () => undefined,
  };
}

const standardOptions = {
  model: "gpt-5.6-sol",
  variant: "high",
  session: null,
  prompt: "planifica",
} as const;

const threadStarted = (threadId: string) => event({ type: "thread.started", thread_id: threadId });
const assistantMessage = (text: string, id = "item_message") => event({
  type: "item.completed",
  item: { id, type: "agent_message", text },
});
const turnCompleted = (usage: Record<string, number>, reason = "completed") => event({
  type: "turn.completed",
  reason,
  usage,
});

test("Codex construye exec JSON con autoridad, modelo y esfuerzo", async () => {
  const commands: string[][] = [];
  const spawn = (command: string[]) => {
    commands.push(command);
    return processFor([threadStarted("thread_1"), assistantMessage("listo"), turnCompleted({ input_tokens: 2, output_tokens: 1 })].join("\n"));
  };
  const destination = await mkdtemp(join(tmpdir(), "codex-service-home-"));
  try {
    const service = new CodexService(
      spawn,
      reporter(),
      async (profile, _operatorHome, home) => {
        await mkdir(join(home, "rules"), { recursive: true });
        await Bun.write(join(home, "rules", `${profile}.rules`), "rules");
        return home;
      },
      () => "/operator/.codex",
      () => destination,
    );

    await service.run({
      ...standardOptions,
      workingDirectory: "/repo",
      agent: { profile: "lazy-github-plan", configPath: "/rules/lazy-github-plan.rules" },
    });

    expect(commands[0]).toEqual([
      "codex",
      "-s",
      "danger-full-access",
      "--ask-for-approval",
      "never",
      "exec",
      "--json",
      "--model",
      "gpt-5.6-sol",
      "-c",
      "model_reasoning_effort=high",
      "planifica",
    ]);
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});

test("Codex normaliza el thread, texto final, razon, tokens y ausencia de costo", async () => {
  const service = new CodexService(() => processFor([
    threadStarted("thread_result"),
    event({ type: "item.started", item: { type: "reasoning", id: "r1" } }),
    event({ type: "item.updated", item: { type: "reasoning", id: "r1", text: "pienso" } }),
    assistantMessage("respuesta final"),
    turnCompleted({ total_tokens: 10, input_tokens: 6, cached_input_tokens: 4, output_tokens: 4, reasoning_output_tokens: 2 }, "completed"),
  ].join("\n")));

  const execution = await service.run(standardOptions);

  expect(execution.result.sessionId).toBe("thread_result");
  expect(execution.result.text).toBe("respuesta final");
  expect(execution.result.reason).toBe("completed");
  expect(execution.result.tokens).toEqual({
    total: 10,
    input: 6,
    output: 4,
    reasoning: 2,
    cache: { read: 4 },
  });
  expect(execution.result.cost).toBeUndefined();
  expect(execution.failed).toBeFalse();
});

test("Codex reporta texto como info, razonamiento y herramientas como debug y el detalle completo en trace", async () => {
  const captured: Captured = { info: [], warn: [], error: [], debug: [], trace: [] };
  const service = new CodexService(() => processFor([
    threadStarted("thread_report"),
    event({ type: "item.started", item: { type: "command_execution", command: "bun test", status: "in_progress" } }),
    event({ type: "item.completed", item: { type: "command_execution", command: "bun test", aggregated_output: "1 pass", status: "completed" } }),
    assistantMessage("avance"),
  ].join("\n")), reporter(captured));

  await service.run(standardOptions);

  expect(captured.info.some((line) => line.includes("Codex [sesion thread_report]: avance"))).toBeTrue();
  expect(captured.debug.some((line) => line.includes("herramienta command_execution") && line.includes("bun test"))).toBeTrue();
  expect(captured.trace.some((line) => line.includes("salida: 1 pass"))).toBeTrue();
  expect(captured.trace.some((line) => line.startsWith("Codex evento crudo: {"))).toBeTrue();
});

test("resume usa la forma propia de Codex y solo pasa los overrides declarados", async () => {
  const commands: string[][] = [];
  const service = new CodexService((command) => {
    commands.push(command);
    return processFor([threadStarted("thread_resume"), assistantMessage("ok")].join("\n"));
  });

  await service.resume("thread_resume", "continue", "/repo", undefined, { model: "gpt-5.6-pro", variant: "xhigh" });
  await service.resume("thread_resume");

  expect(commands[0]).toEqual([
    "codex",
    "-s",
    "danger-full-access",
    "--ask-for-approval",
    "never",
    "exec",
    "resume",
    "thread_resume",
    "--json",
    "--model",
    "gpt-5.6-pro",
    "-c",
    "model_reasoning_effort=xhigh",
    "continue",
  ]);
  expect(commands[1]).toEqual([
    "codex",
    "-s",
    "danger-full-access",
    "--ask-for-approval",
    "never",
    "exec",
    "resume",
    "thread_resume",
    "--json",
    "continue",
  ]);
});

test("un esfuerzo Codex invalido falla antes de abrir la sesion", async () => {
  let spawned = false;
  const service = new CodexService(() => {
    spawned = true;
    return processFor(threadStarted("never"));
  });

  await expect(service.run({ ...standardOptions, variant: "turbo" })).rejects.toThrow(/turbo/);
  expect(spawned).toBeFalse();
});

test("Codex clasifica solo las causas tipadas de agotamiento", async () => {
  const exhausted = new CodexService(() => processFor([
    threadStarted("thread_exhausted"),
    event({ type: "turn.failed", error: { codex_error_info: { code: "rate_limit_exceeded" } } }),
  ].join("\n"), "", 1));
  const ordinary = new CodexService(() => processFor([
    threadStarted("thread_ordinary"),
    event({ type: "turn.failed", error: { message: "usage_limit_exceeded" } }),
  ].join("\n"), "", 1));

  const exhaustedExecution = await exhausted.run(standardOptions);
  const ordinaryExecution = await ordinary.run(standardOptions);

  expect(exhaustedExecution.exhaustion).toEqual({
    cli: "Codex",
    model: standardOptions.model,
    cause: "rate_limit_exceeded",
  });
  expect(ordinaryExecution.exhaustion).toBeUndefined();
});

test("resume agotado lanza AgentExhaustionError y una sesion ausente lanza AgentSessionNotFoundError", async () => {
  const exhausted = new CodexService(() => processFor([
    threadStarted("thread_resume_exhausted"),
    event({ type: "turn.failed", error: { code: "session_budget_exceeded" } }),
  ].join("\n"), "", 1));
  const missing = new CodexService(() => processFor("", "thread missing not found", 1));

  await expect(exhausted.resume("thread_resume_exhausted")).rejects.toBeInstanceOf(AgentExhaustionError);
  await expect(missing.resume("missing")).rejects.toBeInstanceOf(AgentSessionNotFoundError);
});

test("Codex detecta az login y no ejecuta un cierre de sesion al recibir el marcador", async () => {
  const commands: string[][] = [];
  const service = new CodexService((command) => {
    commands.push(command);
    return processFor([
      threadStarted("thread_login"),
      event({ type: "item.completed", item: { type: "agent_message", text: "Please run az login --use-device-code" } }),
      assistantMessage("IMPLEMENTATION_READY"),
    ].join("\n"));
  });

  const execution = await service.run({ ...standardOptions, terminalMarker: "IMPLEMENTATION_READY" }, true);

  expect(execution.azureLoginRequired).toBeTrue();
  expect(commands).toHaveLength(1);
});
