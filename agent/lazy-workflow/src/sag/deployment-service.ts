import { resolve } from "node:path";

export type DeploymentEnvironment = "dev";

export interface DeploymentScope {
  tracker: "azure" | "github";
  id: number;
  title: string;
}

export interface DeploymentProjectConfig {
  authentication: "operator";
  route: {
    repository: string;
    baseBranch: string;
    pipeline: { id: string; version: "v7" };
    releaseDefinition: { id: string };
    target: { id: string; environment: DeploymentEnvironment; evidence: string };
  };
}

export interface DeploymentRoute {
  id: string;
  repository: string;
  baseBranch: string;
  pipeline: { id: string; version: "v7" };
  releaseDefinition: { id: string };
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
}

export interface DeploymentSystems {
  discoverRoutes(config: DeploymentProjectConfig, scope: DeploymentScope): Promise<DeploymentRoute[]>;
  findExisting(route: DeploymentRoute, idempotencyKey: string): Promise<DeploymentRecord | null>;
  trigger(route: DeploymentRoute, idempotencyKey: string): Promise<DeploymentRecord>;
  verify(route: DeploymentRoute, record: DeploymentRecord): Promise<VerifiedDeployment>;
}

export interface DeploymentResult {
  status: "verified";
  environment: DeploymentEnvironment;
  idempotencyKey: string;
  route: DeploymentRoute;
  deployment: VerifiedDeployment;
  reconciled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`.sag/config.json requiere ${name}`);
  return value.trim();
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
  const targetValue = routeValue.target;
  if (!isRecord(pipelineValue) || !isRecord(releaseDefinitionValue) || !isRecord(targetValue)) {
    throw new Error(".sag/config.json requiere una ruta deployment completa");
  }
  const route = routeValue;
  const pipeline = pipelineValue;
  const releaseDefinition = releaseDefinitionValue;
  const target = targetValue;
  if (pipeline.version !== "v7") throw new Error("deploy-sag requiere pipeline v7 explicito");
  if (target.environment !== "dev") throw new Error("deploy-sag solo permite el destino DEV");
  return {
    authentication: "operator",
    route: {
      repository: requiredText(route.repository, "deployment.route.repository"),
      baseBranch: requiredText(route.baseBranch, "deployment.route.baseBranch"),
      pipeline: { id: requiredText(pipeline.id, "deployment.route.pipeline.id"), version: "v7" },
      releaseDefinition: { id: requiredText(releaseDefinition.id, "deployment.route.releaseDefinition.id") },
      target: {
        id: requiredText(target.id, "deployment.route.target.id"),
        environment: "dev",
        evidence: requiredText(target.evidence, "deployment.route.target.evidence"),
      },
    },
  };
}

function routeKey(route: DeploymentRoute): string {
  return [route.repository, route.baseBranch, route.pipeline.id, route.releaseDefinition.id, route.target.id].join("/");
}

function matchesConfiguredRoute(config: DeploymentProjectConfig, route: DeploymentRoute): boolean {
  return route.repository === config.route.repository
    && route.baseBranch === config.route.baseBranch
    && route.pipeline.id === config.route.pipeline.id
    && route.pipeline.version === config.route.pipeline.version
    && route.releaseDefinition.id === config.route.releaseDefinition.id
    && route.target.id === config.route.target.id
    && route.target.environment === config.route.target.environment;
}

function validateRoute(route: DeploymentRoute): void {
  if (!route.id.trim() || !route.repository.trim() || !route.baseBranch.trim()) throw new Error("la ruta de despliegue no tiene identidad completa");
  if (!route.pipeline.id.trim() || route.pipeline.version !== "v7") throw new Error("la ruta no tiene un pipeline v7 verificable");
  if (!route.releaseDefinition.id.trim()) throw new Error("la ruta no tiene Release Definition verificable");
  if (!route.target.id.trim() || route.target.environment !== "dev" || !route.target.evidence.trim()) {
    throw new Error("la ruta no tiene un destino DEV verificable");
  }
}

class UnconfiguredDeploymentSystems implements DeploymentSystems {
  async discoverRoutes(_config: DeploymentProjectConfig, _scope: DeploymentScope): Promise<DeploymentRoute[]> {
    throw new Error("no hay un adaptador de despliegue autenticado configurado");
  }

  async findExisting(_route: DeploymentRoute, _idempotencyKey: string): Promise<DeploymentRecord | null> {
    throw new Error("no hay un adaptador de despliegue autenticado configurado");
  }

  async trigger(_route: DeploymentRoute, _idempotencyKey: string): Promise<DeploymentRecord> {
    throw new Error("no hay un adaptador de despliegue autenticado configurado");
  }

  async verify(_route: DeploymentRoute, _record: DeploymentRecord): Promise<VerifiedDeployment> {
    throw new Error("no hay un adaptador de despliegue autenticado configurado");
  }
}

export class SagDeploymentService {
  constructor(private readonly systems: DeploymentSystems = new UnconfiguredDeploymentSystems()) {}

  async deploy(scope: DeploymentScope, workingDirectory: string, environment: DeploymentEnvironment = "dev"): Promise<DeploymentResult> {
    if (environment !== "dev") throw new Error("deploy-sag solo permite DEV en esta version");
    let raw: unknown;
    try {
      raw = JSON.parse(await Bun.file(resolve(workingDirectory, ".sag/config.json")).text());
    } catch (error) {
      throw new Error(`no se pudo leer .sag/config.json (${error instanceof Error ? error.message : String(error)})`);
    }
    const config = parseConfig(raw);
    const routes = await this.systems.discoverRoutes(config, scope);
    if (routes.length !== 1) throw new Error(`deploy-sag requiere una ruta unica; se encontraron ${routes.length}`);
    const route = routes[0]!;
    validateRoute(route);
    if (!matchesConfiguredRoute(config, route)) throw new Error("la ruta externa no coincide con la ruta explicita del proyecto");
    const idempotencyKey = `lazy-workflow:${scope.tracker}:${scope.id}:${routeKey(route)}`;
    const existing = await this.systems.findExisting(route, idempotencyKey);
    const record = existing ?? await this.systems.trigger(route, idempotencyKey);
    const deployment = await this.systems.verify(route, record);
    if (deployment.status !== "succeeded" || deployment.environment !== "dev"
      || deployment.target !== route.target.id || deployment.routeId !== route.id) {
      throw new Error("el despliegue no tiene un estado DEV verificado");
    }
    return {
      status: "verified",
      environment: "dev",
      idempotencyKey,
      route,
      deployment,
      reconciled: existing !== null,
    };
  }
}
