import { expect, test } from "bun:test";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { HuInfo } from "../src/azure/hu-info.ts";
import {
  AzureAutocodeService,
  COMPLETION_GATE,
  type AutocodeContext,
  type AutocodeState,
  type IncompleteTicketCompletion,
} from "../src/azure/autocode-service.ts";
import { OpenCodeResult } from "../src/opencode/open-code-result.ts";
import { OpenCodeService, OpenCodeSessionCloseError, type OpenCodeRunOptions } from "../src/opencode/open-code-service.ts";
import type { AutocodeCheckpoint, AutocodeCheckpointStore } from "../src/azure/autocode-checkpoint.ts";
import { operatorLine } from "../src/output/operator-output.ts";
import { GitTicketBranchCleaner } from "../src/git/git-ticket-branch-cleaner.ts";

const emptyCheckpointStore = (): AutocodeCheckpointStore => ({
  read: async () => null,
  write: async () => undefined,
  clear: async () => undefined,
});

test("las salidas operativas incluyen fecha y hora local con segundos", () => {
  const date = new Date(2026, 7, 10, 16, 23, 5);

  expect(operatorLine("avance", date)).toBe("[10/08/26 16:23:05] avance");
  expect(operatorLine("uno\ndos", date)).toBe([
    "[10/08/26 16:23:05] uno",
    "[10/08/26 16:23:05] dos",
  ].join("\n"));
});

test("Azure usa el vínculo Branch nativo de la HU como rama de integración", async () => {
  const commands: string[][] = [];
  const service = new AzureAutocodeService(async (args) => {
    commands.push(args);
    return JSON.stringify({
      id: 23438,
      relations: [{
        rel: "ArtifactLink",
        url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBhu%2F23438",
        attributes: { name: "Branch" },
      }],
    });
  });

  expect(await service.ensureIntegrationBranch(23438)).toBe("refs/heads/hu/23438");
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain("--expand");
  expect(commands[0]).not.toContain("update");
  expect(commands[0]).not.toContain("Custom.IntegrationBranch");
});

test("Azure consulta la rama nativa de la HU y normaliza su ref", async () => {
  const commands: string[][] = [];
  const service = new AzureAutocodeService(async (args) => {
    commands.push(args);
    return JSON.stringify({
      id: 23438,
      relations: [{
        rel: "ArtifactLink",
        url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBfeature%2Fhu-23438",
        attributes: { name: "Branch" },
      }],
    });
  });

  expect(await service.getIntegrationBranchInfo(23438)).toEqual({
    hu: 23438,
    branch: "refs/heads/feature/hu-23438",
  });
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain("--expand");
});

test("Azure representa la ausencia de Branch ArtifactLink como null", async () => {
  const service = new AzureAutocodeService(async () => JSON.stringify({ id: 23438, relations: [] }));

  expect(await service.getIntegrationBranchInfo(23438)).toEqual({ hu: 23438, branch: null });
});

test("Azure rechaza URI de rama malformada y ramas nativas ambiguas", async () => {
  const malformed = new AzureAutocodeService(async () => JSON.stringify({
    id: 23438,
    relations: [{ rel: "ArtifactLink", url: "vstfs:///Git/Ref/not-a-branch", attributes: { name: "Branch" } }],
  }));
  await expect(malformed.getIntegrationBranchInfo(23438)).rejects.toThrow("malformada");

  const ambiguous = new AzureAutocodeService(async () => JSON.stringify({
    id: 23438,
    relations: [
      { rel: "ArtifactLink", url: "vstfs:///Git/Ref/project%2Frepo%2FGBhu%2F23438", attributes: { name: "Branch" } },
      { rel: "ArtifactLink", url: "vstfs:///Git/Ref/project%2Frepo%2FGBhu%2Fother", attributes: { name: "Branch" } },
    ],
  }));
  await expect(ambiguous.getIntegrationBranchInfo(23438)).rejects.toThrow("multiples");
});

test("Azure propone la rama HU sin escribir un campo personalizado cuando aún no está vinculada", async () => {
  const commands: string[][] = [];
  const service = new AzureAutocodeService(async (args) => {
    commands.push(args);
    return JSON.stringify({ id: 23438, relations: [] });
  });

  expect(await service.ensureIntegrationBranch(23438)).toBe("refs/heads/hu/23438");
  expect(commands).toHaveLength(1);
  expect(commands[0]).not.toContain("update");
});

