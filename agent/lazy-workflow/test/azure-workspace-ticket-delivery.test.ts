import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LazyWorkflowCli, type AzureBoundary } from "../src/cli/lazy-workflow-cli.ts";
import {
  createAzureWorkspaceHarness as createHarness,
  hu,
  integrationBranch,
  remoteUrlA,
  repoA,
  repoAId,
  repoB,
  repoBId,
  seedRepo,
  staticGit,
  projectId,
  teamProject,
  ticket,
  ticketBranch,
} from "./_helpers/azure-workspace-fixtures.ts";

test("deliverAzureWorkspaceTicket associates every changed-repository PR and merge commit with the ticket serially", async () => {
  const harness = createHarness();
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(0);
  expect(harness.events.filter((event) => event === "opencode:run")).toHaveLength(1);
  expect(harness.events.filter((event) => event.startsWith("pr:"))).toEqual(["pr:1", "pr:2"]);
  expect(harness.events.filter((event) => event.startsWith("link-pr:"))).toEqual(["link-pr:1", "link-pr:2"]);
  expect(harness.events.filter((event) => event.startsWith("link-commit:"))).toEqual(["link-commit:1", "link-commit:2"]);
  expect(harness.ticketStateCalls.map((entry) => entry.desiredState)).toContain("Done");
  expect(harness.huStateCalls).toHaveLength(1);
  expect(harness.huStateCalls[0]).toEqual({ desiredState: "Desarrollo Terminado", expectedState: "En Desarrollo" });
});

test("deliverAzureWorkspaceTicket creates each PR against its own Azure repository in declared order", async () => {
  const harness = createHarness();
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(0);
  expect(harness.prCreateCalls.map(({ target }) => target?.repository)).toEqual([repoAId, repoBId]);
  expect(harness.prCreateCalls.map(({ target }) => target?.project)).toEqual([projectId, projectId]);
  expect(harness.prCreateCalls.map(({ target }) => target?.source)).toEqual([ticketBranch, ticketBranch]);
  expect(harness.prCreateCalls.map(({ target }) => target?.target)).toEqual([integrationBranch, integrationBranch]);
  expect(harness.prLinkCalls.map(({ target }) => target?.repository)).toEqual([repoAId, repoBId]);
  expect(harness.commitLinkCalls.map(({ target }) => target?.repository)).toEqual([repoAId, repoBId]);
});

test("deliverAzureWorkspaceTicket accrues real effort from the measured active duration", async () => {
  const harness = createHarness({ elapsedMs: 3_600_000 });
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(0);
  expect(harness.effortCalls).toHaveLength(1);
  expect(harness.effortCalls[0]!.realEffort).toBe(2);
  expect(harness.effortCalls[0]!.realEffortHours).toBe(2);
});

test("deliverAzureWorkspaceTicket sets effort with the revision observed after setState(Done)", async () => {
  const harness = createHarness();
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(0);
  expect(harness.ticketStateCalls.map(({ desiredState }) => desiredState)).toEqual(["Done"]);
  expect(harness.effortCalls).toHaveLength(1);
  expect(harness.effortCalls[0]!.expectedRevision).toBe(5);
});

test("deliverAzureWorkspaceTicket blocks HU transition when a direct child remains open", async () => {
  const harness = createHarness({
    huState: "En Desarrollo",
    huChildren: [{ id: 99, type: "Task", state: "Active" }],
  });
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(0);
  expect(harness.huStateCalls).toHaveLength(0);
  expect(harness.ticketStateCalls.map((entry) => entry.desiredState)).toContain("Done");
});

test("deliverAzureWorkspaceTicket fails closed when a participant PR association fails and preserves ticket open", async () => {
  const harness = createHarness({
    linkPullRequestFails: true,
  });
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).not.toBe(0);
  expect(harness.huStateCalls).toHaveLength(0);
  expect(harness.ticketStateCalls.find((entry) => entry.desiredState === "Done")).toBeUndefined();
});

test("deliverAzureWorkspaceTicket logs HU transition failure and preserves the checkpoint", async () => {
  const harness = createHarness({ huTransitionFails: true });
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(0);
  expect(harness.huStateCalls).toHaveLength(1);
  expect(harness.ticketStateCalls.map((entry) => entry.desiredState)).toContain("Done");
});

