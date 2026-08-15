import type { GitHubCheckpointStore, GitHubDeliveryCheckpoint } from "../../src/github/github-delivery-checkpoint.ts";
import type { GitHubDeliveryAdapter, GitHubReadyManifest } from "../../src/github/github-delivery-service.ts";
import type { GitHubRepositoryLockBoundary } from "../../src/github/github-repository-lock.ts";

/**
 * Minimal reusable GitHub delivery stub: `prepareBranch` fixes an
 * issue/branch pair that `readManifest` then echoes back, so a caller only
 * needs to override the calls it wants to fail or observe.
 */
export function fakeGitHubDelivery(overrides: Partial<GitHubDeliveryAdapter> = {}): GitHubDeliveryAdapter {
  let prepared: { issue: number; branch: string; baseBranch: string; manifestPath: string } | null = null;
  return {
    async prepareBranch(issue) {
      prepared = {
        issue,
        branch: `refs/heads/issue/${issue}`,
        baseBranch: "refs/heads/main",
        manifestPath: `/tmp/lazy-workflow-fake-manifest-${issue}.json`,
      };
      return { branch: prepared.branch, baseBranch: prepared.baseBranch, manifestPath: prepared.manifestPath };
    },
    async readManifest(): Promise<GitHubReadyManifest> {
      if (!prepared) throw new Error("readManifest llamado antes de prepareBranch");
      return {
        issue: prepared.issue,
        branch: prepared.branch,
        commit: "a".repeat(40),
        validation: [{ command: "bun test", result: "ok" }],
        clean: true,
        summary: "entrega completada",
      };
    },
    async pushCommit() {},
    async createOrReusePullRequest() { return { number: 1 }; },
    async mergePullRequest() { return { number: 1, mergeCommit: "b".repeat(40) }; },
    async closeIssue() {},
    async cleanupBranch() {},
    ...overrides,
  };
}

export function fakeGitHubCheckpointStore(): GitHubCheckpointStore {
  let current: GitHubDeliveryCheckpoint | null = null;
  return {
    read: async () => current,
    write: async (value) => { current = value; },
    clear: async () => { current = null; },
  };
}

export function fakeGitHubRepositoryLock(): GitHubRepositoryLockBoundary {
  return { acquire: async () => async () => undefined };
}

/** The store/lock/delivery trio a coordinated `code` run always needs together. */
export function fakeCoordinatedGitHubDeps(): [GitHubCheckpointStore, GitHubRepositoryLockBoundary, GitHubDeliveryAdapter] {
  return [fakeGitHubCheckpointStore(), fakeGitHubRepositoryLock(), fakeGitHubDelivery()];
}
