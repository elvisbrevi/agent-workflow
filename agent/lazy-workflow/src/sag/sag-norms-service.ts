import { resolve } from "node:path";

export const CANONICAL_SAG_REPOSITORY_URL = "https://dev.azure.com/SubdepartamentoSolucionesTI/Secci%C3%B3n%20Desarrollo/_git/sag.desarrollo.ia.rag";

const API_URL = "https://dev.azure.com/SubdepartamentoSolucionesTI/Secci%C3%B3n%20Desarrollo/_apis/git/repositories/sag.desarrollo.ia.rag";
const COMPONENTS = ["api", "bff", "nextjs"] as const;
const COMPONENT_PATHS: Record<SagComponent, readonly [string, string]> = {
  api: ["/estandares/api.md", "/estandares/api-adonis-patrones.md"],
  bff: ["/estandares/bff.md", "/estandares/bff-patrones.md"],
  nextjs: ["/estandares/nextjs.md", "/estandares/nextjs-patrones.md"],
};
const CHANGE_KINDS = ["new-component", "feature", "bugfix", "contract-change", "migration", "infrastructure"];
const ARTIFACTS = ["work-item", "source", "test", "config", "secret", "pr", "pipeline", "release", "consul", "database", "openshift", "document"];
const CAPABILITIES = ["database", "admin-endpoints", "server-auth", "user-session", "permissions", "forms", "realtime", "document-processing", "sonar", "cache", "observability"];
const ENVIRONMENTS = ["none", "dev", "test", "qa"];
const NORMATIVE_PATHS = {
  common: "/estandares/comunes.md",
  tracker: "/estandares/seguimiento.md",
  documentation: "/estandares/documentacion.md",
  integrations: "/estandares/integraciones.md",
  extraction: "/estandares/extraccion-documentos.md",
  sonar: "/estandares/sonarqube.md",
} as const;
const ARCHITECTURE_GUIDANCE_PATHS = [
  "/estandares/revision.md",
  "/core/agents/arquitecto-sag.md",
] as const;
const ARCHITECTURE_FAMILIES = [
  "boundaries",
  "contracts",
  "auth",
  "session",
  "data",
  "cache",
  "consul",
  "observability",
  "realtime",
  "deployment-topology",
] as const;
const FAMILY_TERMS: Record<SagArchitectureFamily, readonly string[]> = {
  boundaries: ["boundary", "boundar", "limite", "módulo", "modulo"],
  contracts: ["contract", "contrato", "endpoint", "api"],
  auth: ["auth", "autentic", "seguridad", "permiso", "rol", "token"],
  session: ["session", "sesión", "sesion", "cookie"],
  data: ["database", "base de datos", "persist", "datos"],
  cache: ["cache", "caché"],
  consul: ["consul", "configuración", "configuracion"],
  observability: ["observ", "logging", "log", "trazab", "monitor"],
  realtime: ["realtime", "tiempo real", "websocket"],
  "deployment-topology": ["deploy", "desplieg", "openshift", "route", "pipeline", "topolog"],
};

export type SagComponent = typeof COMPONENTS[number];
export type SagArchitectureFamily = typeof ARCHITECTURE_FAMILIES[number];

export interface SagNormSelection {
  classification: "N";
  applicability: "applicable" | "needs-decision";
  ruleId: string;
  source: string;
  commit: string;
  selectedBecause: string;
}

export interface SagNormsContext {
  phase: "planning";
  sourceRepository: string;
  branch: "master";
  commit: string;
  component: SagComponent;
  explicitFacts: {
    changeKind: string | null;
    artifacts: string[] | null;
    capabilities: string[] | null;
    significantChange: boolean | null;
    environment: string | null;
  };
  selectedRules: SagNormSelection[];
  needsDecision: string[];
}

export interface SagArchitectureFamilySelection {
  family: SagArchitectureFamily;
  applicability: "applicable" | "not-applicable" | "needs-decision";
  selectedBecause: string;
}

