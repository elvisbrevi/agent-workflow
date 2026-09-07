import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";
import {
  CONTRACT_LITERALS,
  IMPLEMENTATION_READY_MARKER,
  QUESTIONS_ANSWERED_MARKER,
  QUESTIONS_PENDING_MARKER,
  QUEUE_BLOCKED_MARKER,
  QUEUE_EMPTY_MARKER,
  UnknownContractPlaceholderError,
  renderContract,
} from "../src/prompts/workflow-contract.ts";
import {
  buildInterviewAnswersPrompt,
  buildResumePrompt,
  buildWorkflowPrompt,
  resolveWorkflowRun,
  type WorkflowPromptContext,
} from "../src/prompts/workflow-prompt.ts";
import { HuInfo } from "../src/azure/hu-info.ts";
import type { SelectedManagedIssue } from "../src/github/managed-queue-service.ts";
import type { WorkspaceScope } from "../src/workspace/repository-scope.ts";

const context: WorkflowPromptContext = {
  operatorRequest: "entrega lo pedido",
  workingDirectory: "/repo",
  questions: 3,
};

const issue: SelectedManagedIssue = {
  number: 201,
  title: "Add the thing",
  state: "OPEN",
  labels: [{ name: "ready-for-agent" }],
  assignees: [{ login: "elvisbrevi" }],
  createdAt: "2026-01-01T00:00:00Z",
  blockedBy: { nodes: [] },
  body: "body of #201",
  comments: ["a comment"],
};

const scope: WorkspaceScope = {
  repositories: [
    { path: "/ws/api", remote: "https://github.com/o/api.git", providerIdentity: null },
    { path: "/ws/web", remote: "https://github.com/o/web.git", providerIdentity: null },
  ],
  parentDirectory: "/ws",
  stateDirectory: "/ws/.state",
};

const topology = { integrationBranch: "refs/heads/hu/23438", ticketBranch: "refs/heads/ticket/51" };

/** What the coordinator reads off the ticket before it opens the session. */
const deliveryContext = {
  hu: { id: 23438, title: "HU transversal de pagos" },
  ticket: { id: 51, title: "Conciliar el intento de pago", type: "Task" as const, state: "Active" },
  integrationBranch: "refs/heads/hu/23438",
  project: "Procesos Digitales",
};

test("renderContract resuelve los placeholders del contrato", () => {
  expect(renderContract("marca {{IMPLEMENTATION_READY}}")).toBe(`marca ${IMPLEMENTATION_READY_MARKER}`);
});

test("renderContract falla cerrado ante un placeholder desconocido", () => {
  expect(() => renderContract("{{NO_EXISTE}}")).toThrow(UnknownContractPlaceholderError);
});

test("renderContract resuelve bindings de runtime", () => {
  expect(renderContract("trabajo {{UNIT_ID}}", { UNIT_ID: "#42" })).toBe("trabajo #42");
});

test("renderContract falla cerrado ante un binding de runtime desconocido", () => {
  expect(() => renderContract("{{DESCONOCIDO}}", { UNIT_ID: "#42" })).toThrow(UnknownContractPlaceholderError);
});

test("ningun asset de prompt fija un literal del contrato", async () => {
  const directory = new URL("../prompts/", import.meta.url);
  const assets = (await readdir(directory)).filter((name) => name.endsWith(".md"));
  expect(assets.length).toBeGreaterThan(0);
  for (const asset of assets) {
    const raw = await Bun.file(new URL(asset, directory)).text();
    // A placeholder spells its own name, so drop placeholders before scanning:
    // what must not survive is a contract literal written out by hand.
    const outsidePlaceholders = raw.replace(/\{\{[A-Z_]+\}\}/g, "");
    for (const literal of CONTRACT_LITERALS) {
      expect(`${asset}: ${outsidePlaceholders.includes(literal)}`).toBe(`${asset}: false`);
    }
  }
});

test("resolveWorkflowRun resuelve el proveedor una sola vez desde --hu", () => {
  expect(resolveWorkflowRun(null)).toEqual({ kind: "github-repository-run" });
  expect(resolveWorkflowRun(23438)).toEqual({ kind: "azure-hu-run", hu: 23438 });
});

test("el plan GitHub declara su workflow y su presupuesto de preguntas", async () => {
  const prompt = await buildWorkflowPrompt({ kind: "github-plan" }, context);
  expect(prompt).toContain("This is a planning workflow: do not implement code.");
  expect(prompt).toContain("The number of questions must be 3");
  expect(prompt).toContain("The working directory is /repo");
  expect(prompt.endsWith("Operator request:\nentrega lo pedido")).toBe(true);
});

