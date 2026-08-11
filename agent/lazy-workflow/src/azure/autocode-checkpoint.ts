import { $ } from "bun";
import { unlink } from "node:fs/promises";

export interface AutocodeCheckpoint {
  workflow: "autocode";
  hu: number;
  ticket: number;
  sessionId: string | null;
}

export type AutocodePhase = "preflight-hu" | "selected" | "started" | "implementing" | "implementation-ready" | "integrating" | "evidencing" | "completing" | "cleaning" | "reconciling";

export type AutocodeEffect = "hu-integration-branch" | "ticket-selected" | "ticket-state" | "ticket-branch" | "pull-request" | "ticket-effort" | "ticket-completion";

export interface VersionedAutocodeCheckpoint {
  schemaVersion: 2;
  workflow: "autocode";
  phase: AutocodePhase;
  hu: number;
  ticket: number | null;
  integrationBranch: string | null;
  ticketBranch: string | null;
  azureRevision: number | null;
  effortBaseline: { real: number; realHours: number };
  activeDurationMs: number;
  activeSince: string | null;
  sessionId: string | null;
  intent: { effect: AutocodeEffect; target: string } | null;
  receipts: Partial<Record<AutocodeEffect, { verifiedAt: string }>>;
  manifestPath?: string | null;
  pullRequest?: number | null;
}

export type StoredAutocodeCheckpoint = AutocodeCheckpoint | VersionedAutocodeCheckpoint;

export interface AutocodeCheckpointStore {
  read(): Promise<StoredAutocodeCheckpoint | null>;
  write(checkpoint: StoredAutocodeCheckpoint): Promise<void>;
  clear(): Promise<void>;
}

const FILE_NAME = "lazy-workflow/autocode-checkpoint.json";
const EFFECTS: readonly AutocodeEffect[] = ["hu-integration-branch", "ticket-selected", "ticket-state", "ticket-branch", "pull-request", "ticket-effort", "ticket-completion"];

function validBranch(value: string | null): boolean {
  return value === null || (/^refs\/heads\/[^\s]+$/.test(value) && !value.includes("//"));
}

function validLegacy(value: unknown): value is AutocodeCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const sessionId = (value as AutocodeCheckpoint).sessionId;
  return (value as AutocodeCheckpoint).workflow === "autocode"
    && Number.isInteger((value as AutocodeCheckpoint).hu)
    && Number.isInteger((value as AutocodeCheckpoint).ticket)
    && (sessionId === null
      || (typeof sessionId === "string"
        && sessionId.trim().length > 0
        && !/[\r\n]/.test(sessionId)));
}

function validVersioned(value: unknown): value is VersionedAutocodeCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const checkpoint = value as Partial<VersionedAutocodeCheckpoint>;
  return checkpoint.schemaVersion === 2
    && checkpoint.workflow === "autocode"
     && (checkpoint.phase === "preflight-hu" || checkpoint.phase === "selected" || checkpoint.phase === "started" || checkpoint.phase === "implementing" || checkpoint.phase === "implementation-ready" || checkpoint.phase === "integrating" || checkpoint.phase === "evidencing" || checkpoint.phase === "completing" || checkpoint.phase === "cleaning" || checkpoint.phase === "reconciling")
    && Number.isInteger(checkpoint.hu)
    && (checkpoint.ticket === null || Number.isInteger(checkpoint.ticket))
    && (checkpoint.integrationBranch === null || (typeof checkpoint.integrationBranch === "string" && validBranch(checkpoint.integrationBranch)))
    && (checkpoint.ticketBranch === null || (typeof checkpoint.ticketBranch === "string" && validBranch(checkpoint.ticketBranch)))
    && (checkpoint.azureRevision === null || Number.isInteger(checkpoint.azureRevision))
    && typeof checkpoint.effortBaseline?.real === "number"
    && Number.isFinite(checkpoint.effortBaseline.real)
    && typeof checkpoint.effortBaseline?.realHours === "number"
    && Number.isFinite(checkpoint.effortBaseline.realHours)
    && typeof checkpoint.activeDurationMs === "number"
    && Number.isFinite(checkpoint.activeDurationMs)
    && (checkpoint.activeSince === null || typeof checkpoint.activeSince === "string")
    && (checkpoint.sessionId === null || (typeof checkpoint.sessionId === "string" && checkpoint.sessionId.trim().length > 0 && !/[\r\n]/.test(checkpoint.sessionId)))
    && (checkpoint.intent === null || (typeof checkpoint.intent === "object" && checkpoint.intent !== null && EFFECTS.includes(checkpoint.intent.effect) && typeof checkpoint.intent.target === "string" && checkpoint.intent.target.length > 0))
    && typeof checkpoint.receipts === "object"
    && checkpoint.receipts !== null
    && Object.entries(checkpoint.receipts).every(([effect, receipt]) => EFFECTS.includes(effect as AutocodeEffect)
      && typeof receipt?.verifiedAt === "string"
      && receipt.verifiedAt.length > 0);
}

export function isVersionedAutocodeCheckpoint(value: StoredAutocodeCheckpoint): value is VersionedAutocodeCheckpoint {
  return (value as VersionedAutocodeCheckpoint).schemaVersion === 2;
}

export function migrateAutocodeCheckpoint(value: unknown, now = Date.now()): VersionedAutocodeCheckpoint | null {
  if (validVersioned(value)) {
    if (!value.activeSince) return value;
    const started = Date.parse(value.activeSince);
    if (!Number.isFinite(started)) return { ...value, activeSince: null };
    return {
      ...value,
      activeDurationMs: value.activeDurationMs + Math.max(0, now - started),
      activeSince: null,
    };
  }
  if (typeof value === "object" && value !== null && "schemaVersion" in value) return null;
  if (!validLegacy(value)) return null;
  return {
    schemaVersion: 2,
    workflow: "autocode",
    phase: value.sessionId === null ? "reconciling" : "implementing",
    hu: value.hu,
    ticket: value.ticket,
    integrationBranch: null,
    ticketBranch: null,
    azureRevision: null,
    effortBaseline: { real: 0, realHours: 0 },
    activeDurationMs: 0,
    activeSince: null,
    sessionId: value.sessionId,
    intent: null,
    receipts: {},
  };
}

export class GitAutocodeCheckpointStore implements AutocodeCheckpointStore {
  private async path(): Promise<string> {
    return (await $`git rev-parse --git-path ${FILE_NAME}`.text()).trim();
  }

  async read(): Promise<StoredAutocodeCheckpoint | null> {
    const path = await this.path();
    const file = Bun.file(path);
    if (!await file.exists()) return null;
    const value: unknown = await file.json();
    const migrated = migrateAutocodeCheckpoint(value);
    if (!migrated) throw new Error("Checkpoint autocode invalido; no se sobrescribira");
    if (migrated && (!validVersioned(value) || (value.activeSince && migrated.activeSince === null))) {
      await Bun.write(path, `${JSON.stringify(migrated)}\n`);
    }
    return migrated;
  }

  async write(checkpoint: StoredAutocodeCheckpoint): Promise<void> {
    const path = await this.path();
    await Bun.$`mkdir -p ${path.substring(0, path.lastIndexOf("/"))}`;
    const normalized = isVersionedAutocodeCheckpoint(checkpoint)
      ? checkpoint
      : migrateAutocodeCheckpoint(checkpoint);
    if (!normalized || !validVersioned(normalized)) throw new Error("Checkpoint autocode invalido");
    await Bun.write(path, `${JSON.stringify(normalized)}\n`);
  }

  async clear(): Promise<void> {
    const path = await this.path();
    try { await unlink(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
