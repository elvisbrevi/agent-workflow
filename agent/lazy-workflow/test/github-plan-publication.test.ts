/**
 * La publicación GitHub del plan: el coordinador crea los Issues, la sesión no.
 *
 * La sesión devuelve sus rebanadas detrás de `PLAN_READY`; crear cada Issue con
 * su rol de triage y cablear las aristas de bloqueo es trabajo mecánico, y lo
 * hace el coordinador con primitivas tipadas (ADR-0040).
 */
import { expect, test } from "bun:test";
import { AgentResult } from "../src/coding-agent/agent-result.ts";
import { PLAN_READY_MARKER } from "../src/prompts/workflow-contract.ts";
import { createCli } from "./_helpers/create-cli.ts";
import { GitHubManagedQueueService, type GhRunner } from "../src/github/managed-queue-service.ts";
import { publishPlanIssues, type GitHubPlanPublicationBoundary } from "../src/github/plan-publication-service.ts";
import type { PlannedTicket } from "../src/prompts/plan-contract.ts";

function ticket(title: string, blockedBy: string[] = []): PlannedTicket {
  return { type: "Task", title, body: `cuerpo de ${title}`, blockedBy };
}

function recordingBoundary(): { boundary: GitHubPlanPublicationBoundary; created: string[]; links: Array<[number, number]> } {
  const created: string[] = [];
  const links: Array<[number, number]> = [];
  let next = 41;
  return {
    created,
    links,
    boundary: {
      async createReadyIssue({ title }) {
        created.push(title);
        next += 1;
        return { number: next, id: next * 1000 };
      },
      async linkBlockedBy(blocked, blockerId) {
        links.push([blocked, blockerId]);
        return { linked: true };
      },
    },
  };
}

test("publica los bloqueantes antes de lo que desbloquean y cablea cada arista declarada", async () => {
  const { boundary, created, links } = recordingBoundary();

  const publication = await publishPlanIssues(
    boundary,
    [ticket("segundo", ["primero"]), ticket("primero")],
    "/repo",
  );

  expect(created).toEqual(["primero", "segundo"]);
  expect(publication.issues).toEqual([
    { title: "primero", issue: 42 },
    { title: "segundo", issue: 43 },
  ]);
  // La arista viaja como el id del bloqueante sobre el Issue bloqueado.
  expect(links).toEqual([[43, 42000]]);
  expect(publication.blockingLinks).toEqual([{ blocker: 42, blocked: 43, linked: true }]);
});

test("un plan sin aristas no cablea ninguna relación", async () => {
  const { boundary, links } = recordingBoundary();

  const publication = await publishPlanIssues(boundary, [ticket("solo")], "/repo");

  expect(links).toEqual([]);
  expect(publication.blockingLinks).toEqual([]);
});

test("el directorio de trabajo llega a cada primitiva", async () => {
  const directories: string[] = [];
  const boundary: GitHubPlanPublicationBoundary = {
    async createReadyIssue(_input, workingDirectory) {
      directories.push(workingDirectory);
      return { number: 7, id: 700 };
    },
    async linkBlockedBy(_blocked, _blockerId, workingDirectory) {
      directories.push(workingDirectory);
      return { linked: true };
    },
  };

  await publishPlanIssues(boundary, [ticket("uno"), ticket("dos", ["uno"])], "/otro-repo");

  expect(directories).toEqual(["/otro-repo", "/otro-repo", "/otro-repo"]);
});

/**
 * Las primitivas `gh` de la publicación: el rol viaja en la misma llamada que
 * crea el Issue, y la arista usa la relación nativa de dependencias.
 */
type GhResponse = string | (() => string);

function ghRunner(responses: Array<[string, GhResponse]>, calls: string[] = []): GhRunner {
  const table = new Map(responses);
  return async (args) => {
    const key = args.join(" ");
    calls.push(key);
    const response = table.get(key);
    if (response === undefined) throw new Error(`unexpected gh args: ${key}`);
    return typeof response === "function" ? response() : response;
  };
}

function createdIssue(number: number, id: number, labels: string[]): string {
  return JSON.stringify({ number, id, labels: labels.map((name) => ({ name })) });
}