export interface SagArchitectureGuidance {
  classification: "W";
  path: string;
  source: string;
  commit: string;
  selectedBecause: string;
}

export interface SagArchitectureReviewContext {
  phase: "architecture-review";
  sourceRepository: string;
  branch: "master";
  commit: string;
  component: SagComponent;
  explicitFacts: SagNormsContext["explicitFacts"];
  reviewFamilies: SagArchitectureFamilySelection[];
  selectedRules: SagNormSelection[];
  guidance: SagArchitectureGuidance[];
  needsDecision: string[];
}

export interface SagDeploymentContext {
  phase: "delivery";
  sourceRepository: string;
  branch: "master";
  commit: string;
  component: SagComponent;
  explicitFacts: SagNormsContext["explicitFacts"];
  selectedRules: SagNormSelection[];
  guidance: SagArchitectureGuidance[];
  needsDecision: string[];
}

export interface SagInfrastructureContext {
  phase: "infrastructure";
  sourceRepository: string;
  branch: "master";
  commit: string;
  component: SagComponent;
  explicitFacts: SagNormsContext["explicitFacts"];
  selectedRules: SagNormSelection[];
  needsDecision: string[];
}

export interface SagNormSourceSnapshot {
  commit: string;
  files: Record<string, string>;
}

export interface SagNormSource {
  load(paths: readonly string[]): Promise<SagNormSourceSnapshot>;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

function sourceUrl(path: string): string {
  return `${CANONICAL_SAG_REPOSITORY_URL}?path=${encodeURIComponent(path)}&version=GBmaster`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function ruleIds(content: string, prefix: string): string[] {
  return [...new Set(content.match(new RegExp(`\\b${prefix}-[A-Z]\\d+\\b`, "g")) ?? [])].sort();
}

function listValue(config: Record<string, unknown>, names: string[]): string[] | null {
  const value = names.map((name) => config[name]).find((candidate) => candidate !== undefined);
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`.sag/config.json: ${names[0]} debe ser una lista de textos`);
  }
  return value;
}

function readComponent(config: Record<string, unknown>): SagComponent {
  const component = config.tipo;
  if (!COMPONENTS.includes(component as SagComponent)) {
    throw new Error(".sag/config.json requiere un tipo explicito: api, bff o nextjs");
  }
  return component as SagComponent;
}

