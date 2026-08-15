import { isAgentCli, withOwnerCli, type AgentCli } from "../coding-agent/agent-cli.ts";
import { areReceipts, isBranchRef, WorkspaceCheckpointStore, writeWorkspaceManifest } from "../workspace/workspace-checkpoint-store.ts";

export const GITHUB_WORKSPACE_PHASES = [
  "selected",
  "started",
  "implementing",
  "implementation-ready",
  "integrating",
  "conflict-resolving",
  "reconciling",
  "cleaning",
] as const;

export type GitHubWorkspacePhase = typeof GITHUB_WORKSPACE_PHASES[number];

export interface GitHubWorkspaceUnit {
  path: string;
  remote: string;
  repository: string;
  branch: string;
  baseBranch: string | null;
  manifestPath: string;
  changed: boolean | null;
  startingCommit: string;
  commit: string | null;
  evidence: Array<{ path: string; sha256: string }>;
  pullRequest: number | null;
  mergeCommit: string | null;
  phase: GitHubWorkspacePhase;
  receipts: Record<string, { verifiedAt: string }>;
}

export interface GitHubWorkspaceCheckpoint {
  schemaVersion: 2;
  /** The coding agent CLI owning `sessionId`, so recovery resumes against it (ADR-0023). */
  cli: AgentCli;
  workflow: "github-workspace-code";
  issue: number;
  phase: GitHubWorkspacePhase;
  sessionId: string | null;
  branch: string;
  parentDirectory: string;
  repositories: Array<{ path: string; remote: string; repository: string }>;
  units: GitHubWorkspaceUnit[];
  receipts: Record<string, { verifiedAt: string }>;
  intent: { effect: string; target: string } | null;
  reconciliation?: { path: string; pullRequest: number; originalCommit: string; baseCommit: string } | null;
}

const FILE_NAME = "github-workspace-code-checkpoint.json";


function validCommit(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[0-9a-f]{40,64}$/i.test(value));
}


function validEvidence(value: unknown): value is Array<{ path: string; sha256: string }> {
  return Array.isArray(value) && value.every((entry) =>
    typeof entry?.path === "string" && entry.path.length > 0 && typeof entry.sha256 === "string" && entry.sha256.length > 0
  );
}

function validUnit(value: unknown): value is GitHubWorkspaceUnit {
  if (typeof value !== "object" || value === null) return false;
  const unit = value as Partial<GitHubWorkspaceUnit>;
  return typeof unit.path === "string"
    && typeof unit.remote === "string" && unit.remote.length > 0
    && typeof unit.repository === "string"
    && isBranchRef(unit.branch)
    && (unit.baseBranch === null || isBranchRef(unit.baseBranch))
    && typeof unit.manifestPath === "string"
    && (unit.changed === null || typeof unit.changed === "boolean")
    && /^[0-9a-f]{40,64}$/i.test(unit.startingCommit ?? "")
    && validCommit(unit.commit)
    && validEvidence(unit.evidence)
    && (unit.pullRequest === null || (typeof unit.pullRequest === "number" && Number.isInteger(unit.pullRequest) && unit.pullRequest > 0))
    && validCommit(unit.mergeCommit)
    && GITHUB_WORKSPACE_PHASES.includes(unit.phase as GitHubWorkspacePhase)
    && areReceipts(unit.receipts);
}

export function isGitHubWorkspaceCheckpoint(value: unknown): value is GitHubWorkspaceCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const checkpoint = value as Partial<GitHubWorkspaceCheckpoint>;
  const repositories = checkpoint.repositories;
  const units = checkpoint.units;
  return checkpoint.schemaVersion === 2
    && isAgentCli(checkpoint.cli)
    && checkpoint.workflow === "github-workspace-code"
    && Number.isInteger(checkpoint.issue) && (checkpoint.issue ?? 0) > 0
    && GITHUB_WORKSPACE_PHASES.includes(checkpoint.phase as GitHubWorkspacePhase)
    && (checkpoint.sessionId === null || typeof checkpoint.sessionId === "string")
    && isBranchRef(checkpoint.branch)
    && typeof checkpoint.parentDirectory === "string" && checkpoint.parentDirectory.length > 0
    && Array.isArray(repositories) && repositories.length > 0
    && repositories.every((entry) => typeof entry?.path === "string" && typeof entry.remote === "string" && typeof entry.repository === "string" && entry.path.length > 0 && entry.remote.length > 0 && entry.repository.length > 0)
    && Array.isArray(units) && units.length <= repositories.length
    && units.every(validUnit)
    && areReceipts(checkpoint.receipts)
    && (checkpoint.intent === null || (typeof checkpoint.intent === "object" && typeof checkpoint.intent.effect === "string" && typeof checkpoint.intent.target === "string" && checkpoint.intent.effect.length > 0 && checkpoint.intent.target.length > 0))
    && (checkpoint.reconciliation === undefined || checkpoint.reconciliation === null || (
      typeof checkpoint.reconciliation === "object"
      && typeof checkpoint.reconciliation.path === "string"
      && checkpoint.reconciliation.path.length > 0
      && Number.isInteger(checkpoint.reconciliation.pullRequest)
      && checkpoint.reconciliation.pullRequest > 0
      && /^[0-9a-f]{40,64}$/i.test(checkpoint.reconciliation.originalCommit)
      && /^[0-9a-f]{40,64}$/i.test(checkpoint.reconciliation.baseCommit)
    ));
}

export interface GitHubWorkspaceManifest {
  issue: number;
  branch: string;
  repositories: GitHubWorkspaceUnit[];
  summary: string;
  clean: true;
}

export function isGitHubWorkspaceManifest(value: unknown): value is GitHubWorkspaceManifest {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as Partial<GitHubWorkspaceManifest>;
  return Number.isInteger(manifest.issue) && (manifest.issue ?? 0) > 0
    && isBranchRef(manifest.branch)
    && Array.isArray(manifest.repositories) && manifest.repositories.length > 0
    && manifest.repositories.every(validUnit)
    && typeof manifest.summary === "string" && manifest.summary.trim().length > 0
    && manifest.clean === true;
}

const MANIFEST_FILE_NAME = "github-workspace-manifest.json";

export async function writeGitHubWorkspaceManifest(manifest: GitHubWorkspaceManifest, stateDirectory: string): Promise<void> {
  await writeWorkspaceManifest(manifest, stateDirectory, MANIFEST_FILE_NAME, isGitHubWorkspaceManifest, "GitHub");
}

export class GitHubWorkspaceCheckpointStore extends WorkspaceCheckpointStore<GitHubWorkspaceCheckpoint> {
  protected readonly fileName = FILE_NAME;
  protected readonly label = "GitHub workspace";
  protected isCheckpoint = isGitHubWorkspaceCheckpoint;

  protected override upgrade(value: unknown): unknown {
    return withOwnerCli(value, 1, 2);
  }
}