test("deliverAzureWorkspaceTicket keeps single-repository Azure ticket delivery unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-azure-single-"));
  const pathA = await seedRepo(root, repoA, remoteUrlA);
  const events: string[] = [];
  const workspacePrepareCalled = { value: false };
  const azureBoundary: AzureBoundary = {
    getHuInfo: async () => ({ id: hu }),
    waitForAccess: async () => undefined,
    getIntegrationBranchInfo: async () => ({ hu, branch: integrationBranch }),
    setIntegrationBranch: async () => ({ hu, branch: integrationBranch }),
    ensureIntegrationBranch: async () => integrationBranch,
    setTicketBranch: async () => ({ hu, ticket, branch: ticketBranch }),
    pushTicketBranch: async () => undefined,
    checkoutTicketBranch: async () => undefined,
    getAutocodeState: async () => ({ context: null, pending: false }),
    getAutocodeContext: async () => null,
    getAutocodeContextForTicket: async () => null,
    verifyTicketCompletion: async () => ({ ticketBranch }),
    getCompletedTicketBranch: async () => ticketBranch,
    getTicketInfo: async () => ({
      hu: { id: hu, title: "HU" },
      ticket: { id: ticket, type: "Task" as const, title: "Ticket", state: "En progreso", revision: 4 },
      branch: ticketBranch,
      integrationBranch,
      effort: { estimated: 1, real: 1, realHours: 1 },
      pullRequests: [],
      canonicalPullRequest: null,
      mergeCommit: null,
      attachments: [],
      completionEvidence: null,
      gates: { satisfied: [], unmet: [] },
    }),
    validateDirectTicketContext: async () => undefined,
    getCompletionInfo: async () => ({ hu, ticket, gates: { satisfied: [], unmet: [] } }),
    readCompletionManifest: async () => ({
      ticket,
      ticketBranch,
      commit: "a".repeat(40),
      validation: [{ command: "bun test", result: "passed" }],
      evidence: [{
        path: "/tmp/evidence.json",
        kind: "command-output",
        sha256: "a".repeat(64),
      }],
    }),
    validateCompletionManifest: async () => undefined,
    getCompletionManifestPath: async (workingDirectory: string) => join(workingDirectory, "lazy-workflow/completion-manifest.json"),
    createOrReusePullRequest: async () => {
      events.push("single-repo-pr");
      return { pullRequest: 1, mergeCommit: "merge-1" };
    },
    validateEvidenceFile: async () => undefined,
    validateEvidence: async () => undefined,
    getBranch: async () => ({ hu, ticket, branch: ticketBranch, integrationBranch }),
    getTicket: async (id: number) => ({ id, type: "Task" as const }),
    getDescription: async () => ({ ticket, description: null }),
    getState: async (id: number) => {
      if (id === ticket) return { ticket: id, state: "En progreso", revision: 4 };
      if (id === hu) return { ticket: id, state: "En Desarrollo", revision: 7 };
      throw new Error(`unexpected state for ${id}`);
    },
    getEffort: async () => ({ ticket, effort: { estimated: 1, real: 1, realHours: 1 } }),
    getAttachments: async () => ({ ticket, attachments: [] }),
    getEvidence: async () => ({ ticket, completionEvidence: null }),
    setDescription: async () => undefined,
    setState: async () => ({ ticket, state: "Done", revision: 5 }),
    setEffort: async () => undefined,
    linkPullRequest: async () => ({ hu, ticket, pullRequest: 1, mergeCommit: "merge-1" }),
    linkCommit: async () => ({ ticket, pullRequest: 1, mergeCommit: "merge-1", artifactLink: "vstfs:///Git/Commit/x" }),
    addAttachment: async () => ({ ticket, name: "evidence.json", kind: "command-output" as const, digest: "a".repeat(64), url: "https://example.test/evidence" }),
    setEvidence: async () => undefined,
    setHuState: async () => ({ hu: 1, state: "Desarrollo Terminado", revision: 8 }),
    getHuChildren: async () => [],
    hasOpenDeliveryChildren: async () => false,
    prepareWorkspaceBranches: async () => {
      workspacePrepareCalled.value = true;
      throw new Error("must not be called in single-repo");
    },
    prepareWorkspaceTicketBranches: async () => {
      workspacePrepareCalled.value = true;
      throw new Error("must not be called in single-repo");
    },
  };
  const cli = new LazyWorkflowCli(
    azureBoundary,
    {
      run: async () => {
        events.push("opencode:run");
        await Bun.write(join(pathA, "lazy-workflow/completion-manifest.json"), "{}");
        return {
          result: { text: "IMPLEMENTATION_READY", sessionId: "ses", failed: false } as never,
          azureLoginRequired: false,
          failed: false,
        };
      },
      resume: async () => { throw new Error("must not resume"); },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    staticGit(),
  );

  let exit = -1;
  try {
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", pathA]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  expect(workspacePrepareCalled.value).toBe(false);
});