async function readConfig(workingDirectory: string): Promise<{
  component: SagComponent;
  needsDecision: string[];
  explicitFacts: SagNormsContext["explicitFacts"];
}> {
  const path = resolve(workingDirectory, ".sag/config.json");
  let value: unknown;
  try {
    value = JSON.parse(await Bun.file(path).text());
  } catch (error) {
    throw new Error(`no se pudo leer .sag/config.json (${message(error)})`);
  }
  if (!isRecord(value)) throw new Error(".sag/config.json debe contener un objeto");

  const needsDecision: string[] = [];
  const facts = [
    ["change-kind", ["changeKind", "cambio"]],
    ["artifacts", ["artifacts", "artefactos"]],
    ["capabilities", ["capabilities", "capacidades"]],
    ["significant-change", ["significantChange", "cambioSignificativo"]],
    ["environment", ["environment", "entorno"]],
  ] as const;
  for (const [name, names] of facts) {
    const values = names.map((key) => value[key]).filter((candidate) => candidate !== undefined);
    const present = values.length > 0;
    if (values.length > 1 && JSON.stringify(values[0]) !== JSON.stringify(values[1])) {
      throw new Error(`.sag/config.json contiene valores en conflicto para ${name}`);
    }
    if (present) {
      if (name === "significant-change") {
        if (typeof value[names[0]] !== "boolean" && typeof value[names[1]] !== "boolean") {
          throw new Error(`.sag/config.json: ${names[0]} debe ser booleano`);
        }
      } else if (name === "change-kind") {
        if (typeof value[names[0]] !== "string" && typeof value[names[1]] !== "string") {
          throw new Error(`.sag/config.json: ${names[0]} debe ser texto`);
        }
      } else if (name === "environment") {
        if (typeof value[names[0]] !== "string" && typeof value[names[1]] !== "string") {
          throw new Error(`.sag/config.json: ${names[0]} debe ser texto`);
        }
      } else {
        listValue(value, [...names]);
      }
    } else {
      needsDecision.push(name);
    }
  }

  const readAlias = (names: string[]): unknown => names.map((name) => value[name]).find((candidate) => candidate !== undefined);
  const changeKind = readAlias(["changeKind", "cambio"]);
  const artifacts = readAlias(["artifacts", "artefactos"]);
  const capabilities = readAlias(["capabilities", "capacidades"]);
  const significantChange = readAlias(["significantChange", "cambioSignificativo"]);
  const environment = readAlias(["environment", "entorno"]);
  const normalizeValue = (value: unknown, allowed: string[], name: string): string | null => {
    if (value === undefined) return null;
    if (typeof value !== "string" || !allowed.includes(value)) {
      needsDecision.push(`${name}: contiene un valor desconocido`);
      return null;
    }
    return value;
  };
  const normalizeList = (value: unknown, allowed: string[], name: string): string[] | null => {
    if (value === undefined) return null;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
    if (value.some((item) => !allowed.includes(item))) {
      needsDecision.push(`${name}: contiene valores desconocidos`);
      return null;
    }
    return value;
  };
  return {
    component: readComponent(value),
    needsDecision,
    explicitFacts: {
      changeKind: normalizeValue(changeKind, CHANGE_KINDS, "change-kind"),
      artifacts: normalizeList(artifacts, ARTIFACTS, "artifacts"),
      capabilities: normalizeList(capabilities, CAPABILITIES, "capabilities"),
      significantChange: typeof significantChange === "boolean" ? significantChange : null,
      environment: normalizeValue(environment, ENVIRONMENTS, "environment"),
    },
  };
}

export class RemoteSagNormSource implements SagNormSource {
  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly accessToken = process.env.AZURE_DEVOPS_EXT_PAT,
  ) {}

  private async get(url: string): Promise<unknown> {
    const headers: Record<string, string> = this.accessToken ? { Authorization: `Basic ${btoa(`:${this.accessToken}`)}` } : {};
    const response = await this.fetcher(url, { headers });
    if (!response.ok) throw new Error(`fuente SAG inaccesible (${response.status})`);
    return response.json();
  }

  async load(paths: readonly string[]): Promise<SagNormSourceSnapshot> {
    const refs = await this.get(`${API_URL}/refs?filter=heads/master&api-version=7.1-preview.1`);
    const values = isRecord(refs) && Array.isArray(refs.value) ? refs.value : [];
    const masterRefs = values.filter((ref): ref is Record<string, unknown> =>
      isRecord(ref) && ref.name === "refs/heads/master" && typeof ref.objectId === "string");
    if (masterRefs.length !== 1) throw new Error("la fuente SAG no tiene una referencia master unica");
    const commit = masterRefs[0]!.objectId as string;

    const files: Record<string, string> = {};
    for (const path of paths) {
      const item = await this.get(`${API_URL}/items?path=${encodeURIComponent(path)}&versionDescriptor.version=${encodeURIComponent(commit)}&versionDescriptor.versionType=commit&includeContent=true&api-version=7.1-preview.1`);
      if (!isRecord(item) || typeof item.content !== "string") {
        throw new Error(`la fuente SAG no contiene ${path}`);
      }
      files[path] = item.content;
    }
    return { commit, files };
  }
}

export class SagNormsService {
  constructor(private readonly source: SagNormSource = new RemoteSagNormSource()) {}

