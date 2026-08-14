import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { LazyWorkflowCli, type AzureBoundary } from "../../src/cli/lazy-workflow-cli.ts";
import type { AzurePullRequestTarget } from "../../src/azure/autocode-service.ts";
import { AzureWorkspaceCheckpointStore, type AzureWorkspaceCheckpoint } from "../../src/azure/azure-workspace-checkpoint.ts";
import type { GitRunner } from "../../src/git/git-ticket-branch-cleaner.ts";

export const hu = 23438;
export const ticket = 51;
export const repoA = "repo-a";
export const repoB = "repo-b";
export const teamProject = "Team";
export const projectId = "project-id";
export const repoAId = `${repoA}-id`;
export const repoBId = `${repoB}-id`;
export const remoteUrlA = `https://dev.azure.com/org/${teamProject}/_git/${repoA}`;
export const remoteUrlB = `https://dev.azure.com/org/${teamProject}/_git/${repoB}`;
export const integrationBranch = `refs/heads/hu/${hu}`;
export const ticketBranch = `refs/heads/ticket/${ticket}`;

export async function seedRepo(root: string, name: string, remote: string): Promise<string> {
  const path = join(root, name);
  const { runGit } = await import("../../src/git/git-ticket-branch-cleaner.ts");
  await runGit(["init", "-q", path], root);
  await runGit(["remote", "add", "origin", remote], path);
  await runGit(["config", "user.email", "test@example.test"], path);
  await runGit(["config", "user.name", "Test"], path);
  await runGit(["commit", "-q", "--allow-empty", "-m", "seed"], path);
  return path;
}

export function staticGit(remotes: Map<string, string> = new Map()): GitRunner {
  return async (args, directory) => {
    if (args[0] === "remote" && args[1] === "get-url") {
      const name = basename(directory);
      return `${remotes.get(name) ?? (name === repoA ? remoteUrlA : remoteUrlB)}\n`;
    }
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return directory;
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return `${directory}/.git`;
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "a".repeat(40);
    if (args[0] === "rev-parse" && args[1] === "HEAD^{commit}") return "a".repeat(40);
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "status") return "";
    if (args[0] === "symbolic-ref") return `ticket/${ticket}`;
    return "";
  };
}

export interface AzureWorkspaceHarnessOptions {
  huState?: string;
  huChildren?: Array<{ id: number; type: string; state: string }>;
  linkPullRequestFails?: boolean;
  huTransitionFails?: boolean;
  elapsedMs?: number;
  /** Repositories (by directory name) whose OpenCode session leaves a completion manifest. */
  changedRepositories?: string[];
  /** Repository (by directory name) whose pull-request creation must fail. */
  pullRequestFailsIn?: string;
  /** Remote URLs to report per repository directory name, overriding the seeded ones. */
  remotes?: Map<string, string>;
  /** Repository (by directory name) already carrying the ticket's Branch ArtifactLink. */
  resolvedPrimary?: string;
  terminal?: boolean;
}

export interface AzureWorkspaceHarness {
  events: string[];
  huStateCalls: Array<{ desiredState: string; expectedState: string }>;
  prLinkCalls: Array<{ pullRequest: number; target?: AzurePullRequestTarget }>;
  commitLinkCalls: Array<{ pullRequest: number; target?: AzurePullRequestTarget }>;
  prCreateCalls: Array<{ pullRequest: number; target?: AzurePullRequestTarget }>;
  ticketStateCalls: Array<{ desiredState: string }>;
  effortCalls: Array<{ realEffort: number; realEffortHours: number; expectedRevision: number }>;
  deletedTicketBranches: string[];
  ticketBranchLinks: string[];
  checkpointStore: AzureWorkspaceCheckpointStore;
  stateDirectory(): string;
  readCheckpoint(): Promise<AzureWorkspaceCheckpoint | null>;
  writeCheckpoint(checkpoint: AzureWorkspaceCheckpoint): Promise<void>;
  setupCli(overrides?: Partial<AzureBoundary>): Promise<{ cli: LazyWorkflowCli; pathA: string; pathB: string }>;
  cleanup(): Promise<void>;
}

