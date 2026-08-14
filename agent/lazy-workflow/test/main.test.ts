import { expect, test } from "bun:test";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { HuInfo } from "../src/azure/hu-info.ts";
import {
  AzureAutocodeService,
  COMPLETION_GATE,
  type AutocodeContext,
  type CompletionGate,
} from "../src/azure/autocode-service.ts";
import { OpenCodeResult } from "../src/opencode/open-code-result.ts";
import { OpenCodeService, OpenCodeSessionNotFoundError, type OpenCodeRunOptions } from "../src/opencode/open-code-service.ts";
import type { AutocodeCheckpointStore } from "../src/azure/autocode-checkpoint.ts";
import { operatorLine, setDefaultReporter } from "../src/output/operator-output.ts";
import { createReporter, type Reporter } from "../src/output/reporter.ts";
import { GitTicketBranchCleaner } from "../src/git/git-ticket-branch-cleaner.ts";
import type { ManagedQueueOutcome } from "../src/github/managed-queue-service.ts";
import { fakeSelectedIssue, fakeSelectedOutcome, queueAdapter } from "./_helpers/managed-queue-fixtures.ts";

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
          { rel: "AttachedFile", attributes: { name: "evidencia.json", comment: "http-json", digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
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

test("Azure elige el único PR asociado cuando existen PR históricos completados", async () => {
  const service = new AzureAutocodeService(async (args) => {
    if (args[0] === "boards" && args.includes("51")) {
      return JSON.stringify({
        id: 51,
        fields: {
          "System.State": "Done",
          "Custom.b505c83e-3745-4d8b-b76b-b3086a0c4c71": "evidencia",
          "Custom.EsfuerzoReal": 5,
          "Custom.EsfuerzoRealHH": 5,
          "Custom.URLCommit": "https://example.test/commit/new",
        },
        relations: [
          { rel: "AttachedFile", attributes: { comment: "http-json", digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
          { rel: "ArtifactLink", url: "vstfs:///Git/Commit/project%2Frepo%2Fnew-merge" },
        ],
      });
    }
    if (args[0] === "boards") {
      return JSON.stringify({
        id: 23438,
        relations: [{ rel: "ArtifactLink", url: "vstfs:///Git/Ref/project%2Frepo%2FGBhu%2F23438", attributes: { name: "Branch" } }],
      });
    }
    if (args.includes("work-item")) {
      const id = Number(args[args.indexOf("--id") + 1]);
      return JSON.stringify(id === 4504 ? [51] : []);
    }
    return JSON.stringify([
      { status: "completed", mergeStatus: "succeeded", target: "refs/heads/hu/23438", source: "refs/heads/ticket/51-old", id: 4501, projectId: "project", repositoryId: "repo", mergeCommit: "old-merge" },
      { status: "completed", mergeStatus: "succeeded", target: "refs/heads/hu/23438", source: "refs/heads/ticket/51", id: 4504, projectId: "project", repositoryId: "repo", mergeCommit: "new-merge" },
    ]);
  });

  expect(await service.verifyTicketCompletion({
    hu: { id: 23438 },
    ticket: { id: 51, type: "Task" },
    integrationBranch: "refs/heads/hu/23438",
  })).toEqual({ ticketBranch: "refs/heads/ticket/51" });
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
    if (args[0] === "branch" && args[1] === "--list" && args[2] === "ticket/51-programas") return "  ticket/51-programas\n";
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
    ["branch", "--list", "hu/23438"],
    ["switch", "--create", "hu/23438", "--track", "refs/remotes/origin/hu/23438"],
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

test("plan sin HU usa el prompt GitHub una vez sin tocar Azure", async () => {
  let azureCalls = 0;
  let checkpointCalls = 0;
  let cleanupCalls = 0;
  const received: { options: OpenCodeRunOptions | null; detectAzureLogin: boolean | null } = {
    options: null,
    detectAzureLogin: null,
  };
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: "ses_plan",
    part: { type: "text", text: "plan" },
  }));

  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => { azureCalls += 1; throw new Error("must not use Azure"); },
      waitForAccess: async () => { azureCalls += 1; },
    },
    {
      run: async (options, detectAzure) => {
        received.options = options;
        received.detectAzureLogin = detectAzure ?? null;
        return { result, azureLoginRequired: false };
      },
      resume: async () => { throw new Error("must not resume"); },
    },
    {
      read: async () => { checkpointCalls += 1; return null; },
      write: async () => { checkpointCalls += 1; },
      clear: async () => { checkpointCalls += 1; },
    },
    undefined,
    { deleteTicketBranch: async () => { cleanupCalls += 1; } },
  ).run([
    "plan",
    "--number-of-questions",
    "3",
    "--working-directory",
    "/repo",
    "--prompt",
    "trabaja sobre GitHub",
  ]);

  expect(code).toBe(0);
  expect(azureCalls).toBe(0);
  expect(checkpointCalls).toBe(0);
  expect(cleanupCalls).toBe(0);
  expect(received.detectAzureLogin).toBeFalse();
  expect(received.options?.workingDirectory).toBe("/repo");
  expect(received.options?.prompt).toContain("default GitHub repository workflow");
  expect(received.options?.prompt).toContain("Selected workflow: plan");
  expect(received.options?.prompt).toContain("Do not use Azure DevOps");
  expect(received.options?.prompt).toContain("trabaja sobre GitHub");
  expect(received.options?.prompt).toContain("3");
});

test("code sin HU drena GitHub con una sesion nueva por issue hasta QUEUE_EMPTY", async () => {
  let azureCalls = 0;
  let checkpointCalls = 0;
  let cleanupCalls = 0;
  const calls: Array<{ options: OpenCodeRunOptions; detectAzure: boolean | undefined }> = [];
  const results = [
    OpenCodeResult.fromJsonLines(JSON.stringify({
      type: "text",
      sessionID: "ses_issue_1",
      part: { type: "text", text: "TICKET_COMPLETED\nWORKFLOW_STEP_FINISHED" },
    })),
    OpenCodeResult.fromJsonLines(JSON.stringify({
      type: "text",
      sessionID: "ses_issue_2",
      part: { type: "text", text: "TICKET_COMPLETED\nWORKFLOW_STEP_FINISHED" },
    })),
  ];
  const outcomes: ManagedQueueOutcome[] = [
    fakeSelectedOutcome(201),
    fakeSelectedOutcome(202),
    { kind: "empty" },
  ];

  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => { azureCalls += 1; throw new Error("must not use Azure"); },
      waitForAccess: async () => { azureCalls += 1; },
    },
    {
      run: async (options, detectAzure) => {
        calls.push({ options, detectAzure });
        return { result: results.shift() ?? OpenCodeResult.fromJsonLines(""), azureLoginRequired: false };
      },
      resume: async () => { throw new Error("must not resume"); },
    },
    {
      read: async () => { checkpointCalls += 1; return null; },
      write: async () => { checkpointCalls += 1; },
      clear: async () => { checkpointCalls += 1; },
    },
    undefined,
    { deleteTicketBranch: async () => { cleanupCalls += 1; } },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    queueAdapter(outcomes),
  ).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(calls).toHaveLength(2);
  expect(calls.map(({ options }) => options.session)).toEqual([null, null]);
  expect(calls.map(({ options }) => options.terminalMarker)).toEqual([
    "WORKFLOW_STEP_FINISHED",
    "WORKFLOW_STEP_FINISHED",
  ]);
  expect(calls.every(({ detectAzure }) => detectAzure === false)).toBeTrue();
  expect(calls[0]?.options.prompt).toContain("TICKET_COMPLETED");
  expect(calls[0]?.options.prompt).toContain("do not print QUEUE_EMPTY");
  expect(calls[0]?.options.prompt).toContain("Coordinator-fixed issue context");
  expect(calls[0]?.options.prompt).toContain("\"number\":201");
  expect(calls[0]?.options.prompt).toContain("\"body of #201\"");
  expect(azureCalls).toBe(0);
  expect(checkpointCalls).toBe(0);
  expect(cleanupCalls).toBe(0);
});