  async loadPlanning(workingDirectory: string): Promise<SagNormsContext> {
    const { component, needsDecision, explicitFacts } = await readConfig(workingDirectory);
    const componentPaths = COMPONENT_PATHS[component];
    const optionalPaths = [
      NORMATIVE_PATHS.documentation,
      NORMATIVE_PATHS.integrations,
      NORMATIVE_PATHS.extraction,
      NORMATIVE_PATHS.sonar,
    ];
    const paths = [NORMATIVE_PATHS.common, ...componentPaths, NORMATIVE_PATHS.tracker, ...optionalPaths];
    const snapshot = await this.source.load(paths);
    if (!snapshot.commit.trim()) throw new Error("la fuente SAG no devolvio un commit master");

    const common = ruleIds(snapshot.files[NORMATIVE_PATHS.common] ?? "", "com");
    const tracker = ruleIds(snapshot.files[NORMATIVE_PATHS.tracker] ?? "", "seg");
    const componentRules = componentPaths.flatMap((path) => ruleIds(snapshot.files[path] ?? "", component));
    if (!common.includes("com-G1")) throw new Error("la fuente SAG no contiene la norma com-G1");
    if (componentRules.length === 0) throw new Error(`la fuente SAG no contiene normas para ${component}`);
    if (tracker.length === 0) throw new Error("la fuente SAG no contiene normas de seguimiento");

    const conditionalDecisions = [
      ...ruleIds(snapshot.files[componentPaths[1]!] ?? "", component)
        .map((ruleId) => `${ruleId}: requiere decidir aplicabilidad por artefacto o capacidad`),
      ...tracker.map((ruleId) => `${ruleId}: requiere decidir aplicabilidad por change-kind`),
    ];
    const selectedOptionalRules = optionalPaths.flatMap((path) => {
      const prefix = path === NORMATIVE_PATHS.documentation ? "doc"
        : path === NORMATIVE_PATHS.integrations ? "int"
          : path === NORMATIVE_PATHS.extraction ? "ext" : "sonar";
      const ids = ruleIds(snapshot.files[path] ?? "", prefix);
      if (ids.length === 0) throw new Error(`la fuente SAG no contiene normas para ${path}`);
      const artifactIntegration = explicitFacts.artifacts?.some((artifact) => artifact === "config" || artifact === "secret");
      const artifactDocument = explicitFacts.artifacts?.includes("document");
      const capabilityDocument = explicitFacts.capabilities?.includes("document-processing");
      const capabilitySonar = explicitFacts.capabilities?.includes("sonar");
      const knownFalse = path === NORMATIVE_PATHS.documentation
        ? explicitFacts.significantChange === false
        : path === NORMATIVE_PATHS.integrations
          ? artifactIntegration === false
          : path === NORMATIVE_PATHS.extraction
            ? artifactDocument === false && capabilityDocument === false
            : capabilitySonar === false;
      if (knownFalse) return [];
      const applicable = path === NORMATIVE_PATHS.documentation
        ? explicitFacts.significantChange === true && explicitFacts.environment !== null
        : path === NORMATIVE_PATHS.integrations
          ? artifactIntegration === true && explicitFacts.environment !== null
          : path === NORMATIVE_PATHS.extraction
            ? (artifactDocument === true || capabilityDocument === true) && explicitFacts.environment !== null
            : capabilitySonar === true && explicitFacts.environment !== null;
      const unknown = !applicable;
      if (unknown) {
        conditionalDecisions.push(...ids.map((ruleId) => `${ruleId}: requiere decidir aplicabilidad por hechos de alcance`));
      }
      return this.select(
        ids,
        path,
        snapshot.commit,
        applicable
          ? "phase=planning; explicit .sag/config.json facts make this family applicable"
          : "phase=planning; family applicability needs decision",
        applicable ? "applicable" : "needs-decision",
      );
    });

    const selectedRules = [
      ...this.select(common.filter((id) => id === "com-G1"), NORMATIVE_PATHS.common, snapshot.commit, "phase=planning; common planning rule", "applicable"),
      ...this.select(
        ruleIds(snapshot.files[componentPaths[0]!] ?? "", component),
        componentPaths[0]!,
        snapshot.commit,
        `phase=planning; tipo=${component} from .sag/config.json`,
        "applicable",
      ),
      ...this.select(
        ruleIds(snapshot.files[componentPaths[1]!] ?? "", component),
        componentPaths[1]!,
        snapshot.commit,
        `phase=planning; tipo=${component}; rule-specific artifact/capability applicability needs decision`,
        "needs-decision",
      ),
      ...selectedOptionalRules,
      ...this.select(
        tracker,
        NORMATIVE_PATHS.tracker,
        snapshot.commit,
        "phase=planning; rule-specific change-kind applicability needs decision",
        "needs-decision",
      ),
    ];
    return {
      phase: "planning",
      sourceRepository: CANONICAL_SAG_REPOSITORY_URL,
      branch: "master",
      commit: snapshot.commit,
      component,
      explicitFacts,
      selectedRules,
      needsDecision: [...needsDecision, ...conditionalDecisions],
    };
  }

