import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { DeploymentAuthenticationRequiredError, SagDeploymentService, type DeploymentEnvironment, type DeploymentRoute, type DeploymentSystems } from "../src/sag/deployment-service.ts";
import { SagNormsService, type SagDeploymentContext, type SagNormSource } from "../src/sag/sag-norms-service.ts";

const root = `${process.env.TMPDIR ?? "/tmp"}/lazy-workflow-deploy-${crypto.randomUUID()}`;

const route: DeploymentRoute = {
  id: "route-dev",
  repository: "project/repository",
  baseBranch: "main",
  pipeline: { id: "pipeline-7", version: "v7" },
  releaseDefinition: { id: "release-1" },
  openShift: { id: "openshift-dev", evidence: "openshift-observed" },
  consul: { deployKey: "project/deploy", requiredVariables: ["DATABASE_URL"], evidence: "consul-observed" },
  target: { id: "openshift-dev", environment: "dev", evidence: "target-observed" },
};

const config = async (environment: DeploymentEnvironment = "dev"): Promise<string> => {
  const directory = `${root}-${crypto.randomUUID()}`;
  const target = { ...route.target, id: `openshift-${environment}`, environment };
  await mkdir(`${directory}/.sag`, { recursive: true });
  await Bun.write(`${directory}/.sag/config.json`, JSON.stringify({
    tipo: "api",
    deployment: {
      authentication: "operator",
      adapter: { command: [".sag/deploy-adapter"] },
      route: {
        repository: route.repository,
        baseBranch: route.baseBranch,
        pipeline: route.pipeline,
        releaseDefinition: route.releaseDefinition,
        openShift: route.openShift,
        consul: route.consul,
        target,
      },
    },
  }));
  return directory;
};

