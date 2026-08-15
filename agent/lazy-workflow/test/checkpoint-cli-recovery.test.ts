import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { AgentResult } from "../src/coding-agent/agent-result.ts";
import type { AgentCli } from "../src/coding-agent/agent-cli.ts";
import type { CodingAgent } from "../src/coding-agent/coding-agent.ts";
import { buildCli } from "../src/cli/parse-cli-options.ts";
import type { AutocodeCheckpointStore, VersionedAutocodeCheckpoint } from "../src/azure/autocode-checkpoint.ts";
import type { GitHubCheckpointStore, GitHubDeliveryCheckpoint } from "../src/github/github-delivery-checkpoint.ts";
import type { GitHubWorkspaceCheckpoint } from "../src/github/github-workspace-checkpoint.ts";
import type { GitHubRepositoryLockBoundary } from "../src/github/github-repository-lock.ts";
import type { GitRunner } from "../src/git/git-ticket-branch-cleaner.ts";
import { fakeSelectedIssue } from "./_helpers/managed-queue-fixtures.ts";
import { createAzureWorkspaceHarness, hu, integrationBranch, remoteUrlA, remoteUrlB, repoA, repoB, ticket, ticketBranch } from "./_helpers/azure-workspace-fixtures.ts";

/** Records which CLI the run resolved and never lets a session actually open. */
function spyingAgents(): { requested: AgentCli[]; resumed: AgentCli[]; source: (cli: AgentCli) => CodingAgent } {
  const requested: AgentCli[] = [];
  const resumed: AgentCli[] = [];
  // The resumed session reports its terminal marker, so a recovery run ends
  // instead of retrying while the assertion only cares about which CLI resumed.
  const result = AgentResult.fromJsonLines(JSON.stringify({
    type: "text", sessionID: "ses_recovered", part: { type: "text", text: "IMPLEMENTATION_READY" },
  }));
  return {
    requested,
    resumed,
    source: (cli) => {
      requested.push(cli);
      return {
        run: async () => { throw new Error("recovery must resume, never start a session"); },
        resume: async () => { resumed.push(cli); return result; },
      };
    },
  };
}

const azure = {
  getHuInfo: async () => { throw new Error("must not use Azure"); },
  waitForAccess: async () => undefined,
};

function githubDeliveryCheckpoint(cli: AgentCli): GitHubDeliveryCheckpoint {
  return {
    schemaVersion: 2,
    cli,
    workflow: "github-code",
    repository: "owner/repo",
    issue: 178,
    phase: "implementing",
    branch: null,
    sessionId: "ses_recovered",
    commit: null,
    pullRequest: null,
    receipts: {},
  };
}

function githubDeliveryCli(checkpoint: GitHubDeliveryCheckpoint, agents: ReturnType<typeof spyingAgents>) {
  let current: GitHubDeliveryCheckpoint | null = checkpoint;
  const store: GitHubCheckpointStore = {
    read: async () => current,
    write: async (value) => { current = value; },
    clear: async () => { current = null; },
  };
  const lock: GitHubRepositoryLockBoundary = { acquire: async () => async () => undefined };
  const cli = new LazyWorkflowCli(
    azure,
    agents.source,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    buildCli(() => true),
    undefined,
    {
      reconcileClaimedIssue: async () => fakeSelectedIssue(178),
      selectAndClaimEligibleIssue: async () => ({ kind: "empty" as const }),
    },
    store,
    lock,
  );
  return { cli, store, get current() { return current; } };
}

test("la entrega GitHub reanuda con el CLI que fijó el checkpoint", async () => {
  const agents = spyingAgents();
  const { cli } = githubDeliveryCli(githubDeliveryCheckpoint("claudecode"), agents);

  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await cli.run(["code", "--working-directory", "/repo"]);
  } finally {
    console.log = originalLog;
  }

  expect(agents.resumed).toEqual(["claudecode"]);
});

test("un --cli que contradice el checkpoint GitHub falla cerrado y lo conserva", async () => {
  const agents = spyingAgents();
  const checkpoint = githubDeliveryCheckpoint("claudecode");
  const state = githubDeliveryCli(checkpoint, agents);

  expect(await state.cli.run(["code", "--cli", "opencode", "--working-directory", "/repo"])).toBe(1);
  expect(agents.resumed).toEqual([]);
  expect(state.current).toEqual(checkpoint);
});

function autocodeCheckpoint(cli: AgentCli): VersionedAutocodeCheckpoint {
  return {
    schemaVersion: 3,
    cli,
    workflow: "autocode",
    phase: "implementing",
    hu: 23438,
    ticket: 51,
    integrationBranch: "refs/heads/hu/23438",
    ticketBranch: "refs/heads/ticket/51",
    azureRevision: 7,
    effortBaseline: { real: 1, realHours: 1 },
    activeDurationMs: 0,
    activeSince: null,
    sessionId: "ses_recovered",
    intent: null,
    receipts: {},
  };
}

