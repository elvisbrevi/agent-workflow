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
    schemaVersion: 2,
    cli: "opencode",
    workflow: "github-workspace-code",
    issue: 178,
    phase: "implementing",
    sessionId: "ses_178",
    branch: "refs/heads/issue/178",
    parentDirectory: "/workspace",
    repositories: [{ path: "/workspace/repo-a", remote: "git@github.com:owner/repo-a.git", repository: "owner/repo-a" }],
    units: [],
    receipts: {},
    intent: null,
  };
}

test("los checkpoints workspace nombran el CLI dueño de la sesión", () => {
  expect(isAzureWorkspaceCheckpoint({ ...azureCheckpoint(), cli: "claudecode" })).toBeTrue();
  expect(isAzureWorkspaceCheckpoint({ ...azureCheckpoint(), cli: "gemini" })).toBeFalse();
  expect(isAzureWorkspaceCheckpoint({ ...azureCheckpoint(), schemaVersion: 1 })).toBeFalse();
  expect(isGitHubWorkspaceCheckpoint({ ...githubCheckpoint(), cli: "claudecode" })).toBeTrue();
  expect(isGitHubWorkspaceCheckpoint({ ...githubCheckpoint(), cli: "gemini" })).toBeFalse();
  expect(isGitHubWorkspaceCheckpoint({ ...githubCheckpoint(), schemaVersion: 1 })).toBeFalse();
});

for (const form of [
  { label: "Azure", store: new AzureWorkspaceCheckpointStore(), fileName: "azure-workspace-code-checkpoint.json", checkpoint: azureCheckpoint() },
  { label: "GitHub", store: new GitHubWorkspaceCheckpointStore(), fileName: "github-workspace-code-checkpoint.json", checkpoint: githubCheckpoint() },
] as const) {
  test(`un checkpoint workspace ${form.label} de la versión anterior se lee como OpenCode y se reescribe`, async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "lazy-workflow-workspace-checkpoint-"));
    try {
      const { schemaVersion: _version, cli: _cli, ...rest } = form.checkpoint;
      const path = join(stateDirectory, form.fileName);
      await Bun.write(path, `${JSON.stringify({ schemaVersion: 1, ...rest })}\n`);

      expect(await form.store.read(stateDirectory)).toEqual(form.checkpoint as never);
      expect(await Bun.file(path).json()).toEqual(form.checkpoint);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
}
