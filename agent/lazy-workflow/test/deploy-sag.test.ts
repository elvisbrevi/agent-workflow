import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { SagDeploymentService, type DeploymentRoute, type DeploymentSystems } from "../src/sag/deployment-service.ts";
import { SagNormsService, type SagDeploymentContext, type SagNormSource } from "../src/sag/sag-norms-service.ts";

const root = `${process.env.TMPDIR ?? "/tmp"}/lazy-workflow-deploy-${crypto.randomUUID()}`;

const route: DeploymentRoute = {
  id: "route-dev",
  repository: "project/repository",
  baseBranch: "main",
  pipeline: { id: "pipeline-7", version: "v7" },
  releaseDefinition: { id: "release-1" },
  target: { id: "openshift-dev", environment: "dev", evidence: "target-observed" },
};

const config = async (): Promise<string> => {
  const directory = `${root}-${crypto.randomUUID()}`;
  await mkdir(`${directory}/.sag`, { recursive: true });
  await Bun.write(`${directory}/.sag/config.json`, JSON.stringify({
    tipo: "api",
    deployment: {
      authentication: "operator",
      route: {
        repository: route.repository,
        baseBranch: route.baseBranch,
        pipeline: route.pipeline,
        releaseDefinition: route.releaseDefinition,
        target: route.target,
      },
    },
  }));
  return directory;
};

const context: SagDeploymentContext = {
  phase: "deployment",
  sourceRepository: "https://example.test/sag",
  branch: "master",
  commit: "sag-commit",
  component: "api",
  explicitFacts: { changeKind: "feature", artifacts: ["pipeline"], capabilities: null, significantChange: null, environment: "dev" },
  selectedRules: [],
  guidance: [],
  needsDecision: [],
};

const scope = { tracker: "github" as const, id: 157, title: "Deploy SAG scopes safely to DEV" };

