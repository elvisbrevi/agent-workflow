import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const GITHUB_WORKSPACE_PHASES = [
  "selected",
  "started",
  "implementing",
  "implementation-ready",
  "integrating",
  "reconciling",
  "cleaning",
] as const;

export type GitHubWorkspacePhase = typeof GITHUB_WORKSPACE_PHASES[number];

export interface GitHubWorkspaceUnit {
  path: string;
  repository: string;
  branch: string;
  baseBranch: string | null;
  manifestPath: string;
  changed: boolean | null;
  commit: string | null;
  pullRequest: number | null;
  mergeCommit: string | null;
  phase: GitHubWorkspacePhase;
  receipts: Record<string, { verifiedAt: string }>;
}

export interface GitHubWorkspaceCheckpoint {
  schemaVersion: 1;
  workflow: "github-workspace-code";
  issue: number;
  phase: GitHubWorkspacePhase;
  sessionId: string | null;
  branch: string;
  parentDirectory: string;
  repositories: Array<{ path: string; remote: string; repository: string }>;
  units: GitHubWorkspaceUnit[];
  receipts: Record<string, { verifiedAt: string }>;
}

const FILE_NAME = "github-workspace-code-checkpoint.json";

function validRef(value: unknown): value is string {
  return typeof value === "string" && /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..") && !value.includes("//");
}

function validCommit(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[0-9a-f]{40,64}$/i.test(value));
}

function validReceipts(value: unknown): value is Record<string, { verifiedAt: string }> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every((receipt) => typeof receipt === "object" && receipt !== null && Object.keys(receipt).length === 1 && typeof receipt.verifiedAt === "string" && Number.isFinite(Date.parse(receipt.verifiedAt)));
}

function validUnit(value: unknown): value is GitHubWorkspaceUnit {
  if (typeof value !== "object" || value === null) return false;
  const unit = value as Partial<GitHubWorkspaceUnit>;
  return typeof unit.path === "string"
    && typeof unit.repository === "string"
    && validRef(unit.branch)
    && (unit.baseBranch === null || validRef(unit.baseBranch))
    && typeof unit.manifestPath === "string"
    && (unit.changed === null || typeof unit.changed === "boolean")
    && validCommit(unit.commit)
    && (unit.pullRequest === null || (typeof unit.pullRequest === "number" && Number.isInteger(unit.pullRequest) && unit.pullRequest > 0))
    && validCommit(unit.mergeCommit)
    && GITHUB_WORKSPACE_PHASES.includes(unit.phase as GitHubWorkspacePhase)
    && validReceipts(unit.receipts);
}

export function isGitHubWorkspaceCheckpoint(value: unknown): value is GitHubWorkspaceCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const checkpoint = value as Partial<GitHubWorkspaceCheckpoint>;
  const repositories = checkpoint.repositories;
  const units = checkpoint.units;
  return checkpoint.schemaVersion === 1
    && checkpoint.workflow === "github-workspace-code"
    && Number.isInteger(checkpoint.issue) && (checkpoint.issue ?? 0) > 0
    && GITHUB_WORKSPACE_PHASES.includes(checkpoint.phase as GitHubWorkspacePhase)
    && (checkpoint.sessionId === null || typeof checkpoint.sessionId === "string")
    && validRef(checkpoint.branch)
    && typeof checkpoint.parentDirectory === "string" && checkpoint.parentDirectory.length > 0
    && Array.isArray(repositories) && repositories.length > 0
    && repositories.every((entry) => typeof entry?.path === "string" && typeof entry.remote === "string" && typeof entry.repository === "string" && entry.path.length > 0 && entry.remote.length > 0 && entry.repository.length > 0)
    && Array.isArray(units) && units.length <= repositories.length
    && units.every(validUnit)
    && validReceipts(checkpoint.receipts);
}

export class GitHubWorkspaceCheckpointStore {
  private path(stateDirectory: string): string {
    return resolve(stateDirectory, FILE_NAME);
  }

  async read(stateDirectory: string): Promise<GitHubWorkspaceCheckpoint | null> {
    const path = this.path(stateDirectory);
    if (!await Bun.file(path).exists()) return null;
    const value: unknown = await Bun.file(path).json();
    if (!isGitHubWorkspaceCheckpoint(value)) throw new Error("Checkpoint GitHub workspace inválido; no se sobrescribirá");
    return value;
  }

  async write(checkpoint: GitHubWorkspaceCheckpoint, stateDirectory: string): Promise<void> {
    if (!isGitHubWorkspaceCheckpoint(checkpoint)) throw new Error("Checkpoint GitHub workspace inválido");
    const path = this.path(stateDirectory);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp-${process.pid}`;
    await Bun.write(temporaryPath, `${JSON.stringify(checkpoint)}\n`);
    await rename(temporaryPath, path);
  }

  async clear(stateDirectory: string): Promise<void> {
    try {
      await unlink(this.path(stateDirectory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
