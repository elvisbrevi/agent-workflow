import { $ } from "bun";
import { unlink } from "node:fs/promises";

export interface AutocodeCheckpoint {
  workflow: "autocode";
  hu: number;
  ticket: number;
  sessionId: string | null;
}

export interface AutocodeCheckpointStore {
  read(): Promise<AutocodeCheckpoint | null>;
  write(checkpoint: AutocodeCheckpoint): Promise<void>;
  clear(): Promise<void>;
}

const FILE_NAME = "lazy-workflow/autocode-checkpoint.json";

function valid(value: unknown): value is AutocodeCheckpoint {
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

export class GitAutocodeCheckpointStore implements AutocodeCheckpointStore {
  private async path(): Promise<string> {
    return (await $`git rev-parse --git-path ${FILE_NAME}`.text()).trim();
  }

  async read(): Promise<AutocodeCheckpoint | null> {
    const file = Bun.file(await this.path());
    if (!await file.exists()) return null;
    const value: unknown = await file.json();
    return valid(value) ? value : null;
  }

  async write(checkpoint: AutocodeCheckpoint): Promise<void> {
    const path = await this.path();
    await Bun.$`mkdir -p ${path.substring(0, path.lastIndexOf("/"))}`;
    await Bun.write(path, `${JSON.stringify(checkpoint)}\n`);
  }

  async clear(): Promise<void> {
    const path = await this.path();
    try { await unlink(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
