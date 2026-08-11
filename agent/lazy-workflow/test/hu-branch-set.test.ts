import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AzureAutocodeService } from "../src/azure/autocode-service.ts";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { runGit } from "../src/git/git-ticket-branch-cleaner.ts";

const hu = 125;
const branch = "refs/heads/feature/hu-125";
const branchUri = "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBfeature%2Fhu-125";
const seedPath = (root: string): string => join(root, "seed");

function serviceFixture(options: {
  relations?: Array<Record<string, unknown>>;
  remoteBranch?: boolean;
  remoteUrl?: string;
  resolvedRepositoryName?: string;
  resolvedRemoteUrl?: string;
  verifiedRelations?: Array<Record<string, unknown>>;
} = {}) {
  const patchBodies: unknown[] = [];
  const patchCommands: string[][] = [];
  let patched = false;
  const az = async (args: string[]): Promise<string> => {
    if (args[0] === "boards") {
      return JSON.stringify({
        id: hu,
        fields: { "System.TeamProject": "Team" },
        relations: patched ? options.verifiedRelations ?? [{
          rel: "ArtifactLink",
          url: branchUri,
          attributes: { name: "Branch" },
        }] : options.relations ?? [],
      });
    }
    if (args[0] === "repos") {
      return JSON.stringify({
        id: "repository-id",
        name: options.resolvedRepositoryName ?? "repo",
        project: { id: "project-id", name: "Team" },
        remoteUrl: options.resolvedRemoteUrl ?? "https://dev.azure.com/org/Team/_git/repo",
      });
    }
    if (args[0] === "rest") {
      patchCommands.push(args);
      patchBodies.push(JSON.parse(args[args.indexOf("--body") + 1]!));
      patched = true;
      return "{}";
    }
    throw new Error(`Unexpected Azure command: ${args.join(" ")}`);
  };
  const git = async (args: string[]): Promise<string> => {
    if (args[0] === "remote") return options.remoteUrl ?? "https://dev.azure.com/org/Team/_git/repo\n";
    if (args[0] === "ls-remote") return options.remoteBranch === false ? "" : `${"a".repeat(40)}\t${args.at(-1)}\n`;
    throw new Error(`Unexpected Git command: ${args.join(" ")}`);
  };
  return { service: new AzureAutocodeService(az, git), patchBodies, patchCommands };
}

test("hu-branch-set valida la rama remota, crea el Branch ArtifactLink y verifica Azure", async () => {
  const fixture = serviceFixture();

  await expect(fixture.service.setIntegrationBranch(hu, branch, "/repo")).resolves.toEqual({ hu, branch });
  expect(fixture.patchBodies).toEqual([[{
    op: "add",
    path: "/relations/-",
    value: { rel: "ArtifactLink", url: branchUri, attributes: { name: "Branch" } },
  }]]);
  expect(fixture.patchCommands[0]).toEqual(expect.arrayContaining([
    "rest",
    "--resource", "499b84ac-1321-427f-aa17-267ca6975798",
    "--method", "patch",
    "--uri", "https://dev.azure.com/SubdepartamentoSolucionesTI/project-id/_apis/wit/workitems/125?api-version=7.1",
    "--headers", "Content-Type=application/json-patch+json",
    "--output", "json",
  ]));
});

test("hu-branch-set es idempotente para el mismo vínculo y no lo duplica", async () => {
  const fixture = serviceFixture({ relations: [{ rel: "ArtifactLink", url: branchUri, attributes: { name: "Branch" } }] });

  await expect(fixture.service.setIntegrationBranch(hu, branch, "/repo")).resolves.toEqual({ hu, branch });
  expect(fixture.patchBodies).toHaveLength(0);
});

