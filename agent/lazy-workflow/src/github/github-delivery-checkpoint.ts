import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runGit, type GitRunner } from "../git/git-ticket-branch-cleaner.ts";

/**
 * Lo único que git no puede contar por sí solo (ADR-0038).
 *
 * Todo lo demás sobre una entrega en vuelo se deriva: qué issue está en curso lo dice el claim,
 * qué rama lo dice su nombre, si hay trabajo commiteado lo dice `rev-list`, si ya hay pull request
 * lo dice `gh`. Lo que ninguno de ellos puede responder es si la sesión que la trabajó llegó a
 * verificarse antes de que la corrida se cortara — una rama con dos commits significa lo mismo si
 * el agente terminó y el coordinador se cayó abriendo el PR, que si el agente se cayó habiendo
 * commiteado dos de cinco cosas. `commit` es esa respuesta: presente significa verificada.
 *
 * Lo que había acá era una máquina de ocho fases con recibos por efecto, intenciones previas a
 * cada uno, y el identificador y el CLI de la sesión para poder reanudarla. Los recibos eran
 * redundantes —cada efecto verifica su propio estado antes de actuar— y ninguna sesión se reanuda
 * ya en ninguna parte del camino GitHub (ADR-0039).
 */
export interface GitHubDeliveryCheckpoint {
  schemaVersion: 3;
  workflow: "github-code";
  repository: string;
  issue: number;
  branch: string | null;
  baseBranch?: string | null;
  /** El commit verificado de la unidad. `null` mientras la sesión no haya pasado su verificación. */
  commit: string | null;
  /** El último texto de la sesión, que es el cuerpo del pull request (ADR-0037). */
  summary?: string | null;
}

export interface GitHubCheckpointStore {
  read(workingDirectory?: string): Promise<GitHubDeliveryCheckpoint | null>;
  write(checkpoint: GitHubDeliveryCheckpoint, workingDirectory?: string): Promise<void>;
  clear(workingDirectory?: string): Promise<void>;
}

const FILE_NAME = "lazy-workflow/github-code-checkpoint.json";

function isBranch(value: unknown): value is string | null {
  const name = typeof value === "string" ? value.slice("refs/heads/".length) : "";
  return value === null || (
    typeof value === "string"
    && /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value)
    && !name.includes("..")
    && !name.includes("//")
    && !name.startsWith("/")
    && !name.endsWith("/")
  );
}

function isCommit(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[0-9a-f]{40,64}$/i.test(value));
}

export function isGitHubDeliveryCheckpoint(value: unknown): value is GitHubDeliveryCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const checkpoint = value as Partial<GitHubDeliveryCheckpoint>;
  const allowedKeys = new Set([
    "schemaVersion",
    "workflow",
    "repository",
    "issue",
    "branch",
    "baseBranch",
    "commit",
    "summary",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  return checkpoint.schemaVersion === 3
    && checkpoint.workflow === "github-code"
    && typeof checkpoint.repository === "string"
    && /^[^/\s]+\/[^/\s]+$/.test(checkpoint.repository)
    && Number.isInteger(checkpoint.issue)
    && (checkpoint.issue ?? 0) > 0
    && isBranch(checkpoint.branch)
    && (checkpoint.baseBranch === undefined || isBranch(checkpoint.baseBranch))
    && isCommit(checkpoint.commit)
    && (checkpoint.summary === undefined || checkpoint.summary === null || typeof checkpoint.summary === "string");
}

export class GitHubDeliveryCheckpointStore implements GitHubCheckpointStore {
  constructor(private readonly git: GitRunner = runGit) {}

  private async path(workingDirectory = process.cwd()): Promise<string> {
    return resolve(workingDirectory, (await this.git(["rev-parse", "--git-path", FILE_NAME], workingDirectory)).trim());
  }

  /**
   * Un checkpoint de un esquema anterior se descarta en vez de migrarse.
   *
   * Los esquemas 1 y 2 guardaban una fase y una sesión que el coordinador ya no sabe continuar, así
   * que traducirlos sería inventar la única respuesta que importa. Descartarlo deja la unidad
   * reclamada con su rama, que es exactamente lo que una entrega sin verificar debe dejar.
   */
  async read(workingDirectory?: string): Promise<GitHubDeliveryCheckpoint | null> {
    const path = await this.path(workingDirectory);
    if (!await Bun.file(path).exists()) return null;
    const stored: unknown = await Bun.file(path).json();
    if (!isGitHubDeliveryCheckpoint(stored)) {
      await this.clear(workingDirectory);
      return null;
    }
    return stored;
  }

  async write(checkpoint: GitHubDeliveryCheckpoint, workingDirectory?: string): Promise<void> {
    if (!isGitHubDeliveryCheckpoint(checkpoint)) throw new Error("Checkpoint GitHub invalido");
    const path = await this.path(workingDirectory);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp-${process.pid}`;
    await Bun.write(temporaryPath, `${JSON.stringify(checkpoint)}\n`);
    await rename(temporaryPath, path);
  }

  async clear(workingDirectory?: string): Promise<void> {
    const path = await this.path(workingDirectory);
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
