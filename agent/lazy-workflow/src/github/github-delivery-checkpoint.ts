import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runGit, type GitRunner } from "../git/git-ticket-branch-cleaner.ts";

export const GITHUB_DELIVERY_PHASES = [
  "selected",
  "started",
  "implementing",
  "implementation-ready",
  "integrating",
  "reconciling",
  "cleaning",
] as const;

export type GitHubDeliveryPhase = typeof GITHUB_DELIVERY_PHASES[number];

export interface GitHubDeliveryReceipt {
  verifiedAt: string;
}

export interface GitHubDeliveryCheckpoint {
  schemaVersion: 1;
  workflow: "github-code";
  repository: string;
  issue: number;
  phase: GitHubDeliveryPhase;
  branch: string | null;
  sessionId: string | null;
  commit: string | null;
  pullRequest: number | null;
  receipts: Partial<Record<string, GitHubDeliveryReceipt>>;
}

export interface GitHubCheckpointStore {
  read(workingDirectory?: string): Promise<GitHubDeliveryCheckpoint | null>;
  write(checkpoint: GitHubDeliveryCheckpoint, workingDirectory?: string): Promise<void>;
  clear(workingDirectory?: string): Promise<void>;
}

const FILE_NAME = "lazy-workflow/github-code-checkpoint.json";

function isBranch(value: string | null): boolean {
  return value === null || (/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value) && !value.includes("//"));
}

function isCommit(value: string | null): boolean {
  return value === null || /^[0-9a-f]{40,64}$/i.test(value);
}

function isReceipt(value: unknown): value is GitHubDeliveryReceipt {
  return typeof value === "object"
    && value !== null
    && Object.keys(value).every((key) => key === "verifiedAt")
    && typeof (value as GitHubDeliveryReceipt).verifiedAt === "string"
    && (value as GitHubDeliveryReceipt).verifiedAt.length > 0;
}

export function isGitHubDeliveryCheckpoint(value: unknown): value is GitHubDeliveryCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const checkpoint = value as Partial<GitHubDeliveryCheckpoint>;
  const pullRequest = checkpoint.pullRequest;
  const allowedKeys = new Set([
    "schemaVersion",
    "workflow",
    "repository",
    "issue",
    "phase",
    "branch",
    "sessionId",
    "commit",
    "pullRequest",
    "receipts",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  return checkpoint.schemaVersion === 1
    && checkpoint.workflow === "github-code"
    && typeof checkpoint.repository === "string"
    && /^[^/\s]+\/[^/\s]+$/.test(checkpoint.repository)
    && Number.isInteger(checkpoint.issue)
    && (checkpoint.issue ?? 0) > 0
    && GITHUB_DELIVERY_PHASES.includes(checkpoint.phase as GitHubDeliveryPhase)
    && isBranch(checkpoint.branch ?? null)
    && (checkpoint.sessionId === null
      || (typeof checkpoint.sessionId === "string" && checkpoint.sessionId.length > 0 && !/[\r\n]/.test(checkpoint.sessionId)))
    && isCommit(checkpoint.commit ?? null)
    && (pullRequest === null || (typeof pullRequest === "number" && Number.isInteger(pullRequest) && pullRequest > 0))
    && typeof checkpoint.receipts === "object"
    && checkpoint.receipts !== null
    && Object.values(checkpoint.receipts).every(isReceipt);
}

export class GitHubDeliveryCheckpointStore implements GitHubCheckpointStore {
  constructor(private readonly git: GitRunner = runGit) {}

  private async path(workingDirectory = process.cwd()): Promise<string> {
    return resolve(workingDirectory, (await this.git(["rev-parse", "--git-path", FILE_NAME], workingDirectory)).trim());
  }

  async read(workingDirectory?: string): Promise<GitHubDeliveryCheckpoint | null> {
    const path = await this.path(workingDirectory);
    if (!await Bun.file(path).exists()) return null;
    const value: unknown = await Bun.file(path).json();
    if (!isGitHubDeliveryCheckpoint(value)) throw new Error("Checkpoint GitHub invalido; no se sobrescribira");
    return value;
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
