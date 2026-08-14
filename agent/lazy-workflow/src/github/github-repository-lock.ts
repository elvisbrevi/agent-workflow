import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runGit, type GitRunner } from "../git/git-ticket-branch-cleaner.ts";

export interface GitHubRepositoryLockBoundary {
  acquire(workingDirectory?: string): Promise<() => Promise<void>>;
}

const LOCK_NAME = "lazy-workflow/github-code.lock";

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class GitHubRepositoryLockService implements GitHubRepositoryLockBoundary {
  constructor(private readonly git: GitRunner = runGit) {}

  private async path(workingDirectory = process.cwd()): Promise<string> {
    return resolve(workingDirectory, (await this.git(["rev-parse", "--git-path", LOCK_NAME], workingDirectory)).trim());
  }

  async acquire(workingDirectory?: string): Promise<() => Promise<void>> {
    const path = await this.path(workingDirectory);
    await mkdir(dirname(path), { recursive: true });
    try {
      await mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const ownerPath = join(path, "owner.json");
        try {
          const owner = await Bun.file(ownerPath).json() as { pid?: unknown };
          if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && !(await processIsAlive(owner.pid))) {
            await rm(path, { recursive: true, force: false });
            return this.acquire(workingDirectory);
          }
        } catch {
          // An incomplete or unreadable lock is ambiguous; do not remove it.
        }
        throw new Error("el repositorio ya esta bloqueado por otra ejecucion de GitHub");
      }
      throw error;
    }
    await Bun.write(join(path, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`);

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await rm(path, { recursive: true, force: false });
    };
  }
}