test("Azure obtiene la rama exacta del único PR completado del ticket", async () => {
  let includeCommitLink = true;
  let includePrLink = true;
  const service = new AzureAutocodeService(async (args) => {
    if (args[0] === "boards" && args.includes("51")) {
      return JSON.stringify({
        id: 51,
        fields: {
          "System.State": "Done",
          "Custom.b505c83e-3745-4d8b-b76b-b3086a0c4c71": "evidencia verificada",
          "Custom.EsfuerzoReal": 8,
          "Custom.EsfuerzoRealHH": 8,
          "Custom.URLCommit": "https://example.test/commit/abc123",
        },
        relations: [
          { rel: "AttachedFile", attributes: { name: "evidencia.json" } },
          ...(includeCommitLink ? [{
            rel: "ArtifactLink",
            url: "vstfs:///Git/Commit/project-id%2Frepository-id%2Fmerge-commit",
            attributes: { name: "Fixed in Commit" },
          }] : []),
        ],
      });
    }
    if (args[0] === "boards" && args.includes("23438")) {
      return JSON.stringify({
        id: 23438,
        relations: [{
          rel: "ArtifactLink",
          url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBhu%2F23438",
          attributes: { name: "Branch" },
        }],
      });
    }
    if (args[0] === "repos") {
      if (args.includes("work-item")) return JSON.stringify(includePrLink ? [51] : []);
      return JSON.stringify([
        {
          status: "completed",
          mergeStatus: "succeeded",
          target: "refs/heads/hu/23438",
          source: "refs/heads/ticket/51-programas",
          id: 4499,
          projectId: "project-id",
          repositoryId: "repository-id",
          mergeCommit: "merge-commit",
        },
        {
          status: "completed",
          mergeStatus: "succeeded",
          target: "refs/heads/hu/23438",
          source: "refs/heads/ticket/151-no-corresponde",
        },
      ]);
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });
  const context: AutocodeContext = {
    hu: { id: 23438 },
    ticket: { id: 51, type: "Task" },
    integrationBranch: "refs/heads/hu/23438",
  };

  expect(await service.verifyTicketCompletion(context)).toEqual({
    ticketBranch: "refs/heads/ticket/51-programas",
  });
  expect(await service.getCompletedTicketBranch(context)).toBe("refs/heads/ticket/51-programas");
  includeCommitLink = false;
  expect(await service.verifyTicketCompletion(context)).toEqual({
    ticketId: 51,
    unmetGates: [COMPLETION_GATE.mergeCommitArtifact],
  });
  includeCommitLink = true;
  includePrLink = false;
  expect(await service.verifyTicketCompletion(context)).toEqual({
    ticketId: 51,
    unmetGates: [COMPLETION_GATE.nativePullRequestAssociation],
  });
});

test("Azure acumula todos los gates determinables de una verificacion incompleta", async () => {
  const service = new AzureAutocodeService(async (args) => {
    if (args[0] === "boards" && args.includes("51")) {
      return JSON.stringify({ id: 51, fields: { "System.State": "Active" }, relations: [] });
    }
    if (args[0] === "boards" && args.includes("23438")) {
      return JSON.stringify({ id: 23438, relations: [] });
    }
    if (args[0] === "repos") return JSON.stringify([]);
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  const result = await service.verifyTicketCompletion({
    hu: { id: 23438 },
    ticket: { id: 51, type: "Task" },
    integrationBranch: "refs/heads/hu/23438",
  });

  expect(result).toEqual({
    ticketId: 51,
    unmetGates: [
      COMPLETION_GATE.ticketState,
      COMPLETION_GATE.completionEvidence,
      COMPLETION_GATE.realEffort,
      COMPLETION_GATE.realEffortHours,
      COMPLETION_GATE.commitUrl,
      COMPLETION_GATE.attachedCapture,
      COMPLETION_GATE.huIntegrationBranch,
      COMPLETION_GATE.completedHuPullRequest,
    ],
  });
});

test("Git cambia a la rama HU actualizada y elimina la rama del ticket local y remota", async () => {
  const commands: string[][] = [];
  const cleaner = new GitTicketBranchCleaner(async (args) => {
    commands.push(args);
    if (args[0] === "status") return "";
    if (args[0] === "branch" && args[1] === "--list") return "  ticket/51-programas\n";
    if (args[0] === "ls-remote") return "abc123\trefs/heads/ticket/51-programas\n";
    return "";
  });

  await cleaner.deleteTicketBranch(
    "refs/heads/ticket/51-programas",
    "refs/heads/hu/23438",
    "/repo",
  );

  expect(commands).toEqual([
    ["status", "--porcelain"],
    ["fetch", "origin", "+refs/heads/hu/23438:refs/remotes/origin/hu/23438"],
    ["switch", "hu/23438"],
    ["merge", "--ff-only", "origin/hu/23438"],
    ["branch", "--list", "ticket/51-programas"],
    ["branch", "-D", "ticket/51-programas"],
    ["ls-remote", "--heads", "origin", "refs/heads/ticket/51-programas"],
    ["push", "origin", "--delete", "ticket/51-programas"],
  ]);
});

test("Git no elimina ramas cuando el repositorio tiene cambios locales", async () => {
  const commands: string[][] = [];
  const cleaner = new GitTicketBranchCleaner(async (args) => {
    commands.push(args);
    return "?? evidencia-local.png\n";
  });

  await expect(cleaner.deleteTicketBranch(
    "refs/heads/ticket/51-programas",
    "refs/heads/hu/23438",
    "/repo",
  )).rejects.toThrow("cambios sin guardar");
  expect(commands).toEqual([["status", "--porcelain"]]);
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

test("el comando hu-branch-info imprime una consulta JSON y no inicia OpenCode", async () => {
  const output: string[] = [];
  let openCodeCalls = 0;
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    const result = await new LazyWorkflowCli(
      {
        getHuInfo: async () => new HuInfo({ id: 23438 }),
        waitForAccess: async () => undefined,
        getIntegrationBranchInfo: async (hu) => ({ hu, branch: "refs/heads/hu/23438" }),
      },
      {
        run: async () => { openCodeCalls += 1; throw new Error("no debe ejecutarse"); },
        resume: async () => { openCodeCalls += 1; throw new Error("no debe ejecutarse"); },
      },
    ).run(["hu-branch-info", "--hu", "23438"]);

    expect(result).toBe(0);
  } finally {
    console.log = originalLog;
  }

  expect(output).toEqual([JSON.stringify({ hu: 23438, branch: "refs/heads/hu/23438" }, null, 2)]);
  expect(openCodeCalls).toBe(0);
});

test("hu-branch-info rechaza un HU inválido sin consultar Azure", async () => {
  let calls = 0;
  const result = await new LazyWorkflowCli({
    getHuInfo: async () => new HuInfo({ id: 1 }),
    waitForAccess: async () => undefined,
    getIntegrationBranchInfo: async () => { calls += 1; return { hu: 1, branch: null }; },
  }).run(["hu-branch-info", "--hu", "abc"]);

  expect(result).toBe(1);
  expect(calls).toBe(0);
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
  expect(output[0]).toContain("code --session <id> --prompt continue");
  expect(output[0]).toContain("--session <id>");
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
      type: "tool_use",
      sessionID: "ses_stream",
      part: { type: "tool", tool: "bash", state: { status: "running", input: { command: "az login --use-device-code" } } },
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

test("OpenCode transmite eventos y usa el working directory solicitado", async () => {
  const reports: string[] = [];
  let spawnOptions: { cwd?: string } | undefined;
  const output = [
    JSON.stringify({ type: "session", sessionID: "ses_visible" }),
    JSON.stringify({
      type: "tool_use",
      sessionID: "ses_visible",
      part: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "git status --short" } } },
    }),
    JSON.stringify({ type: "reasoning", sessionID: "ses_visible", part: { type: "reasoning", text: "Revisando árbol" } }),
    JSON.stringify({ type: "text", sessionID: "ses_visible", part: { type: "text", text: "avance" } }),
  ].join("\n");
  const service = new OpenCodeService((_, options) => {
    spawnOptions = options;
    return {
      stdout: new Blob([output]).stream(),
      stderr: new Blob(["transport listo\n"]).stream(),
      exited: Promise.resolve(0),
      kill: () => undefined,
    };
  }, (message) => reports.push(message));

  const result = await service.run({
    model: "provider/model",
    variant: "medium",
    session: null,
    prompt: "trabaja",
    workingDirectory: "/repo/objetivo",
  });

  expect(result.result.text).toBe("avance");
  expect(spawnOptions).toEqual({ cwd: "/repo/objetivo" });
  expect(reports).toContain('OpenCode [sesión ses_visible] herramienta bash (completed): "git status --short"');
  expect(reports).toContain("OpenCode [sesión ses_visible] razonando: Revisando árbol");
  expect(reports).toContain("OpenCode [sesión ses_visible]: avance");
  expect(reports).toContain("OpenCode stderr: transport listo");
});

test("OpenCode termina al recibir el marcador aunque stdout permanezca abierto", async () => {
  const encoder = new TextEncoder();
  let closeStdout: () => void = () => undefined;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      closeStdout = () => controller.close();
      controller.enqueue(encoder.encode(`${JSON.stringify({
        type: "text",
        sessionID: "ses_terminal",
        part: { type: "text", text: "Trabajo completado.\n\nTICKET_COMPLETED" },
      })}\n`));
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
    model: "provider/model",
    variant: "medium",
    session: null,
    prompt: "trabaja",
    terminalMarker: "TICKET_COMPLETED",
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
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect((await execution).failed).toBeFalse();
});

test("OpenCode cierra la sesion nativa al recibir el marcador", async () => {
  const commands: string[][] = [];
  const service = new OpenCodeService((command) => {
    commands.push(command);
    const output = command[1] === "session"
      ? ""
      : JSON.stringify({
        type: "text",
        sessionID: "ses_closed",
        part: { type: "text", text: "TICKET_COMPLETED" },
      });
    return {
      stdout: new Blob([output]).stream(),
      stderr: new Blob([]).stream(),
      exited: Promise.resolve(0),
      kill: () => undefined,
    };
  });

  await service.run({
    model: "provider/model",
    variant: "medium",
    session: null,
    prompt: "trabaja",
    terminalMarker: "TICKET_COMPLETED",
  }, true);

  expect(commands[1]).toEqual(["opencode", "session", "delete", "ses_closed"]);
});

test("OpenCode acepta de forma idempotente una sesion ausente sin alterar su identificador", async () => {
  const sessionId = "ses;opaque";
  const commands: string[][] = [];
  const service = new OpenCodeService((command) => {
    commands.push(command);
    const deleting = command[1] === "session";
    return {
      stdout: new Blob([deleting ? "" : JSON.stringify({
        type: "text",
        sessionID: sessionId,
        part: { type: "text", text: "TICKET_COMPLETED" },
      })]).stream(),
      stderr: new Blob([deleting ? `Session ${sessionId} not found` : ""]).stream(),
      exited: Promise.resolve(deleting ? 1 : 0),
      kill: () => undefined,
    };
  });

  await service.run({
    model: "provider/model",
    variant: "medium",
    session: null,
    prompt: "trabaja",
    terminalMarker: "TICKET_COMPLETED",
  }, true);

  expect(commands[1]).toEqual(["opencode", "session", "delete", sessionId]);
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
    "--thinking",
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
    part: { type: "text", text: "Resumen final\n\nTICKET_COMPLETED" },
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
        verifyTicketCompletion: async (context) => {
          verified.push(context.ticket.id);
          return { ticketBranch: `refs/heads/ticket/${context.ticket.id}` };
        },
        getCompletedTicketBranch: async (context) => `refs/heads/ticket/${context.ticket.id}`,
      },
      {
        run: async (options) => { prompts.push(options.prompt); return { result, azureLoginRequired: false }; },
        resume: async () => result,
      },
      emptyCheckpointStore(),
      undefined,
      { deleteTicketBranch: async () => undefined },
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
  expect(prompts[0]).toContain("operator's instruction");
  expect(prompts[0]).toContain("If the operator did not specify a base branch");
  expect(prompts[0]).toContain("native PR work-item association");
  expect(prompts[0]).toContain("exact merge commit as a native `ArtifactLink`");
  expect(output).toEqual([JSON.stringify(result, null, 2)]);
});

test("code drena tickets con sesiones nuevas y refresca Azure entre tickets", async () => {
  const contexts: Array<AutocodeState> = [
    { context: { hu: { id: 23438 }, ticket: { id: 51, type: "Task" }, integrationBranch: "refs/heads/hu/23438" }, pending: true },
    { context: { hu: { id: 23438 }, ticket: { id: 52, type: "Bug" }, integrationBranch: "refs/heads/hu/23438" }, pending: true },
    { context: null, pending: false },
  ];
  const sessions: string[] = [];
  const cleanedBranches: Array<[string, string, string]> = [];
  const checkpoints: Array<AutocodeCheckpoint | "clear"> = [];
  const store: AutocodeCheckpointStore = {
    read: async () => null,
    write: async (checkpoint) => { checkpoints.push(checkpoint); },
    clear: async () => { checkpoints.push("clear"); },
  };
  const result = (sessionId: string) => OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text", sessionID: sessionId, part: { type: "text", text: "TICKET_COMPLETED" },
  }));

  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async () => "refs/heads/hu/23438",
      getAutocodeState: async () => contexts.shift()!,
      getAutocodeContext: async () => { throw new Error("must use queue state"); },
      verifyTicketCompletion: async (context) => ({ ticketBranch: `refs/heads/ticket/${context.ticket.id}` }),
      getCompletedTicketBranch: async (context) => `refs/heads/ticket/${context.ticket.id}`,
    },
    {
      run: async () => {
        const sessionId = `ses-${sessions.length + 1}`;
        sessions.push(sessionId);
        return { result: result(sessionId), azureLoginRequired: false };
      },
      resume: async () => { throw new Error("must not resume another ticket"); },
    },
    store,
    undefined,
    {
      deleteTicketBranch: async (ticketBranch, integrationBranch, workingDirectory) => {
        cleanedBranches.push([ticketBranch, integrationBranch, workingDirectory]);
      },
    },
  ).run(["code", "--hu", "23438"]);

  expect(code).toBe(0);
  expect(sessions).toEqual(["ses-1", "ses-2"]);
  expect(checkpoints.map((value) => value === "clear" ? "clear" : value.ticket)).toEqual([
    51, 51, "clear", 52, 52, "clear",
  ]);
  expect(cleanedBranches).toEqual([
    ["refs/heads/ticket/51", "refs/heads/hu/23438", process.cwd()],
    ["refs/heads/ticket/52", "refs/heads/hu/23438", process.cwd()],
  ]);
});

