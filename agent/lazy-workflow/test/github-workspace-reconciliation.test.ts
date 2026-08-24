import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { AgentResult } from "../src/coding-agent/agent-result.ts";
import type { GitHubCheckpointStore } from "../src/github/github-delivery-checkpoint.ts";
import { GitHubPullRequestConflictError, type GitHubDeliveryAdapter } from "../src/github/github-delivery-service.ts";

test("cierra un workspace con el manifest reconciliado del repositorio conflictivo", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-workspace-reconciliation-"));
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  await Bun.$`mkdir -p ${repoA} ${repoB}`;
  const originalCommit = "a".repeat(40);
  const baseCommit = "d".repeat(40);
  const reconciledCommit = "e".repeat(40);
  const events: string[] = [];
  let reconciled = false;
  let runs = 0;
  let deliveredEvidence: Parameters<NonNullable<GitHubDeliveryAdapter["closeIssue"]>>[4];
  const manifest = (commit: string, evidencePath: string) => ({
    issue: 188,
    branch: "refs/heads/issue/188",
    commit,
    validation: [{ command: "bun test", result: "passed" }],
    clean: true,
    summary: "changed",
    evidence: [{ path: evidencePath, sha256: createHash("sha256").update(evidencePath).digest("hex") }],
  });
  const git = async (args: string[], directory: string) => {
    if (args[0] === "rev-parse" && args[1] === "HEAD^{commit}") return "c".repeat(40);
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "remote") return `git@github.com:owner/${basename(directory)}.git`;
    return "";
  };
  const delivery: GitHubDeliveryAdapter = {
    verifyRepository: async () => undefined,
    prepareBranch: async (issue, workingDirectory) => ({ branch: `refs/heads/issue/${issue}`, baseBranch: "refs/heads/main", manifestPath: join(workingDirectory, "manifest.json") }),
    readManifest: async (path) => path.includes("repo-a")
      ? manifest(reconciled ? reconciledCommit : originalCommit, reconciled ? "reconciled-evidence.txt" : "original-evidence.txt")
      : manifest("b".repeat(40), "repo-b-evidence.txt"),
    pushCommit: async (_branch, commit, workingDirectory) => { events.push(`push:${basename(workingDirectory)}:${commit}`); },
    createOrReusePullRequest: async (_issue, _branch, _base, _commit, workingDirectory) => ({ number: basename(workingDirectory) === "repo-a" ? 1 : 2 }),
    preparePullRequestReconciliation: async (_branch, _base, commit, workingDirectory) => {
      expect(commit).toBe(originalCommit);
      expect(basename(workingDirectory)).toBe("repo-a");
      events.push("prepare:repo-a");
      return { baseCommit };
    },
    verifyPullRequestReconciliation: async (branch, original, base, commit, workingDirectory) => {
      expect({ branch, original, base, commit, directory: basename(workingDirectory) }).toEqual({
        branch: "refs/heads/issue/188",
        original: originalCommit,
        base: baseCommit,
        commit: reconciledCommit,
        directory: "repo-a",
      });
      events.push("verify:repo-a");
    },
    mergePullRequest: async (pullRequest, _issue, _branch, _base, _commit, workingDirectory) => {
      events.push(`merge:${basename(workingDirectory)}`);
      if (basename(workingDirectory) === "repo-a" && !reconciled) throw new GitHubPullRequestConflictError(pullRequest);
      return { number: pullRequest, mergeCommit: `${pullRequest}`.repeat(40) };
    },
    closeIssue: async (_issue, _pullRequest, _mergeCommit, _workingDirectory, evidence) => {
      events.push("close");
      deliveredEvidence = evidence;
    },
    cleanupBranch: async (_branch, _base, commit, workingDirectory) => { events.push(`cleanup:${basename(workingDirectory)}:${commit}`); },
  };
  const issue = { number: 188, title: "workspace", state: "OPEN", labels: [{ name: "ready-for-agent" }], assignees: [], createdAt: "2026-01-01", blockedBy: { nodes: [] } };
  const queue = {
    selectEligibleIssue: async () => ({ kind: "candidate" as const, issue, repository: { nameWithOwner: "owner/repo-a" } }),
    claimSelectedIssue: async () => ({ ...issue, body: "body", comments: [] }),
    reconcileClaimedIssue: async () => ({ ...issue, body: "body", comments: [] }),
    selectAndClaimEligibleIssue: async () => ({ kind: "empty" as const }),
  };
  const checkpointStore: GitHubCheckpointStore = { read: async () => null, write: async () => undefined, clear: async () => undefined };
  const cli = new LazyWorkflowCli(
    { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    {
      run: async () => {
        runs += 1;
        if (runs === 1) {
          for (const repository of [repoA, repoB]) {
            await Bun.write(join(repository, "manifest.json"), "{}\n");
            await Bun.write(join(repository, "evidence.txt"), "evidence");
          }
        } else {
          reconciled = true;
        }
        return { result: AgentResult.fromJsonLines(JSON.stringify({ type: "text", sessionID: `ses-${runs}`, part: { type: "text", text: "IMPLEMENTATION_READY" } })), azureLoginRequired: false };
      },
      resume: async () => { throw new Error("must not resume"); },
    },
    undefined, undefined, undefined, undefined, undefined, git,
    undefined, undefined, undefined, undefined, undefined,
    queue,
    checkpointStore,
    { acquire: async () => async () => undefined },
    delivery,
  );
  try {
    expect(await cli.run(["code", "--working-directory", `${repoA},${repoB}`])).toBe(0);
    expect(runs).toBe(2);
    expect(events).toContain("prepare:repo-a");
    expect(events).toContain("verify:repo-a");
    expect(events.indexOf("close")).toBeGreaterThan(events.indexOf("merge:repo-b"));
    expect(deliveredEvidence).toEqual([
      { manifest: manifest(reconciledCommit, "reconciled-evidence.txt"), directory: await realpath(repoA), commit: "1".repeat(40) },
      { manifest: manifest("b".repeat(40), "repo-b-evidence.txt"), directory: await realpath(repoB), commit: "2".repeat(40) },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