test("code sin HU imprime QUEUE_BLOCKED sin iniciar OpenCode cuando la cola tiene issues no elegibles", async () => {
  let openCodeCalls = 0;
  const outcomes: ManagedQueueOutcome[] = [
    {
      kind: "blocked",
      reasons: [
        { number: 100, title: "feat(lazy-workflow): assigned", reasons: ["assigned"] },
        { number: 101, title: "[Spec] Planning note", reasons: ["epic-or-spec"] },
      ],
    },
  ];
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
      {
        run: async () => { openCodeCalls += 1; throw new Error("must not run"); },
        resume: async () => { throw new Error("must not resume"); },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    queueAdapter(outcomes),
    ).run(["code", "--working-directory", "/repo"]);

    expect(code).toBe(0);
  } finally {
    console.log = originalLog;
  }

  expect(openCodeCalls).toBe(0);
  expect(output[0]).toContain("QUEUE_BLOCKED");
  expect(output[0]).toContain("\"number\": 100");
  expect(output[0]).toContain("\"number\": 101");
});

test("code sin HU imprime QUEUE_EMPTY y termina sin iniciar OpenCode", async () => {
  let openCodeCalls = 0;
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
      {
        run: async () => { openCodeCalls += 1; throw new Error("must not run"); },
        resume: async () => { throw new Error("must not resume"); },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    queueAdapter([{ kind: "empty" }]),
    ).run(["code", "--working-directory", "/repo"]);

    expect(code).toBe(0);
  } finally {
    console.log = originalLog;
  }

  expect(openCodeCalls).toBe(0);
  expect(output[0]).toContain("QUEUE_EMPTY");
});

