import { resolve } from "node:path";

export const CANONICAL_SAG_REPOSITORY_URL = "https://dev.azure.com/SubdepartamentoSolucionesTI/Secci%C3%B3n%20Desarrollo/_git/sag.desarrollo.ia.rag";

const API_URL = "https://dev.azure.com/SubdepartamentoSolucionesTI/Secci%C3%B3n%20Desarrollo/_apis/git/repositories/sag.desarrollo.ia.rag";
const COMPONENTS = ["api", "bff", "nextjs"] as const;
const NORMATIVE_PATHS = {
  common: "/estandares/comunes.md",
  tracker: "/estandares/seguimiento.md",
  documentation: "/estandares/documentacion.md",
  integrations: "/estandares/integraciones.md",
  extraction: "/estandares/extraccion-documentos.md",
  sonar: "/estandares/sonarqube.md",
} as const;

export type SagComponent = typeof COMPONENTS[number];

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
  };
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
  return {
    component: readComponent(value),
    needsDecision,
    explicitFacts: {
      changeKind: typeof changeKind === "string" ? changeKind : null,
      artifacts: Array.isArray(artifacts) ? artifacts as string[] : null,
      capabilities: Array.isArray(capabilities) ? capabilities as string[] : null,
      significantChange: typeof significantChange === "boolean" ? significantChange : null,
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
    const componentPaths = [`/estandares/${component}.md`, `/estandares/${component}-patrones.md`];
    const optionalPaths = [
      ...(explicitFacts.significantChange === true ? [NORMATIVE_PATHS.documentation] : []),
      ...(explicitFacts.artifacts?.some((artifact) => artifact === "config" || artifact === "secret")
        ? [NORMATIVE_PATHS.integrations] : []),
      ...(explicitFacts.artifacts?.includes("document") || explicitFacts.capabilities?.includes("document-processing")
        ? [NORMATIVE_PATHS.extraction] : []),
      ...(explicitFacts.capabilities?.includes("sonar") ? [NORMATIVE_PATHS.sonar] : []),
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
    const selectedOptionalRules = optionalPaths.flatMap((path) => this.select(
      ruleIds(snapshot.files[path] ?? "", path === NORMATIVE_PATHS.documentation ? "doc"
        : path === NORMATIVE_PATHS.integrations ? "int"
          : path === NORMATIVE_PATHS.extraction ? "ext" : "sonar"),
      path,
      snapshot.commit,
      "phase=planning; explicit .sag/config.json facts make this family applicable",
      "applicable",
    ));

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
