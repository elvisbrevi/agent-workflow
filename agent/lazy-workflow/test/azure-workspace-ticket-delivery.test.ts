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

test("deliverAzureWorkspaceTicket sitúa cada participante en la rama del ticket antes de la sesión", async () => {
  const harness = createHarness();
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(0);
  // Manifest validation requires each repository to sit on the ticket branch, and the session is not
  // allowed to switch branches itself, so the checkout has to happen before the session starts.
  const firstRun = harness.events.indexOf("opencode:run");
  const checkouts = harness.events.filter((event) => event.startsWith("checkout:"));
  expect(checkouts.slice(0, 2)).toEqual([`checkout:${repoA}`, `checkout:${repoB}`]);
  expect(harness.events.indexOf(`checkout:${repoA}`)).toBeLessThan(firstRun);
  expect(harness.events.indexOf(`checkout:${repoB}`)).toBeLessThan(firstRun);
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

test("deliverAzureWorkspaceTicket satisfies the real-effort gates before it judges completion", async () => {
  // The default harness stubs gates.unmet as permanently empty, which is exactly why this bug shipped
  // past the suite: it never modeled Azure's actual contract, where real-effort/real-effort-hours stay
  // unmet until setEffort has landed. This fixture does model that, so a regression that checks gates
  // before setting effort fails closed here with "gates incumplidos: real-effort, real-effort-hours"
  // instead of exit 0.
  const harness = createHarness();
  let ticketState = "En progreso";
  let ticketRevision = 4;
  let effortSet = false;
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli({
      getTicketInfo: async (huId, ticketId) => ({
        hu: { id: huId, title: "HU" },
        ticket: { id: ticketId, type: "Task" as const, title: "Ticket", state: ticketState, revision: ticketRevision },
        branch: ticketBranch,
        integrationBranch,
        effort: { estimated: 1, real: 1, realHours: 1 },
        pullRequests: [],
        canonicalPullRequest: null,
        mergeCommit: null,
        attachments: [],
        completionEvidence: "evidence",
        gates: { satisfied: [], unmet: effortSet ? [] : ["real-effort", "real-effort-hours"] },
      }),
      getState: async (id: number) => id === ticket
        ? { ticket: id, state: ticketState, revision: ticketRevision }
        : { ticket: id, state: "En Desarrollo", revision: 7 },
      setState: async (id: number, desiredState: string) => {
        if (id === ticket) {
          ticketState = desiredState;
          ticketRevision += 1;
        }
        return { ticket: id, state: desiredState, revision: ticketRevision };
      },
      setEffort: async (_ticketId, realEffort: number, realEffortHours: number, expectedRevision: number) => {
        effortSet = true;
        harness.effortCalls.push({ realEffort, realEffortHours, expectedRevision });
        return undefined;
      },
    });
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(0);
  expect(harness.effortCalls).toHaveLength(1);
  expect(harness.effortCalls[0]!.expectedRevision).toBe(4);
  expect(ticketState).toBe("Done");
});

test("deliverAzureWorkspaceTicket sets effort before transitioning the ticket to Done", async () => {
  // The real-effort and real-effort-hours gates only clear once this write lands, so setting effort
  // after judging completion gates meant they could never be satisfied on a first run. Effort has to
  // be reconciled — and tested against the ticket's pre-transition revision — before Done is set.
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
  // The pre-transition revision: Done had not been set yet when effort was written.
  expect(harness.effortCalls[0]!.expectedRevision).toBe(4);
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
test("code --hu without --ticket drains the HU's eligible children across the workspace", async () => {
  const harness = createHarness();
  let selections = 0;
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli({
      getAutocodeState: async () => {
        selections += 1;
        // The delivered ticket lands in a completed state, so the drain finds an empty queue next.
        return selections === 1
          ? {
            context: {
              hu: { id: hu },
              ticket: { id: ticket, type: "Task" as const, state: "Active" },
              integrationBranch,
            },
            pending: true,
          }
          : { context: null, pending: false };
      },
    });
    exit = await cli.run(["code", "--hu", `${hu}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(0);
  // Selected once for the delivered unit, once more to discover the queue is empty.
  expect(selections).toBe(2);
  expect(harness.events.filter((event) => event === "opencode:run")).toHaveLength(1);
  expect(harness.ticketStateCalls.map((entry) => entry.desiredState)).toContain("Done");
  expect(await harness.readCheckpoint()).toBeNull();
});

test("code --hu without --ticket reports an empty queue without delivering anything", async () => {
  const harness = createHarness();
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli({
      getAutocodeState: async () => ({ context: null, pending: false }),
    });
    exit = await cli.run(["code", "--hu", `${hu}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(0);
  expect(harness.events.filter((event) => event === "opencode:run")).toHaveLength(0);
});

test("code --hu without --ticket fails closed when work is pending but nothing is eligible", async () => {
  const harness = createHarness();
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli({
      getAutocodeState: async () => ({ context: null, pending: true }),
    });
    exit = await cli.run(["code", "--hu", `${hu}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  // A blocked queue is a dependency wait the operator resolves, not a finished HU.
  expect(exit).toBe(1);
  expect(harness.events.filter((event) => event === "opencode:run")).toHaveLength(0);
});

test("code --hu --ticket delivers exactly that unit without selecting", async () => {
  const harness = createHarness();
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli({
      getAutocodeState: async () => { throw new Error("must not select"); },
    });
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(0);
  expect(harness.events.filter((event) => event === "opencode:run")).toHaveLength(1);
});