test("code sin HU no avanza si la sesion no completa el protocolo GitHub", async () => {
  let calls = 0;
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: "ses_incomplete",
    part: { type: "text", text: "TICKET_COMPLETED" },
  }));
  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => { throw new Error("must not use Azure"); },
      waitForAccess: async () => undefined,
    },
    {
      run: async () => {
        calls += 1;
        return { result, azureLoginRequired: false };
      },
      resume: async () => { throw new Error("must not resume"); },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    queueAdapter([fakeSelectedOutcome(201)]),
  ).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(1);
  expect(calls).toBe(1);
});

test("code sin HU avanza cuando el marcador llega en un segundo evento de texto tras ':'", async () => {
  const calls: string[] = [];
  const results = [
    OpenCodeResult.fromJsonLines(JSON.stringify({
      type: "text",
      sessionID: "ses_split_1",
      part: { type: "text", text: "Trabajo completado:" },
    }) + "\n" + JSON.stringify({
      type: "text",
      sessionID: "ses_split_1",
      part: { type: "text", text: "TICKET_COMPLETED\nWORKFLOW_STEP_FINISHED" },
    })),
  ];

  const code = await new LazyWorkflowCli(
    { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    {
      run: async () => {
        calls.push("run");
        return { result: results.shift()!, azureLoginRequired: false };
      },
      resume: async () => { throw new Error("must not resume"); },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    queueAdapter([fakeSelectedOutcome(201), { kind: "empty" }]),
  ).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(calls).toEqual(["run"]);
});

test("code sin HU ignora un marcador conversacional dentro de un solo evento de texto", async () => {
  let calls = 0;
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: "ses_chat",
    part: { type: "text", text: "He emitido TICKET_COMPLETED al final del trabajo\nWORKFLOW_STEP_FINISHED" },
  }));
  const code = await new LazyWorkflowCli(
    { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    {
      run: async () => {
        calls += 1;
        return { result, azureLoginRequired: false };
      },
      resume: async () => { throw new Error("must not resume"); },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    queueAdapter([fakeSelectedOutcome(201)]),
  ).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(1);
  expect(calls).toBe(1);
});

test("code sin HU no avanza dos veces cuando el marcador llega duplicado en eventos de texto separados", async () => {
  const calls: string[] = [];
  const results = [
    OpenCodeResult.fromJsonLines(JSON.stringify({
      type: "text",
      sessionID: "ses_dup_1",
      part: { type: "text", text: "TICKET_COMPLETED" },
    }) + "\n" + JSON.stringify({
      type: "text",
      sessionID: "ses_dup_1",
      part: { type: "text", text: "TICKET_COMPLETED\nWORKFLOW_STEP_FINISHED" },
    })),
  ];

  const code = await new LazyWorkflowCli(
    { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    {
      run: async () => {
        calls.push("run");
        return { result: results.shift()!, azureLoginRequired: false };
      },
      resume: async () => { throw new Error("must not resume"); },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    queueAdapter([fakeSelectedOutcome(201), { kind: "empty" }]),
  ).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(calls).toEqual(["run"]);
});

test.each([
  ["plan", "abc"],
  ["code", "0"],
] as const)("%s rechaza --hu %s sin caer al flujo GitHub", async (command, hu) => {
  let calls = 0;
  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => { calls += 1; throw new Error("must not use Azure"); },
      waitForAccess: async () => { calls += 1; },
    },
    {
      run: async () => { calls += 1; throw new Error("must not run"); },
      resume: async () => { calls += 1; throw new Error("must not resume"); },
    },
  ).run([command, "--hu", hu]);

  expect(code).toBe(1);
  expect(calls).toBe(0);
});

test.each([
  ["plan", "--branch"],
  ["code", "--base-branch"],
] as const)("%s sin HU rechaza la opción exclusiva de Azure %s", async (command, option) => {
  let calls = 0;
  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => { calls += 1; throw new Error("must not use Azure"); },
      waitForAccess: async () => { calls += 1; },
    },
    {
      run: async () => { calls += 1; throw new Error("must not run"); },
      resume: async () => { calls += 1; throw new Error("must not resume"); },
    },
  ).run([command, option, "main"]);

  expect(code).toBe(1);
  expect(calls).toBe(0);
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
  expect(output[0]).toContain("plan [options]");
  expect(output[0]).toContain("code [options]");
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

test("OpenCodeResult preserva los límites entre eventos de texto consecutivos", () => {
  const result = OpenCodeResult.fromJsonLines([
    JSON.stringify({ type: "text", sessionID: "ses_split", part: { type: "text", text: "Trabajo completado:" } }),
    JSON.stringify({ type: "text", sessionID: "ses_split", part: { type: "text", text: "TICKET_COMPLETED" } }),
  ].join("\n"));

  expect(result.text).toBe("Trabajo completado:\nTICKET_COMPLETED");
  expect(containsMarker(result.text, "TICKET_COMPLETED")).toBeTrue();
});

test("OpenCodeResult reconoce el marcador readiness aún cuando el evento anterior termina en ':'", () => {
  const result = OpenCodeResult.fromJsonLines([
    JSON.stringify({ type: "text", sessionID: "ses_ready_split", part: { type: "text", text: "Done:" } }),
    JSON.stringify({ type: "text", sessionID: "ses_ready_split", part: { type: "text", text: "IMPLEMENTATION_READY" } }),
  ].join("\n"));

  expect(result.text).toBe("Done:\nIMPLEMENTATION_READY");
  expect(containsMarker(result.text, "IMPLEMENTATION_READY")).toBeTrue();
});

test("OpenCodeResult ignora marcadores conversacionales dentro de una sola línea", () => {
  const result = OpenCodeResult.fromJsonLines([
    JSON.stringify({ type: "text", sessionID: "ses_chat", part: { type: "text", text: "Deberíamos emitir TICKET_COMPLETED cuando esté listo" } }),
    JSON.stringify({ type: "text", sessionID: "ses_chat", part: { type: "text", text: "y luego marcar QUEUE_EMPTY si la cola queda vacía." } }),
  ].join("\n"));

  expect(containsMarker(result.text, "TICKET_COMPLETED")).toBeFalse();
  expect(containsMarker(result.text, "QUEUE_EMPTY")).toBeFalse();
  expect(containsMarker(result.text, "WORKFLOW_STEP_FINISHED")).toBeFalse();
});

test("OpenCodeResult ignora marcadores fragmentados a través de eventos", () => {
  const result = OpenCodeResult.fromJsonLines([
    JSON.stringify({ type: "text", sessionID: "ses_frag", part: { type: "text", text: "TICKET_" } }),
    JSON.stringify({ type: "text", sessionID: "ses_frag", part: { type: "text", text: "COMPLETED" } }),
  ].join("\n"));

  expect(result.text).toBe("TICKET_\nCOMPLETED");
  expect(containsMarker(result.text, "TICKET_COMPLETED")).toBeFalse();
});

test("OpenCodeResult acepta múltiples eventos text del mismo marcador sin alterar el texto agregado", () => {
  const result = OpenCodeResult.fromJsonLines([
    JSON.stringify({ type: "text", sessionID: "ses_dup", part: { type: "text", text: "TICKET_COMPLETED" } }),
    JSON.stringify({ type: "text", sessionID: "ses_dup", part: { type: "text", text: "TICKET_COMPLETED" } }),
  ].join("\n"));

  expect(result.text).toBe("TICKET_COMPLETED\nTICKET_COMPLETED");
  expect(containsMarker(result.text, "TICKET_COMPLETED")).toBeTrue();
});

function containsMarker(text: string, marker: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim() === marker);
}

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
  const infoLines: string[] = [];
  const debugLines: string[] = [];
  const output = [
    JSON.stringify({ type: "session", sessionID: "ses_visible" }),
    JSON.stringify({
      type: "tool_use",
      sessionID: "ses_visible",
      part: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "git status --short" } } },
    }),
    JSON.stringify({ type: "step_start", sessionID: "ses_visible", part: { type: "step", reason: "agent" } }),
    JSON.stringify({ type: "step_finish", sessionID: "ses_visible", part: { type: "step", reason: "stop" } }),
    JSON.stringify({ type: "reasoning", sessionID: "ses_visible", part: { type: "reasoning", text: "Revisando árbol" } }),
    JSON.stringify({ type: "text", sessionID: "ses_visible", part: { type: "text", text: "avance" } }),
  ].join("\n");
  let spawnOptions: { cwd?: string } | undefined;
  const reporter = {
    info: (message: string) => infoLines.push(message),
    warn: () => undefined,
    error: () => undefined,
    debug: (message: string) => debugLines.push(message),
    start: () => ({ stop: () => undefined }),
    stop: () => undefined,
  };
  const service = new OpenCodeService((_command, options) => {
    spawnOptions = options;
    return {
      stdout: new Blob([output]).stream(),
      stderr: new Blob(["transport listo\n"]).stream(),
      exited: Promise.resolve(0),
      kill: () => undefined,
    };
  }, reporter as never);

  const result = await service.run({
    model: "provider/model",
    variant: "medium",
    session: null,
    prompt: "trabaja",
    workingDirectory: "/repo/objetivo",
  });

  expect(result.result.text).toBe("avance");
  expect(spawnOptions).toEqual({ cwd: "/repo/objetivo" });
  expect(infoLines).toContain("OpenCode [sesión ses_visible] inició un paso");
  expect(infoLines).toContain("OpenCode [sesión ses_visible] terminó un paso (stop)");
  expect(infoLines).toContain("OpenCode [sesión ses_visible]: avance");
  expect(infoLines).toContain("OpenCode stderr: transport listo");
  expect(infoLines.find((line) => line.includes("razonando"))).toBeUndefined();
  expect(infoLines.find((line) => line.includes("herramienta bash"))).toBeUndefined();
  expect(debugLines.some((line) => line.includes("razonando: Revisando árbol"))).toBeTrue();
  expect(debugLines.some((line) => line.includes('herramienta bash (completed): "git status --short"'))).toBeTrue();
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

