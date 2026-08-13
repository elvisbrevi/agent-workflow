import { resolve } from "node:path";

export type DeploymentEnvironment = "dev" | "test" | "qa";
const DEPLOYMENT_ENVIRONMENTS: readonly DeploymentEnvironment[] = ["dev", "test", "qa"];

export interface DeploymentScope {
  tracker: "azure" | "github";
  id: number;
  title: string;
  source?: unknown;
}

export interface DeploymentProjectConfig {
  authentication: "operator";
  adapter: { command: string[] };
  route: {
    repository: string;
    baseBranch: string;
    pipeline: { id: string; version: "v7" };
    releaseDefinition: { id: string };
    openShift: { id: string; evidence: string };
    consul: { deployKey: string; requiredVariables: string[]; evidence: string };
    target: { id: string; environment: DeploymentEnvironment; evidence: string };
  };
}

export interface DeploymentRoute {
  id: string;
  repository: string;
  baseBranch: string;
  pipeline: { id: string; version: "v7" };
  releaseDefinition: { id: string };
  openShift: { id: string; evidence: string };
  consul: { deployKey: string; requiredVariables: string[]; evidence: string };
  target: { id: string; environment: DeploymentEnvironment; evidence: string };
}

export interface DeploymentRecord {
  id: string;
  status: string;
}

export interface VerifiedDeployment {
  id: string;
  status: "succeeded";
  environment: DeploymentEnvironment;
  target: string;
  routeId: string;
  evidence: { openShift: string; consul: string; target: string };
}

export interface DeploymentSystems {
  discoverRoutes(config: DeploymentProjectConfig, scope: DeploymentScope): Promise<DeploymentRoute[]>;
  reconcile(config: DeploymentProjectConfig, route: DeploymentRoute, idempotencyKey: string): Promise<{ record: DeploymentRecord; reconciled: boolean }>;
  verify(config: DeploymentProjectConfig, route: DeploymentRoute, record: DeploymentRecord): Promise<VerifiedDeployment>;
}

export interface DeploymentResult {
  status: "verified";
  environment: DeploymentEnvironment;
  idempotencyKey: string;
  route: DeploymentRoute;
  deployment: VerifiedDeployment;
  reconciled: boolean;
}

export class DeploymentAuthenticationRequiredError extends Error {
  constructor() {
    super("el adaptador de deployment requiere autenticacion del operador");
    this.name = "DeploymentAuthenticationRequiredError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`.sag/config.json requiere ${name}`);
  return value.trim();
}

function requiredTextList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`.sag/config.json requiere ${name} como lista de textos`);
  }
  return value.map((item) => item.trim());
}

