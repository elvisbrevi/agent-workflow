import { expect, test } from "bun:test";
import { AzureAutocodeService } from "../src/azure/autocode-service.ts";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";

const hu = 125;
const branch = "refs/heads/feature/hu-125";
const branchUri = "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBfeature%2Fhu-125";

function serviceFixture(options: {
  relations?: Array<Record<string, unknown>>;
  remoteBranch?: boolean;
  remoteUrl?: string;
  verifiedRelations?: Array<Record<string, unknown>>;
} = {}) {
  const patchBodies: unknown[] = [];
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
        name: "repo",
        project: { id: "project-id", name: "Team" },
        remoteUrl: "https://dev.azure.com/org/Team/_git/repo",
      });
    }
    if (args[0] === "devops") {
      const path = args[args.indexOf("--in-file") + 1]!;
      patchBodies.push(await Bun.file(path).json());
      patched = true;
      return "{}";
    }
    throw new Error(`Unexpected Azure command: ${args.join(" ")}`);
  };
  const git = async (args: string[]): Promise<string> => {
    if (args[0] === "remote") return options.remoteUrl ?? "https://dev.azure.com/org/Team/_git/repo\n";
    if (args[0] === "ls-remote") return options.remoteBranch === false ? "" : `abc123\t${args.at(-1)}\n`;
    throw new Error(`Unexpected Git command: ${args.join(" ")}`);
  };
  return { service: new AzureAutocodeService(az, git), patchBodies };
}

test("hu-branch-set valida la rama remota, crea el Branch ArtifactLink y verifica Azure", async () => {
  const fixture = serviceFixture();

  await expect(fixture.service.setIntegrationBranch(hu, branch, "/repo")).resolves.toEqual({ hu, branch });
  expect(fixture.patchBodies).toEqual([[{
    op: "add",
    path: "/relations/-",
    value: { rel: "ArtifactLink", url: branchUri, attributes: { name: "Branch" } },
  }]]);
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

test("hu-branch-set exige verificar el vínculo creado", async () => {
  const fixture = serviceFixture({ verifiedRelations: [] });

  await expect(fixture.service.setIntegrationBranch(hu, branch, "/repo")).rejects.toThrow("verificar");
  expect(fixture.patchBodies).toHaveLength(1);
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