  async loadArchitectureReview(workingDirectory: string): Promise<SagArchitectureReviewContext> {
    const { component, needsDecision, explicitFacts } = await readConfig(workingDirectory);
    const componentPaths = COMPONENT_PATHS[component];
    const paths = [
      NORMATIVE_PATHS.common,
      ...componentPaths,
      NORMATIVE_PATHS.integrations,
      "/estandares/pull-requests.md",
      ...ARCHITECTURE_GUIDANCE_PATHS,
    ];
    const snapshot = await this.source.load(paths);
    if (!snapshot.commit.trim()) throw new Error("la fuente SAG no devolvio un commit master");

    const reviewFamilies = ARCHITECTURE_FAMILIES.map((family) => this.architectureFamily(family, explicitFacts));
    const decisions = [
      ...needsDecision,
      ...reviewFamilies
        .filter(({ applicability }) => applicability === "needs-decision")
        .map(({ family }) => `${family}: requiere decidir aplicabilidad por hechos de alcance`),
    ];
    const selectFamilyRules = (
      content: string,
      ids: string[],
      path: string,
      families: SagArchitectureFamily[],
    ): SagNormSelection[] => ids.flatMap((ruleId) => {
      const familyApplicability = this.ruleFamilyApplicability(content, ruleId, families, reviewFamilies);
      return familyApplicability === "not-applicable" ? [] : this.select(
        [ruleId],
        path,
        snapshot.commit,
        `phase=architecture-review; tipo=${component}; rule-specific family applicability=${familyApplicability}`,
        familyApplicability,
      );
    });
    const selectedRules = [
      ...this.select(ruleIds(snapshot.files[NORMATIVE_PATHS.common] ?? "", "com"), NORMATIVE_PATHS.common, snapshot.commit, "phase=architecture-review; common structural rule", "applicable"),
      ...this.select(ruleIds(snapshot.files[componentPaths[0]!] ?? "", component), componentPaths[0]!, snapshot.commit, `phase=architecture-review; tipo=${component} from .sag/config.json`, "applicable"),
      ...selectFamilyRules(snapshot.files[componentPaths[1]!] ?? "", ruleIds(snapshot.files[componentPaths[1]!] ?? "", component), componentPaths[1]!, [...ARCHITECTURE_FAMILIES]),
      ...selectFamilyRules(snapshot.files[NORMATIVE_PATHS.integrations] ?? "", ruleIds(snapshot.files[NORMATIVE_PATHS.integrations] ?? "", "int"), NORMATIVE_PATHS.integrations, ["auth", "consul"]),
      ...selectFamilyRules(snapshot.files["/estandares/pull-requests.md"] ?? "", ruleIds(snapshot.files["/estandares/pull-requests.md"] ?? "", "pr"), "/estandares/pull-requests.md", ["deployment-topology"]),
    ];
    const guidance = ARCHITECTURE_GUIDANCE_PATHS.map((path) => ({
      classification: "W" as const,
      path,
      source: sourceUrl(path),
      commit: snapshot.commit,
      selectedBecause: "phase=architecture-review; procedural guidance is separate from numbered norms",
    }));
    return {
      phase: "architecture-review",
      sourceRepository: CANONICAL_SAG_REPOSITORY_URL,
      branch: "master",
      commit: snapshot.commit,
      component,
      explicitFacts,
      reviewFamilies,
      selectedRules,
      guidance,
      needsDecision: decisions,
    };
  }

