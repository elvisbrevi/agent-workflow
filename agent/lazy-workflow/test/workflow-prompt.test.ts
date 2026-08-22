import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";
import {
  AZURE_MANIFEST_COMMAND,
  AZURE_MANIFEST_TOOL_INSTRUCTION,
  CONTRACT_LITERALS,
  GITHUB_MANIFEST_COMMAND,
  GITHUB_MANIFEST_TOOL_INSTRUCTION,
  HTTP_EVIDENCE_INSTRUCTION,
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
import { EVIDENCE_KINDS, TEXT_EVIDENCE_KINDS } from "../src/azure/completion-manifest.ts";
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
    { path: "/ws/api", remote: "https://github.com/o/api.git" },
    { path: "/ws/web", remote: "https://github.com/o/web.git" },
  ],
  parentDirectory: "/ws",
  stateDirectory: "/ws/.state",
} as WorkspaceScope;

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
  expect(renderContract("{{AZURE_MANIFEST_TOOL}}")).toBe(AZURE_MANIFEST_TOOL_INSTRUCTION);
  expect(renderContract("{{GITHUB_MANIFEST_TOOL}}")).toBe(GITHUB_MANIFEST_TOOL_INSTRUCTION);
});

test("el contrato del manifest nombra la herramienta y prohíbe escribir el archivo", () => {
  // El manifest dejó de ser una forma que la sesión reproduce: es un comando que
  // ejecuta. Si el prompt vuelve a describir el JSON, vuelve a inventarlo.
  for (const instruction of [AZURE_MANIFEST_TOOL_INSTRUCTION, GITHUB_MANIFEST_TOOL_INSTRUCTION]) {
    expect(instruction).toContain("never write, edit, or repair that JSON file yourself");
  }
  expect(AZURE_MANIFEST_TOOL_INSTRUCTION).toContain(`lazy-workflow ${AZURE_MANIFEST_COMMAND}`);
  // Los kinds salen del enum, no de un literal: si alguien agrega uno, el contrato lo nombra solo.
  expect(AZURE_MANIFEST_TOOL_INSTRUCTION).toContain(EVIDENCE_KINDS.join(", "));
  // Y la regla que la sesión solo descubría en la última compuerta, con los PR ya mergeados.
  expect(AZURE_MANIFEST_TOOL_INSTRUCTION).toContain(`At least one --evidence must be ${TEXT_EVIDENCE_KINDS.join(" or ")}`);
  expect(GITHUB_MANIFEST_TOOL_INSTRUCTION).toContain(`lazy-workflow ${GITHUB_MANIFEST_COMMAND}`);
});

