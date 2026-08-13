import { resolve } from "node:path";

export interface InfrastructureScope {
  tracker: "azure" | "github";
  id: number;
  title: string;
  source?: {
    title?: string;
    description?: string;
    acceptanceCriteria?: string;
    comments?: string[];
    state?: string;
    project?: string;
  };
}

export interface InfrastructureProjectConfig {
  authentication: "operator";
  adapter: { command: string[] };
  repository: { id: string; baseBranch: string };
  consul: { deployKey: string; requiredVariables: string[] };
  database: { required: boolean; id: string | null };
  pipeline: { required: boolean; id: string | null };
  releaseDefinition: { required: boolean; id: string | null };
}

export interface InfrastructureObservation {
  repository: { id: string; baseBranch: string; exists: boolean; baseBranchExists: boolean };
  consul: { deployKey: string; variables: string[]; available: boolean };
  database: { id: string | null; available: boolean };
  pipeline: { id: string | null; available: boolean };
  releaseDefinition: { id: string | null; available: boolean };
}

export interface InfrastructureFinding {
  category: "repository" | "consul" | "database" | "pipeline" | "release-definition" | "verification";
  title: string;
  body: string;
}

export interface InfrastructurePublication {
  specification: number;
  tickets: number[];
}

export interface InfrastructureVerification {
  status: "ready" | "findings";
  observations: InfrastructureObservation;
  findings: InfrastructureFinding[];
}

export interface InfrastructureSystems {
  verify(config: InfrastructureProjectConfig, scope: InfrastructureScope): Promise<InfrastructureObservation>;
}