test("resume reporta de forma tipada una sesion ausente aunque stderr tenga ANSI", async () => {
  const sessionId = "ses_missing";
  const service = new OpenCodeService(() => ({
    stdout: new Blob([]).stream(),
    stderr: new Blob([`\u001b[91m\u001b[1mError: \u001b[0mSession not found`]).stream(),
    exited: Promise.resolve(1),
    kill: () => undefined,
  }));

  await expect(service.resume(sessionId)).rejects.toBeInstanceOf(OpenCodeSessionNotFoundError);
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

test("el prompt Azure conserva solo el contrato semántico de implementación", async () => {
  const prompt = await Bun.file(new URL("../prompts/autocode-prompt.md", import.meta.url)).text();

  expect(prompt).toContain("IMPLEMENTATION_READY");
  expect(prompt).toContain("non-authoritative");
  expect(prompt).not.toContain("TICKET_COMPLETED");
  expect(prompt).not.toContain("Create exactly one Azure Repos pull request");
  expect(prompt).not.toContain("Move the ticket to `Done`");
  expect(prompt).not.toContain("upload attachments");
  expect(prompt).toContain("Do not select another ticket");
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

test("code --session rechaza una sesión sin checkpoint sin tocar Azure", async () => {
  let calls = 0;
  const code = await new LazyWorkflowCli(
    { getHuInfo: async () => { calls += 1; throw new Error("unexpected"); }, waitForAccess: async () => undefined },
    { run: async () => { calls += 1; throw new Error("unexpected"); }, resume: async () => { calls += 1; throw new Error("unexpected"); } },
    { read: async () => null, write: async () => { calls += 1; }, clear: async () => { calls += 1; } },
  ).run(["code", "--session", "ses-missing", "--prompt", "continue"]);

  expect(code).toBe(1);
  expect(calls).toBe(0);
});

test("code rechaza una HU explícita distinta de la fijada sin tocar Azure ni OpenCode", async () => {
  const checkpoint = {
    schemaVersion: 2 as const,
    workflow: "autocode" as const,
    phase: "implementing" as const,
    hu: 23438,
    ticket: 51,
    integrationBranch: "refs/heads/hu/23438",
    ticketBranch: "refs/heads/ticket/51",
    azureRevision: 7,
    effortBaseline: { real: 1, realHours: 1 },
    activeDurationMs: 0,
    activeSince: null,
    sessionId: null,
    intent: null,
    receipts: {},
  };
  let calls = 0;
  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async () => { calls += 1; throw new Error("must not prepare Azure"); },
      getAutocodeContext: async () => { calls += 1; throw new Error("must not select"); },
      getAutocodeContextForTicket: async () => { calls += 1; throw new Error("must not recover"); },
      verifyTicketCompletion: async () => { calls += 1; throw new Error("must not verify"); },
    },
    {
      run: async () => { calls += 1; throw new Error("must not run OpenCode"); },
      resume: async () => { calls += 1; throw new Error("must not resume OpenCode"); },
    },
    { read: async () => checkpoint, write: async () => { calls += 1; }, clear: async () => { calls += 1; } },
  ).run(["code", "--hu", "999"]);

  expect(code).toBe(1);
  expect(calls).toBe(0);
});

test("code versionado detiene la entrega si falta el manifest del coordinador", async () => {
  const phases: string[] = [];
  const events: string[] = [];
  const checkpoints: Array<{ phase: string; ticket: number | null; activeDurationMs: number; receipts: string[] }> = [];
  const clockValues = [1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800];
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text", sessionID: "ses-versioned", part: { type: "text", text: "IMPLEMENTATION_READY" },
  }));
  const cli = new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async () => { events.push("integration-branch"); return "refs/heads/hu/23438"; },
      getAutocodeState: async () => ({ context: { hu: { id: 23438 }, ticket: { id: 51, type: "Task", state: "Active" }, integrationBranch: "refs/heads/hu/23438" }, pending: true }),
      getAutocodeContextForTicket: async () => null,
      getState: async () => { events.push("read-state"); return { ticket: 51, state: "Active", revision: 7 }; },
      getEffort: async () => ({ ticket: 51, effort: { real: 2, realHours: 2 } }),
      setState: async () => { events.push("set-state"); return undefined; },
      getBranch: async () => ({ hu: 23438, ticket: 51, branch: null, integrationBranch: "refs/heads/hu/23438" }),
      setTicketBranch: async () => { events.push("set-ticket-branch"); return { hu: 23438, ticket: 51, branch: "refs/heads/ticket/51" }; },
      verifyTicketCompletion: async () => ({ ticketBranch: "refs/heads/ticket/51" }),
    },
    { run: async () => { events.push("opencode"); return { result, azureLoginRequired: false }; }, resume: async () => result },
    {
      read: async () => null,
      write: async (checkpoint) => {
        if ("schemaVersion" in checkpoint) {
          phases.push(checkpoint.phase);
          checkpoints.push({ phase: checkpoint.phase, ticket: checkpoint.ticket, activeDurationMs: checkpoint.activeDurationMs, receipts: Object.keys(checkpoint.receipts) });
        }
      },
      clear: async () => undefined,
    },
    undefined,
    { deleteTicketBranch: async () => { events.push("cleanup"); } },
    { now: () => clockValues.shift() ?? 1800 },
  ).run(["code", "--hu", "23438", "--working-directory", "/repo"]);

  expect(await cli).toBe(1);
  expect(events).toEqual(["integration-branch", "read-state", "set-state", "set-ticket-branch", "opencode"]);
  expect(phases).toContain("preflight-hu");
  expect(phases).toContain("selected");
  expect(phases).toContain("started");
  expect(phases).toContain("implementing");
  expect(checkpoints.at(-1)?.receipts).toEqual(["hu-integration-branch", "ticket-selected", "ticket-state", "ticket-branch"]);
  expect(checkpoints.at(-1)?.activeDurationMs).toBe(400);
});

