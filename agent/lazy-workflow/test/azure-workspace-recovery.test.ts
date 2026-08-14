import { expect, test } from "bun:test";
import { join } from "node:path";
import type { AzureWorkspaceCheckpoint } from "../src/azure/azure-workspace-checkpoint.ts";
import {
  createAzureWorkspaceHarness,
  hu,
  integrationBranch,
  remoteUrlA,
  remoteUrlB,
  repoA,
  repoAId,
  repoB,
  repoBId,
  teamProject,
  ticket,
  ticketBranch,
} from "./_helpers/azure-workspace-fixtures.ts";

function checkpointFor(
  pathA: string,
  pathB: string,
  parentDirectory: string,
  overrides: Partial<AzureWorkspaceCheckpoint> = {},
): AzureWorkspaceCheckpoint {
  return {
    schemaVersion: 1,
    workflow: "azure-workspace-code",
    hu,
    ticket,
    phase: "integrating",
    sessionId: null,
    integrationBranch,
    ticketBranch,
    parentDirectory,
    activeDurationMs: 0,
    repositories: [{ path: pathA, remote: remoteUrlA }, { path: pathB, remote: remoteUrlB }],
    units: [],
    receipts: {},
    intent: null,
    ...overrides,
  };
}

function unit(path: string, repository: string, overrides: Partial<AzureWorkspaceCheckpoint["units"][number]> = {}): AzureWorkspaceCheckpoint["units"][number] {
  return {
    path,
    remote: repository === repoA ? remoteUrlA : remoteUrlB,
    repository,
    project: teamProject,
    changed: true,
    commit: "a".repeat(40),
    pullRequest: null,
    mergeCommit: null,
    receipts: {},
    ...overrides,
  };
}

test("azure workspace recovery stops when a repository was added to the declared scope", async () => {
  const harness = createAzureWorkspaceHarness();
  let exit = -1;
  let preserved: AzureWorkspaceCheckpoint | null = null;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    const checkpoint = checkpointFor(pathA, pathB, harness.stateDirectory().replace(/\/\.lazy-workflow$/, ""));
    await harness.writeCheckpoint({ ...checkpoint, repositories: [{ path: pathA, remote: remoteUrlA }] });
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
    preserved = await harness.readCheckpoint();
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(1);
  expect(harness.prCreateCalls).toHaveLength(0);
  expect(harness.ticketStateCalls).toHaveLength(0);
  expect(harness.events).not.toContain("opencode:run");
  expect(preserved?.repositories).toHaveLength(1);
});

test("azure workspace recovery stops when a repository was removed from the declared scope", async () => {
  const harness = createAzureWorkspaceHarness();
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    const checkpoint = checkpointFor(pathA, pathB, harness.stateDirectory().replace(/\/\.lazy-workflow$/, ""));
    await harness.writeCheckpoint({
      ...checkpoint,
      repositories: [...checkpoint.repositories, { path: `${pathB}-extra`, remote: "https://dev.azure.com/org/Team/_git/extra" }],
    });
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(1);
  expect(harness.prCreateCalls).toHaveLength(0);
  expect(harness.ticketStateCalls).toHaveLength(0);
});

test("azure workspace recovery stops when the declared order changes", async () => {
  const harness = createAzureWorkspaceHarness();
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    await harness.writeCheckpoint(checkpointFor(pathA, pathB, harness.stateDirectory().replace(/\/\.lazy-workflow$/, "")));
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathB}, ${pathA}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(1);
  expect(harness.prCreateCalls).toHaveLength(0);
  expect(harness.ticketStateCalls).toHaveLength(0);
});

test("azure workspace recovery stops when a checkpointed remote identity changed", async () => {
  const harness = createAzureWorkspaceHarness({
    remotes: new Map([[repoB, "https://dev.azure.com/org/Team/_git/other-repo"]]),
  });
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    await harness.writeCheckpoint(checkpointFor(pathA, pathB, harness.stateDirectory().replace(/\/\.lazy-workflow$/, "")));
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(1);
  expect(harness.prCreateCalls).toHaveLength(0);
  expect(harness.ticketStateCalls).toHaveLength(0);
});

test("azure workspace recovery stops when --session does not match the checkpoint", async () => {
  const harness = createAzureWorkspaceHarness();
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    await harness.writeCheckpoint(checkpointFor(pathA, pathB, harness.stateDirectory().replace(/\/\.lazy-workflow$/, ""), {
      phase: "implementing",
      sessionId: "ses-original",
    }));
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--session", "ses-other", "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(1);
  expect(harness.events).not.toContain("opencode:resume");
  expect(harness.prCreateCalls).toHaveLength(0);
});

