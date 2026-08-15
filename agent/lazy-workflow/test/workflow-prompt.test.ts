import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";
import {
  CONTRACT_LITERALS,
  IMPLEMENTATION_READY_MARKER,
  MANIFEST_VALIDATION_SHAPE,
  QUEUE_BLOCKED_MARKER,
  QUEUE_EMPTY_MARKER,
  UnknownContractPlaceholderError,
  renderContract,
} from "../src/prompts/workflow-contract.ts";
import {
  buildResumePrompt,
  buildWorkflowPrompt,
  type WorkflowPromptContext,
} from "../src/prompts/workflow-prompt.ts";
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

test("renderContract resuelve los placeholders del contrato", () => {
  expect(renderContract("marca {{IMPLEMENTATION_READY}}")).toBe(`marca ${IMPLEMENTATION_READY_MARKER}`);
  expect(renderContract("{{MANIFEST_VALIDATION_SHAPE}}")).toBe(MANIFEST_VALIDATION_SHAPE);
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
  expect(prompt).toContain(MANIFEST_VALIDATION_SHAPE);
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
  expect(prompt).toContain(MANIFEST_VALIDATION_SHAPE);
});

test("la entrega workspace GitHub declara el orden y un manifest por repositorio", async () => {
  const prompt = await buildWorkflowPrompt({
    kind: "github-workspace-delivery",
    scope,
    issue,
    units: [],
  }, context);
  expect(prompt).toContain("Workspace parent directory: /ws");
  expect(prompt).toContain("1. /ws/api (https://github.com/o/api.git)");
  expect(prompt).toContain("2. /ws/web (https://github.com/o/web.git)");
  expect(prompt).toContain("Work through repositories serially in the declared order");
  expect(prompt).toContain(MANIFEST_VALIDATION_SHAPE);
  expect(prompt).toContain("The working directory is /ws");
});

test("un run Azure nunca recibe el alcance GitHub", async () => {
  const huInfo = { id: 23438 } as never;

  const workspacePlan = await buildWorkflowPrompt({ kind: "workspace-plan", scope, huInfo }, context);
  expect(workspacePlan).toContain("child work items");
  expect(workspacePlan).not.toContain("Do not use Azure DevOps");
  expect(workspacePlan).not.toContain("Use GitHub and `gh` for");

  const workspaceDelivery = await buildWorkflowPrompt({
    kind: "azure-workspace-delivery",
    scope,
    hu: 23438,
    ticket: 51,
    topology: topology as never,
    ticketTopology: topology as never,
  }, context);
  expect(workspaceDelivery).toContain("You are implementing exactly one Azure delivery ticket");
  expect(workspaceDelivery).not.toContain("Use GitHub and `gh` for");
});

test("un plan de workspace GitHub conserva el alcance GitHub", async () => {
  const prompt = await buildWorkflowPrompt({ kind: "workspace-plan", scope, huInfo: null }, context);
  expect(prompt).toContain("Do not use Azure DevOps");
  expect(prompt).toContain("Selected workflow: plan");
  expect(prompt).not.toContain("child work items");
});

test("el shape no coordinado omite el contrato de manifest en vez de degradarlo en silencio", async () => {
  const prompt = await buildWorkflowPrompt({
    kind: "github-code-uncoordinated",
    issue,
    repository: { nameWithOwner: "o/api" },
  }, context);
  expect(prompt).toContain('"number":201');
  expect(prompt).not.toContain("Coordinator-fixed issue branch:");
  expect(prompt).not.toContain(MANIFEST_VALIDATION_SHAPE);
});

test("la entrega workspace Azure fija HU, ticket y ambas ramas", async () => {
  const prompt = await buildWorkflowPrompt({
    kind: "azure-workspace-delivery",
    scope,
    hu: 23438,
    ticket: 51,
    topology: topology as never,
    ticketTopology: topology as never,
  }, context);
  expect(prompt).toContain("Coordinator-fixed HU: 23438");
  expect(prompt).toContain("Coordinator-fixed ticket: 51");
  expect(prompt).toContain("Coordinator-fixed integration branch: refs/heads/hu/23438");
  expect(prompt).toContain("Coordinator-fixed ticket branch: refs/heads/ticket/51");
  expect(prompt).toContain(MANIFEST_VALIDATION_SHAPE);
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
  expect(prompt).toContain(MANIFEST_VALIDATION_SHAPE);
  expect(prompt).toContain("Supplemental operator request (non-authoritative):");
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
