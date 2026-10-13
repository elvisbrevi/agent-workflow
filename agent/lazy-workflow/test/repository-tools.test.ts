/**
 * Lo que pasa antes de que exista un repositorio en esta máquina (ADR-0049):
 * qué se puede planificar, leído en el tracker, y descargar o crear el
 * repositorio donde se planifica. Todo con `az`, `gh` y `git` simulados.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AZURE_CREDENTIAL_HELPER,
  azurePlannableWork,
  cloneAzureRepository,
  createAzureRepository,
} from "../src/azure/azure-repositories.ts";
import { cloneGitHubRepository, createGitHubRepository, githubOwners, githubPlannableWork } from "../src/github/github-repositories.ts";
import { runDeterministicTool, type ProvisionRequest, type RepositoryTools } from "../src/cli/deterministic-tools.ts";
import { buildCli, type CliOptions } from "../src/cli/parse-cli-options.ts";
import { createReporter } from "../src/output/reporter.ts";
import { setDefaultReporter } from "../src/output/operator-output.ts";

const previousOrganization = process.env.LAZY_WORKFLOW_AZURE_ORGANIZATION;
let root = "";
beforeEach(() => {
  process.env.LAZY_WORKFLOW_AZURE_ORGANIZATION = "https://dev.azure.com/synthetic";
  root = mkdtempSync(join(tmpdir(), "lz-repository-tools-"));
  setDefaultReporter(createReporter({ quiet: true, noColor: true }));
});
afterEach(() => {
  if (previousOrganization === undefined) delete process.env.LAZY_WORKFLOW_AZURE_ORGANIZATION;
  else process.env.LAZY_WORKFLOW_AZURE_ORGANIZATION = previousOrganization;
  rmSync(root, { recursive: true, force: true });
});

const item = (id: number, type: string, project: string, parent?: number) => ({
  id,
  fields: { "System.Title": `Item ${id}`, "System.WorkItemType": type, "System.State": type === "Bug" ? "En progreso" : "En Desarrollo", "System.TeamProject": project },
  relations: parent ? [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `https://dev.azure.com/synthetic/_apis/wit/workItems/${parent}` }] : [],
});

test("Azure lista mis HU En Desarrollo y Bugs En progreso de toda la organización, sin el Bug que es entrega de una HU", async () => {
  const bodies: Array<{ uri: string; body: Record<string, unknown> }> = [];
  const work = await azurePlannableWork(async (args) => {
    const uri = args[args.indexOf("--uri") + 1]!;
    const body = JSON.parse(args[args.indexOf("--body") + 1]!);
    bodies.push({ uri, body });
    if (uri.includes("wiql")) return JSON.stringify({ workItems: [{ id: 50 }, { id: 70 }, { id: 71 }] });
    if (body.fields) return JSON.stringify({ value: [{ id: 60, fields: { "System.WorkItemType": "User Story" } }, { id: 61, fields: { "System.WorkItemType": "Feature" } }] });
    return JSON.stringify({ value: [item(50, "User Story", "Portal"), item(70, "Bug", "Portal", 61), item(71, "Bug", "Pagos", 60)] });
  }, null);

  const query = String(bodies[0]!.body.query);
  expect(bodies[0]!.uri).toBe("https://dev.azure.com/synthetic/_apis/wit/wiql?$top=201&api-version=7.1");
  expect(query).toContain("[System.AssignedTo] = @Me");
  expect(query).toContain("[System.WorkItemType] = 'User Story' AND [System.State] = 'En Desarrollo'");
  expect(query).toContain("[System.WorkItemType] = 'Bug' AND [System.State] = 'En progreso'");
  expect(query).not.toContain("TeamProject");
  expect(work.items.map((entry) => [entry.id, entry.type, entry.scope])).toEqual([[50, "User Story", "Portal"], [70, "Bug", "Portal"]]);
  expect(work.items[0]!.url).toBe("https://dev.azure.com/synthetic/Portal/_workitems/edit/50");
});

test("Azure limita a un proyecto, escapando su nombre", async () => {
  let query = "";
  await azurePlannableWork(async (args) => {
    query = String(JSON.parse(args[args.indexOf("--body") + 1]!).query);
    return JSON.stringify({ workItems: [] });
  }, "Proyecto D'Arte");
  expect(query).toContain("[System.TeamProject] = 'Proyecto D''Arte'");
});

test("descargar de Azure usa el PAT de lz por un helper que no guarda el secreto, y lo deja para los push", async () => {
  const commands: Array<{ args: string[]; directory: string }> = [];
  const result = await cloneAzureRepository(
    async () => JSON.stringify({ name: "api", remoteUrl: "https://synthetic@dev.azure.com/synthetic/Portal/_git/api" }),
    async (args, directory) => { commands.push({ args, directory }); return ""; },
    { project: "Portal", repository: "api", destination: "/work/api", parent: "/work" },
  );

  expect(commands).toEqual([
    { args: ["-c", `credential.https://dev.azure.com.helper=${AZURE_CREDENTIAL_HELPER}`, "clone", "https://dev.azure.com/synthetic/Portal/_git/api", "/work/api"], directory: "/work" },
    { args: ["config", "--local", "credential.https://dev.azure.com.helper", AZURE_CREDENTIAL_HELPER], directory: "/work/api" },
  ]);
  expect(AZURE_CREDENTIAL_HELPER).toContain("$AZURE_DEVOPS_EXT_PAT");
  expect(result).toEqual({ tracker: "azure", scope: "Portal", repository: "api", destination: "/work/api", remote: "https://dev.azure.com/synthetic/Portal/_git/api", created: false });
});

test("crear en Azure deja un primer commit en main, desde donde la entrega crea la rama de la HU", async () => {
  const az: string[][] = [];
  const git: string[][] = [];
  const written: Array<[string, string]> = [];
  const result = await createAzureRepository(
    async (args) => { az.push(args); return JSON.stringify({ name: "nuevo", remoteUrl: "https://dev.azure.com/synthetic/Portal/_git/nuevo" }); },
    async (args) => { git.push(args); return ""; },
    { project: "Portal", repository: "nuevo", destination: "/work/nuevo", parent: "/work" },
    async (path, content) => { written.push([path, content]); },
  );

  expect(az[0]!.slice(0, 7)).toEqual(["repos", "create", "--name", "nuevo", "--project", "Portal", "--organization"]);
  expect(written).toEqual([["/work/nuevo/README.md", "# nuevo\n"]]);
  expect(git.slice(2)).toEqual([["add", "README.md"], ["commit", "-m", "Initialize nuevo"], ["branch", "-M", "main"], ["push", "-u", "origin", "main"]]);
  expect(result.created).toBe(true);
});

test("GitHub lista las épicas abiertas de mi cuenta y mis organizaciones, por el predicado de la cola", async () => {
  const searches: string[][] = [];
  const found = (number: number, title: string, labels: string[] = []) =>
    ({ number, title, state: "open", url: `https://github.com/o/r/issues/${number}`, labels: labels.map((name) => ({ name })), repository: { nameWithOwner: "o/r" } });
  const work = await githubPlannableWork(async (args) => {
    if (args[1] === "user") return "elvis\n";
    if (args[1] === "user/orgs") return "acme\nelvis\n";
    searches.push(args);
    if (args.includes("--label")) return JSON.stringify([found(1, "Portal", ["epic"])]);
    if (args.includes("Epic")) return JSON.stringify([found(2, "[Epic] Pagos"), found(3, "Revisar el Epic de pagos"), found(1, "Portal", ["epic"])]);
    return JSON.stringify([found(4, "[Spec] Login")]);
  }, "/home");

  expect(searches).toHaveLength(3);
  for (const search of searches) expect(search.join(" ")).toContain("--owner elvis --owner acme --state open");
  expect(work.items.map((entry) => [entry.id, entry.type, entry.scope, entry.state])).toEqual([[1, "Epic", "o/r", "OPEN"], [2, "Epic", "o/r", "OPEN"], [4, "Epic", "o/r", "OPEN"]]);
});

test("GitHub descarga con gh y crea privado con README", async () => {
  const calls: Array<{ args: string[]; directory: string }> = [];
  const gh = async (args: string[], directory: string) => { calls.push({ args, directory }); return ""; };
  expect(await githubOwners(async (args) => args[1] === "user" ? "elvis" : "", "/home")).toEqual(["elvis"]);
  await cloneGitHubRepository(gh, { repository: "o/r", destination: "/work/r", parent: "/work" });
  await createGitHubRepository(gh, { repository: "o/nuevo", destination: "/work/nuevo", parent: "/work" });
  expect(calls).toEqual([
    { args: ["repo", "clone", "o/r", "/work/r"], directory: "/work" },
    { args: ["repo", "create", "o/nuevo", "--private", "--add-readme"], directory: "/work" },
    { args: ["repo", "clone", "o/nuevo", "/work/nuevo"], directory: "/work" },
  ]);
});

function parseOptions(args: string[]): CliOptions {
  const result = buildCli(() => true)(args, { onHelp: () => 0, onError: () => 1 });
  if (result.kind !== "options") throw new Error(`no parseo: ${JSON.stringify(result)}`);
  return result.options;
}

function recordingTools(): { tools: RepositoryTools; requests: Array<[string, unknown]> } {
  const requests: Array<[string, unknown]> = [];
  const answer = (name: string) => async (...args: unknown[]) => { requests.push([name, args.length === 1 ? args[0] : args]); return { ok: name }; };
  return {
    requests,
    tools: {
      plannable: answer("plannable") as never,
      projects: answer("projects") as never,
      azureRepositories: answer("azureRepositories") as never,
      githubOwners: answer("githubOwners") as never,
      clone: answer("clone") as never,
      create: answer("create") as never,
    },
  };
}

async function runTool(args: string[]) {
  const { tools, requests } = recordingTools();
  const printed: string[] = [];
  const options = parseOptions(args);
  const code = await runDeterministicTool(options.command as never, options, { repositories: tools } as never, (line) => printed.push(line));
  return { code, requests, printed };
}

test("work-plannable exige el tracker y solo Azure se limita a un proyecto", async () => {
  expect((await runTool(["work-plannable"])).code).toBe(1);
  expect((await runTool(["work-plannable", "--tracker", "azure", "--project", "Portal"])).requests).toEqual([["plannable", ["azure", "Portal"]]]);
  expect((await runTool(["work-plannable", "--tracker", "github"])).requests).toEqual([["plannable", ["github", null]]]);
  expect((await runTool(["azure-repo-list"])).code).toBe(1);
  expect((await runTool(["azure-repo-list", "--project", "Portal"])).requests).toEqual([["azureRepositories", "Portal"]]);
});

test("repo-clone y repo-create solo escriben en una carpeta nueva bajo una que existe", async () => {
  const existing = join(root, "existente");
  mkdirSync(existing);
  const refused = [
    ["repo-clone", "--tracker", "github", "--repository", "o/r", "--destination", "relativa/r"],
    ["repo-clone", "--tracker", "github", "--repository", "o/r", "--destination", existing],
    ["repo-clone", "--tracker", "github", "--repository", "o/r", "--destination", join(root, "falta", "r")],
    ["repo-clone", "--tracker", "github", "--repository", "solo-nombre", "--destination", join(root, "r")],
    ["repo-create", "--tracker", "azure", "--repository", "api", "--destination", join(root, "api")],
    ["repo-create", "--tracker", "azure", "--project", "Portal", "--repository", "o/api", "--destination", join(root, "api")],
  ];
  for (const args of refused) {
    const run = await runTool(args);
    expect(`${args.join(" ")}: ${run.code} ${run.requests.length}`).toBe(`${args.join(" ")}: 1 0`);
  }
  const cloned = await runTool(["repo-clone", "--tracker", "github", "--repository", "o/r", "--destination", join(root, "r")]);
  expect(cloned.requests).toEqual([["clone", { tracker: "github", project: null, repository: "o/r", destination: join(root, "r"), parent: root } satisfies ProvisionRequest]]);
  const created = await runTool(["repo-create", "--tracker", "azure", "--project", "Portal", "--repository", "api", "--destination", join(root, "api")]);
  expect(created.requests).toEqual([["create", { tracker: "azure", project: "Portal", repository: "api", destination: join(root, "api"), parent: root }]]);
});