const context: SagDeploymentContext = {
  phase: "delivery",
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
    expect(loaded.phase).toBe("delivery");
    expect(loaded.commit).toBe("delivery-commit");
    expect(loaded.selectedRules.map(({ ruleId }) => ruleId)).toEqual([
      "com-G2", "api-R1", "api-R9", "doc-R1", "int-R1", "pr-R1", "seg-R1", "sonar-R1",
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
    reconcile: async (_config, _route, key) => {
      expect(key).toContain("github:157");
      calls.push("reconcile");
      return { record: { id: "deployment-1", status: "accepted" }, reconciled: false };
    },
    verify: async (_config, _route, record) => {
      expect(record.status).toBe("accepted");
      calls.push("verify");
      return { id: record.id, status: "succeeded", environment: "dev", target: route.target.id, routeId: route.id, evidence: { openShift: "verified", consul: "verified", target: "verified" } };
    },
  };

  try {
    await expect(new SagDeploymentService(systems).deploy(scope, directory)).resolves.toMatchObject({
      status: "verified",
      environment: "dev",
      reconciled: false,
      deployment: { id: "deployment-1", status: "succeeded" },
    });
    expect(calls).toEqual(["discover", "reconcile", "verify"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["test", "qa"] as const)("deploy-sag verifica el destino %s", async (environment) => {
  const directory = await config(environment);
  const environmentRoute = { ...route, target: { ...route.target, id: `openshift-${environment}`, environment } };
  const systems: DeploymentSystems = {
    discoverRoutes: async () => [environmentRoute],
    reconcile: async () => ({ record: { id: `deployment-${environment}`, status: "accepted" }, reconciled: false }),
    verify: async (_config, _route, record) => ({
      id: record.id,
      status: "succeeded",
      environment,
      target: environmentRoute.target.id,
      routeId: environmentRoute.id,
      evidence: { openShift: "verified", consul: "verified", target: "verified" },
    }),
  };

  try {
    await expect(new SagDeploymentService(systems).deploy(scope, directory, environment)).resolves.toMatchObject({
      status: "verified",
      environment,
      deployment: { id: `deployment-${environment}`, environment },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deploy-sag rechaza un destino configurado distinto antes de descubrir rutas", async () => {
  const directory = await config("qa");
  let discoveryCalls = 0;
  const systems: DeploymentSystems = {
    discoverRoutes: async () => { discoveryCalls += 1; return [route]; },
    reconcile: async () => { throw new Error("must not reconcile"); },
    verify: async () => { throw new Error("must not verify"); },
  };

  try {
    await expect(new SagDeploymentService(systems).deploy(scope, directory, "dev")).rejects.toThrow("no coincide con el entorno");
    expect(discoveryCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deploy-sag reconcilia una ejecucion existente sin duplicar el trigger", async () => {
  const directory = await config();
  let reconcileCalls = 0;
  const systems: DeploymentSystems = {
    discoverRoutes: async () => [route],
    reconcile: async () => { reconcileCalls += 1; return { record: { id: "deployment-existing", status: "accepted" }, reconciled: true }; },
    verify: async (_config, _route, record) => ({ id: record.id, status: "succeeded", environment: "dev", target: route.target.id, routeId: route.id, evidence: { openShift: "verified", consul: "verified", target: "verified" } }),
  };

  try {
    await expect(new SagDeploymentService(systems).deploy(scope, directory)).resolves.toMatchObject({
      reconciled: true,
      deployment: { id: "deployment-existing" },
    });
    expect(reconcileCalls).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deploy-sag falla cerrado con rutas ambiguas y no muta el sistema", async () => {
  const directory = await config();
  let reconcileCalls = 0;
  const systems: DeploymentSystems = {
    discoverRoutes: async () => [route, { ...route, id: "route-other" }],
    reconcile: async () => { reconcileCalls += 1; throw new Error("must not reconcile ambiguous route"); },
    verify: async () => { throw new Error("must not verify"); },
  };

  try {
    await expect(new SagDeploymentService(systems).deploy(scope, directory)).rejects.toThrow("ruta unica");
    expect(reconcileCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deploy-sag rechaza una ruta externa que no coincide con la configuracion", async () => {
  const directory = await config();
  let reconciliationCalls = 0;
  const systems: DeploymentSystems = {
    discoverRoutes: async () => [{ ...route, target: { ...route.target, id: "openshift-other" } }],
    reconcile: async () => { reconciliationCalls += 1; throw new Error("must not reconcile"); },
    verify: async () => { throw new Error("must not verify"); },
  };

  try {
    await expect(new SagDeploymentService(systems).deploy(scope, directory)).rejects.toThrow("no coincide");
    expect(reconciliationCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  ["route", { ...route, id: "production-route" }],
  ["camel-case route", { ...route, id: "openshiftProd" }],
  ["repository", { ...route, repository: "project.prod/repository" }],
  ["numeric pipeline", { ...route, pipeline: { ...route.pipeline, id: "pipeline-prod01" } }],
  ["base branch", { ...route, baseBranch: "production" }],
  ["pipeline", { ...route, pipeline: { ...route.pipeline, id: "pipeline-prod" } }],
  ["release", { ...route, releaseDefinition: { ...route.releaseDefinition, id: "release-live" } }],
  ["OpenShift", { ...route, openShift: { ...route.openShift, id: "openshift-prod" } }],
  ["OpenShift evidence", { ...route, openShift: { ...route.openShift, evidence: "production-evidence" } }],
  ["Consul", { ...route, consul: { ...route.consul, deployKey: "project/live" } }],
  ["Consul variable", { ...route, consul: { ...route.consul, requiredVariables: ["PROD_DATABASE_URL"] } }],
  ["Consul evidence", { ...route, consul: { ...route.consul, evidence: "prod-evidence" } }],
  ["target", { ...route, target: { ...route.target, id: "openshift-live" } }],
  ["target evidence", { ...route, target: { ...route.target, evidence: "live-evidence" } }],
] as const)("deploy-sag rechaza aliases PROD en la identidad de %s antes de reconciliar", async (kind, unsafeRoute) => {
  const directory = await config();
  let reconcileCalls = 0;
  if (kind !== "route") {
    const path = `${directory}/.sag/config.json`;
    const value = JSON.parse(await Bun.file(path).text()) as {
      deployment: { route: {
        repository: string;
        baseBranch: string;
        pipeline: { id: string };
        releaseDefinition: { id: string };
        openShift: { id: string; evidence: string };
        consul: { deployKey: string; requiredVariables: string[]; evidence: string };
        target: { id: string; evidence: string };
      } };
    };
    const configured = value.deployment.route;
    if (kind === "repository") configured.repository = unsafeRoute.repository;
    else if (kind === "base branch") configured.baseBranch = unsafeRoute.baseBranch;
    else if (kind === "pipeline") configured.pipeline.id = unsafeRoute.pipeline.id;
    else if (kind === "release") configured.releaseDefinition.id = unsafeRoute.releaseDefinition.id;
    else if (kind === "OpenShift") configured.openShift.id = unsafeRoute.openShift.id;
    else if (kind === "OpenShift evidence") configured.openShift.evidence = unsafeRoute.openShift.evidence;
    else if (kind === "Consul") configured.consul.deployKey = unsafeRoute.consul.deployKey;
    else if (kind === "Consul variable") configured.consul.requiredVariables = [...unsafeRoute.consul.requiredVariables];
    else if (kind === "Consul evidence") configured.consul.evidence = unsafeRoute.consul.evidence;
    else if (kind === "target") configured.target.id = unsafeRoute.target.id;
    else if (kind === "target evidence") configured.target.evidence = unsafeRoute.target.evidence;
    await Bun.write(path, JSON.stringify(value));
  }
  const systems: DeploymentSystems = {
    discoverRoutes: async () => [unsafeRoute as DeploymentRoute],
    reconcile: async () => { reconcileCalls += 1; throw new Error("must not reconcile production route"); },
    verify: async () => { throw new Error("must not verify"); },
  };

  try {
    await expect(new SagDeploymentService(systems).deploy(scope, directory)).rejects.toThrow(/PROD|produccion/i);
    expect(reconcileCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deploy-sag rechaza un comando de adapter PROD antes de descubrir rutas", async () => {
  const directory = await config();
  const path = `${directory}/.sag/config.json`;
  const value = JSON.parse(await Bun.file(path).text()) as { deployment: { adapter: { command: string[] } } };
  value.deployment.adapter.command = [".sag/deploy-adapter", "--environment=prod01"];
  await Bun.write(path, JSON.stringify(value));
  let discoveryCalls = 0;
  const systems: DeploymentSystems = {
    discoverRoutes: async () => { discoveryCalls += 1; return [route]; },
    reconcile: async () => { throw new Error("must not reconcile"); },
    verify: async () => { throw new Error("must not verify"); },
  };

  try {
    await expect(new SagDeploymentService(systems).deploy(scope, directory)).rejects.toThrow(/PROD|produccion/i);
    expect(discoveryCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deploy-sag rechaza un resultado no verificado", async () => {
  const directory = await config();
  const systems: DeploymentSystems = {
    discoverRoutes: async () => [route],
    reconcile: async () => ({ record: { id: "deployment-1", status: "accepted" }, reconciled: false }),
    verify: async () => ({ id: "deployment-1", status: "succeeded", environment: "dev", target: "other-target", routeId: route.id, evidence: { openShift: "verified", consul: "verified", target: "verified" } }),
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
        expect(receivedScope.id).toBe(scope.id);
        expect(receivedScope.title).toBe("scope");
        expect(receivedScope.source).toBeDefined();
        expect(receivedDirectory).toBe(directory);
        expect(environment).toBe("dev");
        return { status: "verified", environment: "dev", idempotencyKey: "key", route, deployment: { id: "deployment-1", status: "succeeded", environment: "dev", target: route.target.id, routeId: route.id, evidence: { openShift: "verified", consul: "verified", target: "verified" } }, reconciled: false };
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

test.each(["test", "qa"] as const)("deploy-sag CLI selecciona %s", async (environment) => {
  const directory = await config(environment);
  let receivedEnvironment: DeploymentEnvironment | null = null;
  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
      { run: async () => { throw new Error("must not run OpenCode"); }, resume: async () => { throw new Error("must not resume"); } },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("must not plan"); }, loadDeployment: async () => context },
      undefined,
      { readIssue: async (issue) => ({ number: issue, title: "scope", body: "body", comments: [], state: "OPEN", labels: [] }), publishFindings: async () => ({ specification: 1, tickets: [] }) },
      { deploy: async (_scope, _directory, received = "dev") => {
        receivedEnvironment = received;
        return { status: "verified", environment, idempotencyKey: "key", route: { ...route, target: { ...route.target, id: `openshift-${environment}`, environment } }, deployment: { id: "deployment-1", status: "succeeded", environment, target: `openshift-${environment}`, routeId: route.id, evidence: { openShift: "verified", consul: "verified", target: "verified" } }, reconciled: false };
      } },
    ).run(["deploy-sag", "--issue", "157", "--environment", environment, "--working-directory", directory]);

    expect(code).toBe(0);
    expect(receivedEnvironment as DeploymentEnvironment | null).toBe(environment);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["ambiguous", "unverified"] as const)("deploy-sag CLI falla cerrado ante ruta %s", async (failure) => {
  const directory = await config();
  const systems: DeploymentSystems = {
    discoverRoutes: async () => failure === "ambiguous" ? [route, { ...route, id: "route-other" }] : [route],
    reconcile: async () => ({ record: { id: "deployment-1", status: "accepted" }, reconciled: false }),
    verify: async () => ({ id: "deployment-1", status: "succeeded", environment: "dev", target: failure === "unverified" ? "other-target" : route.target.id, routeId: route.id, evidence: { openShift: "verified", consul: "verified", target: "verified" } }),
  };
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => errors.push(values.join(" "));

  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
      { run: async () => { throw new Error("must not run OpenCode"); }, resume: async () => { throw new Error("must not resume"); } },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("must not plan"); }, loadDeployment: async () => context },
      undefined,
      { readIssue: async (issue) => ({ number: issue, title: "scope", body: "body", comments: [], state: "OPEN", labels: [] }), publishFindings: async () => ({ specification: 1, tickets: [] }) },
      new SagDeploymentService(systems),
    ).run(["deploy-sag", "--issue", "157", "--working-directory", directory]);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(failure === "ambiguous" ? "ruta unica" : "estado DEV verificado");
  } finally {
    console.error = originalError;
    await rm(directory, { recursive: true, force: true });
  }
});

test("deploy-sag reanuda una HU una vez cuando el adaptador requiere autenticacion", async () => {
  const directory = await config();
  let attempts = 0;
  let waits = 0;
  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => ({ id: 23438, title: "HU deployment" }), waitForAccess: async () => { waits += 1; } },
      { run: async () => { throw new Error("must not run OpenCode"); }, resume: async () => { throw new Error("must not resume"); } },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("must not plan"); }, loadDeployment: async () => context },
      undefined,
      undefined,
      { deploy: async () => {
        attempts += 1;
        if (attempts === 1) throw new DeploymentAuthenticationRequiredError();
        return { status: "verified", environment: "dev", idempotencyKey: "key", route, deployment: { id: "deployment-1", status: "succeeded", environment: "dev", target: route.target.id, routeId: route.id, evidence: { openShift: "verified", consul: "verified", target: "verified" } }, reconciled: true };
      } },
    ).run(["deploy-sag", "--hu", "23438", "--working-directory", directory]);

    expect(code).toBe(0);
    expect(attempts).toBe(2);
    expect(waits).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["adapter unavailable", "ambiguous route", "trigger failed", "verification failed"])("deploy-sag propaga el fallo de %s sin filtrar secretos", async (failure) => {
  const directory = await config();
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => errors.push(values.join(" "));
  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
      { run: async () => { throw new Error("must not run OpenCode"); }, resume: async () => { throw new Error("must not resume"); } },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("must not plan"); }, loadDeployment: async () => context },
      undefined,
      { readIssue: async (issue) => ({ number: issue, title: "scope", body: "body", comments: [], state: "OPEN", labels: [] }), publishFindings: async () => ({ specification: 1, tickets: [] }) },
      { deploy: async () => { throw new Error(`${failure}; token: fixture-secret`); } },
    ).run(["deploy-sag", "--issue", "157", "--working-directory", directory]);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(failure);
    expect(errors.join("\n")).not.toContain("fixture-secret");
  } finally {
    console.error = originalError;
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  ["missing scope", ["deploy-sag"]],
  ["conflicting scope", ["deploy-sag", "--hu", "23438", "--issue", "157"]],
  ["invalid issue", ["deploy-sag", "--issue", "abc"]],
  ["missing environment", ["deploy-sag", "--issue", "157", "--environment"]],
  ["production", ["deploy-sag", "--issue", "157", "--environment", "production"]],
  ["inline production", ["deploy-sag", "--issue", "157", "--environment=prod"]],
  ["duplicate environment", ["deploy-sag", "--issue", "157", "--environment", "dev", "--environment", "prod"]],
  ["unsupported environment", ["deploy-sag", "--issue", "157", "--environment", "staging"]],
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
