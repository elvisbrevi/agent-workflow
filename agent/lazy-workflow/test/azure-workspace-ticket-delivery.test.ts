import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { LazyWorkflowCli, type AzureBoundary } from "../src/cli/lazy-workflow-cli.ts";
import type { GitRunner } from "../src/git/git-ticket-branch-cleaner.ts";

const hu = 23438;
const ticket = 51;
const repoA = "repo-a";
const repoB = "repo-b";
const repoC = "repo-c";
const teamProject = "Team";
const repoAId = "repo-a-id";
const repoBId = "repo-b-id";
const projectId = "project-id";
const remoteUrlA = `https://dev.azure.com/org/${teamProject}/_git/${repoA}`;
const remoteUrlB = `https://dev.azure.com/org/${teamProject}/_git/${repoB}`;
const remoteUrlC = `https://dev.azure.com/org/${teamProject}/_git/${repoC}`;
const integrationBranch = `refs/heads/hu/${hu}`;
const ticketBranch = `refs/heads/ticket/${ticket}`;

async function seedRepo(root: string, name: string, remote: string): Promise<string> {
  const path = join(root, name);
  const { runGit } = await import("../src/git/git-ticket-branch-cleaner.ts");
  await runGit(["init", "-q", path], root);
  await runGit(["remote", "add", "origin", remote], path);
  await runGit(["config", "user.email", "test@example.test"], path);
  await runGit(["config", "user.name", "Test"], path);
  await runGit(["commit", "-q", "--allow-empty", "-m", "seed"], path);
  return path;
}

function staticGit(): GitRunner {
  return async (args, directory) => {
    if (args[0] === "remote" && args[1] === "get-url") {
      if (directory.includes(`/${repoA}`) || directory.endsWith(`/${repoA}`)) return `${remoteUrlA}\n`;
      if (directory.includes(`/${repoB}`) || directory.endsWith(`/${repoB}`)) return `${remoteUrlB}\n`;
      if (directory.includes(`/${repoC}`) || directory.endsWith(`/${repoC}`)) return `${remoteUrlC}\n`;
      return "";
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return directory;
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return `${directory}/.git`;
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "a".repeat(40);
    if (args[0] === "rev-parse" && args[1] === "HEAD^{commit}") return "a".repeat(40);
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "status") return "";
    if (args[0] === "symbolic-ref") return "ticket/51";
    return "";
  };
}

interface AzureWorkspaceHarness {
  events: string[];
  huStateCalls: Array<{ desiredState: string; expectedState: string }>;
  prLinkCalls: Array<{ pullRequest: number }>;
  commitLinkCalls: Array<{ pullRequest: number }>;
  ticketStateCalls: Array<{ desiredState: string }>;
  setupCli(overrides?: Partial<AzureBoundary>): Promise<{ cli: LazyWorkflowCli; pathA: string; pathB: string }>;
  cleanup(): Promise<void>;
}