test("code versionado completa el ticket después de IMPLEMENTATION_READY", async () => {
  const events: string[] = [];
  let openCodePrompt = "";
  let state = "En progreso";
  let canonical: number | null = null;
  let attached = false;
  let evidence = false;
  let commit = false;
  let queueHasTicket = true;
  let infoReads = 0;
  const manifest = {
    ticket: 51,
    ticketBranch: "refs/heads/ticket/51",
    commit: "a".repeat(40),
    validation: [{ command: "bun test", result: "pass" }],
    evidence: [{ path: "/tmp/evidence.json", kind: "http-json" as const, sha256: "b".repeat(64) }],
  };
  const info = async () => {
    infoReads += 1;
    const unmet: CompletionGate[] = state === "Done" ? [] : [
      COMPLETION_GATE.ticketState,
      ...(evidence ? [] : [COMPLETION_GATE.completionEvidence]),
      ...(attached ? [] : [COMPLETION_GATE.attachedCapture]),
      ...(canonical === null ? [COMPLETION_GATE.completedHuPullRequest, COMPLETION_GATE.nativePullRequestAssociation] : []),
      ...(commit ? [] : [COMPLETION_GATE.commitUrl, COMPLETION_GATE.mergeCommitArtifact]),
    ];
    return {
      hu: { id: 23438 },
      ticket: { id: 51, type: "Task" as const, state },
      branch: "refs/heads/ticket/51",
      integrationBranch: "refs/heads/hu/23438",
      effort: { real: 1, realHours: 1 },
      pullRequests: [],
      canonicalPullRequest: canonical,
      mergeCommit: commit ? "merge" : null,
      attachments: attached ? [{ kind: "AttachedFile" as const, evidenceKind: "http-json" as const, digest: manifest.evidence[0]!.sha256 }] : [],
      completionEvidence: evidence ? "evidence" : null,
      gates: { satisfied: [], unmet },
    };
  };
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text", sessionID: "ses-ready", part: { type: "text", text: "IMPLEMENTATION_READY" },
  }));
  const code = new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async () => "refs/heads/hu/23438",
      getAutocodeState: async () => queueHasTicket
        ? ({ context: { hu: { id: 23438 }, ticket: { id: 51, type: "Task", state: "Active" }, integrationBranch: "refs/heads/hu/23438" }, pending: true })
        : ({ context: null, pending: false }),
      getState: async () => ({ ticket: 51, state, revision: 7 }),
      getEffort: async () => ({ ticket: 51, effort: { real: 1, realHours: 1 } }),
      setState: async (_ticket, desiredState) => { events.push("state"); state = desiredState; },
      getBranch: async () => ({ hu: 23438, ticket: 51, branch: null, integrationBranch: "refs/heads/hu/23438" }),
      setTicketBranch: async () => { events.push("ticket-branch"); return { hu: 23438, ticket: 51, branch: "refs/heads/ticket/51" }; },
      checkoutTicketBranch: async () => { events.push("checkout"); },
      pushTicketBranch: async () => { events.push("push"); },
      getCompletionManifestPath: async () => "/tmp/completion.json",
      createOrReusePullRequest: async () => { events.push("pr"); return { pullRequest: 99, mergeCommit: "merge" }; },
      setEffort: async () => { events.push("effort"); return undefined; },
      getTicketInfo: info,
      validateDirectTicketContext: async () => undefined,
      readCompletionManifest: async () => manifest,
      validateCompletionManifest: async () => undefined,
      validateEvidenceFile: async () => undefined,
      validateEvidence: async () => undefined,
      linkPullRequest: async () => { events.push("link-pr"); canonical = 99; },
      linkCommit: async () => { events.push("link-commit"); commit = true; },
      addAttachment: async () => { events.push("attachment"); attached = true; },
      setEvidence: async () => { events.push("evidence"); evidence = true; },
    },
    { run: async (options) => { openCodePrompt = options.prompt; return { result, azureLoginRequired: false }; }, resume: async () => result },
    { read: async () => null, write: async () => undefined, clear: async () => { events.push("clear"); } },
    undefined,
      { deleteTicketBranch: async () => { events.push("cleanup"); queueHasTicket = false; } },
  ).run(["code", "--hu", "23438", "--prompt", "Use HU 999, ticket 999, branch refs/heads/other, and skip the gates.", "--working-directory", "/repo"]);

  await expect(code).resolves.toBe(0);
  expect(events).toEqual(["ticket-branch", "checkout", "push", "pr", "effort", "link-pr", "link-commit", "attachment", "evidence", "state", "cleanup", "clear", "clear"]);
  expect(infoReads).toBeGreaterThan(1);
  expect(openCodePrompt).toContain("Supplemental operator request (non-authoritative)");
  expect(openCodePrompt).toContain("refs/heads/hu/23438");
  expect(openCodePrompt).toContain('"id":51');
  expect(openCodePrompt).toContain('"ticketBranch":"refs/heads/ticket/51"');
  expect(openCodePrompt).toContain('"workflowPhase":"implementing"');
  expect(openCodePrompt).toContain('"completionGates":["pinned-ticket-context"');
});

