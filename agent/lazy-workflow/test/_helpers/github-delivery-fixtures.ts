import type { GitHubCheckpointStore, GitHubDeliveryCheckpoint } from "../../src/github/github-delivery-checkpoint.ts";
import type { GitHubDeliveryAdapter } from "../../src/github/github-delivery-service.ts";
import type { GitHubRepositoryLockBoundary } from "../../src/github/github-repository-lock.ts";

/**
 * Minimal reusable GitHub delivery stub: `prepareBranch` fixes the issue's
 * branch pair and `verifySession` answers the commit git would have found, so a
 * caller only needs to override the calls it wants to fail or observe.
 */
export function fakeGitHubDelivery(overrides: Partial<GitHubDeliveryAdapter> = {}): GitHubDeliveryAdapter {
  let prepared: { issue: number; branch: string; baseBranch: string } | null = null;
  return {
    async prepareBranch(issue) {
      prepared = { issue, branch: `refs/heads/issue/${issue}`, baseBranch: "refs/heads/main" };
      return { branch: prepared.branch, baseBranch: prepared.baseBranch };
    },
    async verifySession() {
      if (!prepared) throw new Error("verifySession llamado antes de prepareBranch");
      return { commit: "a".repeat(40) };
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

/**
 * The store/lock/delivery trio a coordinated `code` run always needs together,
 * named as the boundaries they are so a test spreads them into `createCli`.
 */
export function fakeCoordinatedGitHubDeps(): {
  githubCheckpointStore: GitHubCheckpointStore;
  githubRepositoryLock: GitHubRepositoryLockBoundary;
  githubDelivery: GitHubDeliveryAdapter;
} {
  return {
    githubCheckpointStore: fakeGitHubCheckpointStore(),
    githubRepositoryLock: fakeGitHubRepositoryLock(),
    githubDelivery: fakeGitHubDelivery(),
  };
}