test("crear el Issue lleva la etiqueta ready-for-agent en la misma llamada", async () => {
  const calls: string[] = [];
  const service = new GitHubManagedQueueService(ghRunner([
    ["label list --limit 100 --json name", JSON.stringify([{ name: "ready-for-agent" }])],
    [
      "api repos/{owner}/{repo}/issues -f title=Rebanada uno -f body=cuerpo -f labels[]=ready-for-agent",
      createdIssue(51, 5100, ["ready-for-agent"]),
    ],
  ], calls));

  const created = await service.createReadyIssue({ title: "Rebanada uno", body: "cuerpo" }, "/repo");

  expect(created).toEqual({ number: 51, id: 5100 });
  expect(calls).toEqual([
    "label list --limit 100 --json name",
    "api repos/{owner}/{repo}/issues -f title=Rebanada uno -f body=cuerpo -f labels[]=ready-for-agent",
  ]);
});

test("la etiqueta que el repositorio no tiene se crea antes de usarla", async () => {
  const calls: string[] = [];
  const service = new GitHubManagedQueueService(ghRunner([
    ["label list --limit 100 --json name", JSON.stringify([{ name: "enhancement" }])],
    ["label create ready-for-agent --color 0E8A16 --description Issue ready for agent execution", ""],
    ["api repos/{owner}/{repo}/issues -f title=uno -f body=b -f labels[]=ready-for-agent", createdIssue(1, 10, ["ready-for-agent"])],
  ], calls));

  await service.createReadyIssue({ title: "uno", body: "b" }, "/repo");

  expect(calls).toEqual([
    "label list --limit 100 --json name",
    "label create ready-for-agent --color 0E8A16 --description Issue ready for agent execution",
    "api repos/{owner}/{repo}/issues -f title=uno -f body=b -f labels[]=ready-for-agent",
  ]);
});

test("un Issue que no vuelve con el rol detiene la publicación", async () => {
  const service = new GitHubManagedQueueService(ghRunner([
    ["label list --limit 100 --json name", JSON.stringify([{ name: "ready-for-agent" }])],
    ["api repos/{owner}/{repo}/issues -f title=uno -f body=b -f labels[]=ready-for-agent", createdIssue(9, 90, [])],
  ]));

  expect(service.createReadyIssue({ title: "uno", body: "b" }, "/repo")).rejects.toThrow("ready-for-agent");
});

test("la arista de bloqueo usa la relación nativa de dependencias de GitHub", async () => {
  const calls: string[] = [];
  const edge = "api repos/{owner}/{repo}/issues/43/dependencies/blocked_by";
  let wired = false;
  const service = new GitHubManagedQueueService(ghRunner([
    [edge, () => JSON.stringify(wired ? [{ id: 4200 }] : [])],
    ["api --method POST repos/{owner}/{repo}/issues/43/dependencies/blocked_by -F issue_id=4200", () => { wired = true; return "{}"; }],
  ], calls));

  expect(await service.linkBlockedBy(43, 4200, "/repo")).toEqual({ linked: true });
  // Se lee antes de escribir y se vuelve a leer para verificar.
  expect(calls).toEqual([
    edge,
    "api --method POST repos/{owner}/{repo}/issues/43/dependencies/blocked_by -F issue_id=4200",
    edge,
  ]);
});

test("una arista que ya existe no se vuelve a escribir", async () => {
  const calls: string[] = [];
  const service = new GitHubManagedQueueService(ghRunner([
    ["api repos/{owner}/{repo}/issues/43/dependencies/blocked_by", JSON.stringify([{ id: 4200 }])],
  ], calls));

  expect(await service.linkBlockedBy(43, 4200, "/repo")).toEqual({ linked: false });
  expect(calls).toEqual(["api repos/{owner}/{repo}/issues/43/dependencies/blocked_by"]);
});

test("una arista que GitHub no registra detiene la publicación", async () => {
  const service = new GitHubManagedQueueService(ghRunner([
    ["api repos/{owner}/{repo}/issues/43/dependencies/blocked_by", JSON.stringify([])],
    ["api --method POST repos/{owner}/{repo}/issues/43/dependencies/blocked_by -F issue_id=4200", "{}"],
  ]));

  expect(service.linkBlockedBy(43, 4200, "/repo")).rejects.toThrow("arista de bloqueo verificable");
});