test("cada run recibe solo la rama de workflow que el coordinador eligio", async () => {
  const plan = await buildWorkflowPrompt({ kind: "github-plan" }, context);
  expect(plan).toContain("This is a planning workflow: do not implement code.");
  expect(plan).not.toContain("deliver that exact issue");

  const code = await buildWorkflowPrompt({
    kind: "github-delivery",
    issue,
    repository: { nameWithOwner: "o/api" },
    branch: "issue/201",
  }, context);
  expect(code).toContain("/implement the issue #201");
  expect(code).not.toContain("This is a planning workflow");
});

test("el plan Azure adjunta la HU y no implementa codigo", async () => {
  const huInfo = { id: 23438, title: "HU" } as never;
  const prompt = await buildWorkflowPrompt({ kind: "azure-plan", huInfo }, context);
  expect(prompt).toContain('"id":23438');
  expect(prompt).toContain("Do not implement code");
  expect(prompt).toContain("The working directory is /repo");
});

test("el run mono-repositorio y el workspace reciben las mismas secciones de planning Azure", async () => {
  const huInfo = { id: 23438, title: "HU compartida" } as never;

  const monoRepo = await buildWorkflowPrompt({ kind: "azure-plan", huInfo }, context);
  const workspace = await buildWorkflowPrompt({ kind: "workspace-plan", scope, run: { kind: "azure-hu-run", hu: 23438 }, huInfo }, context);

  // The HU data, the autoplan prompt, and the question budget are the Azure HU
  // planning run's own sections: both modes must receive the exact same text,
  // built from the same helper, not two independently written literals.
  const huSection = JSON.stringify(huInfo);
  const questionsLine = "The number of questions must be 3";
  for (const prompt of [monoRepo, workspace]) {
    expect(prompt).toContain(huSection);
    expect(prompt).toContain("PLAN_READY");
    expect(prompt).toContain(questionsLine);
  }
});

test("la entrega GitHub fija issue, rama, manifest y markers", async () => {
  const prompt = await buildWorkflowPrompt({
    kind: "github-delivery",
    issue,
    repository: { nameWithOwner: "o/api" },
    branch: "issue/201",
  }, context);
  // El trabajo, y nada del contrato (ADR-0036). El Issue viaja como su número: la sesión
  // tiene `gh` y lee el cuerpo fresco.
  expect(prompt).toBe([
    "/implement the issue #201 usando /tdd /caveman /ponytail y /code-review.",
    "trabaja y comitea en esta misma branch.",
    "no abras PR, no me hagas preguntas.",
    "termina con un resumen de lo realizado entendible por un humano.",
    "entrega lo pedido",
  ].join("\n"));
  expect(prompt).not.toContain('"body of #201"');
});

test("la reconciliacion GitHub conserva el contrato de entrega y fija los commits", async () => {
  const prompt = await buildWorkflowPrompt({
    kind: "github-reconciliation",
    issue,
    repository: { nameWithOwner: "o/api" },
    branch: "issue/201",
    pullRequest: 314,
    originalCommit: "aaaa111",
    baseCommit: "bbbb222",
  }, context);
  expect(prompt).toContain("Coordinator-fixed pull request: #314");
  expect(prompt).toContain("Original implementation commit: aaaa111");
  expect(prompt).toContain("Coordinator-fetched base commit: bbbb222");
  expect(prompt).toContain("Merge exactly bbbb222 into issue/201");
});

test("la entrega workspace GitHub comparte el asset de entrega de un repositorio y declara el roster", async () => {
  const prompt = await buildWorkflowPrompt({
    kind: "github-workspace-delivery",
    scope,
    issue,
    units: [
      { path: "/ws/api", branch: "issue/201" } as never,
      { path: "/ws/web", branch: "issue/201" } as never,
    ],
  }, context);
  // El mismo asset que usa un solo repositorio (ADR-0036), con el número del Issue: issue #313.
  expect(prompt).toContain("/implement the issue #201 usando /tdd /caveman /ponytail y /code-review.");
  expect(prompt).toContain("Workspace parent directory: /ws");
  expect(prompt).toContain("1. /ws/api (https://github.com/o/api.git)");
  expect(prompt).toContain("2. /ws/web (https://github.com/o/web.git)");
  expect(prompt).toContain("Trabaja los repositorios en el orden declarado");
  expect(prompt).toContain("/ws/api: issue/201");
  expect(prompt).toContain("/ws/web: issue/201");
  expect(prompt).toContain("The working directory is /ws");
});

