import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { runGit, type GitRunner } from "../git/git-ticket-branch-cleaner.ts";

export interface WorkspaceRepository {
  path: string;
  remote: string;
  githubRepository: string | null;
}

export interface WorkspaceScope {
  repositories: WorkspaceRepository[];
  parentDirectory: string;
  stateDirectory: string;
}

export function parseWorkingDirectoryList(value: string): string[] {
  if (typeof value !== "string") throw new Error("--working-directory requiere una ruta");
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) {
    throw new Error("--working-directory no permite entradas vacías");
  }
  return entries;
}

function githubRepository(remote: string): string | null {
  const value = remote.trim().replace(/\.git$/, "");
  return value.match(/(?:github\.com[/:])([^/]+\/[^/]+)$/i)?.[1] ?? null;
}

function commonParent(paths: string[]): string {
  const parts = paths.map((path) => resolve(path).split(sep));
  const first = parts[0] ?? [];
  let length = first.length;
  for (const current of parts.slice(1)) {
    length = Math.min(length, current.findIndex((part, index) => part !== first[index]) < 0
      ? length
      : current.findIndex((part, index) => part !== first[index]));
  }
  const parent = first.slice(0, length).join(sep) || sep;
  return resolve(parent);
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
}

export async function normalizeWorkspaceScope(
  workingDirectory: string,
  git: GitRunner = runGit,
): Promise<WorkspaceScope> {
  const requested = parseWorkingDirectoryList(workingDirectory);
  const repositories: WorkspaceRepository[] = [];
  const seen = new Set<string>();

  for (const requestedPath of requested) {
    const absolute = resolve(isAbsolute(requestedPath) ? requestedPath : resolve(process.cwd(), requestedPath));
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(absolute);
    } catch (error) {
      throw new Error(`el repositorio no existe: ${requestedPath}`, { cause: error });
    }
    const root = (await git(["rev-parse", "--show-toplevel"], canonicalPath)).trim();
    if (!root) throw new Error(`la ruta no es un repositorio Git: ${requestedPath}`);
    const canonicalRoot = await realpath(root);
    if (canonicalRoot !== canonicalPath) throw new Error(`la ruta no es la raíz del repositorio Git: ${requestedPath}`);
    if (seen.has(canonicalRoot)) throw new Error(`el repositorio está repetido: ${canonicalRoot}`);
    seen.add(canonicalRoot);
    const remote = (await git(["remote", "get-url", "origin"], canonicalRoot)).trim();
    if (!remote) throw new Error(`el repositorio no tiene remote origin: ${canonicalRoot}`);
    const status = await git(["status", "--porcelain", "--untracked-files=all"], canonicalRoot);
    if (status.trim()) throw new Error(`el repositorio tiene cambios sin guardar: ${canonicalRoot}`);
    repositories.push({ path: canonicalRoot, remote, githubRepository: githubRepository(remote) });
  }

  const roots = repositories.map(({ path }) => path);
  let parentDirectory = commonParent(roots);
  if (roots.some((root) => root === parentDirectory)) parentDirectory = dirname(parentDirectory);
  if (roots.some((root) => isWithin(root, parentDirectory))) {
    throw new Error("el directorio de estado no puede quedar dentro de un repositorio fuente");
  }
  return {
    repositories,
    parentDirectory,
    stateDirectory: resolve(parentDirectory, ".lazy-workflow"),
  };
}