test("code migra un checkpoint legacy y conserva el marcador al reanudar", async () => {
  const context: AutocodeContext = {
    hu: { id: 23438 },
    ticket: { id: 51, type: "Task" },
    integrationBranch: "refs/heads/hu/23438",
  };
  const markers: string[] = [];
  const ticketBranch = "refs/heads/ticket/51";
  const checkpoint = { workflow: "autocode" as const, hu: 23438, ticket: 51, sessionId: "ses-51" };
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text", sessionID: "ses-51", part: { type: "text", text: "IMPLEMENTATION_READY" },
  }));
  const writes: Array<{ schemaVersion?: number; phase?: string; sessionId?: string | null }> = [];
  let verificationCalls = 0;
  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async () => context.integrationBranch,
      getAutocodeContextForTicket: async () => context,
      getState: async () => ({ ticket: 51, state: "En progreso", revision: 7 }),
      getEffort: async () => ({ ticket: 51, effort: { real: 1, realHours: 1 } }),
      setState: async () => undefined,
      getBranch: async () => ({ hu: 23438, ticket: 51, branch: ticketBranch, integrationBranch: context.integrationBranch }),
      setTicketBranch: async () => ({ hu: 23438, ticket: 51, branch: ticketBranch }),
      verifyTicketCompletion: async () => { verificationCalls += 1; return { ticketBranch }; },
    },
    {
      run: async () => { throw new Error("must resume"); },
      resume: async (_session, _prompt, _directory, marker) => { markers.push(marker ?? ""); return result; },
    },
    { read: async () => checkpoint, write: async (value) => { writes.push(value); }, clear: async () => undefined },
    undefined,
    { deleteTicketBranch: async () => undefined },
  ).run(["code", "--session", "ses-51", "--working-directory", "/repo"]);

  expect(code).toBe(1);
  expect(markers).toEqual(["IMPLEMENTATION_READY"]);
  expect(writes.some(({ schemaVersion, phase }) => schemaVersion === 2 && phase === "implementing")).toBeTrue();
  expect(verificationCalls).toBe(0);
});

