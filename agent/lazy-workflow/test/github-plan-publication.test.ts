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

/**
 * Un plan cortado de una épica (`plan --issue`, ADR-0047): la sesión recibe la
 * épica que leyó el coordinador, y cada Issue publicado queda como sub-issue
 * de ella, que es la relación que la reconciliación de padres lee para cerrarla.
 */
test("con épica, cada Issue cuelga de ella en orden de publicación y antes de las aristas", async () => {
  const order: string[] = [];
  const { boundary } = recordingBoundary();
  const publication = await publishPlanIssues({
    createReadyIssue: async (input, directory) => { order.push(`create:${input.title}`); return boundary.createReadyIssue(input, directory); },
    linkBlockedBy: async (blocked, blockerId, directory) => { order.push(`block:${blocked}`); return boundary.linkBlockedBy(blocked, blockerId, directory); },
    addSubIssue: async (parent, childId) => { order.push(`sub:${parent}:${childId}`); return { linked: true }; },
  }, [ticket("segundo", ["primero"]), ticket("primero")], "/repo", 40);

  expect(order).toEqual(["create:primero", "create:segundo", "sub:40:42000", "sub:40:43000", "block:43"]);
  expect(publication.epic).toEqual({ issue: 40, subIssues: [{ issue: 42, linked: true }, { issue: 43, linked: true }] });
});

test("sin épica la publicación no toca la relación de sub-issues", async () => {
  const { boundary } = recordingBoundary();
  let subIssues = 0;
  const publication = await publishPlanIssues({ ...boundary, addSubIssue: async () => { subIssues += 1; return { linked: true }; } }, [ticket("solo")], "/repo");

  expect(subIssues).toBe(0);
  expect(publication.epic).toBeUndefined();
});

test("el sub-issue usa la relación nativa, se verifica y no se duplica", async () => {
  const calls: string[] = [];
  const list = "api --paginate --slurp repos/{owner}/{repo}/issues/40/sub_issues?per_page=100";
  let linked = false;
  const service = new GitHubManagedQueueService(ghRunner([
    [list, () => JSON.stringify([linked ? [{ id: 6100 }] : []])],
    ["api --method POST repos/{owner}/{repo}/issues/40/sub_issues -F sub_issue_id=6100", () => { linked = true; return "{}"; }],
  ], calls));

  expect(await service.addSubIssue(40, 6100, "/repo")).toEqual({ linked: true });
  expect(await service.addSubIssue(40, 6100, "/repo")).toEqual({ linked: false });
  expect(calls).toEqual([list, "api --method POST repos/{owner}/{repo}/issues/40/sub_issues -F sub_issue_id=6100", list, list]);
});

test("un sub-issue que GitHub no registra detiene la publicación", async () => {
  const service = new GitHubManagedQueueService(ghRunner([
    ["api --paginate --slurp repos/{owner}/{repo}/issues/40/sub_issues?per_page=100", JSON.stringify([[]])],
    ["api --method POST repos/{owner}/{repo}/issues/40/sub_issues -F sub_issue_id=6100", "{}"],
  ]));

  expect(service.addSubIssue(40, 6100, "/repo")).rejects.toThrow("sub-issue 6100 verificable");
});

const EPIC_VIEW = "issue view 40 --json number,title,state,labels,assignees,createdAt,blockedBy,body,comments";

function epicDetail(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 40, title: "[Epic] Portal de pagos", state: "OPEN", labels: [], assignees: [], createdAt: "2026-10-01T00:00:00Z",
    blockedBy: { nodes: [] }, body: "Cuerpo de la épica", comments: [{ body: "Un comentario" }], ...overrides,
  });
}

test("plan --issue entrega la épica a la sesión y publica sus rebanadas como sub-issues", async () => {
  const calls: string[] = [];
  const prompts: string[] = [];
  const list = "api --paginate --slurp repos/{owner}/{repo}/issues/40/sub_issues?per_page=100";
  const children = new Set<number>();
  const service = new GitHubManagedQueueService(ghRunner([
    [EPIC_VIEW, epicDetail()],
    ["label list --limit 100 --json name", JSON.stringify([{ name: "ready-for-agent" }])],
    ["api repos/{owner}/{repo}/issues -f title=uno -f body=cuerpo de uno -f labels[]=ready-for-agent", createdIssue(61, 6100, ["ready-for-agent"])],
    [list, () => JSON.stringify([[...children].map((id) => ({ id }))])],
    ["api --method POST repos/{owner}/{repo}/issues/40/sub_issues -F sub_issue_id=6100", () => { children.add(6100); return "{}"; }],
  ], calls));
  const result = new AgentResult({ sessionId: "ses_plan", text: planReady([ticket("uno")]) });

  const code = await silently(() => createCli({
    agentSource: { run: async (options) => { prompts.push(options.prompt); return { result, azureLoginRequired: false }; }, resume: async () => result },
    githubManagedQueue: service,
    git: async () => "",
  }).run(["plan", "--issue", "40", "--working-directory", "/repo"]));

  expect(code).toBe(0);
  expect(calls[0]).toBe(EPIC_VIEW);
  expect(prompts[0]).toContain("GitHub epic #40");
  expect(prompts[0]).toContain("Cuerpo de la épica");
  expect(children).toEqual(new Set([6100]));
});

test("plan --issue no abre sesión si la issue no es una épica o está cerrada", async () => {
  for (const detail of [epicDetail({ title: "Arreglar el login" }), epicDetail({ state: "CLOSED" })]) {
    let sessions = 0;
    const service = new GitHubManagedQueueService(ghRunner([[EPIC_VIEW, detail]]));
    const code = await silently(() => createCli({
      agentSource: { run: async () => { sessions += 1; throw new Error("no session"); }, resume: async () => { throw new Error("no session"); } },
      githubManagedQueue: service,
      git: async () => "",
    }).run(["plan", "--issue", "40", "--working-directory", "/repo"]));

    expect(code).toBe(1);
    expect(sessions).toBe(0);
  }
});

test("una épica por etiqueta también se planifica", async () => {
  const service = new GitHubManagedQueueService(ghRunner([[EPIC_VIEW, epicDetail({ title: "Portal de pagos", labels: [{ name: "epic" }] })]]));
  const result = new AgentResult({ sessionId: "ses_plan", text: planReady([]) });

  const code = await silently(() => createCli({
    agentSource: { run: async () => ({ result, azureLoginRequired: false }), resume: async () => result },
    githubManagedQueue: service,
    git: async () => "",
  }).run(["plan", "--issue", "40", "--working-directory", "/repo"]));

  expect(code).toBe(0);
});

test("plan no acepta una épica GitHub y una HU Azure a la vez", async () => {
  let sessions = 0;
  const code = await silently(() => createCli({
    agentSource: { run: async () => { sessions += 1; throw new Error("no session"); }, resume: async () => { throw new Error("no session"); } },
    git: async () => "",
  }).run(["plan", "--issue", "40", "--hu", "7", "--working-directory", "/repo"]));

  expect(code).toBe(1);
  expect(sessions).toBe(0);
});