  async loadDeployment(workingDirectory: string): Promise<SagDeploymentContext> {
    const { component, needsDecision, explicitFacts } = await readConfig(workingDirectory);
    const componentPaths = COMPONENT_PATHS[component];
    const paths = [
      NORMATIVE_PATHS.common,
      ...componentPaths,
      NORMATIVE_PATHS.documentation,
      NORMATIVE_PATHS.integrations,
      "/estandares/pull-requests.md",
      NORMATIVE_PATHS.tracker,
      NORMATIVE_PATHS.sonar,
      "/core/workflows/finalizar.md",
      "/core/agents/despliegue-sag.md",
    ];
    const snapshot = await this.source.load(paths);
    if (!snapshot.commit.trim()) throw new Error("la fuente SAG no devolvio un commit master");

    const content = (path: string): string => snapshot.files[path] ?? "";
    const ids = (path: string, prefix: string): string[] => ruleIds(content(path), prefix);
    const required = [
      [NORMATIVE_PATHS.common, "com", "com-G2"],
      [componentPaths[0]!, component, `${component}-R1`],
      [componentPaths[1]!, component, `${component}-R9`],
      [NORMATIVE_PATHS.documentation, "doc", "doc-R1"],
      [NORMATIVE_PATHS.integrations, "int", "int-R1"],
      ["/estandares/pull-requests.md", "pr", "pr-R1"],
      [NORMATIVE_PATHS.tracker, "seg", "seg-R1"],
      [NORMATIVE_PATHS.sonar, "sonar", "sonar-R1"],
    ] as const;
    for (const [path, prefix, requiredId] of required) {
      if (!ids(path, prefix).includes(requiredId)) throw new Error(`la fuente SAG no contiene la norma ${requiredId}`);
    }

    const decisions = [...needsDecision];
    const selectDeliveryRules = (path: string, prefix: string): SagNormSelection[] => {
      const ruleIdsForPath = ids(path, prefix);
      const known = (value: boolean | null): SagNormSelection["applicability"] => {
        if (value === false) return "applicable";
        if (value === true) return "applicable";
        decisions.push(`${prefix}: requiere decidir aplicabilidad por hechos de entrega`);
        return "needs-decision";
      };
      let applies: boolean | null = null;
      if (prefix === component) applies = path === componentPaths[0] ? true : null;
      else if (prefix === "doc") applies = explicitFacts.significantChange;
      else if (prefix === "int") applies = explicitFacts.artifacts === null
        ? null
        : explicitFacts.artifacts.some((artifact) => ["config", "secret", "consul"].includes(artifact));
      else if (prefix === "pr") applies = explicitFacts.artifacts === null
        ? null
        : explicitFacts.artifacts.some((artifact) => ["pr", "pipeline", "release", "openshift"].includes(artifact));
      else if (prefix === "seg") applies = explicitFacts.changeKind === null ? null : true;
      else if (prefix === "sonar") applies = explicitFacts.capabilities === null ? null : explicitFacts.capabilities.includes("sonar");
      if (applies === false) return [];
      const applicability = known(applies);
      return this.select(
        ruleIdsForPath,
        path,
        snapshot.commit,
        `phase=deployment; tipo=${component}; delivery rule family ${prefix}`,
        applicability,
      );
    };
    const selectedRules = [
      ...this.select(["com-G2"], NORMATIVE_PATHS.common, snapshot.commit, "phase=deployment; common delivery rule", "applicable"),
      ...selectDeliveryRules(componentPaths[0]!, component),
      ...selectDeliveryRules(componentPaths[1]!, component),
      ...selectDeliveryRules(NORMATIVE_PATHS.documentation, "doc"),
      ...selectDeliveryRules(NORMATIVE_PATHS.integrations, "int"),
      ...selectDeliveryRules("/estandares/pull-requests.md", "pr"),
      ...selectDeliveryRules(NORMATIVE_PATHS.tracker, "seg"),
      ...selectDeliveryRules(NORMATIVE_PATHS.sonar, "sonar"),
    ];
    const guidance = ["/core/workflows/finalizar.md", "/core/agents/despliegue-sag.md"].map((path) => ({
      classification: "W" as const,
      path,
      source: sourceUrl(path),
      commit: snapshot.commit,
      selectedBecause: "phase=deployment; delivery guidance is separate from numbered norms",
    }));
    return {
      phase: "delivery",
      sourceRepository: CANONICAL_SAG_REPOSITORY_URL,
      branch: "master",
      commit: snapshot.commit,
      component,
      explicitFacts,
      selectedRules,
      guidance,
      needsDecision: decisions,
    };
  }

