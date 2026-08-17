import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { LazyWorkflowCli, type AzureBoundary } from "../src/cli/lazy-workflow-cli.ts";
import { buildCli } from "../src/cli/parse-cli-options.ts";
import type { AgentCli } from "../src/coding-agent/agent-cli.ts";
import { AgentExhaustionError, type CodingAgent } from "../src/coding-agent/coding-agent.ts";
import type { GitRunner } from "../src/git/git-ticket-branch-cleaner.ts";
import { AzureWorkspaceCheckpointStore, type AzureWorkspaceCheckpoint } from "../src/azure/azure-workspace-checkpoint.ts";
import { captureReporter } from "./_helpers/reporter-capture.ts";

const hu = 192;
const repoA = "repo-a";
const repoB = "repo-b";
const teamProject = "Team";
const repoAId = "repo-a-id";
const repoBId = "repo-b-id";
const projectId = "project-id";
const remoteUrlA = `https://dev.azure.com/org/${teamProject}/_git/${repoA}`;
const remoteUrlB = `https://dev.azure.com/org/${teamProject}/_git/${repoB}`;
const integrationBranch = `refs/heads/hu/${hu}`;
const huBranchUri = `vstfs:///Git/Ref/${projectId}%2F${repoAId}%2FGBhu%2F${hu}`;

async function seedRepo(root: string, name: string): Promise<string> {
  const path = join(root, name);
  const { runGit } = await import("../src/git/git-ticket-branch-cleaner.ts");
  await runGit(["init", "-q", path], root);
  await runGit(["remote", "add", "origin", `https://dev.azure.com/org/${teamProject}/_git/${name}`], path);
  await runGit(["config", "user.email", "test@example.test"], path);
  await runGit(["config", "user.name", "Test"], path);
  await runGit(["commit", "-q", "--allow-empty", "-m", "seed"], path);
  return path;
}