test("code espera y refresca cuando quedan tickets bloqueados", async () => {
  const states: AutocodeState[] = [
    { context: null, pending: true },
    { context: { hu: { id: 23438 }, ticket: { id: 51, type: "Task" }, integrationBranch: "refs/heads/hu/23438" }, pending: true },
    { context: null, pending: false },
  ];
  const waits: number[] = [];
  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async () => "refs/heads/hu/23438",
      getAutocodeState: async () => states.shift()!,
      getAutocodeContext: async () => { throw new Error("must use queue state"); },
      verifyTicketCompletion: async (context) => ({ ticketBranch: `refs/heads/ticket/${context.ticket.id}` }),
      getCompletedTicketBranch: async (context) => `refs/heads/ticket/${context.ticket.id}`,
    },
    {
      run: async () => ({ result: OpenCodeResult.fromJsonLines(JSON.stringify({
        type: "text", sessionID: "ses-1", part: { type: "text", text: "TICKET_COMPLETED" },
      })), azureLoginRequired: false }),
      resume: async () => { throw new Error("must not resume"); },
    },
    emptyCheckpointStore(),
    { wait: async (milliseconds) => { waits.push(milliseconds); } },
    { deleteTicketBranch: async () => undefined },
  ).run(["code", "--hu", "23438"]);

  expect(code).toBe(0);
  expect(waits).toEqual([10_000]);
});