test("un run Azure nunca recibe el alcance GitHub", async () => {
  const huInfo = { id: 23438 } as never;

  const workspacePlan = await buildWorkflowPrompt({ kind: "workspace-plan", scope, run: { kind: "azure-hu-run", hu: 23438 }, huInfo }, context);
  expect(workspacePlan).toContain("address the current User Story");
  expect(workspacePlan).toContain("PLAN_READY");
  expect(workspacePlan).not.toContain("Use GitHub and `gh` for");

  const workspaceDelivery = await buildWorkflowPrompt({
    kind: "azure-workspace-delivery",
    scope,
    hu: 23438,
    ticket: 51,
    context: deliveryContext,
    description: null,
    topology: topology as never,
    ticketTopology: topology as never,
  }, context);
  expect(workspaceDelivery).toContain("/implement el ticket 51");
  expect(workspaceDelivery).not.toContain("Use GitHub and `gh` for");
});

test("un plan de workspace GitHub conserva su roster y su workflow", async () => {
  const prompt = await buildWorkflowPrompt({ kind: "workspace-plan", scope, run: { kind: "github-repository-run" }, huInfo: null }, context);
  expect(prompt).toContain("This is a planning workflow: do not implement code.");
  expect(prompt).not.toContain("child work items");
});

test("la entrega workspace Azure fija HU, ticket y ambas ramas", async () => {
  const prompt = await buildWorkflowPrompt({
    kind: "azure-workspace-delivery",
    scope,
    hu: 23438,
    ticket: 51,
    context: deliveryContext,
    description: null,
    topology: topology as never,
    ticketTopology: topology as never,
  }, context);
  expect(prompt).toContain('"id":23438');
  expect(prompt).toContain("/implement el ticket 51");
  expect(prompt).toContain("Rama de integración: refs/heads/hu/23438");
  expect(prompt).toContain("Rama del ticket: refs/heads/ticket/51");
  // El roster ordena el trabajo; el contrato del manifest ya no existe (ADR-0036, ADR-0037).
  expect(prompt).toContain("1. /ws/api");
  expect(prompt).not.toContain("manifest");
});

test("la entrega Azure nombra el ticket, lo describe y dice el trabajo, nada más", async () => {
  const prompt = await buildWorkflowPrompt({
    kind: "azure-delivery",
    context: { hu: { id: 23438 }, ticket: { id: 51, title: "Migrar el endpoint" }, integrationBranch: "refs/heads/hu/23438" } as never,
    ticketBranch: "refs/heads/ticket/51",
  }, context);

  expect(prompt).toContain("/implement el ticket 51 usando /tdd /caveman /ponytail y /code-review.");
  // El ticket viaja entero porque la sesión no tiene `az` con el que leerlo.
  expect(prompt).toContain('"title":"Migrar el endpoint"');
  expect(prompt).toContain("trabaja y comitea en esta misma branch.");
  expect(prompt).toContain("termina con un resumen de lo realizado entendible por un humano.");
});

test("la entrega Azure ya no lleva el contrato de manifest, evidencia ni marcador", async () => {
  const prompt = await buildWorkflowPrompt({
    kind: "azure-delivery",
    context: { hu: { id: 23438 }, ticket: { id: 51 }, integrationBranch: "refs/heads/hu/23438" } as never,
    ticketBranch: "refs/heads/ticket/51",
  }, context);

  expect(prompt).not.toContain(IMPLEMENTATION_READY_MARKER);
  expect(prompt).not.toContain("Supplemental operator request (non-authoritative):");
});

test("la entrega Azure y la GitHub dicen el mismo trabajo", async () => {
  const azure = await buildWorkflowPrompt({
    kind: "azure-delivery",
    context: { hu: { id: 23438 }, ticket: { id: 51 }, integrationBranch: "refs/heads/hu/23438" } as never,
    ticketBranch: "refs/heads/ticket/51",
  }, context);
  const github = await buildWorkflowPrompt(
    { kind: "github-delivery", issue, repository: { nameWithOwner: "o/api" } as never, branch: "issue/201" },
    context,
  );

  const delivery = (await Bun.file(new URL("../prompts/delivery-prompt.md", import.meta.url)).text()).trimEnd();
  expect(azure).toContain(delivery);
  expect(github).toContain(delivery);
});

test("buildResumePrompt solo adjunta normas SAG cuando existen", () => {
  expect(buildResumePrompt("continue", null)).toBe("continue");
  const withNorms = buildResumePrompt("continue", { phase: "coding", paths: [] } as never);
  expect(withNorms).toContain("continue");
  expect(withNorms).toContain("SAG norms context");
});

test("un plan sin entrevista ordena aceptar la recomendación y no menciona rondas", async () => {
  for (const spec of [
    { kind: "github-plan" } as const,
    { kind: "azure-plan", huInfo: new HuInfo({ id: 23438, title: "HU" }) } as const,
  ]) {
    const prompt = await buildWorkflowPrompt(spec, context);

    expect(prompt).toContain("Nobody is available to answer questions");
    expect(prompt).toContain("Do not ask the operator");
    expect(prompt).not.toContain(QUESTIONS_PENDING_MARKER);
  }
});