export class InfrastructureAuthenticationRequiredError extends Error {
  constructor() {
    super("el adaptador de infraestructura requiere autenticacion del operador");
    this.name = "InfrastructureAuthenticationRequiredError";
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

function sanitizeText(value: string): string {
  return value.replace(/(authorization\s*:\s*(?:basic|bearer)\s+|bearer\s+|(?:access[-_ ]?token|token|password|secret|cookie|pat|api[-_ ]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
}

function isAuthenticationError(error: unknown): boolean {
  return /(?:authentication|autenticaci[oó]n|authorization|unauthorized|forbidden|access token|login|\b401\b|\b403\b)/i.test(error instanceof Error ? error.message : String(error));
}

function optionalResource(value: unknown, name: string): { required: boolean; id: string | null } {
  if (value === undefined) return { required: false, id: null };
  if (!isRecord(value) || typeof value.required !== "boolean") {
    throw new Error(`.sag/config.json requiere ${name}.required como booleano`);
  }
  return {
    required: value.required,
    id: value.required ? requiredText(value.id, `${name}.id`) : value.id === undefined ? null : requiredText(value.id, `${name}.id`),
  };
}

async function readConfig(workingDirectory: string): Promise<InfrastructureProjectConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await Bun.file(resolve(workingDirectory, ".sag/config.json")).text());
  } catch (error) {
    throw new Error(`no se pudo leer .sag/config.json (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isRecord(value) || !isRecord(value.infrastructure)) {
    throw new Error(".sag/config.json requiere infrastructure para infra-sag");
  }
  const infrastructure = value.infrastructure;
  const repository = infrastructure.repository;
  const consul = infrastructure.consul;
  const adapter = infrastructure.adapter;
  if (!isRecord(repository) || !isRecord(consul) || !isRecord(adapter) || !Array.isArray(adapter.command)) {
    throw new Error(".sag/config.json requiere una configuracion infrastructure completa");
  }
  if (infrastructure.authentication !== "operator") {
    throw new Error(".sag/config.json requiere infrastructure.authentication=operator");
  }
  return {
    authentication: "operator",
    adapter: { command: requiredTextList(adapter.command, "infrastructure.adapter.command") },
    repository: {
      id: requiredText(repository.id, "infrastructure.repository.id"),
      baseBranch: requiredText(repository.baseBranch, "infrastructure.repository.baseBranch"),
    },
    consul: {
      deployKey: requiredText(consul.deployKey, "infrastructure.consul.deployKey"),
      requiredVariables: requiredTextList(consul.requiredVariables, "infrastructure.consul.requiredVariables"),
    },
    database: optionalResource(infrastructure.database, "infrastructure.database"),
    pipeline: optionalResource(infrastructure.pipeline, "infrastructure.pipeline"),
    releaseDefinition: optionalResource(infrastructure.releaseDefinition, "infrastructure.releaseDefinition"),
  };
}

function parseObservation(value: unknown): InfrastructureObservation {
  if (!isRecord(value) || !isRecord(value.repository) || !isRecord(value.consul)
    || !isRecord(value.database) || !isRecord(value.pipeline) || !isRecord(value.releaseDefinition)) {
    throw new Error("el adaptador de infraestructura devolvio una observacion incompleta");
  }
  const repository = value.repository;
  const consul = value.consul;
  const database = value.database;
  const pipeline = value.pipeline;
  const releaseDefinition = value.releaseDefinition;
  if (typeof repository.id !== "string" || typeof repository.baseBranch !== "string"
    || typeof repository.exists !== "boolean" || typeof repository.baseBranchExists !== "boolean"
    || typeof consul.deployKey !== "string" || !Array.isArray(consul.variables) || consul.variables.some((item) => typeof item !== "string")
    || typeof consul.available !== "boolean"
    || (database.id !== null && typeof database.id !== "string") || typeof database.available !== "boolean"
    || (pipeline.id !== null && typeof pipeline.id !== "string") || typeof pipeline.available !== "boolean"
    || (releaseDefinition.id !== null && typeof releaseDefinition.id !== "string") || typeof releaseDefinition.available !== "boolean") {
    throw new Error("el adaptador de infraestructura devolvio una observacion invalida");
  }
  return {
    repository: { id: repository.id, baseBranch: repository.baseBranch, exists: repository.exists, baseBranchExists: repository.baseBranchExists },
    consul: { deployKey: consul.deployKey, variables: consul.variables, available: consul.available },
    database: { id: database.id, available: database.available },
    pipeline: { id: pipeline.id, available: pipeline.available },
    releaseDefinition: { id: releaseDefinition.id, available: releaseDefinition.available },
  };
}

export class ProcessInfrastructureSystems implements InfrastructureSystems {
  constructor(private readonly workingDirectory: string) {}

  private async invoke(config: InfrastructureProjectConfig, scope: InfrastructureScope): Promise<unknown> {
    const child = Bun.spawn([...config.adapter.command, "--operation", "verify"], {
      cwd: this.workingDirectory,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(JSON.stringify({ scope, configuration: config }));
    child.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      if (isAuthenticationError(stderr)) throw new InfrastructureAuthenticationRequiredError();
      throw new Error(`adaptador de infraestructura fallo (exit ${exitCode})`);
    }
    try {
      const response = JSON.parse(stdout) as unknown;
      if (isRecord(response) && response.authenticationRequired === true) throw new InfrastructureAuthenticationRequiredError();
      return response;
    } catch (error) {
      if (error instanceof InfrastructureAuthenticationRequiredError) throw error;
      throw new Error(`adaptador de infraestructura devolvio JSON invalido (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  async verify(config: InfrastructureProjectConfig, scope: InfrastructureScope): Promise<InfrastructureObservation> {
    return parseObservation(await this.invoke(config, scope));
  }
}

function finding(category: InfrastructureFinding["category"], title: string, body: string): InfrastructureFinding {
  return { category, title, body };
}

export class SagInfrastructureService {
  constructor(private readonly systems: InfrastructureSystems | null = null) {}

  async verify(scope: InfrastructureScope, workingDirectory: string): Promise<InfrastructureVerification> {
    const config = await readConfig(workingDirectory);
    let observation: InfrastructureObservation;
    try {
      observation = await (this.systems ?? new ProcessInfrastructureSystems(workingDirectory)).verify(config, scope);
    } catch (error) {
      if (scope.tracker === "azure" && isAuthenticationError(error)) throw error;
      const reason = sanitizeText(error instanceof Error ? error.message : String(error));
      return {
        status: "findings",
        observations: {
          repository: { id: "", baseBranch: "", exists: false, baseBranchExists: false },
          consul: { deployKey: "", variables: [], available: false },
          database: { id: null, available: false },
          pipeline: { id: null, available: false },
          releaseDefinition: { id: null, available: false },
        },
        findings: [finding("verification", "Infrastructure verification was unavailable", reason)],
      };
    }
    const findings: InfrastructureFinding[] = [];
    if (!observation.repository.exists || !observation.repository.baseBranchExists
      || observation.repository.id !== config.repository.id || observation.repository.baseBranch !== config.repository.baseBranch) {
      findings.push(finding("repository", "Repository or base branch is not verified", `Expected ${config.repository.id} at ${config.repository.baseBranch}; authoritative observation did not match.`));
    }
    if (!observation.consul.available || observation.consul.deployKey !== config.consul.deployKey
      || config.consul.requiredVariables.some((variable) => !observation.consul.variables.includes(variable))) {
      findings.push(finding("consul", "Consul configuration is missing or unverifiable", `Expected deploy key ${config.consul.deployKey} and all configured variables to be available.`));
    }
    if (config.database.required && (!observation.database.available || observation.database.id !== config.database.id)) {
      findings.push(finding("database", "Required database is missing or unverifiable", `Expected database ${config.database.id}.`));
    }
    if (config.pipeline.required && (!observation.pipeline.available || observation.pipeline.id !== config.pipeline.id)) {
      findings.push(finding("pipeline", "Required pipeline is missing or unverifiable", `Expected pipeline ${config.pipeline.id}.`));
    }
    if (config.releaseDefinition.required && (!observation.releaseDefinition.available || observation.releaseDefinition.id !== config.releaseDefinition.id)) {
      findings.push(finding("release-definition", "Required Release Definition is missing or unverifiable", `Expected Release Definition ${config.releaseDefinition.id}.`));
    }
    return { status: findings.length === 0 ? "ready" : "findings", observations: observation, findings };
  }
}