export function createAzureWorkspaceHarness(options: AzureWorkspaceHarnessOptions = {}): AzureWorkspaceHarness {
  const events: string[] = [];
  const huStateCalls: Array<{ desiredState: string; expectedState: string }> = [];
  const prLinkCalls: Array<{ pullRequest: number; target?: AzurePullRequestTarget }> = [];
  const commitLinkCalls: Array<{ pullRequest: number; target?: AzurePullRequestTarget }> = [];
  const prCreateCalls: Array<{ pullRequest: number; target?: AzurePullRequestTarget }> = [];
  const ticketStateCalls: Array<{ desiredState: string }> = [];
  const effortCalls: Array<{ realEffort: number; realEffortHours: number; expectedRevision: number }> = [];
  const deletedTicketBranches: string[] = [];
  const ticketBranchLinks: string[] = [];
  const checkpointStore = new AzureWorkspaceCheckpointStore();
  const huChildren = options.huChildren ?? [];
  const changedRepositories = options.changedRepositories ?? [repoA, repoB];
  let prCounter = 0;
  let root: string | null = null;
  let parentDirectory: string | null = null;
  let currentTicketState = "En progreso";
  let currentHuState = options.huState ?? "En Desarrollo";
  let currentTicketRevision = 4;

  const harness: AzureWorkspaceHarness = {
    events,
    huStateCalls,
    prLinkCalls,
    commitLinkCalls,
    prCreateCalls,
    ticketStateCalls,
    effortCalls,
    deletedTicketBranches,
    ticketBranchLinks,
    checkpointStore,
    stateDirectory() {
      if (!parentDirectory) throw new Error("harness not set up");
      return resolve(parentDirectory, ".lazy-workflow");
    },
    readCheckpoint() {
      return checkpointStore.read(harness.stateDirectory());
    },
    writeCheckpoint(checkpoint) {
      return checkpointStore.write(checkpoint, harness.stateDirectory());
    },
    async setupCli(overrides = {}) {
      root = await realpath(await mkdtemp(join(tmpdir(), "lazy-workflow-azure-workspace-")));
      const pathA = await seedRepo(root, repoA, remoteUrlA);
      const pathB = await seedRepo(root, repoB, remoteUrlB);
      parentDirectory = root;

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
        getTicketInfo: async (huId, ticketId) => ({
          hu: { id: huId, title: "HU" },
          ticket: { id: ticketId, type: "Task" as const, title: "Ticket", state: currentTicketState, revision: currentTicketRevision },
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
        linkTicketBranch: async (_huId, ticketId, branch: string, repositories: readonly string[]) => {
          const resolved = repositories.find((path) => basename(path) === options.resolvedPrimary) ?? repositories[0]!;
          ticketBranchLinks.push(basename(resolved));
          return { ticket: ticketId, branch, workingDirectory: resolved };
        },
        getCompletionInfo: async (huId, ticketId) => ({ hu: huId, ticket: ticketId, gates: { satisfied: [], unmet: [] } }),
        readCompletionManifest: async () => ({
          ticket,
          ticketBranch,
          commit: "a".repeat(40),
          validation: [{ command: "bun test", result: "passed" }],
          evidence: [{ path: "/tmp/evidence.json", kind: "command-output", sha256: "a".repeat(64) }],
        }),
        validateCompletionManifest: async () => undefined,
        getCompletionManifestPath: async (workingDirectory: string) => join(workingDirectory, "lazy-workflow/completion-manifest.json"),
        createOrReusePullRequest: async (_huId, _ticketId, target?: AzurePullRequestTarget) => {
          if (options.pullRequestFailsIn && target?.repository === options.pullRequestFailsIn) {
            events.push(`pr-failed:${target.repository}`);
            throw new Error(`no se pudo crear el PR en ${target.repository}`);
          }
          prCounter += 1;
          const pullRequest = prCounter;
          prCreateCalls.push({ pullRequest, target });
          events.push(`pr:${pullRequest}`);
          return { pullRequest, mergeCommit: `merge-${pullRequest}` };
        },
        validateEvidenceFile: async () => undefined,
        validateEvidence: async () => undefined,
        getBranch: async () => ({ hu, ticket, branch: ticketBranch, integrationBranch }),
        getTicket: async (id: number) => ({ id, type: "Task" as const }),
        getDescription: async () => ({ ticket, description: null }),
        getState: async (id: number) => {
          if (id === ticket) return { ticket: id, state: currentTicketState, revision: currentTicketRevision };
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
            currentTicketRevision += 1;
            ticketStateCalls.push({ desiredState });
          }
          if (id === hu) {
            currentHuState = desiredState;
            huStateCalls.push({ desiredState, expectedState: options.huState ?? "En Desarrollo" });
          }
          events.push(`state:${id}:${desiredState}`);
          return { ticket: id, state: desiredState, revision: id === ticket ? currentTicketRevision : 5 };
        },
        setEffort: async (_ticketId, realEffort: number, realEffortHours: number, expectedRevision: number) => {
          effortCalls.push({ realEffort, realEffortHours, expectedRevision });
          return undefined;
        },
        linkPullRequest: async (huId, ticketId, pullRequest: number, target?: AzurePullRequestTarget) => {
          events.push(`link-pr:${pullRequest}`);
          if (options.linkPullRequestFails && pullRequest === 2) throw new Error("native PR association failed");
          prLinkCalls.push({ pullRequest, target });
          return { hu: huId, ticket: ticketId, pullRequest, mergeCommit: `merge-${pullRequest}` };
        },
        linkCommit: async (ticketId: number, pullRequest: number, target?: AzurePullRequestTarget) => {
          events.push(`link-commit:${pullRequest}`);
          commitLinkCalls.push({ pullRequest, target });
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
            repository: basename(repositories[0]!.path),
            project: teamProject,
            projectId: "project-id",
            repositoryId: `${basename(repositories[0]!.path)}-id`,
          },
          ticketBranchAnchor: null,
          units: repositories.map((repository) => ({
            path: repository.path,
            remote: repository.remote,
            repository: basename(repository.path),
            repositoryId: `${basename(repository.path)}-id`,
            projectId,
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
            repository: basename(repositories[0]!.path),
            project: teamProject,
            projectId: "project-id",
            repositoryId: `${basename(repositories[0]!.path)}-id`,
          },
          ticketBranchAnchor: repositories[0]!.path,
          units: repositories.map((repository) => ({
            path: repository.path,
            remote: repository.remote,
            repository: basename(repository.path),
            repositoryId: `${basename(repository.path)}-id`,
            projectId,
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

      let ticks = 0;
      const elapsedMs = options.elapsedMs ?? 0;
      const clock = { now: () => (ticks++ === 0 ? 0 : elapsedMs) };
      const terminal = options.terminal ?? true;
      const cli = new LazyWorkflowCli(
        azureBoundary,
        {
          run: async () => {
            events.push("opencode:run");
            for (const name of changedRepositories) {
              await Bun.write(join(root!, name, "lazy-workflow/completion-manifest.json"), "{}");
            }
            return {
              result: { text: terminal ? "IMPLEMENTATION_READY" : "still working", sessionId: "ses", failed: false } as never,
              azureLoginRequired: false,
              failed: false,
            };
          },
          resume: async () => {
            events.push("opencode:resume");
            for (const name of changedRepositories) {
              await Bun.write(join(root!, name, "lazy-workflow/completion-manifest.json"), "{}");
            }
            return { text: "IMPLEMENTATION_READY", sessionId: "ses" } as never;
          },
        },
        undefined,
        undefined,
        {
          deleteTicketBranch: async (branch: string, _integration: string, workingDirectory: string) => {
            deletedTicketBranches.push(`${basename(workingDirectory)}:${branch}`);
          },
        },
        clock,
        undefined,
        staticGit(options.remotes),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        checkpointStore,
      );
      return { cli, pathA, pathB };
    },
    async cleanup() {
      if (root) await rm(root, { recursive: true, force: true });
    },
  };
  return harness;
}
