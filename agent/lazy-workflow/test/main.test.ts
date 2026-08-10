import { expect, test } from "bun:test";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { HuInfo } from "../src/azure/hu-info.ts";
import { OpenCodeResult } from "../src/opencode/open-code-result.ts";
import { OpenCodeService, type OpenCodeRunOptions } from "../src/opencode/open-code-service.ts";

test("HuInfo expone sus campos", () => {
  const huInfo = new HuInfo({
    id: 23438,
    title: "Nueva HU",
    state: "New",
  });

  expect(huInfo.id).toBe(23438);
  expect(huInfo.title).toBe("Nueva HU");
  expect(huInfo.state).toBe("New");
});

test("el comando hu-info obtiene y muestra la HU solicitada", async () => {
  let requestedHu = 0;
  const huInfo = new HuInfo({ id: 12345, title: "HU de prueba" });
  const service = {
    getHuInfo: async (hu: number) => {
      requestedHu = hu;
      return huInfo;
    },
    waitForAccess: async () => undefined,
  };
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    await new LazyWorkflowCli(service).run(["hu-info", "--hu", "12345"]);
  } finally {
    console.log = originalLog;
  }

  expect(requestedHu).toBe(12345);
  expect(output).toEqual([JSON.stringify(huInfo, null, 2)]);
});

test("plan obtiene la HU y ejecuta el autoplan en ingles", async () => {
  const huInfo = new HuInfo({ id: 12345, title: "HU de prueba" });
  let requestedHu = 0;
  const received: { options: OpenCodeRunOptions | null; azure: boolean | null } = {
    options: null,
    azure: null,
  };
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: "ses_plan",
    part: { type: "text", text: "plan" },
  }));
  const huInfoService = {
    getHuInfo: async (hu: number) => {
      requestedHu = hu;
      return huInfo;
    },
    waitForAccess: async () => undefined,
  };
  const openCodeService = {
    run: async (options: OpenCodeRunOptions, azure: boolean) => {
      received.options = options;
      received.azure = azure;
      return { result, azureLoginRequired: false };
    },
    resume: async () => result,
  };
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    await new LazyWorkflowCli(huInfoService, openCodeService).run([
      "plan",
      "--hu",
      "12345",
      "--number-of-questions",
      "3",
      "--working-directory",
      "/repo",
      "--prompt",
      "pregunta",
    ]);
  } finally {
    console.log = originalLog;
  }

  expect(requestedHu).toBe(12345);
  expect(received.azure).toBeTrue();
  expect(received.options?.prompt).toContain("Do not implement code");
  expect(received.options?.prompt).toContain('"id":12345');
  expect(received.options?.prompt).toContain("3");
  expect(received.options?.prompt).toContain("/repo");
  expect(received.options?.prompt).toContain("pregunta");
  expect(output).toEqual([JSON.stringify(result, null, 2)]);
});

test.each([{ args: [] as string[] }, { args: ["unknown"] as string[] }])("subcomando %j muestra ayuda sin ejecutar servicios", async ({ args }) => {
  let azureCalls = 0;
  let openCodeCalls = 0;
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { azureCalls += 1; throw new Error("unexpected"); }, waitForAccess: async () => undefined },
      { run: async () => { openCodeCalls += 1; throw new Error("unexpected"); }, resume: async () => { throw new Error("unexpected"); } },
    ).run(args);

    expect(code).toBe(1);
  } finally {
    console.log = originalLog;
  }

  expect(azureCalls).toBe(0);
  expect(openCodeCalls).toBe(0);
  expect(output[0]).toContain("plan --hu <id>");
});

test("OpenCodeResult normaliza la salida JSONL", () => {
  const result = OpenCodeResult.fromJsonLines([
    JSON.stringify({
      type: "step_start",
      sessionID: "ses_test",
      part: { type: "step-start" },
    }),
    JSON.stringify({
      type: "text",
      sessionID: "ses_test",
      part: { type: "text", text: "4" },
    }),
    JSON.stringify({
      type: "step_finish",
      sessionID: "ses_test",
      part: {
        type: "step-finish",
        reason: "stop",
        tokens: { total: 10, input: 8, output: 1, reasoning: 1 },
        cost: 0.01,
      },
    }),
  ].join("\n"));

  expect(result.sessionId).toBe("ses_test");
  expect(result.text).toBe("4");
  expect(result.reason).toBe("stop");
  expect(result.tokens?.total).toBe(10);
  expect(result.cost).toBe(0.01);
});

