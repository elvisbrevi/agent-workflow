import { expect, test } from "bun:test";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { HuInfo } from "../src/azure/hu-info.ts";
import type { AutocodeContext } from "../src/azure/autocode-service.ts";
import { OpenCodeResult } from "../src/opencode/open-code-result.ts";
import { OpenCodeService, type OpenCodeRunOptions } from "../src/opencode/open-code-service.ts";
import type { AutocodeCheckpoint, AutocodeCheckpointStore } from "../src/azure/autocode-checkpoint.ts";

const emptyCheckpointStore = (): AutocodeCheckpointStore => ({
  read: async () => null,
  write: async () => undefined,
  clear: async () => undefined,
});

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

test("code entrega un ticket y solo avanza después de la verificación Azure", async () => {
  const contexts: Array<AutocodeContext | null> = [
    {
      hu: { id: 23438, title: "HU" },
      ticket: { id: 51, title: "Implementar", type: "Task" },
      integrationBranch: "refs/heads/hu/23438",
    },
    null,
  ];
  const prompts: string[] = [];
  const verified: number[] = [];
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: "ses_code",
    part: { type: "text", text: "TICKET_COMPLETED" },
  }));
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    const code = await new LazyWorkflowCli(
      {
        getHuInfo: async () => new HuInfo({ id: 23438, title: "HU" }),
        waitForAccess: async () => undefined,
        ensureIntegrationBranch: async () => "refs/heads/hu/23438",
        getAutocodeContext: async () => contexts.shift() ?? null,
        verifyTicketCompletion: async (context) => { verified.push(context.ticket.id); return true; },
      },
      {
        run: async (options) => { prompts.push(options.prompt); return { result, azureLoginRequired: false }; },
        resume: async () => result,
      },
      emptyCheckpointStore(),
    ).run(["code", "--hu", "23438", "--working-directory", "/repo"]);

    expect(code).toBe(0);
  } finally {
    console.log = originalLog;
  }

  expect(verified).toEqual([51]);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("one Azure delivery ticket");
  expect(prompts[0]).toContain("/implement");
  expect(prompts[0]).toContain("/ponytail");
  expect(prompts[0]).toContain("/tdd");
  expect(prompts[0]).toContain("/code-review");
  expect(prompts[0]).toContain("refs/heads/hu/23438");
  expect(output).toEqual([JSON.stringify(result, null, 2)]);
});

test("code no avanza con un marcador sin evidencia Azure completa", async () => {
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text", sessionID: "ses_code", part: { type: "text", text: "TICKET_COMPLETED" },
  }));
  let verificationCalls = 0;
  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async () => "refs/heads/hu/23438",
      getAutocodeContext: async () => ({ hu: { id: 23438 }, ticket: { id: 51, title: "T", type: "Bug" }, integrationBranch: "refs/heads/hu/23438" }),
      verifyTicketCompletion: async () => { verificationCalls += 1; return false; },
    },
    { run: async () => ({ result, azureLoginRequired: false }), resume: async () => result },
    emptyCheckpointStore(),
    { wait: async () => { throw new Error("stop retry"); } },
  ).run(["code", "--hu", "23438"]);

  expect(code).toBe(1);
  expect(verificationCalls).toBe(1);
});

