import { resolve } from "node:path";

export const CANONICAL_SAG_REPOSITORY_URL = "https://dev.azure.com/example-org/example-project/_git/sag-norms";

const COMPONENTS = ["api", "bff", "nextjs"] as const;
const COMPONENT_PATHS: Record<SagComponent, readonly [string, string]> = {
  api: ["/estandares/api.md", "/estandares/api-adonis-patrones.md"],
  bff: ["/estandares/bff.md", "/estandares/bff-patrones.md"],
  nextjs: ["/estandares/nextjs.md", "/estandares/nextjs-patrones.md"],
};
const NORMATIVE_PATHS = {
  common: "/estandares/comunes.md",
  tracker: "/estandares/seguimiento.md",
  documentation: "/estandares/documentacion.md",
  integrations: "/estandares/integraciones.md",
  extraction: "/estandares/extraccion-documentos.md",
  pullRequests: "/estandares/pull-requests.md",
  sonar: "/estandares/sonarqube.md",
} as const;

export type SagComponent = typeof COMPONENTS[number];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readComponent(config: Record<string, unknown>): SagComponent {
  const component = config.tipo;
  if (!COMPONENTS.includes(component as SagComponent)) {
    throw new Error(".sag/config.json requiere un tipo explicito: api, bff o nextjs");
  }
  return component as SagComponent;
}

export interface SagNormsContext {
  phase: "planning" | "coding";
  sourceRepository: string;
  component: SagComponent;
  paths: string[];
}

async function readConfig(workingDirectory: string): Promise<{ component: SagComponent }> {
  const path = resolve(workingDirectory, ".sag/config.json");
  let value: unknown;
  try {
    value = JSON.parse(await Bun.file(path).text());
  } catch (error) {
    throw new Error(`no se pudo leer .sag/config.json (${message(error)})`);
  }
  if (!isRecord(value)) throw new Error(".sag/config.json debe contener un objeto");
  return { component: readComponent(value) };
}

export class SagNormsService {
  async loadPlanning(workingDirectory: string): Promise<SagNormsContext> {
    const { component } = await readConfig(workingDirectory);
    const componentPaths = COMPONENT_PATHS[component];
    return {
      phase: "planning",
      sourceRepository: CANONICAL_SAG_REPOSITORY_URL,
      component,
      paths: [
        NORMATIVE_PATHS.common,
        ...componentPaths,
        NORMATIVE_PATHS.tracker,
        NORMATIVE_PATHS.documentation,
        NORMATIVE_PATHS.integrations,
        NORMATIVE_PATHS.extraction,
        NORMATIVE_PATHS.sonar,
      ],
    };
  }

  async loadCoding(workingDirectory: string): Promise<SagNormsContext> {
    const { component } = await readConfig(workingDirectory);
    const componentPaths = COMPONENT_PATHS[component];
    return {
      phase: "coding",
      sourceRepository: CANONICAL_SAG_REPOSITORY_URL,
      component,
      paths: [
        NORMATIVE_PATHS.common,
        ...componentPaths,
        NORMATIVE_PATHS.tracker,
        NORMATIVE_PATHS.documentation,
        NORMATIVE_PATHS.integrations,
        NORMATIVE_PATHS.extraction,
        NORMATIVE_PATHS.pullRequests,
        NORMATIVE_PATHS.sonar,
      ],
    };
  }
}