test("code no avanza con un marcador sin evidencia Azure completa", async () => {
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text", sessionID: "ses_code", part: { type: "text", text: "TICKET_COMPLETED" },
  }));
  let verificationCalls = 0;
  let checkpointSessionId: string | null | undefined;
  let waits = 0;
  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async () => "refs/heads/hu/23438",
      getAutocodeContext: async () => ({ hu: { id: 23438 }, ticket: { id: 51, title: "T", type: "Bug" }, integrationBranch: "refs/heads/hu/23438" }),
      verifyTicketCompletion: async () => { verificationCalls += 1; return null; },
    },
    { run: async () => ({ result, azureLoginRequired: false }), resume: async () => { throw new Error("must not resume"); } },
    {
      read: async () => null,
      write: async (value) => { checkpointSessionId = value.sessionId; },
      clear: async () => { throw new Error("must preserve checkpoint"); },
    },
    { wait: async () => { waits += 1; } },
  ).run(["code", "--hu", "23438"]);

  expect(code).toBe(1);
  expect(verificationCalls).toBe(1);
  expect(waits).toBe(0);
  expect(checkpointSessionId).toBeNull();
});

test("code reconcilia y reporta todos los gates incumplidos sin avanzar", async () => {
  const checkpoint: AutocodeCheckpoint = {
    workflow: "autocode",
    hu: 23438,
    ticket: 51,
    sessionId: null,
  };
  const incomplete: IncompleteTicketCompletion = {
    ticketId: 51,
    unmetGates: [
      COMPLETION_GATE.ticketState,
      COMPLETION_GATE.completionEvidence,
      COMPLETION_GATE.nativePullRequestAssociation,
    ],
  };
  const messages: string[] = [];
  let openCodeCalls = 0;
  let cleanupCalls = 0;
  let clearCalls = 0;
  const originalError = console.error;
  console.error = (...values: unknown[]) => messages.push(values.join(" "));

  try {
    const code = await new LazyWorkflowCli(
      {
        getHuInfo: async () => new HuInfo({ id: 23438 }),
        waitForAccess: async () => undefined,
        ensureIntegrationBranch: async () => "refs/heads/hu/23438",
        getAutocodeContext: async () => null,
        getAutocodeContextForTicket: async () => ({
          hu: { id: 23438 },
          ticket: { id: 51, type: "Task" },
          integrationBranch: "refs/heads/hu/23438",
        }),
        verifyTicketCompletion: async () => incomplete,
      },
      {
        run: async () => { openCodeCalls += 1; throw new Error("must not run"); },
        resume: async () => { openCodeCalls += 1; throw new Error("must not resume"); },
      },
      {
        read: async () => checkpoint,
        write: async () => undefined,
        clear: async () => { clearCalls += 1; },
      },
      undefined,
      { deleteTicketBranch: async () => { cleanupCalls += 1; } },
    ).run(["code", "--hu", "23438"]);

    expect(code).toBe(1);
  } finally {
    console.error = originalError;
  }

  expect(messages.join("\n")).toContain("ticket 51");
  expect(messages.join("\n")).toContain("ticket-state");
  expect(messages.join("\n")).toContain("completion-evidence");
  expect(messages.join("\n")).toContain("native-pr-association");
  expect(openCodeCalls).toBe(0);
  expect(cleanupCalls).toBe(0);
  expect(clearCalls).toBe(0);
  expect(checkpoint).toEqual({ workflow: "autocode", hu: 23438, ticket: 51, sessionId: null });
});