function isProductionAlias(value: string): boolean {
  const normalized = value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return /(^|[-_/:.= ?&#])(?:prod|production|prd|live|primary|online)(?=$|[-_/:.= ?&#0-9])/i.test(normalized);
}

function rejectProductionIdentity(value: string, name: string): void {
  if (isProductionAlias(value)) throw new Error(`deploy-sag no permite identidades PROD en ${name}`);
}

function rejectProductionRouteIdentities(route: DeploymentProjectConfig["route"] | DeploymentRoute): void {
  const identities: Array<[string, string]> = [
    ["route", "id" in route ? route.id : ""],
    ["repository", route.repository],
    ["baseBranch", route.baseBranch],
    ["pipeline", route.pipeline.id],
    ["releaseDefinition", route.releaseDefinition.id],
    ["openShift", route.openShift.id],
    ["openShift.evidence", route.openShift.evidence],
    ["consul", route.consul.deployKey],
    ["consul.evidence", route.consul.evidence],
    ["target", route.target.id],
    ["target.evidence", route.target.evidence],
  ];
  identities.push(...route.consul.requiredVariables.map((value, index) => [`consul.requiredVariables[${index}]`, value] as [string, string]));
  for (const [name, value] of identities) {
    if (value) rejectProductionIdentity(value, name);
  }
}

function parseConfig(value: unknown): DeploymentProjectConfig {
  if (!isRecord(value) || !isRecord(value.deployment)) {
    throw new Error(".sag/config.json requiere deployment para deploy-sag");
  }
  const deployment = value.deployment;
  if (deployment.authentication !== "operator") {
    throw new Error(".sag/config.json requiere deployment.authentication=operator");
  }
  const routeValue = deployment.route;
  if (!isRecord(routeValue)) {
    throw new Error(".sag/config.json requiere una ruta deployment completa");
  }
  const pipelineValue = routeValue.pipeline;
  const releaseDefinitionValue = routeValue.releaseDefinition;
  const openShiftValue = routeValue.openShift;
  const consulValue = routeValue.consul;
  const targetValue = routeValue.target;
  if (!isRecord(pipelineValue) || !isRecord(releaseDefinitionValue) || !isRecord(openShiftValue)
    || !isRecord(consulValue) || !isRecord(targetValue)) {
    throw new Error(".sag/config.json requiere una ruta deployment completa");
  }
  const route = routeValue;
  const pipeline = pipelineValue;
  const releaseDefinition = releaseDefinitionValue;
  const openShift = openShiftValue;
  const consul = consulValue;
  const target = targetValue;
  const adapterValue = deployment.adapter;
  if (!isRecord(adapterValue) || !Array.isArray(adapterValue.command)) {
    throw new Error(".sag/config.json requiere deployment.adapter.command explicito");
  }
  const adapter = adapterValue.command;
  if (pipeline.version !== "v7") throw new Error("deploy-sag requiere pipeline v7 explicito");
  const targetId = requiredText(target.id, "deployment.route.target.id");
  if (typeof target.environment !== "string" || !DEPLOYMENT_ENVIRONMENTS.includes(target.environment as DeploymentEnvironment)) {
    throw new Error("deploy-sag requiere un destino DEV, TEST o QA explicito");
  }
  const config: DeploymentProjectConfig = {
    authentication: "operator",
    adapter: {
      command: requiredTextList(adapter, "deployment.adapter.command"),
    },
    route: {
      repository: requiredText(route.repository, "deployment.route.repository"),
      baseBranch: requiredText(route.baseBranch, "deployment.route.baseBranch"),
      pipeline: { id: requiredText(pipeline.id, "deployment.route.pipeline.id"), version: "v7" },
      releaseDefinition: { id: requiredText(releaseDefinition.id, "deployment.route.releaseDefinition.id") },
      openShift: {
        id: requiredText(openShift.id, "deployment.route.openShift.id"),
        evidence: requiredText(openShift.evidence, "deployment.route.openShift.evidence"),
      },
      consul: {
        deployKey: requiredText(consul.deployKey, "deployment.route.consul.deployKey"),
        requiredVariables: requiredTextList(consul.requiredVariables, "deployment.route.consul.requiredVariables"),
        evidence: requiredText(consul.evidence, "deployment.route.consul.evidence"),
      },
      target: {
        id: targetId,
        environment: target.environment as DeploymentEnvironment,
        evidence: requiredText(target.evidence, "deployment.route.target.evidence"),
      },
    },
  };
  rejectProductionRouteIdentities(config.route);
  config.adapter.command.forEach((value, index) => rejectProductionIdentity(value, `adapter.command[${index}]`));
  return config;
}

function routeKey(route: DeploymentRoute): string {
  return JSON.stringify([route.repository, route.baseBranch, route.pipeline.id, route.releaseDefinition.id, route.openShift.id, route.consul.deployKey, route.target.environment, route.target.id]);
}

function matchesConfiguredRoute(config: DeploymentProjectConfig, route: DeploymentRoute): boolean {
  return route.repository === config.route.repository
    && route.baseBranch === config.route.baseBranch
    && route.pipeline.id === config.route.pipeline.id
    && route.pipeline.version === config.route.pipeline.version
    && route.releaseDefinition.id === config.route.releaseDefinition.id
    && route.openShift.id === config.route.openShift.id
    && route.openShift.evidence === config.route.openShift.evidence
    && route.consul.deployKey === config.route.consul.deployKey
    && JSON.stringify(route.consul.requiredVariables) === JSON.stringify(config.route.consul.requiredVariables)
    && route.consul.evidence === config.route.consul.evidence
    && route.target.id === config.route.target.id
    && route.target.environment === config.route.target.environment
    && route.target.evidence === config.route.target.evidence;
}

function validateRoute(route: DeploymentRoute): void {
  if (!route.id.trim() || !route.repository.trim() || !route.baseBranch.trim()) throw new Error("la ruta de despliegue no tiene identidad completa");
  if (!route.pipeline.id.trim() || route.pipeline.version !== "v7") throw new Error("la ruta no tiene un pipeline v7 verificable");
  if (!route.releaseDefinition.id.trim()) throw new Error("la ruta no tiene Release Definition verificable");
  if (!route.openShift.id.trim() || !route.openShift.evidence.trim()) throw new Error("la ruta no tiene OpenShift verificable");
  if (!route.consul.deployKey.trim() || route.consul.requiredVariables.length === 0 || !route.consul.evidence.trim()) {
    throw new Error("la ruta no tiene Consul verificable");
  }
  if (!route.target.id.trim() || !DEPLOYMENT_ENVIRONMENTS.includes(route.target.environment) || !route.target.evidence.trim()) {
    throw new Error("la ruta no tiene un destino no productivo verificable");
  }
  rejectProductionRouteIdentities(route);
}

export function sanitizeDeploymentText(value: string): string {
  return value.replace(/(authorization\s*:\s*(?:basic|bearer)\s+|bearer\s+|(?:access[-_ ]?token|token|password|secret|cookie|pat|api[-_ ]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
}

type AdapterOperation = "discover" | "reconcile" | "verify";

export class ProcessDeploymentSystems implements DeploymentSystems {
  constructor(private readonly workingDirectory: string) {}

  private async invoke(config: DeploymentProjectConfig, operation: AdapterOperation, payload: unknown): Promise<unknown> {
    const child = Bun.spawn([...config.adapter.command, "--operation", operation], {
      cwd: this.workingDirectory,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`adaptador de deployment fallo (exit ${exitCode})`);
    try {
      const response = JSON.parse(stdout) as unknown;
      if (isRecord(response) && response.authenticationRequired === true) throw new DeploymentAuthenticationRequiredError();
      return response;
    } catch (error) {
      if (error instanceof DeploymentAuthenticationRequiredError) throw error;
      throw new Error(`adaptador de deployment devolvio JSON invalido (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  async discoverRoutes(config: DeploymentProjectConfig, scope: DeploymentScope): Promise<DeploymentRoute[]> {
    const response = await this.invoke(config, "discover", { scope, route: config.route });
    const routes = Array.isArray(response) ? response : isRecord(response) ? response.routes : null;
    if (!Array.isArray(routes)) throw new Error("adaptador de deployment no devolvio rutas");
    return routes as DeploymentRoute[];
  }

  async reconcile(config: DeploymentProjectConfig, route: DeploymentRoute, idempotencyKey: string): Promise<{ record: DeploymentRecord; reconciled: boolean }> {
    const response = await this.invoke(config, "reconcile", { route, idempotencyKey });
    if (!isRecord(response) || !isRecord(response.record) || typeof response.reconciled !== "boolean") {
      throw new Error("adaptador de deployment no devolvio una reconciliacion verificable");
    }
    const record = response.record;
    if (typeof record.id !== "string" || typeof record.status !== "string") throw new Error("adaptador de deployment devolvio un registro invalido");
    return { record: { id: record.id, status: record.status }, reconciled: response.reconciled };
  }

  async verify(config: DeploymentProjectConfig, route: DeploymentRoute, record: DeploymentRecord): Promise<VerifiedDeployment> {
    const response = await this.invoke(config, "verify", { route, record });
    if (!isRecord(response) || typeof response.id !== "string" || response.status !== "succeeded"
      || response.environment !== route.target.environment || typeof response.target !== "string" || typeof response.routeId !== "string"
      || !isRecord(response.evidence)
      || typeof response.evidence.openShift !== "string" || typeof response.evidence.consul !== "string" || typeof response.evidence.target !== "string") {
      throw new Error("adaptador de deployment devolvio un estado no verificable");
    }
    return {
      id: response.id,
      status: "succeeded",
      environment: route.target.environment,
      target: response.target,
      routeId: response.routeId,
      evidence: {
        openShift: response.evidence.openShift,
        consul: response.evidence.consul,
        target: response.evidence.target,
      },
    };
  }
}

export class SagDeploymentService {
  constructor(private readonly systems: DeploymentSystems | null = null) {}

  async deploy(scope: DeploymentScope, workingDirectory: string, environment: DeploymentEnvironment = "dev"): Promise<DeploymentResult> {
    if (!DEPLOYMENT_ENVIRONMENTS.includes(environment)) throw new Error("deploy-sag requiere DEV, TEST o QA");
    let raw: unknown;
    try {
      raw = JSON.parse(await Bun.file(resolve(workingDirectory, ".sag/config.json")).text());
    } catch (error) {
      throw new Error(`no se pudo leer .sag/config.json (${error instanceof Error ? error.message : String(error)})`);
    }
    const config = parseConfig(raw);
    if (config.route.target.environment !== environment) {
      throw new Error(`la ruta configurada no coincide con el entorno ${environment.toUpperCase()}`);
    }
    const systems = this.systems ?? new ProcessDeploymentSystems(workingDirectory);
    const routes = await systems.discoverRoutes(config, scope);
    if (routes.length !== 1) throw new Error(`deploy-sag requiere una ruta unica; se encontraron ${routes.length}`);
    const route = routes[0]!;
    validateRoute(route);
    if (!matchesConfiguredRoute(config, route)) throw new Error("la ruta externa no coincide con la ruta explicita del proyecto");
    const idempotencyKey = `lazy-workflow:${scope.tracker}:${scope.id}:${routeKey(route)}`;
    const reconciliation = await systems.reconcile(config, route, idempotencyKey);
    const deployment = await systems.verify(config, route, reconciliation.record);
    if (deployment.id !== reconciliation.record.id || deployment.status !== "succeeded" || deployment.environment !== environment
      || deployment.target !== route.target.id || deployment.routeId !== route.id
      || !deployment.evidence
      || typeof deployment.evidence.openShift !== "string" || typeof deployment.evidence.consul !== "string" || typeof deployment.evidence.target !== "string"
     || !deployment.evidence.openShift.trim() || !deployment.evidence.consul.trim() || !deployment.evidence.target.trim()) {
       throw new Error(`el despliegue no tiene un estado ${environment.toUpperCase()} verificado`);
    }
    rejectProductionIdentity(deployment.id, "deployment.id");
    rejectProductionIdentity(deployment.target, "deployment.target");
    rejectProductionIdentity(deployment.routeId, "deployment.routeId");
    rejectProductionIdentity(deployment.evidence.openShift, "deployment.evidence.openShift");
    rejectProductionIdentity(deployment.evidence.consul, "deployment.evidence.consul");
    rejectProductionIdentity(deployment.evidence.target, "deployment.evidence.target");
    return {
      status: "verified",
      environment,
      idempotencyKey,
      route,
      deployment,
      reconciled: reconciliation.reconciled,
    };
  }
}
