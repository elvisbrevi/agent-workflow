import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isAgentCli, withOwnerCli, type AgentCli } from "../coding-agent/agent-cli.ts";
import { runGit, type GitRunner } from "../git/git-ticket-branch-cleaner.ts";

export const GITHUB_DELIVERY_PHASES = [
  "selected",
  "started",
  "implementing",
  "implementation-ready",
  "integrating",
  "conflict-resolving",
  "reconciling",
  "cleaning",
] as const;

export type GitHubDeliveryPhase = typeof GITHUB_DELIVERY_PHASES[number];

export interface GitHubDeliveryReceipt {
  verifiedAt: string;
}

export interface GitHubDeliveryIntent {
  effect: string;
  target: string;
}

export interface GitHubPullRequestReconciliation {
  pullRequest: number;
  originalCommit: string;
  baseCommit: string;
}

export interface GitHubDeliveryCheckpoint {
  schemaVersion: 2;
  /** The coding agent CLI owning `sessionId`, so recovery resumes against it (ADR-0023). */
  cli: AgentCli;
  workflow: "github-code";
  repository: string;
  issue: number;
  phase: GitHubDeliveryPhase;
  branch: string | null;
  sessionId: string | null;
  /**
   * The rung the session is running on, written only once a fallback descent
   * moves it off the run's own; absent means the primary rung (issue #238).
   */
  model?: string | null;
  variant?: string | null;
  commit: string | null;
  pullRequest: number | null;
  receipts: Partial<Record<string, GitHubDeliveryReceipt>>;
  baseBranch?: string | null;
  manifestPath?: string | null;
  mergeCommit?: string | null;
  intent?: GitHubDeliveryIntent | null;
  reconciliation?: GitHubPullRequestReconciliation | null;
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

/** The model or variant a descent recorded: absent, or a single-line non-empty name. */
function isRung(value: unknown): value is string | null | undefined {
  return value === undefined || value === null
    || (typeof value === "string" && value.length > 0 && !/[\r\n]/.test(value));
}

function isReceipt(value: unknown): value is GitHubDeliveryReceipt {
  return typeof value === "object"
    && value !== null
    && Object.keys(value).every((key) => key === "verifiedAt")
    && typeof (value as GitHubDeliveryReceipt).verifiedAt === "string"
    && Number.isFinite(Date.parse((value as GitHubDeliveryReceipt).verifiedAt))
    && (value as GitHubDeliveryReceipt).verifiedAt.length > 0;
}

export function isGitHubDeliveryCheckpoint(value: unknown): value is GitHubDeliveryCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const checkpoint = value as Partial<GitHubDeliveryCheckpoint>;
  const pullRequest = checkpoint.pullRequest;
  const allowedKeys = new Set([
    "schemaVersion",
    "cli",
    "workflow",
    "repository",
    "issue",
    "phase",
    "branch",
    "sessionId",
    "model",
    "variant",
    "commit",
    "pullRequest",
    "receipts",
    "baseBranch",
    "manifestPath",
    "mergeCommit",
    "intent",
    "reconciliation",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  return checkpoint.schemaVersion === 2
    && isAgentCli(checkpoint.cli)
    && checkpoint.workflow === "github-code"
    && typeof checkpoint.repository === "string"
    && /^[^/\s]+\/[^/\s]+$/.test(checkpoint.repository)
    && Number.isInteger(checkpoint.issue)
    && (checkpoint.issue ?? 0) > 0
    && GITHUB_DELIVERY_PHASES.includes(checkpoint.phase as GitHubDeliveryPhase)
    && isBranch(checkpoint.branch)
    && (checkpoint.sessionId === null
      || (typeof checkpoint.sessionId === "string" && checkpoint.sessionId.length > 0 && !/[\r\n]/.test(checkpoint.sessionId)))
    && isCommit(checkpoint.commit)
    && isRung(checkpoint.model)
    && isRung(checkpoint.variant)
    && (checkpoint.baseBranch === undefined || isBranch(checkpoint.baseBranch))
    && (checkpoint.manifestPath === undefined || checkpoint.manifestPath === null || (typeof checkpoint.manifestPath === "string" && checkpoint.manifestPath.length > 0 && !/[\r\n]/.test(checkpoint.manifestPath)))
    && (checkpoint.mergeCommit === undefined || isCommit(checkpoint.mergeCommit))
    && (checkpoint.intent === undefined || checkpoint.intent === null || (
      typeof checkpoint.intent === "object"
      && checkpoint.intent !== null
      && Object.keys(checkpoint.intent).every((key) => key === "effect" || key === "target")
      && typeof checkpoint.intent.effect === "string"
      && typeof checkpoint.intent.target === "string"
      && checkpoint.intent.effect.length > 0
      && checkpoint.intent.target.length > 0
    ))
    && (checkpoint.reconciliation === undefined || checkpoint.reconciliation === null || (
      typeof checkpoint.reconciliation === "object"
      && checkpoint.reconciliation !== null
      && Object.keys(checkpoint.reconciliation).every((key) => ["pullRequest", "originalCommit", "baseCommit"].includes(key))
      && Number.isInteger(checkpoint.reconciliation.pullRequest)
      && checkpoint.reconciliation.pullRequest > 0
      && isCommit(checkpoint.reconciliation.originalCommit)
      && checkpoint.reconciliation.originalCommit !== null
      && isCommit(checkpoint.reconciliation.baseCommit)
      && checkpoint.reconciliation.baseCommit !== null
    ))
    && (pullRequest === null || (typeof pullRequest === "number" && Number.isInteger(pullRequest) && pullRequest > 0))
    && typeof checkpoint.receipts === "object"
    && checkpoint.receipts !== null
    && !Array.isArray(checkpoint.receipts)
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
    const stored: unknown = await Bun.file(path).json();
    const value = withOwnerCli(stored, 1, 2);
    if (!isGitHubDeliveryCheckpoint(value)) throw new Error("Checkpoint GitHub invalido; no se sobrescribira");
    if (value !== stored) await this.write(value, workingDirectory);
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
