import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { LazyWorkflowCli, type AzureBoundary } from "../src/cli/lazy-workflow-cli.ts";
import type { GitRunner } from "../src/git/git-ticket-branch-cleaner.ts";
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
  const azureBoundary: Pick<AzureBoundary, "getHuInfo" | "waitForAccess" | "prepareWorkspaceBranches" | "prepareWorkspaceTicketBranches" | "createOrReusePullRequest" | "checkoutTicketBranch" | "pushTicketBranch" | "linkPullRequest" | "linkCommit" | "getTicketInfo" | "setEffort" | "setState" | "getCompletionManifestPath" | "readCompletionManifest" | "validateCompletionManifest" | "getBranch" | "validateEvidenceFile" | "addAttachment" | "setEvidence" | "getState" | "getEffort" | "validateEvidence" | "setHuState" | "hasOpenDeliveryChildren" | "getAutocodeContextForTicket" | "getTicket" | "getDescription" | "getAttachments" | "getEvidence" | "validateDirectTicketContext" | "linkTicketBranch"> = {
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
      if (id === hu) return { ticket: id, state: currentHuState, revision: 7 };
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