test("un plan con entrevista fija el protocolo de rondas y su marcador", async () => {
  for (const spec of [
    { kind: "github-plan" } as const,
    { kind: "azure-plan", huInfo: new HuInfo({ id: 23438, title: "HU" }) } as const,
  ]) {
    const prompt = await buildWorkflowPrompt(spec, { ...context, interview: true });

    expect(prompt).toContain("An operator is available to answer questions");
    expect(prompt).toContain(QUESTIONS_PENDING_MARKER);
    expect(prompt).toContain(QUESTIONS_ANSWERED_MARKER);
    expect(prompt).not.toContain("Nobody is available to answer questions");
  }
});

test("el plan workspace lleva la política de respuestas en ambos proveedores", async () => {
  const github = await buildWorkflowPrompt(
    { kind: "workspace-plan", scope, run: resolveWorkflowRun(null), huInfo: null },
    { ...context, interview: true },
  );
  const azure = await buildWorkflowPrompt(
    { kind: "workspace-plan", scope, run: resolveWorkflowRun(23438), huInfo: new HuInfo({ id: 23438, title: "HU" }) },
    context,
  );

  expect(github).toContain("An operator is available to answer questions");
  expect(azure).toContain("Nobody is available to answer questions");
});

test("una entrega nunca recibe la política de respuestas de planificación", async () => {
  const prompt = await buildWorkflowPrompt(
    { kind: "github-delivery", issue, repository: { nameWithOwner: "o/api" } as never, branch: "issue/201" },
    { ...context, interview: true },
  );

  expect(prompt).not.toContain("An operator is available to answer questions");
  expect(prompt).not.toContain("Nobody is available to answer questions");
});

test("el prompt de respuestas lleva el marcador, el payload y cuántas rondas quedan", async () => {
  const answers = { round: 2, source: "operator" as const, answers: [{ id: "q1", answer: "dos" }] };

  const remaining = await buildInterviewAnswersPrompt(answers, 3);
  const last = await buildInterviewAnswersPrompt(answers, 0);

  expect(remaining).toContain(QUESTIONS_ANSWERED_MARKER);
  expect(remaining).toContain(JSON.stringify(answers));
  expect(remaining).toContain("Quedan 3 ronda(s)");
  expect(last).toContain("No quedan rondas de preguntas");
});

test("la entrega workspace Azure lleva el contenido del ticket, no solo su identidad", async () => {
  // El asset `autocode` termina en `HU and ticket context:` y ese hueco lo rellena el
  // coordinador. Rellenarlo solo con las líneas `Coordinator-fixed` le decía a la sesión en qué
  // ticket estaba y nada de lo que el ticket pedía; una sesión que tiene prohibido elegir su
  // propio trabajo solo puede negarse.
  const prompt = await buildWorkflowPrompt({
    kind: "azure-workspace-delivery",
    scope,
    hu: 23438,
    ticket: 51,
    context: deliveryContext,
    description: "Criterio de aceptación: el intento de pago se concilia contra el proveedor.",
    topology: topology as never,
    ticketTopology: topology as never,
  }, context);

  expect(prompt).toContain("Conciliar el intento de pago");
  expect(prompt).toContain("HU transversal de pagos");
  expect(prompt).toContain("Descripción del ticket:");
  expect(prompt).toContain("el intento de pago se concilia contra el proveedor");
  // El contenido del ticket va antes que el roster: es lo que la sesión necesita leer primero.
  expect(prompt.indexOf("Conciliar el intento de pago")).toBeLessThan(prompt.indexOf("Ordered participant repositories"));
});

test("un ticket sin descripción no deja el encabezado colgando", async () => {
  const prompt = await buildWorkflowPrompt({
    kind: "azure-workspace-delivery",
    scope,
    hu: 23438,
    ticket: 51,
    context: deliveryContext,
    description: null,
    topology: topology as never,
    ticketTopology: topology as never,
  }, context);

  expect(prompt).toContain("Conciliar el intento de pago");
  expect(prompt).not.toContain("Ticket description:");
});

test("un plan GitHub pide las rebanadas detrás de PLAN_READY y prohíbe publicarlas", async () => {
  const monoRepo = await buildWorkflowPrompt({ kind: "github-plan" }, context);
  const workspace = await buildWorkflowPrompt(
    { kind: "workspace-plan", scope, run: { kind: "github-repository-run" }, huInfo: null },
    context,
  );

  for (const prompt of [monoRepo, workspace]) {
    expect(prompt).toContain("PLAN_READY");
    expect(prompt).toContain("`blockedBy`");
    expect(prompt).toContain("gh issue create");
    expect(prompt).toContain("Do not create, update, label, or link GitHub issues yourself");
  }
});
