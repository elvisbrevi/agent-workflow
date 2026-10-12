import type { CatalogEnvironmentVariable } from "../cli/command-catalog-schema.ts";
import { AZURE_ORGANIZATION_ENV } from "../azure/azure-organization.ts";
import { SAG_NORMS_REPOSITORY_ENV } from "../sag/sag-norms-service.ts";
import { OFF_PASSWORD_ENV } from "../cli/parse-cli-options.ts";

/** Shared by the catalog, credential store and entrypoint; bootstrap settings stay in the environment. */
export const WORKFLOW_ENVIRONMENT: readonly CatalogEnvironmentVariable[] = [
  { name: "LAZY_WORKFLOW_GUI", description: "Ruta alternativa del binario que abre lz gui.", secret: false, credentialStore: true },
  { name: AZURE_ORGANIZATION_ENV, description: "https://dev.azure.com/<organizacion>; requerida por todo flujo y herramienta Azure.", secret: false, credentialStore: true },
  { name: SAG_NORMS_REPOSITORY_ENV, description: "Repositorio canonico de las normas SAG que carga --normas-sag.", secret: false, credentialStore: true },
  { name: "LAZY_WORKFLOW_LOG_FILE", description: "Ruta del run log; --log-file la precede y el default es ~/.local/state/lazy-workflow/runs.jsonl.", secret: false, credentialStore: true },
  { name: "LAZY_WORKFLOW_SECRETS_DIR", description: "Directorio de los archivos de secretos; default ~/.config/secrets.", secret: false },
  { name: OFF_PASSWORD_ENV, description: "Contrasena de sudo que --off usa sin dejarla en ps ni en el historial.", secret: true, credentialStore: true },
  { name: "AZURE_DEVOPS_EXT_PAT", description: "PAT de Azure DevOps para az y para leer normas SAG autenticadas; nunca se envia al agente.", secret: true, credentialStore: true },
  { name: "GH_TOKEN", description: "Token de GitHub que gh usa antes de su login guardado y de GITHUB_TOKEN.", secret: true, credentialStore: true },
  { name: "GITHUB_TOKEN", description: "Token alternativo de GitHub para gh; GH_TOKEN tiene precedencia.", secret: true, credentialStore: true },
  { name: "NO_COLOR", description: "Con cualquier valor deshabilita los colores ANSI, como --no-color.", secret: false },
];