/**
 * Y el mismo contrato visto desde la corrida: un `plan` GitHub publica lo que
 * la sesion devolvio, y nada mas.
 */
function planning(text: string) {
  const result = new AgentResult({ sessionId: "ses_plan", text });
  return { run: async () => ({ result, azureLoginRequired: false }), resume: async () => result };
}

function planReady(tickets: unknown[]): string {
  return `${PLAN_READY_MARKER}\n${JSON.stringify({ tickets })}`;
}

const silently = async (run: () => Promise<number>): Promise<number> => {
  const original = console.log;
  console.log = () => undefined;
  try {
    return await run();
  } finally {
    console.log = original;
  }
};

test("el plan crea cada Issue con su rol y cablea la arista declarada", async () => {
  const calls: string[] = [];
  const edge = "api repos/{owner}/{repo}/issues/62/dependencies/blocked_by";
  let wired = false;
  const service = new GitHubManagedQueueService(ghRunner([
    ["label list --limit 100 --json name", JSON.stringify([{ name: "ready-for-agent" }])],
    ["api repos/{owner}/{repo}/issues -f title=primero -f body=cuerpo de primero -f labels[]=ready-for-agent", createdIssue(61, 6100, ["ready-for-agent"])],
    ["api repos/{owner}/{repo}/issues -f title=segundo -f body=cuerpo de segundo -f labels[]=ready-for-agent", createdIssue(62, 6200, ["ready-for-agent"])],
    [edge, () => JSON.stringify(wired ? [{ id: 6100 }] : [])],
    [`api --method POST ${edge.slice("api ".length)} -F issue_id=6100`, () => { wired = true; return "{}"; }],
  ], calls));

  const code = await silently(() => createCli({
    agentSource: planning(planReady([ticket("segundo", ["primero"]), ticket("primero")])),
    githubManagedQueue: service,
    git: async () => "",
  }).run(["plan", "--working-directory", "/repo"]));

  expect(code).toBe(0);
  // Ninguna lectura de numeracion: lo que el plan publico es lo que este codigo creo.
  expect(calls.some((call) => call.startsWith("issue list"))).toBeFalse();
  expect(calls.filter((call) => call.startsWith("api repos/{owner}/{repo}/issues -f"))).toEqual([
    "api repos/{owner}/{repo}/issues -f title=primero -f body=cuerpo de primero -f labels[]=ready-for-agent",
    "api repos/{owner}/{repo}/issues -f title=segundo -f body=cuerpo de segundo -f labels[]=ready-for-agent",
  ]);
  expect(calls).toContain("api --method POST repos/{owner}/{repo}/issues/62/dependencies/blocked_by -F issue_id=6100");
});

test("un Issue abierto a mano durante la sesion no queda etiquetado", async () => {
  const calls: string[] = [];
  const service = new GitHubManagedQueueService(ghRunner([], calls));

  const code = await silently(() => createCli({
    agentSource: planning(planReady([])),
    githubManagedQueue: service,
    git: async () => "",
  }).run(["plan", "--working-directory", "/repo"]));

  expect(code).toBe(0);
  expect(calls).toEqual([]);
});

test("una sesion que no emite PLAN_READY detiene la corrida sin crear nada", async () => {
  const calls: string[] = [];
  const service = new GitHubManagedQueueService(ghRunner([], calls));

  const code = await silently(() => createCli({
    agentSource: planning("plan sin marcador"),
    githubManagedQueue: service,
    git: async () => "",
  }).run(["plan", "--working-directory", "/repo"]));

  expect(code).toBe(1);
  expect(calls).toEqual([]);
});

test("una publicacion que falla detiene la corrida", async () => {
  const service = new GitHubManagedQueueService(ghRunner([
    ["label list --limit 100 --json name", JSON.stringify([{ name: "ready-for-agent" }])],
  ]));

  const code = await silently(() => createCli({
    agentSource: planning(planReady([ticket("uno")])),
    githubManagedQueue: service,
    git: async () => "",
  }).run(["plan", "--working-directory", "/repo"]));

  expect(code).toBe(1);
});