function autocodeCli(checkpoint: VersionedAutocodeCheckpoint, agents: ReturnType<typeof spyingAgents>) {
  const writes: VersionedAutocodeCheckpoint[] = [];
  const store: AutocodeCheckpointStore = {
    read: async () => checkpoint,
    write: async (value) => { writes.push(value as VersionedAutocodeCheckpoint); },
    clear: async () => undefined,
  };
  const cli = new LazyWorkflowCli(
    {
      ...azure,
      getHuInfo: async () => ({ id: 23438 }),
      ensureIntegrationBranch: async () => checkpoint.integrationBranch!,
      getAutocodeContextForTicket: async () => ({ hu: { id: 23438 }, ticket: { id: 51, type: "Task" as const }, integrationBranch: checkpoint.integrationBranch! }),
      getState: async () => ({ ticket: 51, state: "En progreso", revision: 7 }),
      getEffort: async () => ({ ticket: 51, effort: { real: 1, realHours: 1 } }),
      getBranch: async () => ({ hu: 23438, ticket: 51, branch: checkpoint.ticketBranch!, integrationBranch: checkpoint.integrationBranch! }),
      setTicketBranch: async () => ({ hu: 23438, ticket: 51, branch: checkpoint.ticketBranch! }),
    },
    agents.source,
    store,
    { wait: async () => undefined },
    { deleteTicketBranch: async () => undefined },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    buildCli(() => true),
  );
  return { cli, writes };
}

test("la entrega Azure reanuda con el CLI que fijó el checkpoint", async () => {
  const agents = spyingAgents();
  const { cli } = autocodeCli(autocodeCheckpoint("claudecode"), agents);

  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await cli.run(["code", "--hu", "23438", "--session", "ses_recovered", "--working-directory", "/repo"]);
  } finally {
    console.log = originalLog;
  }

  expect(agents.resumed).toEqual(["claudecode"]);
});

test("un --cli que contradice el checkpoint Azure falla cerrado y lo conserva", async () => {
  const agents = spyingAgents();
  const state = autocodeCli(autocodeCheckpoint("claudecode"), agents);

  expect(await state.cli.run([
    "code", "--hu", "23438", "--session", "ses_recovered", "--working-directory", "/repo", "--cli", "opencode",
  ])).toBe(1);
  expect(agents.resumed).toEqual([]);
  expect(state.writes).toEqual([]);
});

async function githubWorkspace(cli: AgentCli, agents: ReturnType<typeof spyingAgents>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lazy-workflow-workspace-cli-")));
  const paths = [join(root, "repo-a"), join(root, "repo-b")];
  await Bun.$`mkdir -p ${paths[0]} ${paths[1]}`.quiet();
  const checkpoint: GitHubWorkspaceCheckpoint = {
    schemaVersion: 2,
    cli,
    workflow: "github-workspace-code",
    issue: 188,
    phase: "implementing",
    sessionId: "ses_recovered",
    branch: "refs/heads/issue/188",
    parentDirectory: root,
    repositories: paths.map((path) => ({ path, remote: `git@github.com:owner/${basename(path)}.git`, repository: `owner/${basename(path)}` })),
    units: [],
    receipts: {},
    intent: null,
  };
  const checkpointPath = join(root, ".lazy-workflow", "github-workspace-code-checkpoint.json");
  await Bun.write(checkpointPath, `${JSON.stringify(checkpoint)}\n`);
  const git: GitRunner = async (args, directory) => {
    if (args[0] === "rev-parse" && args[1] === "HEAD^{commit}") return "c".repeat(40);
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "remote") return `git@github.com:owner/${basename(directory)}.git`;
    return "";
  };
  const workflow = new LazyWorkflowCli(
    azure,
    agents.source,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    git,
    undefined,
    undefined,
    undefined,
    buildCli(() => true),
    undefined,
    { selectAndClaimEligibleIssue: async () => ({ kind: "empty" as const }) },
  );
  return {
    workflow,
    paths,
    readCheckpoint: async (): Promise<unknown> => Bun.file(checkpointPath).json(),
    checkpoint,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("el workspace GitHub reanuda con el CLI que fijó el checkpoint", async () => {
  const agents = spyingAgents();
  const state = await githubWorkspace("claudecode", agents);
  try {
    await state.workflow.run(["code", "--working-directory", state.paths.join(",")]);
    expect(agents.resumed).toEqual(["claudecode"]);
  } finally {
    await state.cleanup();
  }
});

test("un --cli que contradice el checkpoint workspace GitHub falla cerrado y lo conserva", async () => {
  const agents = spyingAgents();
  const state = await githubWorkspace("claudecode", agents);
  try {
    expect(await state.workflow.run(["code", "--cli", "opencode", "--working-directory", state.paths.join(",")])).toBe(1);
    expect(agents.resumed).toEqual([]);
    expect(await state.readCheckpoint()).toEqual(state.checkpoint);
  } finally {
    await state.cleanup();
  }
});

test("el workspace Azure reanuda con el CLI que fijó el checkpoint y rechaza uno contradictorio", async () => {
  const requested: AgentCli[] = [];
  const harness = createAzureWorkspaceHarness({ observeCli: (cli) => requested.push(cli) });
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    await harness.writeCheckpoint({
      schemaVersion: 2,
      cli: "claudecode",
      workflow: "azure-workspace-code",
      hu,
      ticket,
      phase: "implementing",
      sessionId: "ses_recovered",
      integrationBranch,
      ticketBranch,
      parentDirectory: harness.stateDirectory().replace(/\/\.lazy-workflow$/, ""),
      activeDurationMs: 0,
      repositories: [{ path: pathA, remote: remoteUrlA }, { path: pathB, remote: remoteUrlB }],
      units: [],
      receipts: {},
      intent: null,
    });
    const scope = ["--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA},${pathB}`];

    expect(await cli.run(["code", ...scope, "--cli", "opencode"])).toBe(1);
    expect(harness.events).not.toContain("opencode:resume");
    expect((await harness.readCheckpoint())?.cli).toBe("claudecode");

    await cli.run(["code", ...scope]);
    expect(requested).toContain("claudecode");
    expect(harness.events).toContain("opencode:resume");
  } finally {
    await harness.cleanup();
  }
});