test("hu-branch-set rechaza conflicto o ambigüedad sin actualizar Azure", async () => {
  const fixture = serviceFixture({ relations: [
    { rel: "ArtifactLink", url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBother", attributes: { name: "Branch" } },
  ] });

  await expect(fixture.service.setIntegrationBranch(hu, branch, "/repo")).rejects.toThrow("conflicto");
  expect(fixture.patchBodies).toHaveLength(0);
});

test("hu-branch-set rechaza múltiples Branch ArtifactLink distintos", async () => {
  const fixture = serviceFixture({ relations: [
    { rel: "ArtifactLink", url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBother", attributes: { name: "Branch" } },
    { rel: "ArtifactLink", url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBanother", attributes: { name: "Branch" } },
  ] });

  await expect(fixture.service.setIntegrationBranch(hu, branch, "/repo")).rejects.toThrow("multiples");
  expect(fixture.patchBodies).toHaveLength(0);
});

test("hu-branch-set codifica la rama y falla antes de mutar si no existe remotamente", async () => {
  const fixture = serviceFixture({ remoteBranch: false });

  await expect(fixture.service.setIntegrationBranch(hu, "feature/hu-125", "/repo")).rejects.toThrow("remota");
  expect(fixture.patchBodies).toHaveLength(0);
});

test("hu-branch-set rechaza un origen Azure de otro proyecto antes de consultar el repositorio", async () => {
  const fixture = serviceFixture({ remoteUrl: "https://dev.azure.com/org/Other/_git/repo" });

  await expect(fixture.service.setIntegrationBranch(hu, branch, "/repo")).rejects.toThrow("proyecto");
  expect(fixture.patchBodies).toHaveLength(0);
});

test("hu-branch-set rechaza un origen que no es Azure", async () => {
  const fixture = serviceFixture({ remoteUrl: "https://github.com/org/repo.git" });

  await expect(fixture.service.setIntegrationBranch(hu, branch, "/repo")).rejects.toThrow("Azure");
  expect(fixture.patchBodies).toHaveLength(0);
});

test("hu-branch-set rechaza un repositorio Azure distinto al de origin", async () => {
  const fixture = serviceFixture({ resolvedRepositoryName: "other-repo" });

  await expect(fixture.service.setIntegrationBranch(hu, branch, "/repo")).rejects.toThrow("repositorio Azure");
  expect(fixture.patchBodies).toHaveLength(0);
});

test("hu-branch-set exige verificar el vínculo creado", async () => {
  const fixture = serviceFixture({ verifiedRelations: [] });

  await expect(fixture.service.setIntegrationBranch(hu, branch, "/repo")).rejects.toThrow("verificar");
  expect(fixture.patchBodies).toHaveLength(1);
});

function provisioningFixture(options: {
  desiredBranch?: string;
  desiredSha?: string;
  baseBranch?: string;
  baseExists?: boolean;
  baseSha?: string;
  dirty?: string;
  publishFails?: boolean;
  verificationSha?: string;
  linked?: boolean;
  existingTempRef?: boolean;
} = {}) {
  const patchBodies: unknown[] = [];
  const gitCommands: string[][] = [];
  let patched = false;
  const desired = options.desiredBranch ?? "refs/heads/feature/hu-126";
  const base = options.baseBranch ?? "refs/heads/main";
  const baseSha = options.baseSha ?? "1".repeat(40);
  let pushed = false;
  let fetchedSha: string | null = null;
  let publishedSha: string | null = null;
  let tempRef: string | null = null;
  const az = async (args: string[]): Promise<string> => {
    if (args[0] === "boards") {
      return JSON.stringify({
        id: hu,
        fields: { "System.TeamProject": "Team" },
        relations: patched || options.linked ? [{
          rel: "ArtifactLink",
          url: `vstfs:///Git/Ref/project-id%2Frepository-id%2FGB${desired.slice("refs/heads/".length)}`,
          attributes: { name: "Branch" },
        }] : [],
      });
    }
    if (args[0] === "repos") {
      return JSON.stringify({
        id: "repository-id",
        name: "repo",
        project: { id: "project-id", name: "Team" },
        remoteUrl: "https://dev.azure.com/org/Team/_git/repo",
      });
    }
    if (args[0] === "rest") {
      patchBodies.push(JSON.parse(args[args.indexOf("--body") + 1]!));
      patched = true;
      return "{}";
    }
    throw new Error(`Unexpected Azure command: ${args.join(" ")}`);
  };
  const git = async (args: string[]): Promise<string> => {
    gitCommands.push(args);
    if (args[0] === "remote") return "https://dev.azure.com/org/Team/_git/repo\n";
    if (args[0] === "status") return options.dirty ?? "";
    if (args[0] === "ls-remote") {
      const ref = args.at(-1)!;
      if (ref === base && options.baseExists !== false) return `${baseSha}\t${base}\n`;
      if (ref === desired && (pushed ? options.verificationSha ?? publishedSha : options.desiredSha)) {
        return `${(pushed ? options.verificationSha ?? publishedSha : options.desiredSha)!}\t${desired}\n`;
      }
      return "";
    }
    if (args[0] === "for-each-ref") {
      return options.existingTempRef ? "refs/lazy-workflow/existing\n" : "";
    }
    if (args[0] === "fetch") {
      const target = args.at(-1)!.split(":")[1];
      if (!target?.startsWith("refs/lazy-workflow/")) throw new Error("fetch no usa el ref temporal");
      tempRef = target;
      fetchedSha = baseSha;
      return "";
    }
    if (args[0] === "rev-parse") {
      if (args[1] !== `${tempRef}^{commit}`) throw new Error("rev-parse no verifica el ref temporal");
      return `${fetchedSha ?? ""}\n`;
    }
    if (args[0] === "push") {
      if (options.publishFails) throw new Error("push rechazado");
      const source = args[2]!.split(":")[0];
      if (source !== tempRef || !fetchedSha) throw new Error("push no usa la base remota preparada");
      publishedSha = fetchedSha;
      pushed = true;
      return "";
    }
    if (args[0] === "update-ref") return "";
    throw new Error(`Unexpected Git command: ${args.join(" ")}`);
  };
  return { service: new AzureAutocodeService(az, git), patchBodies, gitCommands };
}

test("hu-branch-set crea la rama ausente desde el SHA exacto de la base remota", async () => {
  const fixture = provisioningFixture({ verificationSha: "1".repeat(40) });

  await expect(fixture.service.setIntegrationBranch(hu, "feature/hu-126", "/repo", "main"))
    .resolves.toEqual({ hu, branch: "refs/heads/feature/hu-126" });
  const fetchCommand = fixture.gitCommands.find((args) => args[0] === "fetch")!;
  const tempRef = fetchCommand.at(-1)!.split(":")[1]!;
  expect(tempRef).toMatch(/^refs\/lazy-workflow\/[0-9a-f-]+$/);
  expect(fetchCommand).toEqual(["fetch", "--no-tags", "origin", `+refs/heads/main:${tempRef}`]);
  expect(fixture.gitCommands).toContainEqual(["push", "origin", `${tempRef}:refs/heads/feature/hu-126`]);
  expect(fixture.patchBodies).toHaveLength(1);
});

test("ensureIntegrationBranch prepara hu/HU desde la base estructurada", async () => {
  const fixture = provisioningFixture({
    desiredBranch: "refs/heads/hu/125",
    verificationSha: "1".repeat(40),
  });

  await expect(fixture.service.ensureIntegrationBranch(hu, "/repo", "main"))
    .resolves.toEqual("refs/heads/hu/125");
  expect(fixture.gitCommands).toContainEqual([
    "push", "origin", expect.stringMatching(/^refs\/lazy-workflow\/[0-9a-f-]+:refs\/heads\/hu\/125$/),
  ]);
  expect(fixture.patchBodies).toHaveLength(1);
});

test("hu-branch-set exige base explícita y no escribe Azure si falta la base", async () => {
  const fixture = provisioningFixture();

  await expect(fixture.service.setIntegrationBranch(hu, "feature/hu-126", "/repo"))
    .rejects.toThrow("--base-branch");
  expect(fixture.patchBodies).toHaveLength(0);
  expect(fixture.gitCommands.some((args) => args[0] === "push")).toBe(false);
});

test("hu-branch-set reutiliza la rama existente sin aplicar base ni tocar el worktree", async () => {
  const fixture = provisioningFixture({ desiredSha: "2".repeat(40) });

  await expect(fixture.service.setIntegrationBranch(hu, "feature/hu-126", "/repo", "other-base"))
    .resolves.toEqual({ hu, branch: "refs/heads/feature/hu-126" });
  expect(fixture.gitCommands).not.toContainEqual(["status", "--porcelain", "--untracked-files=all", "--ignored"]);
  expect(fixture.gitCommands.some((args) => args[0] === "push")).toBe(false);
  expect(fixture.patchBodies).toHaveLength(1);
});

test("hu-branch-set no duplica un vínculo existente al reconstruir la rama remota", async () => {
  const fixture = provisioningFixture({ linked: true, verificationSha: "1".repeat(40) });

  await expect(fixture.service.setIntegrationBranch(hu, "feature/hu-126", "/repo", "main"))
    .resolves.toEqual({ hu, branch: "refs/heads/feature/hu-126" });
  expect(fixture.patchBodies).toHaveLength(0);
});

test("hu-branch-set falla cerrado con worktree sucio antes de publicar", async () => {
  const fixture = provisioningFixture({ dirty: " M trabajo.ts\n" });

  await expect(fixture.service.setIntegrationBranch(hu, "feature/hu-126", "/repo", "main"))
    .rejects.toThrow("cambios");
  expect(fixture.patchBodies).toHaveLength(0);
  expect(fixture.gitCommands.some((args) => args[0] === "push")).toBe(false);
});

test("hu-branch-set falla cerrado ante cambios no rastreados", async () => {
  const fixture = provisioningFixture({ dirty: "?? evidencia-local.txt\n" });

  await expect(fixture.service.setIntegrationBranch(hu, "feature/hu-126", "/repo", "main"))
    .rejects.toThrow("cambios");
  expect(fixture.patchBodies).toHaveLength(0);
});

test("hu-branch-set falla cerrado ante archivos no rastreados ignorados", async () => {
  const fixture = provisioningFixture({ dirty: "!! .env.local\n" });

  await expect(fixture.service.setIntegrationBranch(hu, "feature/hu-126", "/repo", "main"))
    .rejects.toThrow("cambios");
  expect(fixture.patchBodies).toHaveLength(0);
  expect(fixture.gitCommands).toContainEqual(["status", "--porcelain", "--untracked-files=all", "--ignored"]);
});

test("hu-branch-set falla si el ref temporal local ya existe", async () => {
  const fixture = provisioningFixture({ existingTempRef: true });

  await expect(fixture.service.setIntegrationBranch(hu, "feature/hu-126", "/repo", "main"))
    .rejects.toThrow("ref temporal");
  expect(fixture.patchBodies).toHaveLength(0);
  expect(fixture.gitCommands.some((args) => args[0] === "fetch" || args[0] === "push")).toBe(false);
});

test("hu-branch-set no escribe Azure si la publicación falla", async () => {
  const fixture = provisioningFixture({ publishFails: true });

  await expect(fixture.service.setIntegrationBranch(hu, "feature/hu-126", "/repo", "main"))
    .rejects.toThrow("push rechazado");
  expect(fixture.patchBodies).toHaveLength(0);
});

test("hu-branch-set falla si la base remota explícita no existe", async () => {
  const fixture = provisioningFixture({ baseExists: false });

  await expect(fixture.service.setIntegrationBranch(hu, "feature/hu-126", "/repo", "main"))
    .rejects.toThrow("base refs/heads/main");
  expect(fixture.patchBodies).toHaveLength(0);
  expect(fixture.gitCommands).not.toContainEqual(["status", "--porcelain", "--untracked-files=all", "--ignored"]);
});

test("hu-branch-set no escribe Azure si la verificación remota no coincide con la base", async () => {
  const fixture = provisioningFixture({ verificationSha: "2".repeat(40) });

  await expect(fixture.service.setIntegrationBranch(hu, "feature/hu-126", "/repo", "main"))
    .rejects.toThrow("verificar");
  expect(fixture.patchBodies).toHaveLength(0);
});

test("hu-branch-set publica en un Git real el commit exacto de la base remota", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-"));
  const remote = join(root, "remote.git");
  const worktree = join(root, "worktree");
  let patched = false;
  const events: string[] = [];
  const az = async (args: string[]): Promise<string> => {
    if (args[0] === "boards") return JSON.stringify({
      id: hu,
      fields: { "System.TeamProject": "Team" },
      relations: patched ? [{
        rel: "ArtifactLink",
        url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBfeature%2Fhu-126",
        attributes: { name: "Branch" },
      }] : [],
    });
    if (args[0] === "repos") return JSON.stringify({
      id: "repository-id",
      name: "repo",
      project: { id: "project-id", name: "Team" },
      remoteUrl: "https://dev.azure.com/org/Team/_git/repo",
    });
    if (args[0] === "rest") {
      events.push("azure-patch");
      patched = true;
      return "{}";
    }
    throw new Error(`Unexpected Azure command: ${args.join(" ")}`);
  };

  try {
    await runGit(["init", "--bare", remote], root);
    await runGit(["init", seedPath(root)], root);
    const seed = seedPath(root);
    await runGit(["config", "user.email", "test@example.test"], seed);
    await runGit(["config", "user.name", "Test"], seed);
    await Bun.write(join(seed, "README.md"), "base\n");
    await runGit(["add", "README.md"], seed);
    await runGit(["commit", "-m", "base"], seed);
    await runGit(["branch", "-M", "main"], seed);
    await runGit(["remote", "add", "origin", remote], seed);
    await runGit(["push", "origin", "main"], seed);
    await runGit(["clone", remote, worktree], root);
    await runGit(["config", "user.email", "test@example.test"], worktree);
    await runGit(["config", "user.name", "Test"], worktree);

    const baseSha = (await runGit(["rev-parse", "refs/remotes/origin/main"], worktree)).trim();
    const service = new AzureAutocodeService(async (args) => az(args), async (args, directory) => {
      if (args[0] === "remote" && args[1] === "get-url") return "https://dev.azure.com/org/Team/_git/repo\n";
      return runGit(args, directory);
    });
    await expect(service.setIntegrationBranch(hu, "feature/hu-126", worktree, "main"))
      .resolves.toEqual({ hu, branch: "refs/heads/feature/hu-126" });
    expect((await runGit(["ls-remote", "origin", "refs/heads/feature/hu-126"], worktree)).startsWith(`${baseSha}\t`)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function ticketBranchFixture(options: {
  ticketRelations?: Array<Record<string, unknown>>;
  dirty?: string;
  ticketBranchSha?: string;
  directChild?: boolean;
  revision?: number | null;
} = {}) {
  const events: string[] = [];
  const baseSha = "a".repeat(40);
  let published = false;
  let patched = false;
  let fetchedSha = "";
  const az = async (args: string[]): Promise<string> => {
    events.push(`az:${args[0]}`);
    if (args[0] === "boards" && args.includes(`${hu}`)) return JSON.stringify({
      id: hu,
      fields: { "System.TeamProject": "Team" },
      relations: [
        ...(options.directChild === false ? [] : [{
          rel: "System.LinkTypes.Hierarchy-Forward",
          url: "https://example.test/_apis/wit/workItems/126",
      }]), {
          rel: "ArtifactLink",
          url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBhu%2F125",
          attributes: { name: "Branch" },
        }],
    });
    if (args[0] === "boards") return JSON.stringify({
      id: 126,
      ...(options.revision === null ? {} : { rev: options.revision ?? 4 }),
      fields: { "System.WorkItemType": "Task" },
      relations: patched
        ? [{
          rel: "ArtifactLink",
          url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBfeature%2Fticket-126",
          attributes: { name: "Branch" },
        }]
        : options.ticketRelations ?? [],
    });
    if (args[0] === "repos") return JSON.stringify({
      id: "repository-id",
      name: "repo",
      project: { id: "project-id", name: "Team" },
      remoteUrl: "https://dev.azure.com/org/Team/_git/repo",
    });
    if (args[0] === "rest") {
      events.push("azure-patch");
      patched = true;
      return "{}";
    }
    throw new Error(`Unexpected Azure command: ${args.join(" ")}`);
  };
  const git = async (args: string[]): Promise<string> => {
    events.push(`git:${args[0]}`);
    if (args[0] === "remote") return "https://dev.azure.com/org/Team/_git/repo\n";
    if (args[0] === "status") return options.dirty ?? "";
    if (args[0] === "ls-remote") {
      const ref = args.at(-1)!;
      if (ref === "refs/heads/hu/125") return `${baseSha}\t${ref}\n`;
      if (ref === "refs/heads/feature/ticket-126" && (published || options.ticketBranchSha)) {
        return `${published ? baseSha : options.ticketBranchSha}\t${ref}\n`;
      }
      return "";
    }
    if (args[0] === "for-each-ref") return "";
    if (args[0] === "fetch") {
      fetchedSha = baseSha;
      return "";
    }
    if (args[0] === "rev-parse") return `${fetchedSha}\n`;
    if (args[0] === "push") {
      published = true;
      return "";
    }
    if (args[0] === "update-ref") return "";
    throw new Error(`Unexpected Git command: ${args.join(" ")}`);
  };
  return { service: new AzureAutocodeService(az, git), events, baseSha };
}

test("ticket-branch-set crea la rama desde el SHA exacto de la HU antes del vínculo Azure", async () => {
  const fixture = ticketBranchFixture();

  await expect(fixture.service.setTicketBranch(hu, 126, "feature/ticket-126", "/repo"))
    .resolves.toEqual({ hu, ticket: 126, branch: "refs/heads/feature/ticket-126" });
  expect(fixture.events.indexOf("azure-patch")).toBeGreaterThan(fixture.events.indexOf("git:push"));
  expect(fixture.events).toContain("git:fetch");
  expect(fixture.events).toContain("git:rev-parse");
  expect(fixture.events).toContain("git:update-ref");
});

test("ticket-branch-set es idempotente para la misma rama remota y vínculo", async () => {
  const fixture = ticketBranchFixture({
    ticketRelations: [{
      rel: "ArtifactLink",
      url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBfeature%2Fticket-126",
      attributes: { name: "Branch" },
    }],
    ticketBranchSha: "a".repeat(40),
  });

  await expect(fixture.service.setTicketBranch(hu, 126, "feature/ticket-126", "/repo"))
    .resolves.toEqual({ hu, ticket: 126, branch: "refs/heads/feature/ticket-126" });
  expect(fixture.events).not.toContain("git:push");
  expect(fixture.events).not.toContain("azure-patch");
});

test("ticket-branch-set rechaza conflicto, worktree sucio y ticket no hijo antes de Azure", async () => {
  const conflict = ticketBranchFixture({
    ticketRelations: [{
      rel: "ArtifactLink",
      url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBother",
      attributes: { name: "Branch" },
    }],
    ticketBranchSha: "b".repeat(40),
  });
  await expect(conflict.service.setTicketBranch(hu, 126, "feature/ticket-126", "/repo")).rejects.toThrow("conflicto");
  expect(conflict.events).not.toContain("azure-patch");

  const notChild = ticketBranchFixture({ directChild: false });
  await expect(notChild.service.setTicketBranch(hu, 126, "feature/ticket-126", "/repo")).rejects.toThrow("hijo directo");
  expect(notChild.events).not.toContain("azure-patch");

  const noRevision = ticketBranchFixture({ revision: null });
  await expect(noRevision.service.setTicketBranch(hu, 126, "feature/ticket-126", "/repo")).rejects.toThrow("revisión");
  expect(noRevision.events).not.toContain("azure-patch");

  const dirty = ticketBranchFixture({ dirty: "!! .env.local\n" });
  await expect(dirty.service.setTicketBranch(hu, 126, "feature/ticket-126", "/repo")).rejects.toThrow("cambios");
  expect(dirty.events).not.toContain("azure-patch");
});

test("ticket-branch-set conserva el worktree y publica el SHA exacto en Git real", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-ticket-"));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const worktree = join(root, "worktree");
  let patched = false;
  const events: string[] = [];
  const az = async (args: string[]): Promise<string> => {
    if (args[0] === "boards" && args.includes(`${hu}`)) return JSON.stringify({
      id: hu,
      fields: { "System.TeamProject": "Team" },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/126" }, {
        rel: "ArtifactLink",
        url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBhu%2F125",
        attributes: { name: "Branch" },
      }],
    });
    if (args[0] === "boards") return JSON.stringify({
      id: 126,
      rev: 4,
      fields: { "System.WorkItemType": "Task" },
      relations: patched ? [{
        rel: "ArtifactLink",
        url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBfeature%2Fticket-126",
        attributes: { name: "Branch" },
      }] : [],
    });
    if (args[0] === "repos") return JSON.stringify({
      id: "repository-id",
      name: "repo",
      project: { id: "project-id", name: "Team" },
      remoteUrl: "https://dev.azure.com/org/Team/_git/repo",
    });
    if (args[0] === "rest") {
      events.push("azure-patch");
      patched = true;
      return "{}";
    }
    throw new Error(`Unexpected Azure command: ${args.join(" ")}`);
  };

  try {
    await runGit(["init", "--bare", remote], root);
    await runGit(["init", seed], root);
    await runGit(["config", "user.email", "test@example.test"], seed);
    await runGit(["config", "user.name", "Test"], seed);
    await Bun.write(join(seed, "README.md"), "base\n");
    await runGit(["add", "README.md"], seed);
    await runGit(["commit", "-m", "base"], seed);
    await runGit(["branch", "-M", "main"], seed);
    await runGit(["switch", "-c", "hu/125"], seed);
    await runGit(["remote", "add", "origin", remote], seed);
    await runGit(["push", "origin", "main"], seed);
    await runGit(["push", "origin", "hu/125"], seed);
    await runGit(["clone", remote, worktree], root);
    await runGit(["config", "user.email", "test@example.test"], worktree);
    await runGit(["config", "user.name", "Test"], worktree);
    const beforeBranch = (await runGit(["branch", "--show-current"], worktree)).trim();
    const baseSha = (await runGit(["ls-remote", "origin", "refs/heads/hu/125"], worktree)).split(/\s+/)[0];

    const service = new AzureAutocodeService(
      az,
      async (args, directory) => {
        events.push(`git:${args[0]}`);
        return args[0] === "remote" && args[1] === "get-url"
          ? "https://dev.azure.com/org/Team/_git/repo\n"
          : runGit(args, directory);
      },
    );
    const result = await service.setTicketBranch(hu, 126, "feature/ticket-126", worktree);
    expect(result).toEqual({ hu, ticket: 126, branch: "refs/heads/feature/ticket-126" });

    expect((await runGit(["ls-remote", "origin", "refs/heads/feature/ticket-126"], worktree)).startsWith(`${baseSha}\t`)).toBe(true);
    expect((await runGit(["branch", "--show-current"], worktree)).trim()).toBe(beforeBranch);
    expect(events.indexOf("azure-patch")).toBeGreaterThan(events.lastIndexOf("git:push"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("el CLI hu-branch-set imprime un resultado normalizado sin invocar OpenCode", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    const result = await new LazyWorkflowCli({
      getHuInfo: async () => { throw new Error("no debe consultarse por separado"); },
      waitForAccess: async () => undefined,
      setIntegrationBranch: async (requestedHu) => ({ hu: requestedHu, branch }),
    }).run(["hu-branch-set", "--hu", `${hu}`, "--branch", "feature/hu-125", "--working-directory", "/repo"]);
    expect(result).toBe(0);
  } finally {
    console.log = originalLog;
  }

  expect(output).toEqual([JSON.stringify({ hu, branch }, null, 2)]);
});

test("el CLI hu-branch-set reenvía la base explícita al servicio", async () => {
  let receivedBase: string | null | undefined;
  const result = await new LazyWorkflowCli({
    getHuInfo: async () => { throw new Error("no debe consultarse"); },
    waitForAccess: async () => undefined,
    setIntegrationBranch: async (_requestedHu, _branch, _workingDirectory, baseBranch) => {
      receivedBase = baseBranch;
      return { hu, branch };
    },
  }).run([
    "hu-branch-set",
    "--hu", `${hu}`,
    "--branch", "feature/hu-125",
    "--base-branch", "main",
    "--working-directory", "/repo",
  ]);

  expect(result).toBe(0);
  expect(receivedBase).toBe("main");
});

test("el CLI ticket-branch-set reenvía la identidad y el worktree al servicio", async () => {
  let received: unknown[] = [];
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    const result = await new LazyWorkflowCli({
      getHuInfo: async () => { throw new Error("no debe consultarse"); },
      waitForAccess: async () => undefined,
      setTicketBranch: async (...args) => {
        received = args;
        return { hu, ticket: 126, branch: "refs/heads/feature/ticket-126" };
      },
    }).run([
      "ticket-branch-set",
      "--hu", `${hu}`,
      "--ticket", "126",
      "--branch", "feature/ticket-126",
      "--working-directory", "/repo",
    ]);

    expect(result).toBe(0);
  } finally {
    console.log = originalLog;
  }

  expect(received).toEqual([hu, 126, "feature/ticket-126", "/repo"]);
  expect(output).toEqual([JSON.stringify({ hu, ticket: 126, branch: "refs/heads/feature/ticket-126" }, null, 2)]);
});

test("el CLI ticket-branch-set rechaza un worktree omitido o vacío", async () => {
  let calls = 0;
  const service = {
    getHuInfo: async () => { throw new Error("no debe consultarse"); },
    waitForAccess: async () => undefined,
    setTicketBranch: async () => { calls += 1; return { hu, ticket: 126, branch: "refs/heads/feature/ticket-126" }; },
  };

  await expect(new LazyWorkflowCli(service).run([
    "ticket-branch-set", "--hu", `${hu}`, "--ticket", "126", "--branch", "feature/ticket-126",
  ])).resolves.toBe(1);
  await expect(new LazyWorkflowCli(service).run([
    "ticket-branch-set", "--hu", `${hu}`, "--ticket", "126", "--branch", "feature/ticket-126",
    "--working-directory",
  ])).resolves.toBe(1);
  expect(calls).toBe(0);
});

test("el CLI hu-branch-set rechaza entrada inválida sin tocar Azure", async () => {
  let calls = 0;
  const result = await new LazyWorkflowCli({
    getHuInfo: async () => { throw new Error("no debe consultarse"); },
    waitForAccess: async () => undefined,
    setIntegrationBranch: async () => { calls += 1; return { hu, branch }; },
  }).run(["hu-branch-set", "--hu", "abc", "--branch", "feature/hu-125", "--working-directory", "/repo"]);

  expect(result).toBe(1);
  expect(calls).toBe(0);
});
