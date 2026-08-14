import { areReceipts, isBranchRef, WorkspaceCheckpointStore, writeWorkspaceManifest } from "../workspace/workspace-checkpoint-store.ts";

export const AZURE_WORKSPACE_PHASES = [
  "started",
  "implementing",
  "implementation-ready",
  "integrating",
  "completing",
  "cleaning",
] as const;

export type AzureWorkspacePhase = typeof AZURE_WORKSPACE_PHASES[number];

export interface AzureWorkspaceCheckpointUnit {
  path: string;
  remote: string;
  repository: string;
  project: string;
  changed: boolean | null;
  commit: string | null;
  pullRequest: number | null;
  mergeCommit: string | null;
  receipts: Record<string, { verifiedAt: string }>;
}

export interface AzureWorkspaceCheckpoint {
  schemaVersion: 1;
  workflow: "azure-workspace-code";
  hu: number;
  ticket: number;
  phase: AzureWorkspacePhase;
  sessionId: string | null;
  integrationBranch: string;
  ticketBranch: string;
  parentDirectory: string;
  activeDurationMs: number;
  /** Repository owning the ticket's single native Branch ArtifactLink; the first changed one. */
  primaryRepository?: string | null;
  repositories: Array<{ path: string; remote: string }>;
  units: AzureWorkspaceCheckpointUnit[];
  receipts: Record<string, { verifiedAt: string }>;
  intent: { effect: string; target: string } | null;
}

function validUnit(value: unknown): value is AzureWorkspaceCheckpointUnit {
  if (typeof value !== "object" || value === null) return false;
  const unit = value as Partial<AzureWorkspaceCheckpointUnit>;
  return typeof unit.path === "string" && unit.path.length > 0
    && typeof unit.remote === "string" && unit.remote.length > 0
    && typeof unit.repository === "string" && unit.repository.length > 0
    && typeof unit.project === "string" && unit.project.length > 0
    && (unit.changed === null || typeof unit.changed === "boolean")
    && (unit.commit === null || (typeof unit.commit === "string" && /^[0-9a-f]{40,64}$/i.test(unit.commit)))
    && (unit.pullRequest === null || (Number.isInteger(unit.pullRequest) && (unit.pullRequest ?? 0) > 0))
    && (unit.mergeCommit === null || (typeof unit.mergeCommit === "string" && unit.mergeCommit.length > 0))
    && areReceipts(unit.receipts);
}

export function isAzureWorkspaceCheckpoint(value: unknown): value is AzureWorkspaceCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const checkpoint = value as Partial<AzureWorkspaceCheckpoint>;
  const repositories = checkpoint.repositories;
  const units = checkpoint.units;
  return checkpoint.schemaVersion === 1
    && checkpoint.workflow === "azure-workspace-code"
    && Number.isInteger(checkpoint.hu) && (checkpoint.hu ?? 0) > 0
    && Number.isInteger(checkpoint.ticket) && (checkpoint.ticket ?? 0) > 0
    && AZURE_WORKSPACE_PHASES.includes(checkpoint.phase as AzureWorkspacePhase)
    && (checkpoint.sessionId === null || (typeof checkpoint.sessionId === "string" && checkpoint.sessionId.length > 0))
    && isBranchRef(checkpoint.integrationBranch)
    && isBranchRef(checkpoint.ticketBranch)
    && typeof checkpoint.parentDirectory === "string" && checkpoint.parentDirectory.length > 0
    && typeof checkpoint.activeDurationMs === "number" && Number.isFinite(checkpoint.activeDurationMs) && checkpoint.activeDurationMs >= 0
    && (checkpoint.primaryRepository === undefined || checkpoint.primaryRepository === null
      || (typeof checkpoint.primaryRepository === "string" && checkpoint.primaryRepository.length > 0))
    && Array.isArray(repositories) && repositories.length > 0
    && repositories.every((entry) => typeof entry?.path === "string" && entry.path.length > 0
      && typeof entry.remote === "string" && entry.remote.length > 0)
    && Array.isArray(units) && units.length <= repositories.length && units.every(validUnit)
    && areReceipts(checkpoint.receipts)
    && (checkpoint.intent === null || (typeof checkpoint.intent === "object" && checkpoint.intent !== null
      && typeof checkpoint.intent.effect === "string" && checkpoint.intent.effect.length > 0
      && typeof checkpoint.intent.target === "string" && checkpoint.intent.target.length > 0));
}

/**
 * Proof that a whole transversal delivery landed. Written once the checkpoint is about to be
 * cleared, so the per-repository receipts it carries outlive the checkpoint itself.
 */
export interface AzureWorkspaceManifest {
  hu: number;
  ticket: number;
  integrationBranch: string;
  ticketBranch: string;
  primaryRepository: string;
  repositories: AzureWorkspaceCheckpointUnit[];
  summary: string;
  clean: true;
}

export function isAzureWorkspaceManifest(value: unknown): value is AzureWorkspaceManifest {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as Partial<AzureWorkspaceManifest>;
  return Number.isInteger(manifest.hu) && (manifest.hu ?? 0) > 0
    && Number.isInteger(manifest.ticket) && (manifest.ticket ?? 0) > 0
    && isBranchRef(manifest.integrationBranch)
    && isBranchRef(manifest.ticketBranch)
    && typeof manifest.primaryRepository === "string" && manifest.primaryRepository.length > 0
    && Array.isArray(manifest.repositories) && manifest.repositories.length > 0
    && manifest.repositories.every(validUnit)
    && typeof manifest.summary === "string" && manifest.summary.trim().length > 0
    && manifest.clean === true;
}

const MANIFEST_FILE_NAME = "azure-workspace-manifest.json";

export async function writeAzureWorkspaceManifest(manifest: AzureWorkspaceManifest, stateDirectory: string): Promise<void> {
  await writeWorkspaceManifest(manifest, stateDirectory, MANIFEST_FILE_NAME, isAzureWorkspaceManifest, "Azure");
}

export class AzureWorkspaceCheckpointStore extends WorkspaceCheckpointStore<AzureWorkspaceCheckpoint> {
  protected readonly fileName = "azure-workspace-code-checkpoint.json";
  protected readonly label = "Azure workspace";
  protected isCheckpoint = isAzureWorkspaceCheckpoint;
}
