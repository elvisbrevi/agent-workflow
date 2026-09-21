import { resolve } from "node:path";

/**
 * El repositorio remoto donde viven las normas SAG.
 *
 * La URL no vive en el codigo publicado: cada operador declara la suya en
 * `LAZY_WORKFLOW_SAG_NORMS_REPOSITORY`. Un run `--normas-sag` que no la declara
 * falla antes de abrir sesion, en vez de leer normas de un repositorio ajeno.
 */
export const SAG_NORMS_REPOSITORY_ENV = "LAZY_WORKFLOW_SAG_NORMS_REPOSITORY";

export function sagNormsRepository(env: NodeJS.ProcessEnv = process.env): string {
  const repository = env[SAG_NORMS_REPOSITORY_ENV]?.trim();
  if (!repository) {
    throw new Error(
      `Falta ${SAG_NORMS_REPOSITORY_ENV}: exporta la URL del repositorio remoto de normas SAG, ` +
      "por ejemplo https://dev.azure.com/<organizacion>/<proyecto>/_git/<repositorio>.",
    );
  }
  return repository.replace(/\/+$/, "");
}

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
      sourceRepository: sagNormsRepository(),
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
      sourceRepository: sagNormsRepository(),
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
