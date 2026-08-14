import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import type { AzureBoundary } from "../src/cli/lazy-workflow-cli.ts";
import type { GitRunner } from "../src/git/git-ticket-branch-cleaner.ts";

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
  const azureBoundary: Pick<AzureBoundary, "getHuInfo" | "waitForAccess" | "prepareWorkspaceBranches" | "prepareWorkspaceTicketBranches"> = {
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
          { path: realpathA, remote: remoteUrlA, repository: repoA, project: teamProject, integrationBranch, ticketBranch: null, integrationBranchCreated: true, ticketBranchCreated: false, ticketBranchAnchor: null },
          { path: realpathB, remote: remoteUrlB, repository: repoB, project: teamProject, integrationBranch, ticketBranch: null, integrationBranchCreated: true, ticketBranchCreated: false, ticketBranchAnchor: null },
        ],
      };
    },
    prepareWorkspaceTicketBranches: async () => {
      throw new Error("must not be called");
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
    const exit = await cli.run(["code", "--hu", `${hu}`, "--base-branch", "main", "--working-directory", `${pathA}, ${pathB}`]);
    expect(exit).toBe(0);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]!.hu).toBe(hu);
    expect(prepared[0]!.repositories.map(({ path }) => path).sort()).toEqual([realpathA, realpathB].sort());
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
