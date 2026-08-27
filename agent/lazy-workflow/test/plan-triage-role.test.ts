/**
 * El rol `ready-for-agent` lo escribe el coordinador, no la sesion.
 *
 * Una sesion de planificacion publica Issues; si el nombre de la etiqueta
 * dependiera del prompt, la cola gestionada quedaria vacia con el backlog
 * lleno. Estas pruebas fijan el contrato determinista: marca antes de la
 * sesion, rol aplicado y verificado despues, y corrida detenida si no se pudo.
 */
import { expect, test } from "bun:test";
import { AgentResult } from "../src/coding-agent/agent-result.ts";
import {
  GitHubManagedQueueService,
  type GhRunner,
  type GitHubManagedQueueAdapter,
  type ManagedQueueWatermark,
} from "../src/github/managed-queue-service.ts";
import { createCli } from "./_helpers/create-cli.ts";

const planResult = AgentResult.fromJsonLines(JSON.stringify({
  type: "text",
  sessionID: "ses_plan",
  part: { type: "text", text: "plan" },
}));

const agentSource = {
  run: async () => ({ result: planResult, azureLoginRequired: false }),
  resume: async () => planResult,
};

function ghRunner(responses: Array<[string, string]>, calls: string[] = []): GhRunner {
  const table = new Map(responses);
  return async (args) => {
    const key = args.join(" ");
    calls.push(key);
    if (table.has(key)) return table.get(key)!;
    throw new Error(`unexpected gh args: ${key}`);
  };
}

function issueDetail(number: number, labels: string[]): string {
  return JSON.stringify({
    number,
    title: `feat: ticket ${number}`,
    state: "OPEN",
    labels: labels.map((name) => ({ name })),
    assignees: [],
    createdAt: "2026-01-01T00:00:00Z",
    blockedBy: { nodes: [] },
    body: "",
    comments: [],
  });
}

test("el plan aplica y verifica ready-for-agent en cada Issue publicado tras la marca", async () => {
  const calls: string[] = [];
  const service = new GitHubManagedQueueService(ghRunner([
    ["issue list --state all --limit 1 --json number", JSON.stringify([{ number: 15 }])],
    ["issue list --state all --limit 100 --json number,title,labels", JSON.stringify([
      { number: 17, title: "feat: ticket 17", labels: [] },
      { number: 16, title: "feat: ticket 16", labels: [{ name: "enhancement" }] },
      { number: 15, title: "feat: anterior", labels: [] },
    ])],
    ["label list --limit 100 --json name", JSON.stringify([{ name: "enhancement" }])],
    ["label create ready-for-agent --color 0E8A16 --description Issue ready for agent execution", ""],
    ["issue edit 16 --add-label ready-for-agent", ""],
    ["issue edit 17 --add-label ready-for-agent", ""],
    ["issue view 16 --json number,title,state,labels,assignees,createdAt,blockedBy,body,comments", issueDetail(16, ["enhancement", "ready-for-agent"])],
    ["issue view 17 --json number,title,state,labels,assignees,createdAt,blockedBy,body,comments", issueDetail(17, ["ready-for-agent"])],
  ], calls));

  const code = await createCli({ agentSource, githubManagedQueue: service })
    .run(["plan", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  // La marca se lee antes de abrir la sesion, y el orden de etiquetado es ascendente.
  expect(calls[0]).toBe("issue list --state all --limit 1 --json number");
  expect(calls.filter((call) => call.startsWith("issue edit"))).toEqual([
    "issue edit 16 --add-label ready-for-agent",
    "issue edit 17 --add-label ready-for-agent",
  ]);
  expect(calls).toContain("label create ready-for-agent --color 0E8A16 --description Issue ready for agent execution");
});

test("el plan no toca los Issues previos a la marca ni los que ya llevan el rol", async () => {
  const calls: string[] = [];
  const service = new GitHubManagedQueueService(ghRunner([
    ["issue list --state all --limit 1 --json number", JSON.stringify([{ number: 20 }])],
    ["issue list --state all --limit 100 --json number,title,labels", JSON.stringify([
      { number: 21, title: "feat: ticket 21", labels: [{ name: "ready-for-agent" }] },
      { number: 20, title: "feat: anterior", labels: [] },
    ])],
  ], calls));

  const code = await createCli({ agentSource, githubManagedQueue: service })
    .run(["plan", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(calls.some((call) => call.startsWith("issue edit"))).toBeFalse();
  expect(calls.some((call) => call.startsWith("label"))).toBeFalse();
});

test("el plan deja fuera epics y specs, que la cola tampoco admite", async () => {
  const calls: string[] = [];
  const service = new GitHubManagedQueueService(ghRunner([
    ["issue list --state all --limit 1 --json number", JSON.stringify([{ number: 30 }])],
    ["issue list --state all --limit 100 --json number,title,labels", JSON.stringify([
      { number: 31, title: "[Spec] Autenticacion", labels: [] },
      { number: 32, title: "[Epic] Autenticacion", labels: [] },
      { number: 33, title: "feat: epic por etiqueta", labels: [{ name: "epic" }] },
      { number: 34, title: "feat: ticket 34", labels: [] },
    ])],
    ["label list --limit 100 --json name", JSON.stringify([{ name: "ready-for-agent" }])],
    ["issue edit 34 --add-label ready-for-agent", ""],
    ["issue view 34 --json number,title,state,labels,assignees,createdAt,blockedBy,body,comments", issueDetail(34, ["ready-for-agent"])],
  ], calls));

  const code = await createCli({ agentSource, githubManagedQueue: service })
    .run(["plan", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(calls.filter((call) => call.startsWith("issue edit"))).toEqual([
    "issue edit 34 --add-label ready-for-agent",
  ]);
});

test("un rol que no queda verificable detiene la corrida", async () => {
  const service = new GitHubManagedQueueService(ghRunner([
    ["issue list --state all --limit 1 --json number", JSON.stringify([{ number: 40 }])],
    ["issue list --state all --limit 100 --json number,title,labels", JSON.stringify([
      { number: 41, title: "feat: ticket 41", labels: [] },
    ])],
    ["label list --limit 100 --json name", JSON.stringify([{ name: "ready-for-agent" }])],
    ["issue edit 41 --add-label ready-for-agent", ""],
    ["issue view 41 --json number,title,state,labels,assignees,createdAt,blockedBy,body,comments", issueDetail(41, [])],
  ]));

  const code = await createCli({ agentSource, githubManagedQueue: service })
    .run(["plan", "--working-directory", "/repo"]);

  expect(code).toBe(1);
});

test("una marca ilegible detiene la corrida antes de abrir la sesion", async () => {
  let sessions = 0;
  const failing: GitHubManagedQueueAdapter = {
    async selectAndClaimEligibleIssue() { throw new Error("not used"); },
    async readQueueWatermark(): Promise<ManagedQueueWatermark> { throw new Error("gh issue list fallo"); },
  };

  const code = await createCli({
    agentSource: {
      run: async () => { sessions += 1; return { result: planResult, azureLoginRequired: false }; },
      resume: async () => planResult,
    },
    githubManagedQueue: failing,
  }).run(["plan", "--working-directory", "/repo"]);

  expect(code).toBe(1);
  expect(sessions).toBe(0);
});