test("code reporta cuando ya no puede reconstruir el ticket fijado", async () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => messages.push(values.join(" "));

  try {
    const code = await new LazyWorkflowCli(
      {
        getHuInfo: async () => new HuInfo({ id: 23438 }),
        waitForAccess: async () => undefined,
        ensureIntegrationBranch: async () => "refs/heads/hu/23438",
        getAutocodeContext: async () => null,
        getAutocodeContextForTicket: async () => null,
        verifyTicketCompletion: async () => { throw new Error("must not verify"); },
      },
      {
        run: async () => { throw new Error("must not run"); },
        resume: async () => { throw new Error("must not resume"); },
      },
      {
        read: async () => ({ workflow: "autocode", hu: 23438, ticket: 51, sessionId: null }),
        write: async () => undefined,
        clear: async () => { throw new Error("must preserve checkpoint"); },
      },
    ).run(["code", "--hu", "23438"]);

    expect(code).toBe(1);
  } finally {
    console.error = originalError;
  }

  expect(messages.join("\n")).toContain("pinned-ticket-context");
  expect(messages.join("\n")).not.toContain("cierre verificable");
});

test("code reintenta el mismo checkpoint tras corregir Azure y limpia una sola vez", async () => {
  const checkpoint: AutocodeCheckpoint = {
    workflow: "autocode",
    hu: 23438,
    ticket: 51,
    sessionId: null,
  };
  const verifications = [
    {
      ticketId: 51,
      unmetGates: [COMPLETION_GATE.completionEvidence],
    },
    { ticketBranch: "refs/heads/ticket/51" },
  ];
  let checkpointCleared = false;
  let openCodeCalls = 0;
  let cleanupCalls = 0;
  const store: AutocodeCheckpointStore = {
    read: async () => checkpointCleared ? null : checkpoint,
    write: async () => undefined,
    clear: async () => { checkpointCleared = true; },
  };
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => messages.push(values.join(" "));
  const services = {
    getHuInfo: async () => new HuInfo({ id: 23438 }),
    waitForAccess: async () => undefined,
    ensureIntegrationBranch: async () => "refs/heads/hu/23438",
    getAutocodeContextForTicket: async () => ({
      hu: { id: 23438 },
      ticket: { id: 51, type: "Task" as const },
      integrationBranch: "refs/heads/hu/23438",
    }),
    getAutocodeContext: async () => null,
    verifyTicketCompletion: async () => verifications.shift()!,
  };
  const cli = new LazyWorkflowCli(
    services,
    {
      run: async () => { openCodeCalls += 1; throw new Error("must not run"); },
      resume: async () => { openCodeCalls += 1; throw new Error("must not resume"); },
    },
    store,
    undefined,
    { deleteTicketBranch: async () => { cleanupCalls += 1; } },
  );

  try {
    expect(await cli.run(["code", "--hu", "23438"])).toBe(1);
    expect(checkpointCleared).toBeFalse();
    expect(await cli.run(["code", "--hu", "23438"])).toBe(0);
    expect(checkpointCleared).toBeTrue();
    expect(openCodeCalls).toBe(0);
    expect(cleanupCalls).toBe(1);
  } finally {
    console.error = originalError;
  }
  expect(messages.join("\n")).toContain("completion-evidence");
});