  async loadInfrastructure(workingDirectory: string): Promise<SagInfrastructureContext> {
    const { component, needsDecision, explicitFacts } = await readConfig(workingDirectory);
    const componentPaths = COMPONENT_PATHS[component];
    const paths = [NORMATIVE_PATHS.common, ...componentPaths, NORMATIVE_PATHS.integrations];
    const snapshot = await this.source.load(paths);
    if (!snapshot.commit.trim()) throw new Error("la fuente SAG no devolvio un commit master");
    const content = (path: string): string => snapshot.files[path] ?? "";
    const common = ruleIds(content(NORMATIVE_PATHS.common), "com");
    const componentRules = componentPaths.map((path) => ({ path, ids: ruleIds(content(path), component) }));
    const integrationRules = ruleIds(content(NORMATIVE_PATHS.integrations), "int");
    if (!common.includes("com-G1")) throw new Error("la fuente SAG no contiene la norma com-G1");
    if (componentRules.every(({ ids }) => ids.length === 0)) throw new Error(`la fuente SAG no contiene normas para ${component}`);
    if (!integrationRules.includes("int-R1")) throw new Error("la fuente SAG no contiene la norma int-R1");
    const componentPatternDecisions = componentRules[1]!.ids.map((ruleId) => `${ruleId}: requiere decidir aplicabilidad por artefacto o capacidad`);
    const integrationApplicable = explicitFacts.artifacts?.some((artifact) => ["config", "secret", "consul"].includes(artifact));
    const integrationApplicability: SagNormSelection["applicability"] = integrationApplicable === undefined ? "needs-decision" : "applicable";
    const integrationDecisions = integrationApplicable === undefined
      ? integrationRules.map((ruleId) => `${ruleId}: requiere decidir aplicabilidad por hechos de alcance`)
      : [];
    return {
      phase: "infrastructure",
      sourceRepository: CANONICAL_SAG_REPOSITORY_URL,
      branch: "master",
      commit: snapshot.commit,
      component,
      explicitFacts,
      selectedRules: [
        ...this.select(["com-G1"], NORMATIVE_PATHS.common, snapshot.commit, "phase=infrastructure; common verification rule", "applicable"),
        ...this.select(componentRules[0]!.ids, componentRules[0]!.path, snapshot.commit, `phase=infrastructure; tipo=${component} from .sag/config.json`, "applicable"),
        ...this.select(componentRules[1]!.ids, componentRules[1]!.path, snapshot.commit, "phase=infrastructure; component cross-cutting applicability needs decision", "needs-decision"),
        ...this.select(integrationRules, NORMATIVE_PATHS.integrations, snapshot.commit, "phase=infrastructure; external configuration applicability is explicit", integrationApplicability),
      ],
      needsDecision: [...needsDecision, ...componentPatternDecisions, ...integrationDecisions],
    };
  }