test("la instrucción de evidencia HTTP nombra el navegador y la forma que el coordinador maqueta", () => {
  // Sin la forma, una sesión satisfacía "evidencia de endpoint" con un `curl` pegado, y el ticket
  // publicaba un muro de monoespaciado sin endpoint, sin estado y sin el navegador que lo hizo.
  expect(HTTP_EVIDENCE_INSTRUCTION).toContain("Chrome MCP");
  for (const field of ["title", "screenshot", "request", "response", "status", "headers"]) {
    expect(`${field}: ${HTTP_EVIDENCE_INSTRUCTION.includes(`\`${field}\``)}`).toBe(`${field}: true`);
  }
  expect(HTTP_EVIDENCE_INSTRUCTION).toContain(EVIDENCE_KINDS[0]);
});

test("los prompts de entrega piden la evidencia por el contrato, no por su cuenta", async () => {
  const directory = new URL("../prompts/", import.meta.url);
  for (const asset of ["autocode-prompt.md", "github-code-prompt.md"]) {
    const raw = await Bun.file(new URL(asset, directory)).text();
    expect(`${asset}: ${raw.includes("{{HTTP_EVIDENCE}}")}`).toBe(`${asset}: true`);
  }
});

test("renderContract falla cerrado ante un placeholder desconocido", () => {
  expect(() => renderContract("{{NO_EXISTE}}")).toThrow(UnknownContractPlaceholderError);
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

test("el plan GitHub fija el workflow y prohibe Azure", async () => {
  const prompt = await buildWorkflowPrompt({ kind: "github-plan" }, context);
  expect(prompt).toContain("default GitHub repository workflow");
  expect(prompt).toContain("Selected workflow: plan");
  expect(prompt).toContain("Do not use Azure DevOps");
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
    manifestPath: "/repo/.git/manifest.json",
  }, context);
  expect(code).toContain("deliver that exact issue");
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
    manifestPath: "/repo/.git/manifest.json",
  }, context);
  expect(prompt).toContain("Coordinator-fixed repository: o/api");
  expect(prompt).toContain('"number":201');
  expect(prompt).toContain('"body of #201"');
  expect(prompt).toContain("Coordinator-fixed issue branch: issue/201");
  expect(prompt).toContain(`Write the ${IMPLEMENTATION_READY_MARKER} manifest to: /repo/.git/manifest.json`);
  expect(prompt).toContain(GITHUB_MANIFEST_TOOL_INSTRUCTION);
  // La invocación llega armada con las identidades que el coordinador ya fijó:
  // lo único que la sesión completa es lo que solo ella sabe.
  expect(prompt).toContain(
    `lazy-workflow ${GITHUB_MANIFEST_COMMAND} --issue 201 --branch issue/201 --manifest /repo/.git/manifest.json --working-directory /repo`,
  );
  expect(prompt).toContain(`do not print ${QUEUE_EMPTY_MARKER} or ${QUEUE_BLOCKED_MARKER}`);
});

test("la reconciliacion GitHub conserva el contrato de entrega y fija los commits", async () => {
  const prompt = await buildWorkflowPrompt({
    kind: "github-reconciliation",
    issue,
    repository: { nameWithOwner: "o/api" },
    branch: "issue/201",
    manifestPath: "/repo/.git/manifest.json",
    pullRequest: 314,
    originalCommit: "aaaa111",
    baseCommit: "bbbb222",
  }, context);
  expect(prompt).toContain("Coordinator-fixed pull request: #314");
  expect(prompt).toContain("Original implementation commit: aaaa111");
  expect(prompt).toContain("Coordinator-fetched base commit: bbbb222");
  expect(prompt).toContain("Merge exactly bbbb222 into issue/201");
  expect(prompt).toContain(GITHUB_MANIFEST_TOOL_INSTRUCTION);
  // Reconciliar no reescribe el manifest a mano: vuelve a correr la herramienta.
  expect(prompt).toContain("run the manifest tool again so the manifest names the new HEAD");
});

test("la entrega workspace GitHub declara el orden y un manifest por repositorio", async () => {
  const prompt = await buildWorkflowPrompt({
    kind: "github-workspace-delivery",
    scope,
    issue,
    units: [
      { path: "/ws/api", branch: "issue/201", manifestPath: "/ws/api/.git/manifest.json" } as never,
      { path: "/ws/web", branch: "issue/201", manifestPath: "/ws/web/.git/manifest.json" } as never,
    ],
  }, context);
  expect(prompt).toContain("Workspace parent directory: /ws");
  expect(prompt).toContain("1. /ws/api (https://github.com/o/api.git)");
  expect(prompt).toContain("2. /ws/web (https://github.com/o/web.git)");
  expect(prompt).toContain("Work through repositories serially in the declared order");
  expect(prompt).toContain(GITHUB_MANIFEST_TOOL_INSTRUCTION);
  // Cada repositorio recibe su propia invocación: una sola, compartida, escribiría
  // el manifest de un repositorio con el directorio de otro.
  expect(prompt).toContain(`--manifest /ws/api/.git/manifest.json --working-directory /ws/api`);
  expect(prompt).toContain(`--manifest /ws/web/.git/manifest.json --working-directory /ws/web`);
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
    manifestPaths: [{ path: "/repo/a", manifestPath: "/repo/a/.git/lazy-workflow/completion-manifest.json" }],
  }, context);
  expect(workspaceDelivery).toContain("You are implementing exactly one Azure delivery ticket");
  expect(workspaceDelivery).not.toContain("Use GitHub and `gh` for");
});

test("un plan de workspace GitHub conserva el alcance GitHub", async () => {
  const prompt = await buildWorkflowPrompt({ kind: "workspace-plan", scope, run: { kind: "github-repository-run" }, huInfo: null }, context);
  expect(prompt).toContain("Do not use Azure DevOps");
  expect(prompt).toContain("Selected workflow: plan");
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
    manifestPaths: [{ path: "/repo/a", manifestPath: "/repo/a/.git/lazy-workflow/completion-manifest.json" }],
  }, context);
  expect(prompt).toContain("Coordinator-fixed HU: 23438");
  expect(prompt).toContain("Coordinator-fixed ticket: 51");
  expect(prompt).toContain("Coordinator-fixed integration branch: refs/heads/hu/23438");
  expect(prompt).toContain("Coordinator-fixed ticket branch: refs/heads/ticket/51");
  // The session must never have to infer where its manifest goes: the integration phase only reads
  // the coordinator's own path, so an inferred one delivers nothing.
  expect(prompt).toContain("/repo/a: manifest /repo/a/.git/lazy-workflow/completion-manifest.json");
  expect(prompt).toContain(AZURE_MANIFEST_TOOL_INSTRUCTION);
  expect(prompt).toContain(
    `lazy-workflow ${AZURE_MANIFEST_COMMAND} --ticket 51 --branch refs/heads/ticket/51`
    + " --manifest /repo/a/.git/lazy-workflow/completion-manifest.json --working-directory /repo/a",
  );
});

test("la entrega Azure adjunta el contexto inmutable y el request como suplementario", async () => {
  const prompt = await buildWorkflowPrompt({
    kind: "azure-delivery",
    context: { hu: { id: 23438 }, ticket: { id: 51 }, integrationBranch: "refs/heads/hu/23438" } as never,
    ticketBranch: "refs/heads/ticket/51",
    evidenceDirectory: "/repo/.git/evidence",
    manifestPath: "/repo/.git/evidence/manifest.json",
    workflowPhase: "implementing",
    completionGates: [],
  }, context);
  expect(prompt).toContain("You are implementing exactly one Azure delivery ticket");
  expect(prompt).toContain('"ticketBranch":"refs/heads/ticket/51"');
  expect(prompt).toContain('"workflowPhase":"implementing"');
  expect(prompt).toContain(AZURE_MANIFEST_TOOL_INSTRUCTION);
  expect(prompt).toContain(
    `lazy-workflow ${AZURE_MANIFEST_COMMAND} --ticket 51 --branch refs/heads/ticket/51`
    + " --manifest /repo/.git/evidence/manifest.json --working-directory /repo",
  );
  expect(prompt).toContain("Supplemental operator request (non-authoritative):");
});

test("una entrega Azure sin rama ni manifest fijados no recibe una invocación incompleta", async () => {
  // Media invocación es peor que ninguna: la sesión completaría el hueco con algo
  // inventado, que es exactamente lo que la herramienta existe para impedir.
  const prompt = await buildWorkflowPrompt({
    kind: "azure-delivery",
    context: { hu: { id: 23438 }, ticket: { id: 51 }, integrationBranch: "refs/heads/hu/23438" } as never,
    ticketBranch: null,
    evidenceDirectory: null,
    manifestPath: null,
    workflowPhase: "implementing",
    completionGates: [],
  }, context);

  expect(prompt).toContain(AZURE_MANIFEST_TOOL_INSTRUCTION);
  expect(prompt).not.toContain(`lazy-workflow ${AZURE_MANIFEST_COMMAND} --ticket`);
});

test("la revision de arquitectura SAG no muta y declara su marker", async () => {
  const prompt = await buildWorkflowPrompt({
    kind: "architecture-review-sag",
    scope: { tracker: "github", issue: 201 },
    context: { commit: "abc123", sources: [] } as never,
  }, context);
  expect(prompt).toContain("do not modify source code");
  expect(prompt).toContain('Review scope: {"tracker":"github","issue":201}');
  expect(prompt).toContain("ARCHITECTURE_REVIEW_RESULT");
});

test("buildResumePrompt solo adjunta normas SAG cuando existen", () => {
  expect(buildResumePrompt("continue", null)).toBe("continue");
  const withNorms = buildResumePrompt("continue", { phase: "coding" } as never);
  expect(withNorms).toContain("continue");
  expect(withNorms).toContain("SAG norms context");
  expect(withNorms).toContain("unknown applicability remains an explicit decision");
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
    { kind: "github-delivery", issue, repository: { nameWithOwner: "o/api" } as never, branch: "issue/201", manifestPath: "/m.json" },
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
    manifestPaths: [{ path: "/repo/a", manifestPath: "/repo/a/.git/lazy-workflow/completion-manifest.json" }],
  }, context);

  expect(prompt).toContain("Conciliar el intento de pago");
  expect(prompt).toContain("HU transversal de pagos");
  expect(prompt).toContain("Ticket description:");
  expect(prompt).toContain("el intento de pago se concilia contra el proveedor");
  // El contenido rellena el hueco del asset, antes de las líneas de identidad.
  expect(prompt.indexOf("Conciliar el intento de pago")).toBeLessThan(prompt.indexOf("Coordinator-fixed HU"));
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
    manifestPaths: [],
  }, context);

  expect(prompt).toContain("Conciliar el intento de pago");
  expect(prompt).not.toContain("Ticket description:");
});