test("code mantiene un error Azure como error operativo durante la verificacion", async () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => messages.push(values.join(" "));

  try {
    const result = OpenCodeResult.fromJsonLines(JSON.stringify({
      type: "text",
      sessionID: "ses_code",
      part: { type: "text", text: "TICKET_COMPLETED" },
    }));
    const code = await new LazyWorkflowCli(
      {
        getHuInfo: async () => new HuInfo({ id: 23438 }),
        waitForAccess: async () => undefined,
        ensureIntegrationBranch: async () => "refs/heads/hu/23438",
        getAutocodeContext: async () => ({
          hu: { id: 23438 },
          ticket: { id: 51, type: "Task" },
          integrationBranch: "refs/heads/hu/23438",
        }),
        verifyTicketCompletion: async () => { throw new Error('{"accessToken":"secret"}'); },
      },
      { run: async () => ({ result, azureLoginRequired: false }), resume: async () => result },
      emptyCheckpointStore(),
    ).run(["code", "--hu", "23438"]);

    expect(code).toBe(1);
  } finally {
    console.error = originalError;
  }

  expect(messages.join("\n")).toContain("Azure no respondió durante la verificación");
  expect(messages.join("\n")).not.toContain("no cumple los gates");
  expect(messages.join("\n")).not.toContain("secret");
});