test("las normas de deployment cargan familias de entrega y guidance trazable", async () => {
  const directory = await config();
  const source: SagNormSource = {
    load: async (paths) => {
      expect(paths).toEqual([
        "/estandares/comunes.md",
        "/estandares/api.md",
        "/estandares/api-adonis-patrones.md",
        "/estandares/documentacion.md",
        "/estandares/integraciones.md",
        "/estandares/pull-requests.md",
        "/estandares/seguimiento.md",
        "/estandares/sonarqube.md",
        "/core/workflows/finalizar.md",
        "/core/agents/despliegue-sag.md",
      ]);
      return {
        commit: "delivery-commit",
        files: {
          "/estandares/comunes.md": "com-G2",
          "/estandares/api.md": "api-R1",
          "/estandares/api-adonis-patrones.md": "api-R9",
          "/estandares/documentacion.md": "doc-R1",
          "/estandares/integraciones.md": "int-R1",
          "/estandares/pull-requests.md": "pr-R1",
          "/estandares/seguimiento.md": "seg-R1",
          "/estandares/sonarqube.md": "sonar-R1",
          "/core/workflows/finalizar.md": "delivery workflow",
          "/core/agents/despliegue-sag.md": "deployment guidance",
        },
      };
    },
  };

  try {
    const loaded = await new SagNormsService(source).loadDeployment(directory);
    expect(loaded.phase).toBe("deployment");
    expect(loaded.commit).toBe("delivery-commit");
    expect(loaded.selectedRules.map(({ ruleId }) => ruleId)).toEqual([
      "com-G2", "api-R1", "doc-R1", "int-R1", "pr-R1", "seg-R1", "sonar-R1",
    ]);
    expect(loaded.guidance.map(({ path, classification }) => [path, classification])).toEqual([
      ["/core/workflows/finalizar.md", "W"],
      ["/core/agents/despliegue-sag.md", "W"],
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deploy-sag ejecuta una ruta unica y verifica el estado externo", async () => {
  const directory = await config();
  const calls: string[] = [];
  const systems: DeploymentSystems = {
    discoverRoutes: async (_config, receivedScope) => {
      expect(receivedScope).toEqual(scope);
      calls.push("discover");
      return [route];
    },
    findExisting: async (_route, key) => {
      expect(key).toContain("github:157");
      calls.push("find");
      return null;
    },
    trigger: async (_route, key) => {
      expect(key).toContain("github:157");
      calls.push("trigger");
      return { id: "deployment-1", status: "accepted" };
    },
    verify: async (_route, record) => {
      expect(record.status).toBe("accepted");
      calls.push("verify");
      return { id: record.id, status: "succeeded", environment: "dev", target: route.target.id, routeId: route.id };
    },
  };

  try {
    await expect(new SagDeploymentService(systems).deploy(scope, directory)).resolves.toMatchObject({
      status: "verified",
      environment: "dev",
      reconciled: false,
      deployment: { id: "deployment-1", status: "succeeded" },
    });
    expect(calls).toEqual(["discover", "find", "trigger", "verify"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deploy-sag reconcilia una ejecucion existente sin duplicar el trigger", async () => {
  const directory = await config();
  let triggerCalls = 0;
  const systems: DeploymentSystems = {
    discoverRoutes: async () => [route],
    findExisting: async () => ({ id: "deployment-existing", status: "accepted" }),
    trigger: async () => { triggerCalls += 1; return { id: "unexpected", status: "accepted" }; },
    verify: async (_route, record) => ({ id: record.id, status: "succeeded", environment: "dev", target: route.target.id, routeId: route.id }),
  };

  try {
    await expect(new SagDeploymentService(systems).deploy(scope, directory)).resolves.toMatchObject({
      reconciled: true,
      deployment: { id: "deployment-existing" },
    });
    expect(triggerCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deploy-sag falla cerrado con rutas ambiguas y no muta el sistema", async () => {
  const directory = await config();
  let triggerCalls = 0;
  const systems: DeploymentSystems = {
    discoverRoutes: async () => [route, { ...route, id: "route-other" }],
    findExisting: async () => { throw new Error("must not reconcile ambiguous route"); },
    trigger: async () => { triggerCalls += 1; throw new Error("must not trigger"); },
    verify: async () => { throw new Error("must not verify"); },
  };

  try {
    await expect(new SagDeploymentService(systems).deploy(scope, directory)).rejects.toThrow("ruta unica");
    expect(triggerCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deploy-sag rechaza una ruta externa que no coincide con la configuracion", async () => {
  const directory = await config();
  let reconciliationCalls = 0;
  const systems: DeploymentSystems = {
    discoverRoutes: async () => [{ ...route, target: { ...route.target, id: "openshift-other" } }],
    findExisting: async () => { reconciliationCalls += 1; return null; },
    trigger: async () => { throw new Error("must not trigger"); },
    verify: async () => { throw new Error("must not verify"); },
  };

  try {
    await expect(new SagDeploymentService(systems).deploy(scope, directory)).rejects.toThrow("no coincide");
    expect(reconciliationCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deploy-sag rechaza un resultado no verificado", async () => {
  const directory = await config();
  const systems: DeploymentSystems = {
    discoverRoutes: async () => [route],
    findExisting: async () => null,
    trigger: async () => ({ id: "deployment-1", status: "accepted" }),
    verify: async () => ({ id: "deployment-1", status: "succeeded", environment: "dev", target: "other-target", routeId: route.id }),
  };

  try {
    await expect(new SagDeploymentService(systems).deploy(scope, directory)).rejects.toThrow("estado DEV verificado");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deploy-sag GitHub usa un Issue explicito, carga normas y no inicia OpenCode", async () => {
  const directory = await config();
  let azureCalls = 0;
  let openCodeCalls = 0;
  let deploymentCalls = 0;
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));

  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { azureCalls += 1; throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
      { run: async () => { openCodeCalls += 1; throw new Error("must not run OpenCode"); }, resume: async () => { throw new Error("must not resume"); } },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("must not plan"); }, loadDeployment: async () => context },
      undefined,
      { readIssue: async (issue) => ({ number: issue, title: "scope", body: "body", comments: [], state: "OPEN", labels: [] }), publishFindings: async () => ({ specification: 1, tickets: [] }) },
      { deploy: async (receivedScope, receivedDirectory, environment) => {
        deploymentCalls += 1;
        expect(receivedScope).toEqual({ ...scope, title: "scope" });
        expect(receivedDirectory).toBe(directory);
        expect(environment).toBe("dev");
        return { status: "verified", environment: "dev", idempotencyKey: "key", route, deployment: { id: "deployment-1", status: "succeeded", environment: "dev", target: route.target.id, routeId: route.id }, reconciled: false };
      } },
    ).run(["deploy-sag", "--issue", "157", "--working-directory", directory]);

    expect(code).toBe(0);
    expect(azureCalls).toBe(0);
    expect(openCodeCalls).toBe(0);
    expect(deploymentCalls).toBe(1);
    expect(output[0]).toContain('"commit": "sag-commit"');
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  ["missing scope", ["deploy-sag"]],
  ["conflicting scope", ["deploy-sag", "--hu", "23438", "--issue", "157"]],
  ["invalid issue", ["deploy-sag", "--issue", "abc"]],
  ["missing environment", ["deploy-sag", "--issue", "157", "--environment"]],
  ["production", ["deploy-sag", "--issue", "157", "--environment", "production"]],
  ["unsupported environment", ["deploy-sag", "--issue", "157", "--environment", "qa"]],
] as const)("deploy-sag rechaza %s antes de servicios", async (_name, args) => {
  let calls = 0;
  const code = await new LazyWorkflowCli(
    { getHuInfo: async () => { calls += 1; throw new Error("must not call Azure"); }, waitForAccess: async () => { calls += 1; } },
    { run: async () => { calls += 1; throw new Error("must not run"); }, resume: async () => { calls += 1; throw new Error("must not resume"); } },
    undefined,
    undefined,
    undefined,
    undefined,
    { loadPlanning: async () => { calls += 1; throw new Error("must not load"); }, loadDeployment: async () => { calls += 1; throw new Error("must not load"); } },
    undefined,
    { readIssue: async () => { calls += 1; throw new Error("must not read issue"); }, publishFindings: async () => ({ specification: 1, tickets: [] }) },
    { deploy: async () => { calls += 1; throw new Error("must not deploy"); } },
  ).run([...args, "--working-directory", root]);

  expect(code).toBe(1);
  expect(calls).toBe(0);
});

test("deploy-sag detiene la ejecucion si la fuente SAG no esta disponible", async () => {
  const directory = await config();
  let deploymentCalls = 0;
  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
      { run: async () => { throw new Error("must not run"); }, resume: async () => { throw new Error("must not resume"); } },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("must not plan"); }, loadDeployment: async () => { throw new Error("source unavailable"); } },
      undefined,
      { readIssue: async (issue) => ({ number: issue, title: "scope", body: "body", comments: [], state: "OPEN", labels: [] }), publishFindings: async () => ({ specification: 1, tickets: [] }) },
      { deploy: async () => { deploymentCalls += 1; throw new Error("must not deploy"); } },
    ).run(["deploy-sag", "--issue", "157", "--working-directory", directory]);

    expect(code).toBe(1);
    expect(deploymentCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