test("runAzureWorkspaceCode enruta la preparación multi-repositorio y conserva el comportamiento single-repo", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-azure-workspace-"));
  const pathA = await seedRepo(root, repoA);
  const pathB = await seedRepo(root, repoB);
  const realpathA = await realpath(pathA);
  const realpathB = await realpath(pathB);
  const prepared: Array<{ hu: number; repositories: Array<{ path: string }> }> = [];
  const ticketBranch = `refs/heads/ticket/51`;
  let currentTicketState = "En progreso";
  let currentHuState = "En Desarrollo";
  const azureBoundary: Pick<AzureBoundary, "getHuInfo" | "waitForAccess" | "prepareWorkspaceBranches" | "prepareWorkspaceTicketBranches" | "createOrReusePullRequest" | "checkoutTicketBranch" | "pushTicketBranch" | "linkPullRequest" | "linkCommit" | "getTicketInfo" | "setEffort" | "setState" | "getCompletionManifestPath" | "readCompletionManifest" | "validateCompletionManifest" | "getBranch" | "validateEvidenceFile" | "addAttachment" | "setEvidence" | "getState" | "getHuState" | "getEffort" | "validateEvidence" | "setHuState" | "hasOpenDeliveryChildren" | "getAutocodeContextForTicket" | "getTicket" | "getDescription" | "getAttachments" | "getEvidence" | "validateDirectTicketContext" | "linkTicketBranch"> = {
    getHuInfo: async () => ({ id: hu }),
    waitForAccess: async () => undefined,
    prepareWorkspaceBranches: async (options) => {
      prepared.push({ hu: options.hu, repositories: [...options.repositories] });
      return {
        hu: options.hu,
        ticket: null,
        integrationBranch,
        anchor: {
          workingDirectory: realpathA,
          remote: remoteUrlA,
          repository: repoA,
          project: teamProject,
          projectId,
          repositoryId: repoAId,
        },
        ticketBranchAnchor: null,
        units: [
          { path: realpathA, remote: remoteUrlA, repository: repoA, project: teamProject, repositoryId: repoAId, projectId, integrationBranch, ticketBranch: null, integrationBranchCreated: true, ticketBranchCreated: false, ticketBranchAnchor: null },
          { path: realpathB, remote: remoteUrlB, repository: repoB, project: teamProject, repositoryId: repoBId, projectId, integrationBranch, ticketBranch: null, integrationBranchCreated: true, ticketBranchCreated: false, ticketBranchAnchor: null },
        ],
      };
    },
    prepareWorkspaceTicketBranches: async () => ({
      hu,
      ticket: 51,
      integrationBranch,
      ticketBranch,
      anchor: {
        workingDirectory: realpathA,
        remote: remoteUrlA,
        repository: repoA,
        project: teamProject,
        projectId,
        repositoryId: repoAId,
      },
      ticketBranchAnchor: realpathA,
      units: [
        { path: realpathA, remote: remoteUrlA, repository: repoA, project: teamProject, repositoryId: repoAId, projectId, integrationBranch, ticketBranch, integrationBranchCreated: true, ticketBranchCreated: true, ticketBranchAnchor: realpathA },
        { path: realpathB, remote: remoteUrlB, repository: repoB, project: teamProject, repositoryId: repoBId, projectId, integrationBranch, ticketBranch, integrationBranchCreated: true, ticketBranchCreated: true, ticketBranchAnchor: realpathA },
      ],
    }),
    createOrReusePullRequest: async () => ({ pullRequest: 1, mergeCommit: "merge-1" }),
    checkoutTicketBranch: async () => undefined,
    pushTicketBranch: async () => undefined,
    linkPullRequest: async () => ({ hu, ticket: 51, pullRequest: 1, mergeCommit: "merge-1" }),
    linkCommit: async () => ({ ticket: 51, pullRequest: 1, mergeCommit: "merge-1", artifactLink: "vstfs:///Git/Commit/x" }),
    getTicketInfo: async () => ({
      hu: { id: hu, title: "HU" },
      ticket: { id: 51, type: "Task" as const, title: "Ticket", state: currentTicketState, revision: 4 },
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
    setEffort: async () => undefined,
    setState: async (id: number, desiredState: string) => {
      if (id === 51) currentTicketState = desiredState;
      if (id === hu) currentHuState = desiredState;
      return { ticket: id, state: desiredState, revision: 5 };
    },
    getCompletionManifestPath: async (workingDirectory: string) => join(workingDirectory, "lazy-workflow/completion-manifest.json"),
    readCompletionManifest: async () => ({
      ticket: 51,
      ticketBranch,
      commit: "a".repeat(40),
      validation: [{ command: "bun test", result: "passed" }],
      evidence: [{ path: "/tmp/evidence.json", kind: "command-output", sha256: "a".repeat(64) }],
    }),
    validateCompletionManifest: async () => undefined,
    getBranch: async () => ({ hu, ticket: 51, branch: ticketBranch, integrationBranch }),
    validateEvidenceFile: async () => undefined,
    addAttachment: async () => ({ ticket: 51, name: "evidence.json", kind: "command-output" as const, digest: "a".repeat(64), url: "https://example.test/evidence" }),
    setEvidence: async () => undefined,
    getState: async (id: number) => {
      if (id === 51) return { ticket: id, state: currentTicketState, revision: 4 };
      throw new Error(`unexpected ${id}`);
    },
    getHuState: async (id: number) => {
      if (id === hu) return { hu: id, state: currentHuState, revision: 7 };
      throw new Error(`unexpected ${id}`);
    },
    getEffort: async () => ({ ticket: 51, effort: { estimated: 1, real: 1, realHours: 1 } }),
    validateEvidence: async () => undefined,
    setHuState: async (id: number, desiredState: string) => {
      currentHuState = desiredState;
      return { hu: id, state: desiredState, revision: 8 };
    },
    hasOpenDeliveryChildren: async () => false,
    getAutocodeContextForTicket: async () => null,
    getTicket: async () => ({ id: 51, type: "Task" as const }),
    getDescription: async () => ({ ticket: 51, description: null }),
    getAttachments: async () => ({ ticket: 51, attachments: [] }),
    getEvidence: async () => ({ ticket: 51, completionEvidence: null }),
    validateDirectTicketContext: async () => undefined,
    linkTicketBranch: async (_huId, ticketId, branch: string, candidates: readonly string[]) => ({ ticket: ticketId, branch, workingDirectory: candidates[0]! }),
  };
  const git: GitRunner = async (args, directory) => {
    if (args[0] === "remote" && args[1] === "get-url") {
      return directory.includes(repoA) ? `${remoteUrlA}\n` : `${remoteUrlB}\n`;
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return directory;
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return `${directory}/.git`;
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "a".repeat(40);
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "status") return "";
    return "";
  };
  const cli = new LazyWorkflowCli(
    azureBoundary,
    {
      run: async () => {
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
    git,
  );

  try {
    const exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `51`, "--base-branch", "main", "--working-directory", `${pathA}, ${pathB}`]);
    expect(exit).toBe(0);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]!.hu).toBe(hu);
    expect(prepared[0]!.repositories.map(({ path }) => path).sort()).toEqual([realpathA, realpathB].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The same workspace fixture as the test above, minus the coding agent: each fallback test
 * scripts its own, since that is exactly what varies between a same-CLI descent, a cross-CLI
 * handoff, and no `--fallback` declared at all.
 */
async function setupWorkspaceFallbackFixture() {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-azure-fallback-"));
  const pathA = await seedRepo(root, repoA);
  const pathB = await seedRepo(root, repoB);
  const realpathA = await realpath(pathA);
  const realpathB = await realpath(pathB);
  const ticketBranch = `refs/heads/ticket/51`;
  let currentTicketState = "En progreso";
  let currentHuState = "En Desarrollo";
  const azureBoundary: Pick<AzureBoundary, "getHuInfo" | "waitForAccess" | "prepareWorkspaceBranches" | "prepareWorkspaceTicketBranches" | "createOrReusePullRequest" | "checkoutTicketBranch" | "pushTicketBranch" | "linkPullRequest" | "linkCommit" | "getTicketInfo" | "setEffort" | "setState" | "getCompletionManifestPath" | "readCompletionManifest" | "validateCompletionManifest" | "getBranch" | "validateEvidenceFile" | "addAttachment" | "setEvidence" | "getState" | "getHuState" | "getEffort" | "validateEvidence" | "setHuState" | "hasOpenDeliveryChildren" | "getAutocodeContextForTicket" | "getTicket" | "getDescription" | "getAttachments" | "getEvidence" | "validateDirectTicketContext" | "linkTicketBranch"> = {
    getHuInfo: async () => ({ id: hu }),
    waitForAccess: async () => undefined,
    prepareWorkspaceBranches: async (options) => ({
      hu: options.hu,
      ticket: null,
      integrationBranch,
      anchor: { workingDirectory: realpathA, remote: remoteUrlA, repository: repoA, project: teamProject, projectId, repositoryId: repoAId },
      ticketBranchAnchor: null,
      units: [
        { path: realpathA, remote: remoteUrlA, repository: repoA, project: teamProject, repositoryId: repoAId, projectId, integrationBranch, ticketBranch: null, integrationBranchCreated: true, ticketBranchCreated: false, ticketBranchAnchor: null },
        { path: realpathB, remote: remoteUrlB, repository: repoB, project: teamProject, repositoryId: repoBId, projectId, integrationBranch, ticketBranch: null, integrationBranchCreated: true, ticketBranchCreated: false, ticketBranchAnchor: null },
      ],
    }),
    prepareWorkspaceTicketBranches: async () => ({
      hu,
      ticket: 51,
      integrationBranch,
      ticketBranch,
      anchor: { workingDirectory: realpathA, remote: remoteUrlA, repository: repoA, project: teamProject, projectId, repositoryId: repoAId },
      ticketBranchAnchor: realpathA,
      units: [
        { path: realpathA, remote: remoteUrlA, repository: repoA, project: teamProject, repositoryId: repoAId, projectId, integrationBranch, ticketBranch, integrationBranchCreated: true, ticketBranchCreated: true, ticketBranchAnchor: realpathA },
        { path: realpathB, remote: remoteUrlB, repository: repoB, project: teamProject, repositoryId: repoBId, projectId, integrationBranch, ticketBranch, integrationBranchCreated: true, ticketBranchCreated: true, ticketBranchAnchor: realpathA },
      ],
    }),
    createOrReusePullRequest: async () => ({ pullRequest: 1, mergeCommit: "merge-1" }),
    checkoutTicketBranch: async () => undefined,
    pushTicketBranch: async () => undefined,
    linkPullRequest: async () => ({ hu, ticket: 51, pullRequest: 1, mergeCommit: "merge-1" }),
    linkCommit: async () => ({ ticket: 51, pullRequest: 1, mergeCommit: "merge-1", artifactLink: "vstfs:///Git/Commit/x" }),
    getTicketInfo: async () => ({
      hu: { id: hu, title: "HU" },
      ticket: { id: 51, type: "Task" as const, title: "Ticket", state: currentTicketState, revision: 4 },
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
    setEffort: async () => undefined,
    setState: async (id: number, desiredState: string) => {
      if (id === 51) currentTicketState = desiredState;
      if (id === hu) currentHuState = desiredState;
      return { ticket: id, state: desiredState, revision: 5 };
    },
    getCompletionManifestPath: async (workingDirectory: string) => join(workingDirectory, "lazy-workflow/completion-manifest.json"),
    readCompletionManifest: async () => ({
      ticket: 51,
      ticketBranch,
      commit: "a".repeat(40),
      validation: [{ command: "bun test", result: "passed" }],
      evidence: [{ path: "/tmp/evidence.json", kind: "command-output", sha256: "a".repeat(64) }],
    }),
    validateCompletionManifest: async () => undefined,
    getBranch: async () => ({ hu, ticket: 51, branch: ticketBranch, integrationBranch }),
    validateEvidenceFile: async () => undefined,
    addAttachment: async () => ({ ticket: 51, name: "evidence.json", kind: "command-output" as const, digest: "a".repeat(64), url: "https://example.test/evidence" }),
    setEvidence: async () => undefined,
    getState: async (id: number) => {
      if (id === 51) return { ticket: id, state: currentTicketState, revision: 4 };
      throw new Error(`unexpected ${id}`);
    },
    getHuState: async (id: number) => {
      if (id === hu) return { hu: id, state: currentHuState, revision: 7 };
      throw new Error(`unexpected ${id}`);
    },
    getEffort: async () => ({ ticket: 51, effort: { estimated: 1, real: 1, realHours: 1 } }),
    validateEvidence: async () => undefined,
    setHuState: async (id: number, desiredState: string) => {
      currentHuState = desiredState;
      return { hu: id, state: desiredState, revision: 8 };
    },
    hasOpenDeliveryChildren: async () => false,
    getAutocodeContextForTicket: async () => null,
    getTicket: async () => ({ id: 51, type: "Task" as const }),
    getDescription: async () => ({ ticket: 51, description: null }),
    getAttachments: async () => ({ ticket: 51, attachments: [] }),
    getEvidence: async () => ({ ticket: 51, completionEvidence: null }),
    validateDirectTicketContext: async () => undefined,
    linkTicketBranch: async (_huId, ticketId, branch: string, candidates: readonly string[]) => ({ ticket: ticketId, branch, workingDirectory: candidates[0]! }),
  };
  const git: GitRunner = async (args, directory) => {
    if (args[0] === "remote" && args[1] === "get-url") {
      return directory.includes(repoA) ? `${remoteUrlA}\n` : `${remoteUrlB}\n`;
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return directory;
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return `${directory}/.git`;
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "a".repeat(40);
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "status") return "";
    return "";
  };
  const writeManifests = () => Promise.all([
    Bun.write(join(realpathA, "lazy-workflow/completion-manifest.json"), "{}"),
    Bun.write(join(realpathB, "lazy-workflow/completion-manifest.json"), "{}"),
  ]);
  return { root, pathA, pathB, azureBoundary, git, writeManifests };
}

test("un agotamiento con respaldo de otro CLI continúa el workspace en una sesión fresca del CLI nuevo", async () => {
  const { root, pathA, pathB, azureBoundary, git, writeManifests } = await setupWorkspaceFallbackFixture();
  const started: Array<{ cli: AgentCli; model?: string; variant?: string; session: string | null; workingDirectory?: string }> = [];
  const agentSource = (cli: AgentCli): CodingAgent => ({
    run: async (options) => {
      started.push({ cli, model: options.model, variant: options.variant, session: options.session, workingDirectory: options.workingDirectory });
      if (cli === "opencode") {
        return {
          result: { text: "agotado", sessionId: "ses_exhausted", failed: true } as never,
          azureLoginRequired: false,
          failed: true,
          exhaustion: { cli: "OpenCode", model: options.model ?? "x", cause: "rate_limit" },
        };
      }
      await writeManifests();
      return { result: { text: "IMPLEMENTATION_READY", sessionId: "ses_new", failed: false } as never, azureLoginRequired: false, failed: false };
    },
    resume: async () => { throw new Error("must not resume: no session exists on the handed-off CLI"); },
  });
  const cli = new LazyWorkflowCli(
    azureBoundary, agentSource, undefined, undefined, undefined, undefined, undefined, git, undefined, undefined, undefined,
    buildCli(() => true),
  );

  try {
    const exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", "51", "--base-branch", "main", "--cli", "opencode", "--fallback", "claudecode:claude-opus-5:high", "--working-directory", `${pathA}, ${pathB}`]);
    expect(exit).toBe(0);
    expect(started.map(({ cli: startedCli }) => startedCli)).toEqual(["opencode", "claudecode"]);
    expect(started[1]?.model).toBe("claude-opus-5");
    expect(started[1]?.variant).toBe("high");
    expect(started[1]?.session).toBeNull();
    // The handed-off session has to spawn in the workspace's common parent, not the raw
    // `--working-directory` value (a comma-separated repository list, not a real path):
    // spawning a CLI there fails outright before it can even open a session.
    const expectedParent = await realpath(root);
    expect(started[0]?.workingDirectory).toBe(expectedParent);
    expect(started[1]?.workingDirectory).toBe(expectedParent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Same shape as `setupWorkspaceFallbackFixture`, generalized over the ticket number so a single
 * fixture can deliver two tickets in the same drain and expose `getAutocodeState` to select the
 * second one once the first is clean.
 */
async function setupWorkspaceDrainFixture() {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-azure-drain-"));
  const pathA = await seedRepo(root, repoA);
  const pathB = await seedRepo(root, repoB);
  const realpathA = await realpath(pathA);
  const realpathB = await realpath(pathB);
  let currentTicket = 51;
  let currentTicketBranch = `refs/heads/ticket/51`;
  let currentTicketState = "En progreso";
  let autocodeCalls = 0;
  const azureBoundary: Pick<AzureBoundary, "getHuInfo" | "waitForAccess" | "prepareWorkspaceBranches" | "prepareWorkspaceTicketBranches" | "createOrReusePullRequest" | "checkoutTicketBranch" | "pushTicketBranch" | "linkPullRequest" | "linkCommit" | "getTicketInfo" | "setEffort" | "setState" | "getCompletionManifestPath" | "readCompletionManifest" | "validateCompletionManifest" | "getBranch" | "validateEvidenceFile" | "addAttachment" | "setEvidence" | "getState" | "getHuState" | "getEffort" | "validateEvidence" | "setHuState" | "hasOpenDeliveryChildren" | "getAutocodeContextForTicket" | "getAutocodeState" | "getTicket" | "getDescription" | "getAttachments" | "getEvidence" | "validateDirectTicketContext" | "linkTicketBranch"> = {
    getHuInfo: async () => ({ id: hu }),
    waitForAccess: async () => undefined,
    prepareWorkspaceBranches: async (options) => ({
      hu: options.hu,
      ticket: null,
      integrationBranch,
      anchor: { workingDirectory: realpathA, remote: remoteUrlA, repository: repoA, project: teamProject, projectId, repositoryId: repoAId },
      ticketBranchAnchor: null,
      units: [
        { path: realpathA, remote: remoteUrlA, repository: repoA, project: teamProject, repositoryId: repoAId, projectId, integrationBranch, ticketBranch: null, integrationBranchCreated: true, ticketBranchCreated: false, ticketBranchAnchor: null },
        { path: realpathB, remote: remoteUrlB, repository: repoB, project: teamProject, repositoryId: repoBId, projectId, integrationBranch, ticketBranch: null, integrationBranchCreated: true, ticketBranchCreated: false, ticketBranchAnchor: null },
      ],
    }),
    prepareWorkspaceTicketBranches: async ({ ticket: requestedTicket }) => {
      currentTicket = requestedTicket!;
      currentTicketBranch = `refs/heads/ticket/${currentTicket}`;
      currentTicketState = "En progreso";
      return {
        hu,
        ticket: currentTicket,
        integrationBranch,
        ticketBranch: currentTicketBranch,
        anchor: { workingDirectory: realpathA, remote: remoteUrlA, repository: repoA, project: teamProject, projectId, repositoryId: repoAId },
        ticketBranchAnchor: realpathA,
        units: [
          { path: realpathA, remote: remoteUrlA, repository: repoA, project: teamProject, repositoryId: repoAId, projectId, integrationBranch, ticketBranch: currentTicketBranch, integrationBranchCreated: true, ticketBranchCreated: true, ticketBranchAnchor: realpathA },
          { path: realpathB, remote: remoteUrlB, repository: repoB, project: teamProject, repositoryId: repoBId, projectId, integrationBranch, ticketBranch: currentTicketBranch, integrationBranchCreated: true, ticketBranchCreated: true, ticketBranchAnchor: realpathA },
        ],
      };
    },
    createOrReusePullRequest: async () => ({ pullRequest: 1, mergeCommit: "merge-1" }),
    checkoutTicketBranch: async () => undefined,
    pushTicketBranch: async () => undefined,
    linkPullRequest: async () => ({ hu, ticket: currentTicket, pullRequest: 1, mergeCommit: "merge-1" }),
    linkCommit: async () => ({ ticket: currentTicket, pullRequest: 1, mergeCommit: "merge-1", artifactLink: "vstfs:///Git/Commit/x" }),
    getTicketInfo: async () => ({
      hu: { id: hu, title: "HU" },
      ticket: { id: currentTicket, type: "Task" as const, title: "Ticket", state: currentTicketState, revision: 4 },
      branch: currentTicketBranch,
      integrationBranch,
      effort: { estimated: 1, real: 1, realHours: 1 },
      pullRequests: [],
      canonicalPullRequest: null,
      mergeCommit: null,
      attachments: [],
      completionEvidence: null,
      gates: { satisfied: [], unmet: [] },
    }),
    setEffort: async () => undefined,
    setState: async (id: number, desiredState: string) => {
      if (id === currentTicket) currentTicketState = desiredState;
      return { ticket: id, state: desiredState, revision: 5 };
    },
    getCompletionManifestPath: async (workingDirectory: string) => join(workingDirectory, "lazy-workflow/completion-manifest.json"),
    readCompletionManifest: async () => ({
      ticket: currentTicket,
      ticketBranch: currentTicketBranch,
      commit: "a".repeat(40),
      validation: [{ command: "bun test", result: "passed" }],
      evidence: [{ path: "/tmp/evidence.json", kind: "command-output", sha256: "a".repeat(64) }],
    }),
    validateCompletionManifest: async () => undefined,
    getBranch: async () => ({ hu, ticket: currentTicket, branch: currentTicketBranch, integrationBranch }),
    validateEvidenceFile: async () => undefined,
    addAttachment: async () => ({ ticket: currentTicket, name: "evidence.json", kind: "command-output" as const, digest: "a".repeat(64), url: "https://example.test/evidence" }),
    setEvidence: async () => undefined,
    getState: async (id: number) => ({ ticket: id, state: currentTicketState, revision: 4 }),
    getHuState: async (id: number) => ({ hu: id, state: "En Desarrollo", revision: 7 }),
    getEffort: async () => ({ ticket: currentTicket, effort: { estimated: 1, real: 1, realHours: 1 } }),
    validateEvidence: async () => undefined,
    setHuState: async (id: number, desiredState: string) => ({ hu: id, state: desiredState, revision: 8 }),
    // Kept open throughout: this fixture is about which CLI the *next* ticket starts on, not
    // about the HU's own closing transition.
    hasOpenDeliveryChildren: async () => true,
    getAutocodeContextForTicket: async () => null,
    getAutocodeState: async () => {
      autocodeCalls += 1;
      if (autocodeCalls === 1) return { context: { hu: { id: hu }, ticket: { id: 51, type: "Task" as const, state: "Active" }, integrationBranch }, pending: true };
      if (autocodeCalls === 2) return { context: { hu: { id: hu }, ticket: { id: 52, type: "Task" as const, state: "Active" }, integrationBranch }, pending: true };
      return { context: null, pending: false };
    },
    getTicket: async () => ({ id: currentTicket, type: "Task" as const }),
    getDescription: async () => ({ ticket: currentTicket, description: null }),
    getAttachments: async () => ({ ticket: currentTicket, attachments: [] }),
    getEvidence: async () => ({ ticket: currentTicket, completionEvidence: null }),
    validateDirectTicketContext: async () => undefined,
    linkTicketBranch: async (_huId, ticketId, branch: string, candidates: readonly string[]) => ({ ticket: ticketId, branch, workingDirectory: candidates[0]! }),
  };
  const git: GitRunner = async (args, directory) => {
    if (args[0] === "remote" && args[1] === "get-url") {
      return directory.includes(repoA) ? `${remoteUrlA}\n` : `${remoteUrlB}\n`;
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return directory;
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return `${directory}/.git`;
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "a".repeat(40);
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "status") return "";
    return "";
  };
  const writeManifests = () => Promise.all([
    Bun.write(join(realpathA, "lazy-workflow/completion-manifest.json"), "{}"),
    Bun.write(join(realpathB, "lazy-workflow/completion-manifest.json"), "{}"),
  ]);
  return { root, pathA, pathB, azureBoundary, git, writeManifests };
}

test("un agotamiento a mitad del drenaje no contamina el CLI del siguiente ticket de la HU", async () => {
  // Reproduce el incidente real: el primer ticket agota el CLI declarado y desciende al
  // respaldo; sin la restauración, el segundo ticket arrancaba heredando ese CLI adoptado
  // (y el modelo declarado para el otro CLI), una combinación invalida que el proveedor
  // rechaza de inmediato.
  const { root, pathA, pathB, azureBoundary, git, writeManifests } = await setupWorkspaceDrainFixture();
  const started: Array<{ cli: AgentCli; model?: string; variant?: string; session: string | null }> = [];
  const agentSource = (cli: AgentCli): CodingAgent => ({
    run: async (options) => {
      started.push({ cli, model: options.model, variant: options.variant, session: options.session });
      if (cli === "claudecode" && started.filter((entry) => entry.cli === "claudecode").length === 1) {
        return {
          result: { text: "agotado", sessionId: "ses_exhausted", failed: true } as never,
          azureLoginRequired: false,
          failed: true,
          exhaustion: { cli: "Claude Code", model: options.model ?? "x", cause: "rate_limit" },
        };
      }
      await writeManifests();
      return { result: { text: "IMPLEMENTATION_READY", sessionId: `ses_${cli}_${started.length}`, failed: false } as never, azureLoginRequired: false, failed: false };
    },
    resume: async () => { throw new Error("must not resume: no session exists on the handed-off CLI"); },
  });
  const cli = new LazyWorkflowCli(
    azureBoundary, agentSource, undefined, undefined, undefined, undefined, undefined, git, undefined, undefined, undefined,
    buildCli(() => true),
  );

  try {
    const exit = await cli.run([
      "code", "--hu", `${hu}`, "--base-branch", "main",
      "--cli", "claudecode", "--model", "claude-sonnet-5", "--variant", "high",
      "--fallback", "opencode:github-copilot/gpt-5.5:high",
      "--working-directory", `${pathA}, ${pathB}`,
    ]);
    expect(exit).toBe(0);
    // Ticket 51: claudecode exhausts, opencode delivers. Ticket 52 must start fresh on the
    // operator's own declared rung (claudecode/claude-sonnet-5/high), not on opencode.
    expect(started.map(({ cli: startedCli }) => startedCli)).toEqual(["claudecode", "opencode", "claudecode"]);
    expect(started[2]?.model).toBe("claude-sonnet-5");
    expect(started[2]?.variant).toBe("high");
    expect(started[2]?.session).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("un agotamiento con respaldo del mismo CLI reanuda la sesión con el modelo del escalón nuevo", async () => {
  const { root, pathA, pathB, azureBoundary, git, writeManifests } = await setupWorkspaceFallbackFixture();
  const resumed: Array<{ sessionId: string; model?: string; variant?: string }> = [];
  const agentSource = (): CodingAgent => ({
    run: async () => ({
      result: { text: "agotado", sessionId: "ses1", failed: true } as never,
      azureLoginRequired: false,
      failed: true,
      exhaustion: { cli: "OpenCode", model: "primario", cause: "rate_limit" },
    }),
    resume: async (sessionId, _prompt, _workingDirectory, _marker, overrides = {}) => {
      resumed.push({ sessionId, model: overrides.model, variant: overrides.variant });
      await writeManifests();
      return { text: "IMPLEMENTATION_READY", sessionId, failed: false } as never;
    },
  });
  const cli = new LazyWorkflowCli(
    azureBoundary, agentSource, undefined, undefined, undefined, undefined, undefined, git, undefined, undefined, undefined,
    buildCli(() => true),
  );

  try {
    const exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", "51", "--base-branch", "main", "--cli", "opencode", "--fallback", "opencode:opencode-cheap:high", "--working-directory", `${pathA}, ${pathB}`]);
    expect(exit).toBe(0);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.sessionId).toBe("ses1");
    expect(resumed[0]?.model).toBe("opencode-cheap");
    expect(resumed[0]?.variant).toBe("high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("un agotamiento sin --fallback declarado sigue fallando cerrado, igual que antes", async () => {
  const { root, pathA, pathB, azureBoundary, git } = await setupWorkspaceFallbackFixture();
  const { reporterFn, messages } = captureReporter();
  const agentSource = (): CodingAgent => ({
    run: async () => ({
      result: { text: "agotado", sessionId: "ses1", failed: true } as never,
      azureLoginRequired: false,
      failed: true,
      exhaustion: { cli: "OpenCode", model: "primario", cause: "rate_limit" },
    }),
    resume: async () => { throw new Error("must not resume: nothing to descend to"); },
  });
  const cli = new LazyWorkflowCli(
    azureBoundary, agentSource, undefined, undefined, undefined, undefined, undefined, git, undefined, undefined, undefined,
    buildCli(() => true), reporterFn,
  );

  try {
    const exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", "51", "--base-branch", "main", "--cli", "opencode", "--working-directory", `${pathA}, ${pathB}`]);
    expect(exit).toBe(1);
    expect(messages.some((line) => line.includes("falló durante la entrega workspace Azure"))).toBeTrue();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function checkpointForResume(
  pathA: string,
  pathB: string,
  root: string,
  overrides: Partial<AzureWorkspaceCheckpoint> = {},
): Promise<AzureWorkspaceCheckpoint> {
  const realpathA = await realpath(pathA);
  const realpathB = await realpath(pathB);
  return {
    schemaVersion: 2,
    cli: "opencode",
    workflow: "azure-workspace-code",
    hu,
    ticket: 51,
    phase: "implementing",
    sessionId: "ses_exhausted",
    integrationBranch,
    ticketBranch: "refs/heads/ticket/51",
    parentDirectory: await realpath(root),
    activeDurationMs: 0,
    repositories: [{ path: realpathA, remote: remoteUrlA }, { path: realpathB, remote: remoteUrlB }],
    units: [],
    receipts: {},
    intent: null,
    ...overrides,
  };
}

test("un agotamiento al reanudar la sesión de un ticket ya en curso desciende a otro CLI, no falla con el mensaje de topología", async () => {
  const { root, pathA, pathB, azureBoundary, git, writeManifests } = await setupWorkspaceFallbackFixture();
  const checkpointStore = new AzureWorkspaceCheckpointStore();
  await checkpointStore.write(await checkpointForResume(pathA, pathB, root, { cli: "claudecode" }), join(root, ".lazy-workflow"));
  const resumed: string[] = [];
  const started: Array<{ cli: AgentCli; model?: string; variant?: string; session: string | null }> = [];
  const agentSource = (cli: AgentCli): CodingAgent => ({
    run: async (options) => {
      started.push({ cli, model: options.model, variant: options.variant, session: options.session });
      await writeManifests();
      return { result: { text: "IMPLEMENTATION_READY", sessionId: "ses_new", failed: false } as never, azureLoginRequired: false, failed: false };
    },
    resume: async (sessionId) => {
      resumed.push(sessionId);
      throw new AgentExhaustionError({ cli: "Claude Code", model: "claude-sonnet-5", cause: "session_limit" }, { text: "You've hit your session limit", sessionId, failed: true } as never);
    },
  });
  const cli = new LazyWorkflowCli(
    azureBoundary, agentSource, undefined, undefined, undefined, undefined, undefined, git, undefined, undefined, undefined,
    buildCli(() => true), undefined, undefined, undefined, undefined, undefined, undefined, checkpointStore,
  );

  try {
    const exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", "51", "--base-branch", "main", "--cli", "claudecode", "--model", "claude-sonnet-5", "--fallback", "opencode:github-copilot/gpt-5.5:high", "--working-directory", `${pathA}, ${pathB}`]);
    expect(exit).toBe(0);
    expect(resumed).toEqual(["ses_exhausted"]);
    expect(started.map(({ cli: startedCli }) => startedCli)).toEqual(["opencode"]);
    expect(started[0]?.model).toBe("github-copilot/gpt-5.5");
    expect(started[0]?.session).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("un agotamiento al reanudar la sesión de un ticket ya en curso desciende al mismo CLI con el modelo del escalón nuevo", async () => {
  const { root, pathA, pathB, azureBoundary, git, writeManifests } = await setupWorkspaceFallbackFixture();
  const checkpointStore = new AzureWorkspaceCheckpointStore();
  await checkpointStore.write(await checkpointForResume(pathA, pathB, root), join(root, ".lazy-workflow"));
  const resumed: Array<{ sessionId: string; model?: string; variant?: string }> = [];
  const agentSource = (): CodingAgent => ({
    run: async () => { throw new Error("must not start a fresh session: a checkpointed one exists"); },
    resume: async (sessionId, _prompt, _workingDirectory, _marker, overrides = {}) => {
      resumed.push({ sessionId, model: overrides.model, variant: overrides.variant });
      if (resumed.length === 1) {
        throw new AgentExhaustionError({ cli: "OpenCode", model: "opencode-go/deepseek-v4-pro", cause: "rate_limit" }, { text: "agotado", sessionId, failed: true } as never);
      }
      await writeManifests();
      return { text: "IMPLEMENTATION_READY", sessionId, failed: false } as never;
    },
  });
  const cli = new LazyWorkflowCli(
    azureBoundary, agentSource, undefined, undefined, undefined, undefined, undefined, git, undefined, undefined, undefined,
    buildCli(() => true), undefined, undefined, undefined, undefined, undefined, undefined, checkpointStore,
  );

  try {
    const exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", "51", "--base-branch", "main", "--cli", "opencode", "--model", "opencode-go/deepseek-v4-pro", "--fallback", "opencode:opencode-go/deepseek-v4-cheap:high", "--working-directory", `${pathA}, ${pathB}`]);
    expect(exit).toBe(0);
    expect(resumed).toHaveLength(2);
    expect(resumed[0]?.sessionId).toBe("ses_exhausted");
    expect(resumed[1]?.sessionId).toBe("ses_exhausted");
    expect(resumed[1]?.model).toBe("opencode-go/deepseek-v4-cheap");
    expect(resumed[1]?.variant).toBe("high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("un agotamiento al reanudar sin --fallback declarado falla cerrado con un mensaje preciso, no con el de topología", async () => {
  const { root, pathA, pathB, azureBoundary, git } = await setupWorkspaceFallbackFixture();
  const checkpointStore = new AzureWorkspaceCheckpointStore();
  await checkpointStore.write(await checkpointForResume(pathA, pathB, root, { cli: "claudecode" }), join(root, ".lazy-workflow"));
  const { reporterFn, messages } = captureReporter();
  const agentSource = (): CodingAgent => ({
    run: async () => { throw new Error("must not start a fresh session: a checkpointed one exists"); },
    resume: async (sessionId) => {
      throw new AgentExhaustionError({ cli: "Claude Code", model: "claude-sonnet-5", cause: "session_limit" }, { text: "You've hit your session limit", sessionId, failed: true } as never);
    },
  });
  const cli = new LazyWorkflowCli(
    azureBoundary, agentSource, undefined, undefined, undefined, undefined, undefined, git, undefined, undefined, undefined,
    buildCli(() => true), reporterFn, undefined, undefined, undefined, undefined, undefined, checkpointStore,
  );

  try {
    const exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", "51", "--base-branch", "main", "--cli", "claudecode", "--model", "claude-sonnet-5", "--working-directory", `${pathA}, ${pathB}`]);
    expect(exit).toBe(1);
    expect(messages.some((line) => line.includes("falló durante la entrega workspace Azure"))).toBeTrue();
    expect(messages.some((line) => line.includes("topología multi-repositorio Azure"))).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("un ticket ya descendido a otro modelo reanuda con el modelo del checkpoint, no con el primario exhausto", async () => {
  const { root, pathA, pathB, azureBoundary, git, writeManifests } = await setupWorkspaceFallbackFixture();
  const checkpointStore = new AzureWorkspaceCheckpointStore();
  await checkpointStore.write(await checkpointForResume(pathA, pathB, root, { model: "opencode-go/deepseek-v4-cheap", variant: "high" }), join(root, ".lazy-workflow"));
  const resumed: Array<{ model?: string; variant?: string }> = [];
  const agentSource = (): CodingAgent => ({
    run: async () => { throw new Error("must not start a fresh session: a checkpointed one exists"); },
    resume: async (sessionId, _prompt, _workingDirectory, _marker, overrides = {}) => {
      resumed.push({ model: overrides.model, variant: overrides.variant });
      await writeManifests();
      return { text: "IMPLEMENTATION_READY", sessionId, failed: false } as never;
    },
  });
  const cli = new LazyWorkflowCli(
    azureBoundary, agentSource, undefined, undefined, undefined, undefined, undefined, git, undefined, undefined, undefined,
    buildCli(() => true), undefined, undefined, undefined, undefined, undefined, undefined, checkpointStore,
  );

  try {
    const exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", "51", "--base-branch", "main", "--cli", "opencode", "--working-directory", `${pathA}, ${pathB}`]);
    expect(exit).toBe(0);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.model).toBe("opencode-go/deepseek-v4-cheap");
    expect(resumed[0]?.variant).toBe("high");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI single-repo conserva el rechazo cuando se omite --working-directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-azure-single-"));
  const pathA = await seedRepo(root, repoA);
  let prepareCalled = false;
  const azureBoundary: Pick<AzureBoundary, "getHuInfo" | "waitForAccess" | "prepareWorkspaceBranches"> = {
    getHuInfo: async () => ({ id: hu }),
    waitForAccess: async () => undefined,
    prepareWorkspaceBranches: async () => {
      prepareCalled = true;
      throw new Error("must not be called");
    },
  };
  const git: GitRunner = async (args, directory) => {
    if (args[0] === "remote" && args[1] === "get-url") return `${remoteUrlA}\n`;
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "status") return "";
    return "";
  };
  const cli = new LazyWorkflowCli(
    azureBoundary,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    git,
  );

  try {
    const exit = await cli.run(["code", "--hu", `${hu}`, "--working-directory", pathA]);
    expect([0, 1]).toContain(exit);
    expect(prepareCalled).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan multi-repositorio con --hu inspecciona el alcance Azure sin mutar ramas ni tracker", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-azure-workspace-plan-"));
  const pathA = await seedRepo(root, repoA);
  const pathB = await seedRepo(root, repoB);
  const realpathA = await realpath(pathA);
  const realpathB = await realpath(pathB);
  let prepareCalled = false;
  const azureBoundary: Pick<AzureBoundary, "getHuInfo" | "waitForAccess" | "prepareWorkspaceBranches" | "prepareWorkspaceTicketBranches"> = {
    getHuInfo: async (id: number) => ({ id, title: "HU transversal" }),
    waitForAccess: async () => undefined,
    prepareWorkspaceBranches: async () => {
      prepareCalled = true;
      throw new Error("plan must not prepare branches");
    },
    prepareWorkspaceTicketBranches: async () => {
      prepareCalled = true;
      throw new Error("plan must not prepare ticket branches");
    },
  };
  const git: GitRunner = async (args, directory) => {
    if (args[0] === "remote" && args[1] === "get-url") {
      return directory.includes(repoA) ? `${remoteUrlA}\n` : `${remoteUrlB}\n`;
    }
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "status") return "";
    return "";
  };
  const sessions: Array<{ workingDirectory: string; prompt: string }> = [];
  const cli = new LazyWorkflowCli(
    azureBoundary,
    {
      run: async (options) => {
        sessions.push({ workingDirectory: options.workingDirectory, prompt: options.prompt });
        return { result: { text: "plan", sessionId: "ses_plan", failed: false } as never, azureLoginRequired: false, failed: false };
      },
      resume: async () => { throw new Error("must not resume"); },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    git,
  );

  try {
    const exit = await cli.run(["plan", "--hu", `${hu}`, "--working-directory", `${pathA}, ${pathB}`]);
    expect(exit).toBe(0);
    expect(prepareCalled).toBe(false);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.workingDirectory).toBe(await realpath(root));
    expect(sessions[0]!.prompt).toContain(realpathA);
    expect(sessions[0]!.prompt).toContain(realpathB);
    expect(sessions[0]!.prompt).toContain("HU transversal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan multi-repositorio con --hu conserva la sesión y la reanuda tras el login de Azure", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-azure-workspace-login-"));
  const pathA = await seedRepo(root, repoA);
  const pathB = await seedRepo(root, repoB);
  let waited = 0;
  const azureBoundary: Pick<AzureBoundary, "getHuInfo" | "waitForAccess"> = {
    getHuInfo: async (id: number) => ({ id, title: "HU transversal" }),
    waitForAccess: async () => { waited += 1; },
  };
  const git: GitRunner = async (args, directory) => {
    if (args[0] === "remote" && args[1] === "get-url") {
      return directory.includes(repoA) ? `${remoteUrlA}\n` : `${remoteUrlB}\n`;
    }
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "status") return "";
    return "";
  };
  const resumed: Array<{ sessionId: string; workingDirectory: string; agentProfile: string | undefined }> = [];
  const cli = new LazyWorkflowCli(
    azureBoundary,
    {
      run: async () => ({ result: { text: "", sessionId: "ses_login", failed: false } as never, azureLoginRequired: true, failed: false }),
      resume: async (sessionId: string, _prompt: string, workingDirectory: string, _terminalMarker?: string, overrides?: { agent?: { profile: string } }) => {
        resumed.push({ sessionId, workingDirectory, agentProfile: overrides?.agent?.profile });
        return { text: "plan", sessionId, failed: false } as never;
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    git,
  );

  try {
    const exit = await cli.run(["plan", "--hu", `${hu}`, "--working-directory", `${pathA}, ${pathB}`]);
    expect(exit).toBe(0);
    expect(waited).toBe(1);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.sessionId).toBe("ses_login");
    expect(resumed[0]!.workingDirectory).toBe(await realpath(root));
    // Single owner across mono-repository and workspace planning: the resumed
    // session keeps the same Azure planning authority it started with.
    expect(resumed[0]!.agentProfile).toBe("lazy-azure-plan");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan multi-repositorio fija la frontera de autorización y resuelve las normas SAG en el repositorio ancla", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-azure-workspace-scope-"));
  const pathA = await seedRepo(root, repoA);
  const pathB = await seedRepo(root, repoB);
  const realpathA = await realpath(pathA);
  const azureBoundary: Pick<AzureBoundary, "getHuInfo" | "waitForAccess"> = {
    getHuInfo: async (id: number) => ({ id }),
    waitForAccess: async () => undefined,
  };
  const git: GitRunner = async (args, directory) => {
    if (args[0] === "remote" && args[1] === "get-url") {
      return directory.includes(repoA) ? `${remoteUrlA}\n` : `${remoteUrlB}\n`;
    }
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "status") return "";
    return "";
  };
  const planningDirectories: string[] = [];
  let prompt = "";
  const cli = new LazyWorkflowCli(
    azureBoundary,
    {
      run: async (options) => {
        prompt = options.prompt;
        return { result: { text: "plan", sessionId: "ses_plan", failed: false } as never, azureLoginRequired: false, failed: false };
      },
      resume: async () => { throw new Error("must not resume"); },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    {
      loadPlanning: async (workingDirectory: string) => {
        planningDirectories.push(workingDirectory);
        return { norms: [] } as never;
      },
    } as never,
    git,
  );

  try {
    const exit = await cli.run(["plan", "--hu", `${hu}`, "--normas-sag", "--working-directory", `${pathA}, ${pathB}`]);
    expect(exit).toBe(0);
    expect(planningDirectories).toEqual([realpathA]);
    expect(prompt).toContain("OpenCode may only read or modify the listed repositories.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan multi-repositorio nombra el tracker, no el workspace, cuando falla la lectura de la HU", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-azure-workspace-hu-failure-"));
  const pathA = await seedRepo(root, repoA);
  const pathB = await seedRepo(root, repoB);
  const azureBoundary: Pick<AzureBoundary, "getHuInfo" | "waitForAccess"> = {
    getHuInfo: async () => { throw new Error("az boards work-item show: not logged in"); },
    waitForAccess: async () => undefined,
  };
  const git: GitRunner = async (args, directory) => {
    if (args[0] === "remote" && args[1] === "get-url") {
      return directory.includes(repoA) ? `${remoteUrlA}\n` : `${remoteUrlB}\n`;
    }
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "status") return "";
    return "";
  };
  const { reporterFn, messages } = captureReporter();
  const cli = new LazyWorkflowCli(
    azureBoundary,
    {
      run: async () => { throw new Error("plan must not start an OpenCode session when the HU read fails"); },
      resume: async () => { throw new Error("must not resume"); },
    },
    undefined, undefined, undefined, undefined, undefined,
    git,
    undefined, undefined, undefined, undefined,
    reporterFn,
  );

  try {
    const exit = await cli.run(["plan", "--hu", `${hu}`, "--working-directory", `${pathA}, ${pathB}`]);
    expect(exit).toBe(1);
    expect(messages.some((message) => message.includes("no se pudo leer la HU en Azure DevOps"))).toBeTrue();
    expect(messages.some((message) => message.includes("no se pudo preparar el workspace"))).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan multi-repositorio acepta un remote Azure DevOps con usuario embebido", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-azure-workspace-scope-userinfo-"));
  const pathA = await seedRepo(root, repoA);
  const pathB = await seedRepo(root, repoB);
  let huRead = false;
  const azureBoundary: Pick<AzureBoundary, "getHuInfo" | "waitForAccess"> = {
    getHuInfo: async (id: number) => { huRead = true; return { id }; },
    waitForAccess: async () => undefined,
  };
  const git: GitRunner = async (args, directory) => {
    if (args[0] === "remote" && args[1] === "get-url") {
      // Azure DevOps clones over HTTPS carry the organization as userinfo.
      return `https://org@dev.azure.com/org/${teamProject}/_git/${directory.includes(repoA) ? repoA : repoB}\n`;
    }
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "status") return "";
    return "";
  };
  const { reporterFn, messages } = captureReporter();
  const cli = new LazyWorkflowCli(
    azureBoundary,
    {
      run: async () => { throw new Error("plan must not start an OpenCode session in this test"); },
      resume: async () => { throw new Error("must not resume"); },
    },
    undefined, undefined, undefined, undefined, undefined,
    git,
    undefined, undefined, undefined, undefined,
    reporterFn,
  );

  try {
    await cli.run(["plan", "--hu", `${hu}`, "--working-directory", `${pathA}, ${pathB}`]);
    expect(messages.some((message) => message.includes("no tiene un remote Azure DevOps"))).toBeFalse();
    expect(huRead).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan multi-repositorio conserva el mensaje de alcance cuando un repositorio no tiene remote Azure DevOps", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-azure-workspace-scope-failure-"));
  const pathA = await seedRepo(root, repoA);
  const pathB = await seedRepo(root, repoB);
  let huRead = false;
  const azureBoundary: Pick<AzureBoundary, "getHuInfo" | "waitForAccess"> = {
    getHuInfo: async (id: number) => { huRead = true; return { id }; },
    waitForAccess: async () => undefined,
  };
  const git: GitRunner = async (args, directory) => {
    if (args[0] === "remote" && args[1] === "get-url") {
      // repo-b resolves to a GitHub remote: the same single-provider check that
      // guards `code --hu` rejects the mixed scope before the HU is ever read.
      return directory.includes(repoA) ? `${remoteUrlA}\n` : "https://github.com/org/repo-b.git\n";
    }
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "status") return "";
    return "";
  };
  const { reporterFn, messages } = captureReporter();
  const cli = new LazyWorkflowCli(
    azureBoundary,
    {
      run: async () => { throw new Error("plan must not start an OpenCode session when the scope is rejected"); },
      resume: async () => { throw new Error("must not resume"); },
    },
    undefined, undefined, undefined, undefined, undefined,
    git,
    undefined, undefined, undefined, undefined,
    reporterFn,
  );

  try {
    const exit = await cli.run(["plan", "--hu", `${hu}`, "--working-directory", `${pathA}, ${pathB}`]);
    expect(exit).toBe(1);
    expect(huRead).toBe(false);
    expect(messages.some((message) => message.includes("no se pudo preparar el workspace"))).toBeTrue();
    expect(messages.some((message) => message.includes("no tiene un remote Azure DevOps"))).toBeTrue();
    expect(messages.some((message) => message.includes("no se pudo leer la HU en Azure DevOps"))).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
