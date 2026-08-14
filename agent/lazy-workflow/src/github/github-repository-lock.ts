import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runGit, type GitRunner } from "../git/git-ticket-branch-cleaner.ts";

export interface GitHubRepositoryLockBoundary {
  acquire(workingDirectory?: string): Promise<() => Promise<void>>;
}

const LOCK_NAME = "lazy-workflow/github-code.lock";

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
        throw new Error("el repositorio ya esta bloqueado por otra ejecucion de GitHub");
      }
      throw error;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await rm(path, { recursive: true, force: false });
    };
  }
}