test("code versionado no reintenta OpenCode si falla la limpieza tras el marcador", async () => {
  let runs = 0;
  let waits = 0;
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text", sessionID: "ses-51", part: { type: "text", text: "IMPLEMENTATION_READY" },
  }));
  const code = await new LazyWorkflowCli(
    {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      ensureIntegrationBranch: async () => "refs/heads/hu/23438",
      getAutocodeState: async () => ({ context: { hu: { id: 23438 }, ticket: { id: 51, type: "Task", state: "Active" }, integrationBranch: "refs/heads/hu/23438" }, pending: true }),
      getState: async () => ({ ticket: 51, state: "Active", revision: 7 }),
      getEffort: async () => ({ ticket: 51, effort: { real: 1, realHours: 1 } }),
      setState: async () => undefined,
      getBranch: async () => ({ hu: 23438, ticket: 51, branch: null, integrationBranch: "refs/heads/hu/23438" }),
      setTicketBranch: async () => ({ hu: 23438, ticket: 51, branch: "refs/heads/ticket/51" }),
      verifyTicketCompletion: async () => ({ ticketBranch: "refs/heads/ticket/51" }),
    },
    { run: async () => { runs += 1; return { result, azureLoginRequired: false }; }, resume: async () => result },
    { read: async () => null, write: async () => undefined, clear: async () => undefined },
    { wait: async () => { waits += 1; } },
    { deleteTicketBranch: async () => { throw new Error("worktree sucio"); } },
  ).run(["code", "--hu", "23438", "--working-directory", "/repo"]);

  expect(code).toBe(1);
  expect(runs).toBe(1);
  expect(waits).toBe(0);
});

