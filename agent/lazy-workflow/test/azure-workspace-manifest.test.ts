import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AzureBoundary } from "../src/cli/lazy-workflow-cli.ts";
import { createCli } from "./_helpers/create-cli.ts";
import { HuInfo } from "../src/azure/hu-info.ts";
import { COMPLETION_GATE, type CompletionGate } from "../src/azure/autocode-service.ts";
import { AgentResult } from "../src/coding-agent/agent-result.ts";
import { isAzureWorkspaceManifest, writeAzureWorkspaceManifest, type AzureWorkspaceManifest } from "../src/azure/azure-workspace-checkpoint.ts";
import {
  createAzureWorkspaceHarness,
  hu,
  integrationBranch,
  remoteUrlA,
  repoA,
  seedRepo,
  staticGit,
  teamProject,
  ticket,
  ticketBranch,
} from "./_helpers/azure-workspace-fixtures.ts";

const MANIFEST_FILE = "azure-workspace-manifest.json";

test("la entrega workspace Azure escribe un manifest agregado verificado para un workspace mixto", async () => {
  const harness = createAzureWorkspaceHarness({ changedRepositories: [repoA] });
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    const exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--base-branch", "main", "--working-directory", `${pathA}, ${pathB}`]);
    expect(exit).toBe(0);

    const written: unknown = await Bun.file(join(harness.stateDirectory(), MANIFEST_FILE)).json();
    expect(isAzureWorkspaceManifest(written)).toBe(true);
    const manifest = written as AzureWorkspaceManifest;
    expect(manifest).toMatchObject({
      hu,
      ticket,
      integrationBranch,
      ticketBranch,
      primaryRepository: pathA,
      summary: "1 repositorios entregados",
      clean: true,
    });
    expect(manifest.repositories.find((entry) => entry.path === pathA)).toMatchObject({
      repository: repoA,
      project: teamProject,
      changed: true,
      commit: "a".repeat(40),
      pullRequest: 1,
      mergeCommit: "merge-1",
    });
    expect(manifest.repositories.find((entry) => entry.path === pathB)).toMatchObject({
      changed: false,
      commit: null,
      pullRequest: null,
      mergeCommit: null,
    });
    // The manifest outlives the checkpoint it replaces.
    expect(await harness.readCheckpoint()).toBeNull();
  } finally {
    await harness.cleanup();
  }
});

test("el manifest agregado Azure falla cerrado y no deja archivo cuando no valida", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "lazy-workflow-azure-invalid-manifest-"));
  try {
    const invalid = {
      hu,
      ticket,
      integrationBranch,
      ticketBranch,
      primaryRepository: "/repo",
      // A unit whose Azure identity never resolved: unusable as proof of delivery.
      repositories: [{ path: "/repo", remote: remoteUrlA, repository: "", project: "", changed: true, commit: "a".repeat(40), pullRequest: 1, mergeCommit: "merge-1", receipts: {} }],
      summary: "1 repositorios entregados",
      clean: true,
    } as unknown as AzureWorkspaceManifest;

    expect(isAzureWorkspaceManifest(invalid)).toBe(false);
    await expect(writeAzureWorkspaceManifest(invalid, stateDirectory)).rejects.toThrow(/inválido/);
    expect(await Bun.file(join(stateDirectory, MANIFEST_FILE)).exists()).toBe(false);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("la entrega Azure de un ticket single-repo se completa sin escribir manifest agregado", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-azure-single-manifest-"));
  try {
    const pathA = await seedRepo(root, repoA, remoteUrlA);
    let state = "En progreso";
    let canonical: number | null = null;
    let evidence = false;
    let merged = false;
    let queueHasTicket = true;
    const summary = "Entregado: 18 passed.";
    const info = async () => ({
      hu: { id: hu },
      ticket: { id: ticket, type: "Task" as const, state },
      branch: ticketBranch,
      integrationBranch,
      effort: { real: 1, realHours: 1 },
      pullRequests: [],
      canonicalPullRequest: canonical,
      mergeCommit: merged ? "merge" : null,
      attachments: [],
      completionEvidence: evidence ? summary : null,
      gates: {
        satisfied: [],
        unmet: state === "Done" ? [] : [
          COMPLETION_GATE.ticketState,
          ...(evidence ? [] : [COMPLETION_GATE.completionEvidence]),
          ...(canonical === null ? [COMPLETION_GATE.completedHuPullRequest, COMPLETION_GATE.nativePullRequestAssociation] : []),
          ...(merged ? [] : [COMPLETION_GATE.commitUrl, COMPLETION_GATE.mergeCommitArtifact]),
        ] as CompletionGate[],
      },
    });
    const result = AgentResult.fromJsonLines(JSON.stringify({
      type: "text", sessionID: "ses-ready", part: { type: "text", text: summary },
    }));
    const cli = createCli({
      huInfoService: {
        getHuInfo: async () => new HuInfo({ id: hu }),
        waitForAccess: async () => undefined,
        ensureIntegrationBranch: async () => integrationBranch,
        getAutocodeState: async () => queueHasTicket
          ? ({ context: { hu: { id: hu }, ticket: { id: ticket, type: "Task", state: "Active" }, integrationBranch }, pending: true })
          : ({ context: null, pending: false }),
        getState: async () => ({ ticket, state, revision: 7 }),
        getEffort: async () => ({ ticket, effort: { real: 1, realHours: 1 } }),
        setState: async (_id: number, desiredState: string) => { state = desiredState; },
        getBranch: async () => ({ hu, ticket, branch: null, integrationBranch }),
        setTicketBranch: async () => ({ hu, ticket, branch: ticketBranch }),
        checkoutTicketBranch: async () => undefined,
        pushTicketBranch: async () => undefined,
        verifySession: async () => ({ commit: "a".repeat(40) }),
        createOrReusePullRequest: async () => ({ pullRequest: 99, mergeCommit: "merge" }),
        setEffort: async () => undefined,
        getTicketInfo: info,
        validateDirectTicketContext: async () => undefined,
        validateSummary: async () => undefined,
        linkPullRequest: async () => { canonical = 99; },
        linkCommit: async () => { merged = true; },
        setSummary: async () => { evidence = true; },
      } as unknown as AzureBoundary,
      agentSource: { run: async () => ({ result, azureLoginRequired: false }) as never, resume: async () => result as never },
      checkpointStore: { read: async () => null, write: async () => undefined, clear: async () => undefined },
      ticketBranchCleaner: { deleteTicketBranch: async () => { queueHasTicket = false; } },
      git: staticGit(),
    });

    const exit = await cli.run(["code", "--hu", `${hu}`, "--working-directory", pathA]);
    expect(exit).toBe(0);
    expect(await Bun.file(join(root, ".lazy-workflow", MANIFEST_FILE)).exists()).toBe(false);
    expect(await Bun.file(join(pathA, ".lazy-workflow", MANIFEST_FILE)).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