test("code passes the operator prompt to OpenCode, not to the Azure boundary", async () => {
  const prompt = "crea la rama base de la HU a partir de develop";
  const branch = "refs/heads/hu/23438";
  let contextBranch = "";
  let openCodePrompt = "";
  let openCodeCalls = 0;
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text", sessionID: "ses_code", part: { type: "text", text: "not-complete" },
  }));
  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async () => branch,
      getAutocodeContext: async (_hu, integrationBranch) => {
        contextBranch = integrationBranch ?? "";
        return { hu: { id: 23438 }, ticket: { id: 51, type: "Task" }, integrationBranch: contextBranch };
      },
      verifyTicketCompletion: async () => null,
    },
    { run: async (options) => { openCodeCalls += 1; openCodePrompt = options.prompt; return { result, azureLoginRequired: false }; }, resume: async () => result },
    emptyCheckpointStore(),
    { wait: async () => { throw new Error("stop retry"); } },
  ).run(["code", "--hu", "23438", "--prompt", prompt]);

  expect(code).toBe(1);
  expect(openCodePrompt).toContain(prompt);
  expect(openCodePrompt).toContain("git push --set-upstream origin");
  expect(openCodePrompt).toContain("git ls-remote --heads origin");
  expect(contextBranch).toBe(branch);
  expect(openCodeCalls).toBe(1);
});

test("code stays incomplete and does not invoke OpenCode while Azure cannot resolve the integration branch", async () => {
  let openCodeCalls = 0;
  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async () => null,
      getAutocodeContext: async () => { throw new Error("must not select a ticket"); },
      verifyTicketCompletion: async () => null,
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
  const resumed: Array<[string, string, string | undefined]> = [];
  const waits: number[] = [];
  let attempts = 0;
  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async () => "refs/heads/hu/23438",
      getAutocodeContext: async () => ({ hu: { id: 23438 }, ticket: { id: 51, type: "Task" }, integrationBranch: "refs/heads/hu/23438" }),
      verifyTicketCompletion: async (context) => ({ ticketBranch: `refs/heads/ticket/${context.ticket.id}` }),
      getCompletedTicketBranch: async (context) => `refs/heads/ticket/${context.ticket.id}`,
    },
    {
      run: async () => { attempts += 1; return { result: result("not-complete"), azureLoginRequired: false, failed: true }; },
      resume: async (sessionId: string, prompt?: string, workingDirectory?: string) => {
        resumed.push([sessionId, prompt ?? "", workingDirectory]);
        return result("TICKET_COMPLETED");
      },
    },
    store,
    { wait: async (milliseconds) => { waits.push(milliseconds); } },
    { deleteTicketBranch: async () => undefined },
  ).run(["code", "--hu", "23438", "--prompt", "continua con la rama corregida", "--working-directory", "/repo/objetivo"]);

  expect(code).toBe(0);
  expect(attempts).toBe(1);
  expect(waits).toEqual([10_000]);
  expect(resumed).toEqual([["ses_retry", "continua con la rama corregida", "/repo/objetivo"]]);
  expect(checkpoint.sessionId).toBeNull();
});