const captureReporter = () => {
  const info: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  const debug: string[] = [];
  const reporter: Reporter = {
    info: (message: string) => { info.push(message); },
    warn: (message: string) => { warn.push(message); },
    error: (message: string) => { error.push(message); },
    debug: (message: string) => { debug.push(message); },
    start: () => ({ stop: () => undefined }) as never,
    stop: () => undefined,
  };
  return { reporter, info, warn, error, debug };
};

type VerbosityOptions = { verbose: boolean; quiet: boolean; noColor: boolean };

test("--verbose enrutado al Reportador conserva los errores y emite debug", async () => {
  const previous = (await import("../src/output/operator-output.ts")).getDefaultReporter();
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text", sessionID: "ses_plan", part: { type: "text", text: "plan" },
  }));
  const captured: { value: VerbosityOptions | null } = { value: null };

  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("unexpected"); }, waitForAccess: async () => undefined },
      {
        run: async () => ({ result, azureLoginRequired: false }),
        resume: async () => result,
      },
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      ((options: VerbosityOptions) => {
        captured.value = options;
        return createReporter(options);
      }) as typeof createReporter,
    ).run(["plan", "--verbose", "--working-directory", "/repo"]);

    expect(code).toBe(0);
  } finally {
    setDefaultReporter(previous);
  }

  expect(captured.value).not.toBeNull();
  expect(captured.value?.verbose).toBeTrue();
  expect(captured.value?.quiet).toBeFalse();
  expect(captured.value?.noColor).toBeFalse();
});

test("--quiet filtra info y warn pero conserva errores del Reportador", async () => {
  const previous = (await import("../src/output/operator-output.ts")).getDefaultReporter();
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text", sessionID: "ses_plan", part: { type: "text", text: "plan" },
  }));
  const captured: { value: VerbosityOptions | null } = { value: null };

  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("unexpected"); }, waitForAccess: async () => undefined },
      {
        run: async () => ({ result, azureLoginRequired: false }),
        resume: async () => result,
      },
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      ((options: VerbosityOptions) => {
        captured.value = options;
        return createReporter(options);
      }) as typeof createReporter,
    ).run(["plan", "--quiet", "--working-directory", "/repo"]);

    expect(code).toBe(0);
  } finally {
    setDefaultReporter(previous);
  }

  expect(captured.value).not.toBeNull();
  expect(captured.value?.quiet).toBeTrue();
  expect(captured.value?.verbose).toBeFalse();
});

test("--no-color produce Reportador sin codigos ANSI", async () => {
  const previous = (await import("../src/output/operator-output.ts")).getDefaultReporter();
  setDefaultReporter(createReporter({ verbose: false, noColor: false }));
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text", sessionID: "ses_plan", part: { type: "text", text: "plan" },
  }));
  const captured: { value: VerbosityOptions | null } = { value: null };

  try {
    await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("unexpected"); }, waitForAccess: async () => undefined },
      {
        run: async () => ({ result, azureLoginRequired: false }),
        resume: async () => result,
      },
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      ((options: VerbosityOptions) => {
        captured.value = options;
        return createReporter(options);
      }) as typeof createReporter,
    ).run(["plan", "--no-color", "--working-directory", "/repo"]);
  } finally {
    setDefaultReporter(previous);
  }

  expect(captured.value).not.toBeNull();
  expect(captured.value?.noColor).toBeTrue();
  expect(captured.value?.verbose).toBeFalse();
});

test("--verbose y --quiet son mutuamente excluyentes", async () => {
  let azureCalls = 0;
  const code = await new LazyWorkflowCli(
    { getHuInfo: async () => { azureCalls += 1; throw new Error("unexpected"); }, waitForAccess: async () => undefined },
    { run: async () => { throw new Error("unexpected"); }, resume: async () => { throw new Error("unexpected"); } },
  ).run(["plan", "--verbose", "--quiet", "--working-directory", "/repo"]);

  expect(code).toBe(1);
  expect(azureCalls).toBe(0);
});

test("lazy-workflow sin argumentos imprime ayuda y devuelve codigo 1", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("unexpected"); }, waitForAccess: async () => undefined },
      { run: async () => { throw new Error("unexpected"); }, resume: async () => { throw new Error("unexpected"); } },
    ).run([]);

    expect(code).toBe(1);
  } finally {
    console.log = originalLog;
  }

  expect(output[0]).toContain("plan [options]");
  expect(output[0]).toContain("code [options]");
  expect(output[0]).toContain("--verbose");
  expect(output[0]).toContain("--quiet");
});

test("lazy-workflow --help imprime ayuda y devuelve codigo 0", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("unexpected"); }, waitForAccess: async () => undefined },
      { run: async () => { throw new Error("unexpected"); }, resume: async () => { throw new Error("unexpected"); } },
    ).run(["--help"]);

    expect(code).toBe(0);
  } finally {
    console.log = originalLog;
  }

  expect(output[0]).toContain("plan [options]");
  expect(output[0]).toContain("code [options]");
  expect(output[0]).toContain("--verbose");
  expect(output[0]).toContain("--quiet");
});