test("azure workspace recovery reuses a verified delivery receipt instead of creating a second PR", async () => {
  const harness = createAzureWorkspaceHarness();
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    // The interrupted run already produced both manifests before it stopped.
    for (const path of [pathA, pathB]) await Bun.write(join(path, "lazy-workflow/completion-manifest.json"), "{}");
    await harness.writeCheckpoint(checkpointFor(pathA, pathB, harness.stateDirectory().replace(/\/\.lazy-workflow$/, ""), {
      phase: "implementation-ready",
      units: [
        unit(pathA, repoA, { pullRequest: 41, mergeCommit: "merge-41", receipts: { delivery: { verifiedAt: new Date(0).toISOString() } } }),
        unit(pathB, repoB),
      ],
    }));
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(0);
  expect(harness.events).not.toContain("opencode:run");
  expect(harness.prCreateCalls.map(({ target }) => target?.repository)).toEqual([repoBId]);
  expect(harness.ticketStateCalls.map(({ desiredState }) => desiredState)).toEqual(["Done"]);
});

test("azure workspace delivery leaves later repositories pending and preserves the checkpoint on failure", async () => {
  const harness = createAzureWorkspaceHarness({ pullRequestFailsIn: repoBId });
  let exit = -1;
  let preserved: AzureWorkspaceCheckpoint | null = null;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
    preserved = await harness.readCheckpoint();
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(1);
  expect(harness.prCreateCalls.map(({ target }) => target?.repository)).toEqual([repoAId]);
  expect(harness.ticketStateCalls).toHaveLength(0);
  expect(harness.huStateCalls).toHaveLength(0);
  expect(preserved).not.toBeNull();
  const units = preserved!.units;
  expect(units.find(({ repository }) => repository === repoA)?.receipts.delivery).toBeDefined();
  expect(units.find(({ repository }) => repository === repoB)?.receipts.delivery).toBeUndefined();
  expect(units.find(({ repository }) => repository === repoA)?.pullRequest).toBe(1);
  expect(preserved!.intent).toEqual({ effect: "azure-delivery", target: units.find(({ repository }) => repository === repoB)!.path });
});

test("azure workspace delivery anchors the ticket branch link on the first changed repository", async () => {
  const harness = createAzureWorkspaceHarness({ changedRepositories: [repoB] });
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(0);
  // repo-a is declared first but produces no manifest, so repo-b is the primary repository.
  expect(harness.ticketBranchLinks).toEqual([repoB]);
  expect(harness.prCreateCalls.map(({ target }) => target?.repository)).toEqual([repoBId]);
});

test("azure workspace recovery reuses the checkpointed primary repository instead of reselecting", async () => {
  const harness = createAzureWorkspaceHarness();
  let exit = -1;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    for (const path of [pathA, pathB]) await Bun.write(join(path, "lazy-workflow/completion-manifest.json"), "{}");
    await harness.writeCheckpoint(checkpointFor(pathA, pathB, harness.stateDirectory().replace(/\/\.lazy-workflow$/, ""), {
      phase: "implementation-ready",
      // An earlier run picked repo-b because repo-a had not changed yet.
      primaryRepository: pathB,
    }));
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(0);
  expect(harness.ticketBranchLinks).toEqual([repoB]);
});

test("azure workspace delivery records the primary repository in the checkpoint", async () => {
  const harness = createAzureWorkspaceHarness({ changedRepositories: [repoB], pullRequestFailsIn: repoBId });
  let preserved: AzureWorkspaceCheckpoint | null = null;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
    preserved = await harness.readCheckpoint();
    expect(preserved?.primaryRepository).toBe(pathB);
  } finally {
    await harness.cleanup();
  }
  expect(preserved).not.toBeNull();
});

test("azure workspace delivery cleans the ticket branch of repositories without changes", async () => {
  const harness = createAzureWorkspaceHarness({ changedRepositories: [repoA] });
  let exit = -1;
  let cleared: AzureWorkspaceCheckpoint | null = null;
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    exit = await cli.run(["code", "--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA}, ${pathB}`]);
    cleared = await harness.readCheckpoint();
  } finally {
    await harness.cleanup();
  }
  expect(exit).toBe(0);
  expect(harness.prCreateCalls.map(({ target }) => target?.repository)).toEqual([repoAId]);
  expect(harness.deletedTicketBranches).toEqual([`${repoB}:${ticketBranch}`]);
  expect(cleared).toBeNull();
});