test("plan imprime OpenCode con formato JSON legible", async () => {
  const result = OpenCodeResult.fromJsonLines(
    JSON.stringify({
      type: "text",
      sessionID: "ses_test",
      part: { type: "text", text: "respuesta" },
    }),
  );
  const receivedOptions: { value: OpenCodeRunOptions | null } = { value: null };
  let detectsAzureLogin: boolean | null = null;
  const service = {
    getHuInfo: async () => new HuInfo({ id: 12345, title: "HU de prueba" }),
    waitForAccess: async () => undefined,
  };
  const openCodeService = {
    run: async (options: OpenCodeRunOptions, detectAzureLogin: boolean) => {
      receivedOptions.value = options;
      detectsAzureLogin = detectAzureLogin;
      return { result, azureLoginRequired: false };
    },
    resume: async () => result,
  };
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    await new LazyWorkflowCli(service, openCodeService).run([
      "plan",
      "--hu",
      "12345",
      "--model",
      "modelo-test",
      "--prompt",
      "pregunta-test",
    ]);
  } finally {
    console.log = originalLog;
  }

  expect(receivedOptions.value?.model).toBe("modelo-test");
  expect(receivedOptions.value?.prompt).toContain("pregunta-test");
  expect(detectsAzureLogin).toBeTrue();
  expect(output).toEqual([JSON.stringify(result, null, 2)]);
});

test("espera el login Azure y reanuda la sesion OpenCode exactamente una vez", async () => {
  const blocked = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "step_start",
    sessionID: "ses_blocked",
    part: { type: "tool", tool: "bash", input: { command: "az login --use-device-code" } },
  }));
  const completed = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: "ses_blocked",
    part: { type: "text", text: "continuado" },
  }));
  const resumeCalls: string[] = [];
  const openCodeService = {
    run: async () => ({ result: blocked, azureLoginRequired: true }),
    resume: async (sessionId: string) => {
      resumeCalls.push(sessionId);
      return completed;
    },
  };
  let waitCalls = 0;
  const huInfoService = {
    getHuInfo: async () => new HuInfo({ id: 12345, title: "HU de prueba" }),
    waitForAccess: async () => { waitCalls += 1; },
  };
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    await new LazyWorkflowCli(huInfoService, openCodeService).run([
      "plan",
      "--hu",
      "12345",
      "--working-directory",
      "/repo",
    ]);
  } finally {
    console.log = originalLog;
  }

  expect(resumeCalls).toEqual(["ses_blocked"]);
  expect(waitCalls).toBe(1);
  expect(output).toEqual([JSON.stringify(completed, null, 2)]);
});

test("OpenCode solo detecta az login para flujos Azure y conserva la sesion", async () => {
  const commands: string[][] = [];
  let kills = 0;
  const output = [
    JSON.stringify({ type: "session", sessionID: "ses_stream" }),
    JSON.stringify({
      type: "step_start",
      sessionID: "ses_stream",
      part: { type: "tool", tool: "bash", input: { command: "az login --use-device-code" } },
    }),
  ].join("\n");
  const service = new OpenCodeService((command) => {
    commands.push(command);
    return {
      stdout: new Blob([output]).stream(),
      stderr: new Blob([]).stream(),
      exited: Promise.resolve(0),
      kill: () => { kills += 1; },
    };
  });

  const options = {
    model: "provider/model",
    variant: "high",
    session: null,
    prompt: "planifica",
  };

  const genericExecution = await service.run(options);
  const azureExecution = await service.run(options, true);

  expect(genericExecution.azureLoginRequired).toBeFalse();
  expect(azureExecution.azureLoginRequired).toBeTrue();
  expect(azureExecution.result.sessionId).toBe("ses_stream");
  expect(kills).toBe(1);
  expect(commands).toHaveLength(2);
});

test("resume usa una sola invocacion simple con continue", async () => {
  const commands: string[][] = [];
  const service = new OpenCodeService((command) => {
    commands.push(command);
    return {
      stdout: new Blob([JSON.stringify({
        type: "text",
        sessionID: "ses_resume",
        part: { type: "text", text: "ok" },
      })]).stream(),
      stderr: new Blob([]).stream(),
      exited: Promise.resolve(0),
      kill: () => undefined,
    };
  });

  const result = await service.resume("ses_resume");

  expect(result.text).toBe("ok");
  expect(commands).toEqual([[
    "opencode",
    "run",
    "--auto",
    "--session",
    "ses_resume",
    "--format",
    "json",
    "continue",
  ]]);
});
