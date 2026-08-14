import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { OpenCodeResult } from "../src/opencode/open-code-result.ts";
import type { GitHubCheckpointStore } from "../src/github/github-delivery-checkpoint.ts";
import { GitHubPullRequestConflictError, type GitHubDeliveryAdapter } from "../src/github/github-delivery-service.ts";
import type { GitHubRepositoryLockBoundary } from "../src/github/github-repository-lock.ts";
import type { GitRunner } from "../src/git/git-ticket-branch-cleaner.ts";

test("entrega un workspace GitHub en orden y ejecuta OpenCode una sola vez", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-workspace-"));
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  await Bun.$`mkdir -p ${repoA} ${repoB}`;
  const events: string[] = [];
  let prompt = "";
  const git: GitRunner = async (args, directory) => {
    if (args[0] === "rev-parse" && args[1] === "HEAD^{commit}") return "c".repeat(40);
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "remote") return `git@github.com:owner/${basename(directory)}.git`;
    return "";
  };
  const delivery: GitHubDeliveryAdapter = {
    prepareBranch: async (issue, workingDirectory) => {
      events.push(`prepare:${basename(workingDirectory)}`);
      return { branch: `refs/heads/issue/${issue}`, baseBranch: "refs/heads/main", manifestPath: join(workingDirectory, "manifest.json") };
    },
    readManifest: async (path) => ({ issue: 188, branch: "refs/heads/issue/188", commit: path.includes("repo-a") ? "a".repeat(40) : "b".repeat(40), validation: [{ command: "bun test", result: "passed" }], clean: true, summary: "changed", evidence: [{ path: "evidence.txt", sha256: createHash("sha256").update("evidence").digest("hex") }] }),
    pushCommit: async (_branch, _commit, workingDirectory) => { events.push(`push:${basename(workingDirectory)}`); },
    createOrReusePullRequest: async (_issue, _branch, _base, _commit, workingDirectory) => { events.push(`pr:${basename(workingDirectory)}`); return { number: basename(workingDirectory) === "repo-a" ? 1 : 2 }; },
    mergePullRequest: async (pullRequest, _issue, _branch, _base, _commit, workingDirectory) => { events.push(`merge:${basename(workingDirectory)}`); return { number: pullRequest, mergeCommit: `${pullRequest}`.repeat(40) }; },
    closeIssue: async () => { events.push("close"); },
    cleanupBranch: async (_branch, _base, _commit, workingDirectory) => { events.push(`cleanup:${basename(workingDirectory)}`); },
  };
  const checkpointStore: GitHubCheckpointStore = { read: async () => null, write: async () => undefined, clear: async () => undefined };
  const lock: GitHubRepositoryLockBoundary = { acquire: async (workingDirectory) => { events.push(`lock:${basename(workingDirectory!)}`); return async () => { events.push(`unlock:${basename(workingDirectory!)}`); }; } };
  const issue = { number: 188, title: "workspace", state: "OPEN", labels: [{ name: "ready-for-agent" }], assignees: [], createdAt: "2026-01-01", blockedBy: { nodes: [] } };
  const queue = {
    selectEligibleIssue: async () => ({ kind: "candidate" as const, issue, repository: { nameWithOwner: "owner/repo-a" } }),
    claimSelectedIssue: async () => ({ ...issue, body: "body", comments: [] }),
    selectAndClaimEligibleIssue: async () => ({ kind: "empty" as const }),
  };
  const cli = new LazyWorkflowCli(
    { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    { run: async (options) => {
      prompt = options.prompt;
      for (const repository of [repoA, repoB]) {
        await Bun.write(join(repository, "manifest.json"), "{}\n");
        await Bun.write(join(repository, "evidence.txt"), "evidence");
      }
      return { result: OpenCodeResult.fromJsonLines(JSON.stringify({ type: "text", sessionID: "ses-workspace", part: { type: "text", text: "IMPLEMENTATION_READY" } })), azureLoginRequired: false };
    }, resume: async () => { throw new Error("must not resume"); } },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    git,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    queue,
    checkpointStore,
    lock,
    delivery,
  );
  try {
    expect(await cli.run(["code", "--working-directory", `${repoA}, ${repoB}`])).toBe(0);
    expect(prompt).toContain(`${repoA}`);
    expect(prompt).toContain(`${repoB}`);
    expect(events.filter((event) => event.startsWith("prepare:"))).toEqual(["prepare:repo-a", "prepare:repo-b"]);
    expect(events.filter((event) => event.startsWith("push:"))).toEqual(["push:repo-a", "push:repo-b"]);
    expect(events.indexOf("close")).toBeGreaterThan(events.indexOf("merge:repo-b"));
    expect(events.filter((event) => event.startsWith("lock:"))).toEqual(["lock:repo-a", "lock:repo-b"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconcilia serialmente un PR conflictivo dentro del workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-workspace-conflict-"));
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  await Bun.$`mkdir -p ${repoA} ${repoB}`;
  const originalCommit = "a".repeat(40);
  const baseCommit = "d".repeat(40);
  const reconciledCommit = "e".repeat(40);
  const events: string[] = [];
  let reconciled = false;
  let runs = 0;
  let resumes = 0;
  const git: GitRunner = async (args, directory) => {
    if (args[0] === "rev-parse" && args[1] === "HEAD^{commit}") return "c".repeat(40);
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "remote") return `git@github.com:owner/${basename(directory)}.git`;
    return "";
  };
  const delivery: GitHubDeliveryAdapter = {
    verifyRepository: async () => undefined,
    prepareBranch: async (issue, workingDirectory) => ({ branch: `refs/heads/issue/${issue}`, baseBranch: "refs/heads/main", manifestPath: join(workingDirectory, "manifest.json") }),
    readManifest: async (path) => ({ issue: 188, branch: "refs/heads/issue/188", commit: path.includes("repo-a") ? (reconciled ? reconciledCommit : originalCommit) : "b".repeat(40), validation: [{ command: "bun test", result: "passed" }], clean: true, summary: "changed", evidence: [{ path: "evidence.txt", sha256: createHash("sha256").update("evidence").digest("hex") }] }),
    pushCommit: async (_branch, commit, workingDirectory) => { events.push(`push:${basename(workingDirectory)}:${commit}`); },
    createOrReusePullRequest: async (_issue, _branch, _base, _commit, workingDirectory) => ({ number: basename(workingDirectory) === "repo-a" ? 1 : 2 }),
    preparePullRequestReconciliation: async () => { events.push("prepare:repo-a"); return { baseCommit }; },
    verifyPendingPullRequestReconciliation: async () => { events.push("verify-pending:repo-a"); },
    verifyPullRequestReconciliation: async () => { events.push("verify:repo-a"); },
    mergePullRequest: async (pullRequest, _issue, _branch, _base, _commit, workingDirectory) => {
      events.push(`merge:${basename(workingDirectory)}`);
      if (basename(workingDirectory) === "repo-a" && !reconciled) throw new GitHubPullRequestConflictError(pullRequest);
      return { number: pullRequest, mergeCommit: `${pullRequest}`.repeat(40) };
    },
    closeIssue: async () => { events.push("close"); },
    cleanupBranch: async (_branch, _base, commit, workingDirectory) => { events.push(`cleanup:${basename(workingDirectory)}:${commit}`); },
  };
  const issue = { number: 188, title: "workspace", state: "OPEN", labels: [{ name: "ready-for-agent" }], assignees: [], createdAt: "2026-01-01", blockedBy: { nodes: [] } };
  const queue = {
    selectEligibleIssue: async () => ({ kind: "candidate" as const, issue, repository: { nameWithOwner: "owner/repo-a" } }),
    claimSelectedIssue: async () => ({ ...issue, body: "body", comments: [] }),
    reconcileClaimedIssue: async () => ({ ...issue, body: "body", comments: [] }),
    selectAndClaimEligibleIssue: async () => ({ kind: "empty" as const }),
  };
  const cli = new LazyWorkflowCli(
    { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    {
      run: async (options) => {
        runs += 1;
        if (runs === 1) {
          for (const repository of [repoA, repoB]) {
            await Bun.write(join(repository, "manifest.json"), "{}\n");
            await Bun.write(join(repository, "evidence.txt"), "evidence");
          }
        } else {
          expect(options.prompt).toContain(baseCommit);
          expect(options.prompt).toContain("Coordinator-fixed pull request: #1");
        }
        return { result: OpenCodeResult.fromJsonLines(JSON.stringify({ type: "text", sessionID: `ses-${runs}`, part: { type: "text", text: runs === 2 ? "still working" : "IMPLEMENTATION_READY" } })), azureLoginRequired: false };
      },
      resume: async (session, prompt) => {
        resumes += 1;
        expect(session).toBe("ses-2");
        expect(prompt).toContain(baseCommit);
        expect(prompt).toContain("Coordinator-fixed pull request: #1");
        reconciled = true;
        return OpenCodeResult.fromJsonLines(JSON.stringify({ type: "text", sessionID: session, part: { type: "text", text: "IMPLEMENTATION_READY" } }));
      },
    },
    undefined, undefined, undefined, undefined, undefined, git,
    undefined, undefined, undefined, undefined, undefined,
    queue,
    { read: async () => null, write: async () => undefined, clear: async () => undefined },
    { acquire: async () => async () => undefined },
    delivery,
  );
  try {
    expect(await cli.run(["code", "--working-directory", `${repoA},${repoB}`])).toBe(1);
    expect(await cli.run(["code", "--working-directory", `${repoA},${repoB}`])).toBe(0);
    expect(runs).toBe(2);
    expect(resumes).toBe(1);
    expect(events).toContain("prepare:repo-a");
    expect(events).toContain("verify-pending:repo-a");
    expect(events).toContain("verify:repo-a");
    expect(events).toContain(`cleanup:repo-a:${reconciledCommit}`);
    expect(events.indexOf("merge:repo-b")).toBeGreaterThan(events.lastIndexOf("merge:repo-a"));
    expect(events.indexOf("close")).toBeGreaterThan(events.indexOf("merge:repo-b"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
