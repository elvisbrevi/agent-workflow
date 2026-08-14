import { expect, test } from "bun:test";
import { AzureAutocodeService } from "../src/azure/autocode-service.ts";

const hu = 192;
const ticket = 193;
const projectId = "project-id";
const teamProject = "Team";
const repoA = "repo-a";
const repoB = "repo-b";
const repoC = "repo-c";
const remoteUrlA = `https://dev.azure.com/org/${teamProject}/_git/${repoA}`;
const remoteUrlB = `https://dev.azure.com/org/${teamProject}/_git/${repoB}`;
const remoteUrlC = `https://dev.azure.com/org/${teamProject}/_git/${repoC}`;
const integrationBranch = `refs/heads/hu/${hu}`;
const ticketBranch = `refs/heads/ticket/${ticket}`;
const baseBranch = "refs/heads/main";
const baseSha = "1".repeat(40);

const repositoryId = (repository: string): string => `${repository}-id`;
const huBranchUri = (repository: string): string =>
  `vstfs:///Git/Ref/${projectId}%2F${repositoryId(repository)}%2FGBhu%2F${hu}`;
const ticketBranchUri = (repository: string): string =>
  `vstfs:///Git/Ref/${projectId}%2F${repositoryId(repository)}%2FGBticket%2F${ticket}`;

function resolvedRepository(repository: string): unknown {
  return {
    id: repositoryId(repository),
    name: repository,
    project: { id: projectId, name: teamProject },
    remoteUrl: `https://dev.azure.com/org/${teamProject}/_git/${repository}`,
  };
}

interface RepositoryFixture {
  remoteUrl: string;
  remoteBranches?: Record<string, string>;
  dirty?: string;
}

interface WorkspaceFixtureOptions {
  huRelations?: Array<Record<string, unknown>>;
  ticketRelations?: Array<Record<string, unknown>>;
  repositories?: RepositoryFixture[];
}

interface WorkspaceFixture {
  service: AzureAutocodeService;
  repositories: Array<{ path: string; remote: string }>;
  patchBodies: Array<{ repository: string; body: unknown }>;
  patchCommands: Array<{ repository: string; args: string[] }>;
  pushCommands: Array<{ repository: string; args: string[] }>;
  fetchCommands: Array<{ repository: string; args: string[] }>;
  dirty: (remote: string, status: string) => void;
  branchShas: Map<string, string>;
}

