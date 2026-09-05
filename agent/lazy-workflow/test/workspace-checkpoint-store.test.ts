import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AzureWorkspaceCheckpointStore,
  isAzureWorkspaceCheckpoint,
  type AzureWorkspaceCheckpoint,
} from "../src/azure/azure-workspace-checkpoint.ts";
import {
  GitHubWorkspaceCheckpointStore,
  isGitHubWorkspaceCheckpoint,
  type GitHubWorkspaceCheckpoint,
} from "../src/github/github-workspace-checkpoint.ts";

function azureCheckpoint(): AzureWorkspaceCheckpoint {
  return {
    schemaVersion: 2,
    cli: "opencode",
    workflow: "azure-workspace-code",
    hu: 23438,
    ticket: 51,
    phase: "implementing",
    sessionId: "ses_51",
    integrationBranch: "refs/heads/hu/23438",
    ticketBranch: "refs/heads/ticket/51",
    parentDirectory: "/workspace",
    activeDurationMs: 0,
    repositories: [{ path: "/workspace/repo-a", remote: "https://dev.azure.com/org/Team/_git/repo-a" }],
    units: [],
    receipts: {},
    intent: null,
  };
}

function githubCheckpoint(): GitHubWorkspaceCheckpoint {
  return {
    schemaVersion: 3,
    workflow: "github-workspace-code",
    issue: 178,
    parentDirectory: "/workspace",
    repositories: [{ path: "/workspace/repo-a", remote: "git@github.com:owner/repo-a.git", repository: "owner/repo-a" }],
    units: [],
    summary: null,
  };
}

test("los checkpoints workspace Azure nombran el CLI dueño de la sesión", () => {
  expect(isAzureWorkspaceCheckpoint({ ...azureCheckpoint(), cli: "claudecode" })).toBeTrue();
  expect(isAzureWorkspaceCheckpoint({ ...azureCheckpoint(), cli: "gemini" })).toBeFalse();
  expect(isAzureWorkspaceCheckpoint({ ...azureCheckpoint(), schemaVersion: 1 })).toBeFalse();
});

test("un checkpoint workspace Azure de la versión anterior se lee como OpenCode y se reescribe", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "lazy-workflow-workspace-checkpoint-"));
  try {
    const checkpoint = azureCheckpoint();
    const { schemaVersion: _version, cli: _cli, ...rest } = checkpoint;
    const path = join(stateDirectory, "azure-workspace-code-checkpoint.json");
    await Bun.write(path, `${JSON.stringify({ schemaVersion: 1, ...rest })}\n`);

    const store = new AzureWorkspaceCheckpointStore();
    expect(await store.read(stateDirectory)).toEqual(checkpoint as never);
    expect(await Bun.file(path).json()).toEqual(checkpoint);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("el checkpoint workspace GitHub no lleva fase, sesión ni recibos: solo lo que git no puede contar (ADR-0038)", () => {
  const checkpoint = githubCheckpoint();
  expect(isGitHubWorkspaceCheckpoint(checkpoint)).toBeTrue();
  for (const stale of ["phase", "sessionId", "cli", "receipts", "intent", "reconciliation"]) {
    expect(isGitHubWorkspaceCheckpoint({ ...checkpoint, [stale]: "anything" })).toBeFalse();
  }
  expect(isGitHubWorkspaceCheckpoint({ ...checkpoint, schemaVersion: 2 })).toBeFalse();
});

test("un checkpoint workspace GitHub persiste y se lee de vuelta igual", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "lazy-workflow-workspace-checkpoint-"));
  try {
    const checkpoint = githubCheckpoint();
    const store = new GitHubWorkspaceCheckpointStore();
    await store.write(checkpoint, stateDirectory);
    expect(await store.read(stateDirectory)).toEqual(checkpoint);
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