function createHarness(options: {
  huState?: string;
  huChildren?: Array<{ id: number; type: string; state: string }>;
  linkPullRequestFails?: boolean;
  huTransitionFails?: boolean;
} = {}): AzureWorkspaceHarness {
  const events: string[] = [];
  const huStateCalls: Array<{ desiredState: string; expectedState: string }> = [];
  const prLinkCalls: Array<{ pullRequest: number }> = [];
  const commitLinkCalls: Array<{ pullRequest: number }> = [];
  const ticketStateCalls: Array<{ desiredState: string }> = [];
  const huChildren = options.huChildren ?? [];
  let prCounter = 0;
  let root: string | null = null;
  let currentTicketState = "En progreso";
  let currentHuState = options.huState ?? "En Desarrollo";

  const harness: AzureWorkspaceHarness = {
    events,
    huStateCalls,
    prLinkCalls,
    commitLinkCalls,
    ticketStateCalls,
    async setupCli(overrides = {}) {
      root = await mkdtemp(join(tmpdir(), "lazy-workflow-azure-workspace-"));
      const pathA = await seedRepo(root, repoA, remoteUrlA);
      const pathB = await seedRepo(root, repoB, remoteUrlB);
      const realpathA = await realpath(pathA);
      const realpathB = await realpath(pathB);

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
        getTicketInfo: async (_huId, ticketId) => ({
          hu: { id: _huId, title: "HU" },
          ticket: { id: ticketId, type: "Task" as const, title: "Ticket", state: currentTicketState, revision: 4 },
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
        getCompletionInfo: async (_huId, ticketId) => ({ hu: _huId, ticket: ticketId, gates: { satisfied: [], unmet: [] } }),
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
          prCounter += 1;
          const pullRequest = prCounter;
          events.push(`pr:${pullRequest}`);
          return { pullRequest, mergeCommit: `merge-${pullRequest}` };
        },
        validateEvidenceFile: async () => undefined,
        validateEvidence: async () => undefined,
        getBranch: async () => ({ hu, ticket, branch: ticketBranch, integrationBranch }),
        getTicket: async (id: number) => ({ id, type: "Task" as const }),
        getDescription: async () => ({ ticket, description: null }),
        getState: async (id: number) => {
          if (id === ticket) return { ticket: id, state: currentTicketState, revision: 4 };
          if (id === hu) return { ticket: id, state: currentHuState, revision: 7 };
          throw new Error(`unexpected state for ${id}`);
        },
        getEffort: async () => ({ ticket, effort: { estimated: 1, real: 1, realHours: 1 } }),
        getAttachments: async () => ({ ticket, attachments: [] }),
        getEvidence: async () => ({ ticket, completionEvidence: null }),
        setDescription: async () => undefined,
        setState: async (id: number, desiredState: string) => {
          if (id === ticket) {
            currentTicketState = desiredState;
            ticketStateCalls.push({ desiredState });
          }
          if (id === hu) {
            currentHuState = desiredState;
            huStateCalls.push({ desiredState, expectedState: options.huState ?? "En Desarrollo" });
          }
          events.push(`state:${id}:${desiredState}`);
          return { ticket: id, state: desiredState, revision: 5 };
        },
        setEffort: async () => undefined,
        linkPullRequest: async (_huId, ticketId, pullRequest: number) => {
          events.push(`link-pr:${pullRequest}`);
          if (options.linkPullRequestFails && pullRequest === 2) throw new Error("native PR association failed");
          prLinkCalls.push({ pullRequest });
          return { hu: _huId, ticket: ticketId, pullRequest, mergeCommit: `merge-${pullRequest}` };
        },
        linkCommit: async (ticketId: number, pullRequest: number) => {
          events.push(`link-commit:${pullRequest}`);
          commitLinkCalls.push({ pullRequest });
          return { ticket: ticketId, pullRequest, mergeCommit: `merge-${pullRequest}`, artifactLink: "vstfs:///Git/Commit/x" };
        },
        addAttachment: async (id: number) => ({ ticket: id, name: "evidence.json", kind: "command-output" as const, digest: "a".repeat(64), url: "https://example.test/evidence" }),
        setEvidence: async () => undefined,
        setHuState: async (id: number, desiredState: string, expectedState: string) => {
          events.push(`hu-transition:${desiredState}`);
          huStateCalls.push({ desiredState, expectedState });
          if (options.huTransitionFails) throw new Error("HU transition failed");
          currentHuState = desiredState;
          return { hu: id, state: desiredState, revision: 8 };
        },
        getHuChildren: async (id: number) => {
          if (id !== hu) throw new Error(`unexpected HU ${id}`);
          return huChildren.map((child) => ({ id: child.id, type: child.type, state: child.state }));
        },
        hasOpenDeliveryChildren: async () => huChildren.length > 0,
        prepareWorkspaceBranches: async ({ hu: requestedHu, repositories }) => ({
          hu: requestedHu,
          ticket: null,
          integrationBranch,
          anchor: {
            workingDirectory: repositories[0]!.path,
            remote: repositories[0]!.remote,
            repository: repoA,
            project: teamProject,
            projectId,
            repositoryId: repoAId,
          },
          ticketBranchAnchor: null,
          units: repositories.map((repository) => ({
            path: repository.path,
            remote: repository.remote,
            repository: repoA,
            project: teamProject,
            integrationBranch,
            ticketBranch: null,
            integrationBranchCreated: false,
            ticketBranchCreated: false,
            ticketBranchAnchor: null,
          })),
        }),
        prepareWorkspaceTicketBranches: async ({ repositories, ticket: requestedTicket }) => ({
          hu,
          ticket: requestedTicket,
          integrationBranch,
          ticketBranch,
          anchor: {
            workingDirectory: repositories[0]!.path,
            remote: repositories[0]!.remote,
            repository: repoA,
            project: teamProject,
            projectId,
            repositoryId: repoAId,
          },
          ticketBranchAnchor: repositories[0]!.path,
          units: repositories.map((repository) => ({
            path: repository.path,
            remote: repository.remote,
            repository: repoA,
            project: teamProject,
            integrationBranch,
            ticketBranch,
            integrationBranchCreated: false,
            ticketBranchCreated: true,
            ticketBranchAnchor: repositories[0]!.path,
          })),
        }),
        ...overrides,
      };

      const cli = new LazyWorkflowCli(
        azureBoundary,
        {
          run: async (_options) => {
            events.push("opencode:run");
            await Bun.write(join(realpathA, "lazy-workflow/completion-manifest.json"), "{}");
            await Bun.write(join(realpathB, "lazy-workflow/completion-manifest.json"), "{}");
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
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      return { cli, pathA, pathB };
    },
    async cleanup() {
      if (root) await rm(root, { recursive: true, force: true });
    },
  };
  return harness;
}

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