test("code detiene el flujo cuando falla el cierre de la sesion nativa", async () => {
  const checkpoint: AutocodeCheckpoint = {
    workflow: "autocode",
    hu: 23438,
    ticket: 51,
    sessionId: null,
  };
  let waits = 0;
  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async () => "refs/heads/hu/23438",
      getAutocodeState: async () => ({
        context: { hu: { id: 23438 }, ticket: { id: 51, type: "Task" }, integrationBranch: "refs/heads/hu/23438" },
        pending: true,
      }),
      getAutocodeContext: async () => null,
      verifyTicketCompletion: async () => null,
    },
    {
      run: async () => { throw new OpenCodeSessionCloseError("ses_failed", "provider unavailable"); },
      resume: async () => { throw new Error("must not resume after closure failure"); },
    },
    {
      read: async () => null,
      write: async (value) => { Object.assign(checkpoint, value); },
      clear: async () => { throw new Error("must preserve checkpoint"); },
    },
    { wait: async () => { waits += 1; } },
  ).run(["code", "--hu", "23438"]);

  expect(code).toBe(1);
  expect(waits).toBe(0);
  expect(checkpoint).toEqual({ workflow: "autocode", hu: 23438, ticket: 51, sessionId: null });
});

test("code reconcilia un checkpoint completado sin sesion y continúa con el siguiente ticket", async () => {
  const completedContext: AutocodeContext = {
    hu: { id: 23438 },
    ticket: { id: 51, type: "Task" },
    integrationBranch: "refs/heads/hu/23438",
  };
  const nextContext: AutocodeContext = {
    hu: { id: 23438 },
    ticket: { id: 52, type: "Task" },
    integrationBranch: "refs/heads/hu/23438",
  };
  const states: AutocodeState[] = [
    { context: nextContext, pending: true },
    { context: null, pending: false },
  ];
  const cleanups: number[] = [];
  let checkpoint: AutocodeCheckpoint | null = {
    workflow: "autocode",
    hu: 23438,
    ticket: 51,
    sessionId: null,
  };
  const store: AutocodeCheckpointStore = {
    read: async () => checkpoint,
    write: async (value) => { checkpoint = value; },
    clear: async () => { checkpoint = null; },
  };
  const completedResult = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: "ses-52",
    part: { type: "text", text: "TICKET_COMPLETED" },
  }));

  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async () => "refs/heads/hu/23438",
      getAutocodeContextForTicket: async () => completedContext,
      getAutocodeState: async () => states.shift()!,
      getAutocodeContext: async () => { throw new Error("must use queue state"); },
      verifyTicketCompletion: async (context) => ({ ticketBranch: `refs/heads/ticket/${context.ticket.id}` }),
      getCompletedTicketBranch: async (context) => `refs/heads/ticket/${context.ticket.id}`,
    },
    {
      run: async () => ({ result: completedResult, azureLoginRequired: false }),
      resume: async () => { throw new Error("must use a fresh session"); },
    },
    store,
    undefined,
    {
      deleteTicketBranch: async (ticketBranch) => {
        cleanups.push(Number(ticketBranch.split("/").at(-1)));
      },
    },
  ).run(["code", "--hu", "23438"]);

  expect(code).toBe(0);
  expect(cleanups).toEqual([51, 52]);
  expect(checkpoint).toBeNull();
});

test("code conserva el checkpoint y detiene el flujo ante un error de limpieza Git", async () => {
  const checkpoint: AutocodeCheckpoint = {
    workflow: "autocode",
    hu: 23438,
    ticket: 51,
    sessionId: null,
  };
  let waits = 0;
  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async () => "refs/heads/hu/23438",
      getAutocodeContextForTicket: async () => ({
        hu: { id: 23438 },
        ticket: { id: 51, type: "Task" },
        integrationBranch: "refs/heads/hu/23438",
      }),
      getAutocodeContext: async () => null,
      verifyTicketCompletion: async (context) => ({ ticketBranch: `refs/heads/ticket/${context.ticket.id}` }),
      getCompletedTicketBranch: async () => "refs/heads/ticket/51",
    },
    {
      run: async () => { throw new Error("must not run"); },
      resume: async () => { throw new Error("must not resume"); },
    },
    {
      read: async () => checkpoint,
      write: async () => undefined,
      clear: async () => { throw new Error("must preserve checkpoint"); },
    },
    { wait: async () => { waits += 1; throw new Error("must not retry Git cleanup"); } },
    { deleteTicketBranch: async () => { throw new Error("worktree sucio"); } },
  ).run(["code", "--hu", "23438"]);

  expect(code).toBe(1);
  expect(waits).toBe(0);
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