function workspaceFixture(options: WorkspaceFixtureOptions = {}): WorkspaceFixture {
  const repositories = options.repositories ?? [
    { remoteUrl: remoteUrlA, remoteBranches: { [baseBranch]: baseSha } },
    { remoteUrl: remoteUrlB, remoteBranches: { [baseBranch]: baseSha } },
  ];
  const pathByRemote = new Map<string, string>();
  for (const [index, repository] of repositories.entries()) {
    pathByRemote.set(repository.remoteUrl, `/repo/${String.fromCharCode(97 + index)}`);
  }
  const repos = repositories.map(({ remoteUrl }) => ({
    path: pathByRemote.get(remoteUrl)!,
    remote: remoteUrl,
  }));
  const patchBodies: Array<{ repository: string; body: unknown }> = [];
  const patchCommands: Array<{ repository: string; args: string[] }> = [];
  const pushCommands: Array<{ repository: string; args: string[] }> = [];
  const fetchCommands: Array<{ repository: string; args: string[] }> = [];
  const statuses: Map<string, string> = new Map();
  const branchShas: Map<string, string> = new Map();
  for (const repository of repositories) {
    for (const [ref, sha] of Object.entries(repository.remoteBranches ?? {})) {
      branchShas.set(`${repository.remoteUrl}:${ref}`, sha);
    }
  }
  const huItem = {
    id: hu,
    fields: { "System.TeamProject": teamProject },
    relations: [
      ...(options.huRelations ?? []),
      { rel: "System.LinkTypes.Hierarchy-Forward", url: `https://example.test/_apis/wit/workItems/${ticket}` },
    ],
  };
  const ticketItem = {
    id: ticket,
    rev: 4,
    fields: { "System.WorkItemType": "Task" },
    relations: [
      { rel: "System.LinkTypes.Hierarchy-Reverse", url: `https://example.test/_apis/wit/workItems/${hu}` },
      ...(options.ticketRelations ?? []),
    ],
  };
  const boardItems: Map<number, { value: unknown }> = new Map([
    [hu, { value: huItem }],
    [ticket, { value: ticketItem }],
  ]);
  const repositoryByPath = new Map<string, RepositoryFixture>();
  for (const repository of repositories) {
    repositoryByPath.set(pathByRemote.get(repository.remoteUrl)!, repository);
  }
  const targetIdFromArgs = (args: string[]): number | null => {
    const index = args.indexOf("--id");
    return index >= 0 ? Number(args[index + 1]) : null;
  };
  const repositoryFromUri = (uri: string): string => {
    const match = uri.match(/\/([^\/]+)\/_apis\/wit\/workitems\//);
    if (!match) return "";
    const projectIdFromUri = match[1]!;
    const candidate = repositories.find(() => uri.includes(`/${projectIdFromUri}/_apis/`));
    return candidate?.remoteUrl ?? "";
  };
  const az = async (args: string[]): Promise<string> => {
    if (args[0] === "boards") {
      const id = targetIdFromArgs(args);
      if (id === null) throw new Error(`Azure boards missing --id: ${args.join(" ")}`);
      const item = boardItems.get(id);
      if (!item) throw new Error(`Unexpected work item ${id}`);
      return JSON.stringify(item.value);
    }
    if (args[0] === "repos") {
      const repositoryIndex = args.indexOf("--repository");
      const repository = repositories.find((candidate) => candidate.remoteUrl.endsWith(`/${args[repositoryIndex + 1]}`))
        ?? repositories[0];
      if (!repository) throw new Error("No repository scoped for repos show");
      return JSON.stringify(resolvedRepository(args[repositoryIndex + 1]!));
    }
    if (args[0] === "rest") {
      const uri = args[args.indexOf("--uri") + 1]!;
      const body = JSON.parse(args[args.indexOf("--body") + 1]!);
      const remote = repositoryFromUri(uri);
      patchBodies.push({ repository: remote, body });
      patchCommands.push({ repository: remote, args });
      const idMatch = uri.match(/workitems\/(\d+)/);
      const id = idMatch ? Number(idMatch[1]) : null;
      if (id !== null && boardItems.has(id)) {
        const entry = boardItems.get(id)!;
        const item = entry.value as { relations?: Array<Record<string, unknown>> };
        item.relations = [
          ...(item.relations ?? []),
          ...(body as Array<{ value: { rel?: string; url?: string } }>).map((operation) => operation.value),
        ];
      }
      return "{}";
    }
    throw new Error(`Unexpected Azure command: ${args.join(" ")}`);
  };
  const git = async (args: string[], directory: string): Promise<string> => {
    const repository = repositoryByPath.get(directory);
    if (!repository) throw new Error(`unexpected git workingDirectory: ${directory}`);
    if (args[0] === "remote") return `${repository.remoteUrl}\n`;
    if (args[0] === "status") {
      const stored = statuses.get(repository.remoteUrl);
      if (stored !== undefined) return stored;
      return repository.dirty ?? "";
    }
    if (args[0] === "ls-remote") {
      const ref = args.at(-1)!;
      const sha = branchShas.get(`${repository.remoteUrl}:${ref}`);
      return `${sha ?? ""}\t${ref}\n`;
    }
    if (args[0] === "for-each-ref") return "";
    if (args[0] === "fetch") {
      fetchCommands.push({ repository: repository.remoteUrl, args });
      return "";
    }
    if (args[0] === "rev-parse") {
      const ref = args[1]!;
      if (ref.startsWith("refs/lazy-workflow/")) return `${baseSha}\n`;
      return `${baseSha}\n`;
    }
    if (args[0] === "push") {
      const source = args[2]!.split(":")[0];
      if (!source?.startsWith("refs/lazy-workflow/")) throw new Error("push does not use the temporary ref");
      const target = args[2]!.split(":")[1]!;
      branchShas.set(`${repository.remoteUrl}:${target}`, baseSha);
      pushCommands.push({ repository: repository.remoteUrl, args });
      return "";
    }
    if (args[0] === "update-ref") return "";
    throw new Error(`Unexpected Git command in ${directory}: ${args.join(" ")}`);
  };
  return {
    service: new AzureAutocodeService(az, git),
    repositories: repos,
    patchBodies,
    patchCommands,
    pushCommands,
    fetchCommands,
    dirty: (remote: string, status: string) => statuses.set(remote, status),
    branchShas,
  };
}

test("prepareWorkspaceBranches crea la HU en la primera cuando no hay vínculo existente", async () => {
  const fixture = workspaceFixture();

  const topology = await fixture.service.prepareWorkspaceBranches({
    hu,
    repositories: fixture.repositories,
    baseBranch,
  });

  expect(topology.integrationBranch).toBe(integrationBranch);
  expect(topology.anchor.workingDirectory).toBe("/repo/a");
  expect(topology.anchor.repository).toBe(repoA);
  expect(topology.units).toHaveLength(2);
  expect(topology.units.map(({ integrationBranch: branch }) => branch)).toEqual([integrationBranch, integrationBranch]);
  expect(topology.units.every(({ integrationBranchCreated }) => integrationBranchCreated)).toBe(true);
  const patchByRepository = Object.fromEntries(fixture.patchBodies.map(({ repository, body }) => [
    repository === remoteUrlA ? repoA : repository,
    body,
  ]));
  expect(Object.keys(patchByRepository)).toEqual([repoA]);
  expect(patchByRepository[repoA]).toEqual([{
    op: "add",
    path: "/relations/-",
    value: { rel: "ArtifactLink", url: huBranchUri(repoA), attributes: { name: "Branch" } },
  }]);
  expect(new Set(fixture.pushCommands.map(({ repository }) => repository))).toEqual(new Set([remoteUrlA, remoteUrlB]));
});

test("prepareWorkspaceBranches respeta un Branch ArtifactLink existente como ancla", async () => {
  const fixture = workspaceFixture({
    huRelations: [{
      rel: "ArtifactLink",
      url: huBranchUri(repoB),
      attributes: { name: "Branch" },
    }],
    repositories: [
      { remoteUrl: remoteUrlA, remoteBranches: { [baseBranch]: baseSha } },
      { remoteUrl: remoteUrlB, remoteBranches: { [baseBranch]: baseSha, [integrationBranch]: baseSha } },
    ],
  });

  const topology = await fixture.service.prepareWorkspaceBranches({
    hu,
    repositories: fixture.repositories,
    baseBranch,
  });

  expect(topology.anchor.workingDirectory).toBe("/repo/b");
  expect(topology.anchor.repository).toBe(repoB);
  expect(fixture.patchBodies).toHaveLength(0);
  expect(new Set(fixture.pushCommands.map(({ repository }) => repository))).toEqual(new Set([remoteUrlA]));
});

test("prepareWorkspaceBranches falla cerrado ante múltiples Branch ArtifactLink existentes", async () => {
  const fixture = workspaceFixture({
    huRelations: [
      { rel: "ArtifactLink", url: huBranchUri(repoA), attributes: { name: "Branch" } },
      { rel: "ArtifactLink", url: huBranchUri(repoB), attributes: { name: "Branch" } },
    ],
  });

  await expect(fixture.service.prepareWorkspaceBranches({
    hu,
    repositories: fixture.repositories,
    baseBranch,
  })).rejects.toThrow("multiples");
  expect(fixture.patchBodies).toHaveLength(0);
  expect(fixture.pushCommands).toHaveLength(0);
});

test("prepareWorkspaceBranches falla cerrado cuando la rama vinculada no está en el alcance", async () => {
  const fixture = workspaceFixture({
    huRelations: [{
      rel: "ArtifactLink",
      url: huBranchUri(repoC),
      attributes: { name: "Branch" },
    }],
  });

  await expect(fixture.service.prepareWorkspaceBranches({
    hu,
    repositories: fixture.repositories,
    baseBranch,
  })).rejects.toThrow("alcance");
  expect(fixture.patchBodies).toHaveLength(0);
  expect(fixture.pushCommands).toHaveLength(0);
});

test("prepareWorkspaceBranches exige una base explícita para crear la primera rama HU", async () => {
  const fixture = workspaceFixture();

  await expect(fixture.service.prepareWorkspaceBranches({
    hu,
    repositories: fixture.repositories,
  })).rejects.toThrow("base");
  expect(fixture.patchBodies).toHaveLength(0);
  expect(fixture.pushCommands).toHaveLength(0);
});

test("prepareWorkspaceBranches falla cerrado ante un worktree sucio", async () => {
  const fixture = workspaceFixture();
  fixture.dirty(remoteUrlB, " M file.ts\n");

  await expect(fixture.service.prepareWorkspaceBranches({
    hu,
    repositories: fixture.repositories,
    baseBranch,
  })).rejects.toThrow("cambios");
  expect(fixture.patchBodies).toHaveLength(0);
  expect(fixture.pushCommands).toHaveLength(0);
});

test("prepareWorkspaceBranches falla cerrado cuando un participante sin la rama tiene base remota ausente", async () => {
  const fixture = workspaceFixture({
    repositories: [
      { remoteUrl: remoteUrlA, remoteBranches: { [integrationBranch]: baseSha, [baseBranch]: baseSha } },
      { remoteUrl: remoteUrlB },
    ],
  });

  await expect(fixture.service.prepareWorkspaceBranches({
    hu,
    repositories: fixture.repositories,
    baseBranch,
  })).rejects.toThrow("base refs/heads/main");
  expect(fixture.pushCommands).toHaveLength(0);
  expect(fixture.patchBodies).toHaveLength(0);
});

test("prepareWorkspaceBranches relee la rama y el remoto antes de devolver la topología", async () => {
  const fixture = workspaceFixture();
  let huReads = 0;
  let branchReads = 0;
  const original = fixture.service;
  const observed = new AzureAutocodeService(
    async (args) => {
      if (args[0] === "boards" && args[args.indexOf("--id") + 1] === `${hu}`) huReads += 1;
      return (original as unknown as { az: (args: string[]) => Promise<string> }).az(args);
    },
    async (args, directory) => {
      if (args[0] === "ls-remote") branchReads += 1;
      return (original as unknown as { git: (args: string[], directory: string) => Promise<string> }).git(args, directory);
    },
  );

  await observed.prepareWorkspaceBranches({
    hu,
    repositories: fixture.repositories,
    baseBranch,
  });

  expect(huReads).toBeGreaterThanOrEqual(1);
  expect(branchReads).toBeGreaterThanOrEqual(2);
});

test("prepareWorkspaceBranches escribe el Branch ArtifactLink cuando la rama existe pero el vínculo no", async () => {
  const fixture = workspaceFixture({
    repositories: [
      { remoteUrl: remoteUrlA, remoteBranches: { [baseBranch]: baseSha, [integrationBranch]: baseSha } },
      { remoteUrl: remoteUrlB, remoteBranches: { [baseBranch]: baseSha } },
    ],
  });

  const topology = await fixture.service.prepareWorkspaceBranches({
    hu,
    repositories: fixture.repositories,
    baseBranch,
  });

  const huPatch = fixture.patchBodies.find(({ body }) => JSON.stringify(body).includes("hu%2F192"));
  expect(huPatch).toBeDefined();
  expect(topology.anchor.workingDirectory).toBe("/repo/a");
  expect(topology.units[0]!.integrationBranchCreated).toBe(false);
  expect(topology.units[1]!.integrationBranchCreated).toBe(true);
  // Delivery effects compare identity against pull-request payloads, which only carry GUIDs.
  expect(topology.units.map(({ repositoryId }) => repositoryId)).toEqual([
    topology.anchor.repositoryId,
    expect.any(String),
  ]);
  expect(topology.units.every(({ projectId }) => projectId === topology.anchor.projectId)).toBeTrue();
  expect(topology.units.every(({ repository, repositoryId }) => repository !== repositoryId)).toBeTrue();
});

test("prepareWorkspaceTicketBranches crea la rama del ticket en cada participante y ancla el primer repositorio", async () => {
  const fixture = workspaceFixture();
  await fixture.service.prepareWorkspaceBranches({
    hu,
    repositories: fixture.repositories,
    baseBranch,
  });

  const topology = await fixture.service.prepareWorkspaceTicketBranches({
    hu,
    ticket,
    integrationBranch,
    repositories: fixture.repositories,
    ticketBranch,
  });

  expect(topology.ticketBranch).toBe(ticketBranch);
  expect(topology.ticketBranchAnchor).toBe("/repo/a");
  expect(topology.units).toHaveLength(2);
  expect(topology.units.map(({ ticketBranch: branch }) => branch)).toEqual([ticketBranch, ticketBranch]);
  expect(topology.units.every(({ ticketBranchCreated }) => ticketBranchCreated)).toBe(true);
  expect(topology.units.every(({ ticketBranchAnchor }) => ticketBranchAnchor === "/repo/a")).toBe(true);
  const ticketLink = fixture.patchBodies.find(({ body }) => JSON.stringify(body).includes("ticket%2F193"));
  expect(ticketLink).toBeDefined();
  expect(ticketLink!.body).toEqual([
    { op: "test", path: "/rev", value: 4 },
    {
      op: "add",
      path: "/relations/-",
      value: { rel: "ArtifactLink", url: ticketBranchUri(repoA), attributes: { name: "Branch" } },
    },
  ]);
});

test("prepareWorkspaceTicketBranches falla cuando el ticket no existe", async () => {
  const fixture = workspaceFixture();
  await fixture.service.prepareWorkspaceBranches({
    hu,
    repositories: fixture.repositories,
    baseBranch,
  });

  await expect(fixture.service.prepareWorkspaceTicketBranches({
    hu,
    ticket: 999,
    integrationBranch,
    repositories: fixture.repositories,
    ticketBranch: "refs/heads/ticket/999",
  })).rejects.toThrow("work item 999");
});

test("prepareWorkspaceTicketBranches respeta un Branch ArtifactLink de ticket existente", async () => {
  const fixture = workspaceFixture({
    ticketRelations: [{
      rel: "ArtifactLink",
      url: ticketBranchUri(repoA),
      attributes: { name: "Branch" },
    }],
  });
  await fixture.service.prepareWorkspaceBranches({
    hu,
    repositories: fixture.repositories,
    baseBranch,
  });

  const topology = await fixture.service.prepareWorkspaceTicketBranches({
    hu,
    ticket,
    integrationBranch,
    repositories: fixture.repositories,
    ticketBranch,
  });

  expect(topology.ticketBranchAnchor).toBe("/repo/a");
  expect(topology.units.every(({ ticketBranchCreated }) => ticketBranchCreated)).toBe(true);
  const ticketLink = fixture.patchBodies.find(({ body }) => JSON.stringify(body).includes("ticket%2F193"));
  expect(ticketLink).toBeUndefined();
});