test.each([
  ["existing branch", "", "refs/heads/hu/existing"],
  ["prompt branch", "Use source branch feature/custom", "refs/heads/hu/from-prompt"],
  ["main fallback", "", "refs/heads/hu/from-main"],
  ["master fallback", "", "refs/heads/hu/from-master"],
])("code bootstraps the HU integration branch through the public CLI seam: %s", async (_name, prompt, branch) => {
  let ensuredPrompt = "";
  let contextBranch = "";
  let openCodeCalls = 0;
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text", sessionID: "ses_code", part: { type: "text", text: "not-complete" },
  }));
  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async (_hu, receivedPrompt) => { ensuredPrompt = receivedPrompt; return branch; },
      getAutocodeContext: async (_hu, integrationBranch) => {
        contextBranch = integrationBranch ?? "";
        return { hu: { id: 23438 }, ticket: { id: 51, type: "Task" }, integrationBranch: contextBranch };
      },
      verifyTicketCompletion: async () => false,
    },
    { run: async () => { openCodeCalls += 1; return { result, azureLoginRequired: false }; }, resume: async () => result },
    emptyCheckpointStore(),
    { wait: async () => { throw new Error("stop retry"); } },
  ).run(["code", "--hu", "23438", "--prompt", prompt]);

  expect(code).toBe(1);
  expect(ensuredPrompt).toBe(prompt);
  expect(contextBranch).toBe(branch);
  expect(openCodeCalls).toBe(1);
});

test("code stays incomplete and does not invoke OpenCode without a valid source branch", async () => {
  let openCodeCalls = 0;
  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async () => null,
      getAutocodeContext: async () => { throw new Error("must not select a ticket"); },
      verifyTicketCompletion: async () => false,
    },
    { run: async () => { openCodeCalls += 1; throw new Error("must not run"); }, resume: async () => { throw new Error("must not resume"); } },
    emptyCheckpointStore(),
    { wait: async () => { throw new Error("stop retry"); } },
  ).run(["code", "--hu", "23438"]);

  expect(code).toBe(1);
  expect(openCodeCalls).toBe(0);
});

test("code conserva el ticket, espera diez segundos y reanuda la misma sesion con el prompt indicado", async () => {
  const checkpoint: AutocodeCheckpoint = { workflow: "autocode", hu: 23438, ticket: 51, sessionId: null };
  const store: AutocodeCheckpointStore = {
    read: async () => checkpoint.sessionId ? checkpoint : null,
    write: async (value) => { Object.assign(checkpoint, value); },
    clear: async () => { checkpoint.sessionId = null; },
  };
  const result = (text: string) => OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text", sessionID: "ses_retry", part: { type: "text", text },
  }));
  const resumed: Array<[string, string]> = [];
  const waits: number[] = [];
  let attempts = 0;
  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async () => "refs/heads/hu/23438",
      getAutocodeContext: async () => ({ hu: { id: 23438 }, ticket: { id: 51, type: "Task" }, integrationBranch: "refs/heads/hu/23438" }),
      verifyTicketCompletion: async () => true,
    },
    {
      run: async () => { attempts += 1; return { result: result("not-complete"), azureLoginRequired: false, failed: true }; },
      resume: async (sessionId: string, prompt?: string) => { resumed.push([sessionId, prompt ?? ""]); return result("TICKET_COMPLETED"); },
    },
    store,
    { wait: async (milliseconds) => { waits.push(milliseconds); } },
  ).run(["code", "--hu", "23438", "--prompt", "continua con la rama corregida"]);

  expect(code).toBe(0);
  expect(attempts).toBe(1);
  expect(waits).toEqual([10_000]);
  expect(resumed).toEqual([["ses_retry", "continua con la rama corregida"]]);
  expect(checkpoint.sessionId).toBeNull();
});

test("code --session rechaza un checkpoint de otra sesion sin tocar Azure", async () => {
  const store: AutocodeCheckpointStore = {
    read: async () => ({ workflow: "autocode", hu: 23438, ticket: 51, sessionId: "ses-real" }),
    write: async () => undefined,
    clear: async () => undefined,
  };
  let calls = 0;
  const code = await new LazyWorkflowCli(
    { getHuInfo: async () => { calls += 1; throw new Error("unexpected"); }, waitForAccess: async () => undefined },
    { run: async () => { calls += 1; throw new Error("unexpected"); }, resume: async () => { calls += 1; throw new Error("unexpected"); } },
    store,
  ).run(["code", "--session", "ses-otro", "--prompt", "continue"]);

  expect(code).toBe(1);
  expect(calls).toBe(0);
});