  private architectureFamily(
    family: SagArchitectureFamily,
    facts: SagNormsContext["explicitFacts"],
  ): SagArchitectureFamilySelection {
    const capability = (values: string[] | null, names: string[]): SagArchitectureFamilySelection["applicability"] => {
      if (values === null) return "needs-decision";
      return values.some((value) => names.includes(value)) ? "applicable" : "not-applicable";
    };
    const artifact = (names: string[]): SagArchitectureFamilySelection["applicability"] => {
      if (facts.artifacts === null) return "needs-decision";
      return facts.artifacts.some((value) => names.includes(value)) ? "applicable" : "not-applicable";
    };
    let applicability: SagArchitectureFamilySelection["applicability"];
    if (family === "auth") applicability = capability(facts.capabilities, ["admin-endpoints", "server-auth", "permissions"]);
    else if (family === "session") applicability = capability(facts.capabilities, ["user-session"]);
    else if (family === "data") applicability = capability(facts.capabilities, ["database"]);
    else if (family === "cache") applicability = capability(facts.capabilities, ["cache"]);
    else if (family === "observability") applicability = capability(facts.capabilities, ["observability", "sonar"]);
    else if (family === "realtime") applicability = capability(facts.capabilities, ["realtime"]);
    else if (family === "consul") applicability = artifact(["consul", "config", "secret"]);
    else if (family === "deployment-topology") {
      applicability = facts.environment === null ? "needs-decision"
        : facts.environment === "none" && facts.artifacts !== null && !facts.artifacts.some((value) => ["pipeline", "release", "openshift"].includes(value))
          ? "not-applicable"
          : artifact(["pipeline", "release", "openshift"]);
    } else if (family === "boundaries") {
      applicability = facts.changeKind === null ? "needs-decision"
        : ["new-component", "contract-change"].includes(facts.changeKind) ? "applicable" : "not-applicable";
    } else {
      applicability = facts.changeKind === null ? "needs-decision"
        : facts.changeKind === "contract-change" ? "applicable" : "needs-decision";
    }
    return {
      family,
      applicability,
      selectedBecause: `phase=architecture-review; explicit .sag/config.json facts select ${family}`,
    };
  }

  private ruleFamilyApplicability(
    content: string,
    ruleId: string,
    families: SagArchitectureFamily[],
    selections: SagArchitectureFamilySelection[],
  ): SagArchitectureFamilySelection["applicability"] {
    const start = content.indexOf(ruleId);
    const nextRule = start < 0 ? -1 : content.slice(start + ruleId.length).search(/\b[A-Za-z]+-[A-Z]\d+\b/);
    const ruleText = start < 0 ? "" : content.slice(start, nextRule < 0 ? undefined : start + ruleId.length + nextRule).toLowerCase();
    const mentioned = families.filter((family) => FAMILY_TERMS[family].some((term) => ruleText.includes(term)));
    if (mentioned.length === 0) return "needs-decision";
    const selected = selections.filter(({ family }) => mentioned.includes(family));
    if (selected.some(({ applicability }) => applicability === "applicable")) return "applicable";
    if (selected.some(({ applicability }) => applicability === "needs-decision")) return "needs-decision";
    return "not-applicable";
  }

  private select(
    ids: string[],
    path: string,
    commit: string,
    selectedBecause: string,
    applicability: SagNormSelection["applicability"],
  ): SagNormSelection[] {
    return ids.map((ruleId) => ({
      classification: "N",
      applicability,
      ruleId,
      source: sourceUrl(path),
      commit,
      selectedBecause,
    }));
  }
}
