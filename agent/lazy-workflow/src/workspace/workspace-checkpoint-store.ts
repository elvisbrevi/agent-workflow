import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export function isBranchRef(value: unknown): value is string {
  return typeof value === "string" && /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value)
    && !value.includes("..") && !value.includes("//");
}

export function areReceipts(value: unknown): value is Record<string, { verifiedAt: string }> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every((receipt) => typeof receipt === "object" && receipt !== null
      && Object.keys(receipt).length === 1 && typeof receipt.verifiedAt === "string"
      && Number.isFinite(Date.parse(receipt.verifiedAt)));
}

/**
 * Atomic write of one aggregate workspace manifest, re-read and re-validated afterwards so the
 * proof of a finished delivery is never a file nobody checked.
 */
export async function writeWorkspaceManifest<T>(
  manifest: T,
  stateDirectory: string,
  fileName: string,
  isManifest: (value: unknown) => value is T,
  label: string,
): Promise<void> {
  if (!isManifest(manifest)) throw new Error(`El manifest agregado del workspace ${label} es inválido`);
  const path = resolve(stateDirectory, fileName);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await Bun.write(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporaryPath, path);
  const written: unknown = await Bun.file(path).json();
  if (!isManifest(written)) throw new Error(`El manifest agregado del workspace ${label} no se pudo verificar tras escribirse`);
}

/**
 * Atomic read, validated write and clear of one workspace checkpoint file. A checkpoint that does
 * not validate is never overwritten, so a corrupted run stays inspectable.
 */
export abstract class WorkspaceCheckpointStore<T> {
  protected abstract readonly fileName: string;
  protected abstract readonly label: string;
  protected abstract isCheckpoint(value: unknown): value is T;

  private path(stateDirectory: string): string {
    return resolve(stateDirectory, this.fileName);
  }

  async read(stateDirectory: string): Promise<T | null> {
    const path = this.path(stateDirectory);
    if (!await Bun.file(path).exists()) return null;
    const value: unknown = await Bun.file(path).json();
    if (!this.isCheckpoint(value)) throw new Error(`Checkpoint ${this.label} inválido; no se sobrescribirá`);
    return value;
  }

  async write(checkpoint: T, stateDirectory: string): Promise<void> {
    if (!this.isCheckpoint(checkpoint)) throw new Error(`Checkpoint ${this.label} inválido`);
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
