import { isBranchRef, WorkspaceCheckpointStore } from "../workspace/workspace-checkpoint-store.ts";

/**
 * Lo único que git no puede contar por sí solo en una entrega transversal (ADR-0038): qué issue
 * está en curso, con qué repositorios, y para cada uno la rama que `prepareBranch` fijó y lo que la
 * integración ya verificó con git. Un repositorio con `changed: null` todavía no pasó esa
 * verificación; uno con `changed: false` la pasó y no llevaba nada sobre su base — válido, sin
 * pull request (ADR-0035) — y uno con `changed: true` lleva el commit que push, PR y merge usan.
 * Ninguno necesita un recibo propio: `pushCommit` compara la rama remota con el commit,
 * `createOrReusePullRequest` reusa el PR canónico, `mergePullRequest` devuelve el merge si ya
 * ocurrió, `closeIssue` sale si la issue ya está cerrada, `cleanupBranch` verifica las dos ramas
 * antes de borrarlas — los mismos efectos autoverificables que la entrega de un repositorio.
 *
 * Lo que había acá era una máquina de ocho fases con un recibo por efecto, una intención previa a
 * cada uno, un identificador de sesión para reanudarla (ninguna se reanuda: ADR-0039), un manifest
 * agregado escrito al final que nadie leía, y evidencia de archivo que la sesión nunca produjo.
 */
export interface GitHubWorkspaceUnit {
  path: string;
  remote: string;
  repository: string;
  branch: string;
  baseBranch: string | null;
  /** `null` hasta que la integración lo verifica con git; después, si llevó commits sobre su base. */
  changed: boolean | null;
  /** El commit verificado de la unidad, o el HEAD limpio de una que no cambió. `null` sin verificar. */
  commit: string | null;
  pullRequest: number | null;
  mergeCommit: string | null;
}

export interface GitHubWorkspaceCheckpoint {
  schemaVersion: 3;
  workflow: "github-workspace-code";
  issue: number;
  parentDirectory: string;
  repositories: Array<{ path: string; remote: string; repository: string }>;
  units: GitHubWorkspaceUnit[];
  /** Lo último que dijo la sesión, que es el cuerpo de cada pull request (ADR-0037). */
  summary: string | null;
}

function validCommit(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[0-9a-f]{40,64}$/i.test(value));
}

function validUnit(value: unknown): value is GitHubWorkspaceUnit {
  if (typeof value !== "object" || value === null) return false;
  const unit = value as Partial<GitHubWorkspaceUnit>;
  const allowedKeys = new Set(["path", "remote", "repository", "branch", "baseBranch", "changed", "commit", "pullRequest", "mergeCommit"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  return typeof unit.path === "string" && unit.path.length > 0
    && typeof unit.remote === "string" && unit.remote.length > 0
    && typeof unit.repository === "string" && unit.repository.length > 0
    && isBranchRef(unit.branch)
    && (unit.baseBranch === null || isBranchRef(unit.baseBranch))
    && (unit.changed === null || typeof unit.changed === "boolean")
    && validCommit(unit.commit)
    && (unit.pullRequest === null || (Number.isInteger(unit.pullRequest) && (unit.pullRequest ?? 0) > 0))
    && validCommit(unit.mergeCommit);
}

export function isGitHubWorkspaceCheckpoint(value: unknown): value is GitHubWorkspaceCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const checkpoint = value as Partial<GitHubWorkspaceCheckpoint>;
  const allowedKeys = new Set(["schemaVersion", "workflow", "issue", "parentDirectory", "repositories", "units", "summary"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  const repositories = checkpoint.repositories;
  const units = checkpoint.units;
  return checkpoint.schemaVersion === 3
    && checkpoint.workflow === "github-workspace-code"
    && Number.isInteger(checkpoint.issue) && (checkpoint.issue ?? 0) > 0
    && typeof checkpoint.parentDirectory === "string" && checkpoint.parentDirectory.length > 0
    && Array.isArray(repositories) && repositories.length > 0
    && repositories.every((entry) => typeof entry?.path === "string" && entry.path.length > 0
      && typeof entry.remote === "string" && entry.remote.length > 0
      && typeof entry.repository === "string" && entry.repository.length > 0)
    && Array.isArray(units) && units.length <= repositories.length && units.every(validUnit)
    && (checkpoint.summary === undefined || checkpoint.summary === null || typeof checkpoint.summary === "string");
}

export class GitHubWorkspaceCheckpointStore extends WorkspaceCheckpointStore<GitHubWorkspaceCheckpoint> {
  protected readonly fileName = "github-workspace-code-checkpoint.json";
  protected readonly label = "GitHub workspace";
  protected isCheckpoint = isGitHubWorkspaceCheckpoint;
}
