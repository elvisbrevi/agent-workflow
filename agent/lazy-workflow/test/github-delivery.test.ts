import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import {
  GitHubDeliveryService,
  GitHubPullRequestConflictError,
  type GitHubDeliveryAdapter,
  type GitHubReadyManifest,
} from "../src/github/github-delivery-service.ts";
import type { GitHubParentReconciliationAdapter } from "../src/github/github-parent-reconciliation-service.ts";
import type { GitHubCheckpointStore, GitHubDeliveryCheckpoint } from "../src/github/github-delivery-checkpoint.ts";
import { OpenCodeResult } from "../src/opencode/open-code-result.ts";
import { fakeSelectedIssue } from "./_helpers/managed-queue-fixtures.ts";

function execution() {
  return {
    result: OpenCodeResult.fromJsonLines(JSON.stringify({
      type: "text",
      sessionID: "ses_179",
      part: { type: "text", text: "IMPLEMENTATION_READY" },
    })),
    azureLoginRequired: false,
    failed: false,
  };
}

function phaseOf(checkpoint: GitHubDeliveryCheckpoint | null): string | undefined {
  return checkpoint?.phase;
}

test("checkout de recuperación cambia a la rama local exacta sin crearla", async () => {
  const commands: string[][] = [];
  const delivery = new GitHubDeliveryService(
    async () => { throw new Error("must not use GitHub"); },
    async (command) => {
      commands.push(command);
      if (command[0] === "rev-parse" || command[0] === "status" || command[0] === "switch") return "";
      if (command[0] === "symbolic-ref") return "main\n";
      if (command[0] === "branch") return "  issue/198\n";
      throw new Error(`unexpected git command: ${command.join(" ")}`);
    },
  );

  await delivery.checkoutBranch("refs/heads/issue/198", "refs/heads/main", "/repo");

  expect(commands.at(-1)).toEqual(["switch", "--no-guess", "issue/198"]);
});

test("checkout de recuperación rechaza un worktree sucio aunque la rama fijada ya esté activa", async () => {
  const commands: string[][] = [];
  const delivery = new GitHubDeliveryService(
    async () => { throw new Error("must not use GitHub"); },
    async (command) => {
      commands.push(command);
      if (command[0] === "rev-parse") return "";
      if (command[0] === "symbolic-ref") return "issue/198\n";
      if (command[0] === "status") return "?? local.txt\n";
      throw new Error(`unexpected git command: ${command.join(" ")}`);
    },
  );

  await expect(delivery.checkoutBranch("refs/heads/issue/198", "refs/heads/main", "/repo"))
    .rejects.toThrow("cambios sin guardar");
  expect(commands.some(([command]) => command === "switch")).toBeFalse();
});

test("checkout de recuperación rechaza una operación Git activa", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazy-workflow-git-operation-"));
  const mergeHead = join(root, "MERGE_HEAD");
  writeFileSync(mergeHead, "a".repeat(40));
  const delivery = new GitHubDeliveryService(
    async () => { throw new Error("must not use GitHub"); },
    async (command) => {
      if (command[0] === "rev-parse") return `${mergeHead}\n`;
      if (command[0] === "status") return "";
      if (command[0] === "symbolic-ref") return "issue/198\n";
      throw new Error(`unexpected git command: ${command.join(" ")}`);
    },
  );

  try {
    await expect(delivery.checkoutBranch("refs/heads/issue/198", "refs/heads/main", root))
      .rejects.toThrow("operación Git en curso");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function mergeGhStub(prChecks: (args: string[]) => Promise<string>) {
  const commit = "a".repeat(40);
  let prViews = 0;
  const gh = async (args: string[]): Promise<string> => {
    const [command, sub] = args;
    if (command === "repo" && sub === "view") {
      return JSON.stringify({ nameWithOwner: "owner/repo", defaultBranchRef: { name: "main" } });
    }
    if (command === "pr" && sub === "view") {
      const merged = prViews++ > 0;
      return JSON.stringify({
        number: 201,
        state: merged ? "MERGED" : "OPEN",
        body: "Closes #189",
        headRefName: "issue/189",
        headRefOid: commit,
        baseRefName: "main",
        isDraft: false,
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [],
        ...(merged ? { mergeCommit: { oid: "c".repeat(40) } } : {}),
      });
    }
    if (command === "api" && sub === "repos/owner/repo/branches/main") return JSON.stringify({ protected: false });
    if (command === "pr" && sub === "checks") return prChecks(args);
    if (command === "pr" && sub === "merge") return "";
    throw new Error(`unexpected gh command: ${args.join(" ")}`);
  };
  const git = async (args: string[]): Promise<string> => {
    if (args[0] === "remote" && args[1] === "get-url") return "https://github.com/owner/repo.git\n";
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };
  return { gh, git, commit };
}

test("merge tolera 'no checks reported' cuando la rama no tiene checks", async () => {
  const { gh, git, commit } = mergeGhStub(async () => {
    throw new Error("gh pr fallo (no checks reported on the 'issue/189' branch)");
  });
  const delivery = new GitHubDeliveryService(gh, git);

  const result = await delivery.mergePullRequest(201, 189, "refs/heads/issue/189", "refs/heads/main", commit, "/repo");

  expect(result).toEqual({ number: 201, mergeCommit: "c".repeat(40) });
});

test("merge propaga fallos de gh pr checks que no sean 'no checks reported'", async () => {
  const { gh, git, commit } = mergeGhStub(async () => {
    throw new Error("gh pr fallo (API rate limit exceeded)");
  });
  const delivery = new GitHubDeliveryService(gh, git);

  await expect(delivery.mergePullRequest(201, 189, "refs/heads/issue/189", "refs/heads/main", commit, "/repo"))
    .rejects.toThrow("API rate limit exceeded");
});

test("entrega GitHub desde IMPLEMENTATION_READY hasta limpieza verificada", async () => {
  const calls: string[] = [];
  let selections = 0;
  let current: GitHubDeliveryCheckpoint | null = null;
  const store: GitHubCheckpointStore = {
    read: async () => current,
    write: async (checkpoint) => { current = checkpoint; },
    clear: async () => { current = null; },
  };
  const manifest: GitHubReadyManifest = {
    issue: 179,
    branch: "refs/heads/issue/179",
    commit: "a".repeat(40),
    validation: [{ command: "bun test", result: "passed" }],
    clean: true,
    summary: "implemented",
  };
  const delivery: GitHubDeliveryAdapter = {
    prepareBranch: async () => {
      calls.push("prepare-branch");
      return { branch: manifest.branch, baseBranch: "refs/heads/main", manifestPath: "/repo/.git/lazy-workflow/github-manifest.json" };
    },
    readManifest: async () => {
      calls.push("read-manifest");
      return manifest;
    },
    pushCommit: async () => { calls.push("push"); },
    createOrReusePullRequest: async () => {
      calls.push("pull-request");
      return { number: 201 };
    },
    mergePullRequest: async () => {
      calls.push("merge");
      return { number: 201, mergeCommit: "b".repeat(40) };
    },
    closeIssue: async () => { calls.push("close-issue"); },
    cleanupBranch: async () => { calls.push("cleanup"); },
  };

  const code = await new LazyWorkflowCli(
    { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    { run: async () => execution(), resume: async () => execution().result },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      selectAndClaimEligibleIssue: async () => ({ kind: "empty" }),
      selectEligibleIssue: async () => {
        selections += 1;
        if (selections > 1) return { kind: "empty" };
        return { kind: "candidate", issue: fakeSelectedIssue(179), repository: { nameWithOwner: "owner/repo" } };
      },
      claimSelectedIssue: async () => fakeSelectedIssue(179),
    },
    store,
    { acquire: async () => async () => undefined },
    delivery,
  ).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(selections).toBe(2);
  expect(calls).toEqual(["prepare-branch", "read-manifest", "push", "pull-request", "merge", "close-issue", "cleanup"]);
  expect(current).toBeNull();
});

test("recupera una entrega sessionless desde el límite de merge sin ejecutar OpenCode", async () => {
  let selected = true;
  let failMerge = true;
  let openCodeRuns = 0;
  let current: GitHubDeliveryCheckpoint | null = null;
  const store: GitHubCheckpointStore = {
    read: async () => current,
    write: async (checkpoint) => { current = checkpoint; },
    clear: async () => { current = null; },
  };
  const delivery: GitHubDeliveryAdapter = {
    prepareBranch: async () => ({ branch: "refs/heads/issue/179", baseBranch: "refs/heads/main", manifestPath: "/manifest.json" }),
    readManifest: async () => ({ issue: 179, branch: "refs/heads/issue/179", commit: "a".repeat(40), validation: [{ command: "bun test", result: "passed" }], clean: true, summary: "implemented" }),
    pushCommit: async () => undefined,
    createOrReusePullRequest: async () => ({ number: 201 }),
    mergePullRequest: async () => {
      if (failMerge) throw new Error("merge pending");
      return { number: 201, mergeCommit: "b".repeat(40) };
    },
    closeIssue: async () => undefined,
    cleanupBranch: async () => undefined,
  };
  const queue = {
    selectAndClaimEligibleIssue: async () => ({ kind: "empty" as const }),
    selectEligibleIssue: async () => selected
      ? (selected = false, { kind: "candidate" as const, issue: fakeSelectedIssue(179), repository: { nameWithOwner: "owner/repo" } })
      : { kind: "empty" as const },
    claimSelectedIssue: async () => fakeSelectedIssue(179),
  };
  const makeCli = (run: boolean) => new LazyWorkflowCli(
    { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    { run: async () => { openCodeRuns += 1; return execution(); }, resume: async () => execution().result },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    queue,
    store,
    { acquire: async () => async () => undefined },
    delivery,
  );

  expect(await makeCli(true).run(["code", "--working-directory", "/repo"])).toBe(1);
  expect(phaseOf(current)).toBe("integrating");
  failMerge = false;
  expect(await makeCli(false).run(["code", "--working-directory", "/repo"])).toBe(0);
  expect(openCodeRuns).toBe(1);
  expect(current).toBeNull();
});

test("reconcilia un PR conflictivo sobre la base fijada y continúa la entrega", async () => {
  const originalCommit = "a".repeat(40);
  const baseCommit = "b".repeat(40);
  const reconciledCommit = "c".repeat(40);
  const mergeCommit = "d".repeat(40);
  const events: string[] = [];
  let reconciled = false;
  let current: GitHubDeliveryCheckpoint | null = {
    schemaVersion: 1,
    workflow: "github-code",
    repository: "owner/repo",
    issue: 179,
    phase: "integrating",
    branch: "refs/heads/issue/179",
    baseBranch: "refs/heads/main",
    manifestPath: "/manifest.json",
    sessionId: null,
    commit: originalCommit,
    pullRequest: 201,
    mergeCommit: null,
    receipts: {
      manifest: { verifiedAt: "2026-08-14T00:00:00.000Z" },
      push: { verifiedAt: "2026-08-14T00:00:00.000Z" },
      "pull-request": { verifiedAt: "2026-08-14T00:00:00.000Z" },
    },
    intent: { effect: "merge", target: "201" },
  };
  const manifest = (commit: string): GitHubReadyManifest => ({
    issue: 179,
    branch: "refs/heads/issue/179",
    commit,
    validation: [{ command: "bun test", result: "passed" }],
    clean: true,
    summary: "implemented",
  });
  const store: GitHubCheckpointStore = {
    read: async () => current,
    write: async (checkpoint) => { current = checkpoint; },
    clear: async () => { current = null; },
  };
  const delivery: GitHubDeliveryAdapter = {
    verifyRepository: async () => undefined,
    verifyBranch: async () => undefined,
    prepareBranch: async () => { throw new Error("must not prepare"); },
    readManifest: async () => manifest(reconciled ? reconciledCommit : originalCommit),
    pushCommit: async (_branch, commit) => { events.push(`push:${commit}`); },
    createOrReusePullRequest: async () => { throw new Error("must reuse PR"); },
    preparePullRequestReconciliation: async () => {
      events.push("prepare-reconciliation");
      return { baseCommit };
    },
    verifyPullRequestReconciliation: async (_branch, original, base, commit) => {
      events.push(`verify:${original}:${base}:${commit}`);
    },
    mergePullRequest: async () => {
      events.push("merge");
      if (!reconciled) throw new GitHubPullRequestConflictError(201);
      return { number: 201, mergeCommit };
    },
    closeIssue: async () => { events.push("close"); },
    cleanupBranch: async (_branch, _base, commit) => { events.push(`cleanup:${commit}`); },
  };
  let selections = 0;
  let prompt = "";
  const code = await new LazyWorkflowCli(
    { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    {
      run: async (options) => {
        prompt = options.prompt;
        reconciled = true;
        return execution();
      },
      resume: async () => { throw new Error("must not resume"); },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { selectAndClaimEligibleIssue: async () => { selections += 1; return { kind: "empty" as const }; }, reconcileClaimedIssue: async () => fakeSelectedIssue(179) },
    store,
    { acquire: async () => async () => undefined },
    delivery,
  ).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(selections).toBe(0);
  expect(prompt).toContain(originalCommit);
  expect(prompt).toContain(baseCommit);
  expect(prompt).toContain("Coordinator-fixed pull request: #201");
  expect(events).toEqual([
    "merge",
    "prepare-reconciliation",
    `verify:${originalCommit}:${baseCommit}:${reconciledCommit}`,
    `push:${reconciledCommit}`,
    "merge",
    "close",
    `cleanup:${reconciledCommit}`,
  ]);
  expect(current).toBeNull();
});

test("reanuda una reconciliación conflictiva sin seleccionar otro Issue", async () => {
  const originalCommit = "a".repeat(40);
  const baseCommit = "b".repeat(40);
  const reconciledCommit = "c".repeat(40);
  let current: GitHubDeliveryCheckpoint | null = {
    schemaVersion: 1,
    workflow: "github-code",
    repository: "owner/repo",
    issue: 179,
    phase: "conflict-resolving",
    branch: "refs/heads/issue/179",
    baseBranch: "refs/heads/main",
    manifestPath: "/manifest.json",
    sessionId: "ses_conflict",
    commit: originalCommit,
    pullRequest: 201,
    mergeCommit: null,
    receipts: { "pull-request": { verifiedAt: "2026-08-14T00:00:00.000Z" } },
    intent: { effect: "reconcile-merge", target: "201" },
    reconciliation: { pullRequest: 201, originalCommit, baseCommit },
  };
  let reconciled = false;
  let selections = 0;
  let runs = 0;
  let resumes = 0;
  const events: string[] = [];
  const store: GitHubCheckpointStore = {
    read: async () => current,
    write: async (checkpoint) => { current = checkpoint; },
    clear: async () => { current = null; },
  };
  const delivery: GitHubDeliveryAdapter = {
    verifyRepository: async () => { events.push("verify-repository"); },
    checkoutBranch: async () => { throw new Error("must preserve expected merge state"); },
    verifyBranch: async () => undefined,
    verifyPendingPullRequestReconciliation: async () => { events.push("verify-pending"); },
    prepareBranch: async () => { throw new Error("must not prepare"); },
    readManifest: async () => ({ issue: 179, branch: "refs/heads/issue/179", commit: reconciled ? reconciledCommit : originalCommit, validation: [{ command: "bun test", result: "passed" }], clean: true, summary: "reconciled" }),
    pushCommit: async (_branch, commit) => { events.push(`push:${commit}`); },
    createOrReusePullRequest: async () => { throw new Error("must reuse PR"); },
    verifyPullRequestReconciliation: async () => { events.push("verify-reconciled"); },
    mergePullRequest: async () => { events.push("merge"); return { number: 201, mergeCommit: "d".repeat(40) }; },
    closeIssue: async () => { events.push("close"); },
    cleanupBranch: async () => { events.push("cleanup"); },
  };
  const code = await new LazyWorkflowCli(
    { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    {
      run: async () => { runs += 1; throw new Error("must resume"); },
      resume: async (session, prompt) => {
        resumes += 1;
        expect(session).toBe("ses_conflict");
        expect(prompt).toContain(baseCommit);
        expect(prompt).toContain("Coordinator-fixed pull request: #201");
        reconciled = true;
        return execution().result;
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { selectAndClaimEligibleIssue: async () => { selections += 1; return { kind: "empty" as const }; }, reconcileClaimedIssue: async () => fakeSelectedIssue(179) },
    store,
    { acquire: async () => async () => undefined },
    delivery,
  ).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect({ selections, runs, resumes }).toEqual({ selections: 0, runs: 0, resumes: 1 });
  expect(events.filter((event) => event === "verify-pending")).toHaveLength(1);
  expect(events.indexOf("verify-pending")).toBeLessThan(events.indexOf("verify-reconciled"));
  expect(events.indexOf("verify-reconciled")).toBeLessThan(events.indexOf(`push:${reconciledCommit}`));
  expect(events.indexOf(`push:${reconciledCommit}`)).toBeLessThan(events.indexOf("merge"));
  expect(events.indexOf("merge")).toBeLessThan(events.indexOf("close"));
  expect(events.indexOf("close")).toBeLessThan(events.indexOf("cleanup"));
  expect(current).toBeNull();
});

test("los marcadores de entrega heredados no avanzan una entrega GitHub", async () => {
  let deliveryCalls = 0;
  let current: GitHubDeliveryCheckpoint | null = null;
  const store: GitHubCheckpointStore = {
    read: async () => current,
    write: async (checkpoint) => { current = checkpoint; },
    clear: async () => { current = null; },
  };
  const delivery: GitHubDeliveryAdapter = {
    prepareBranch: async () => ({ branch: "refs/heads/issue/179", baseBranch: "refs/heads/main", manifestPath: "/manifest.json" }),
    readManifest: async () => { deliveryCalls += 1; throw new Error("must not deliver"); },
    pushCommit: async () => undefined,
    createOrReusePullRequest: async () => ({ number: 201 }),
    mergePullRequest: async () => ({ number: 201, mergeCommit: "b".repeat(40) }),
    closeIssue: async () => undefined,
    cleanupBranch: async () => undefined,
  };
  const cli = new LazyWorkflowCli(
    { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    { run: async () => ({ ...execution(), result: OpenCodeResult.fromJsonLines(JSON.stringify({ type: "text", sessionID: "ses_legacy", part: { type: "text", text: "TICKET_COMPLETED\nWORKFLOW_STEP_FINISHED" } })) }), resume: async () => execution().result },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      selectAndClaimEligibleIssue: async () => ({ kind: "empty" }),
      selectEligibleIssue: async () => ({ kind: "candidate", issue: fakeSelectedIssue(179), repository: { nameWithOwner: "owner/repo" } }),
      claimSelectedIssue: async () => fakeSelectedIssue(179),
    },
    store,
    { acquire: async () => async () => undefined },
    delivery,
  );

  expect(await cli.run(["code", "--working-directory", "/repo"])).toBe(1);
  expect(deliveryCalls).toBe(0);
  expect(phaseOf(current)).toBe("implementing");
});

test("reconciliación de padres ocurre después de la limpieza y antes de borrar el checkpoint", async () => {
  const events: string[] = [];
  let current: GitHubDeliveryCheckpoint | null = null;
  const store: GitHubCheckpointStore = {
    read: async () => current,
    write: async (checkpoint) => { current = checkpoint; events.push(`write:${checkpoint.phase}`); },
    clear: async () => { events.push("clear"); current = null; },
  };
  const delivery: GitHubDeliveryAdapter = {
    prepareBranch: async () => ({ branch: "refs/heads/issue/179", baseBranch: "refs/heads/main", manifestPath: "/manifest.json" }),
    readManifest: async () => ({ issue: 179, branch: "refs/heads/issue/179", commit: "a".repeat(40), validation: [{ command: "bun test", result: "passed" }], clean: true, summary: "implemented" }),
    pushCommit: async () => { events.push("push"); },
    createOrReusePullRequest: async () => { events.push("pull-request"); return { number: 201 }; },
    mergePullRequest: async () => { events.push("merge"); return { number: 201, mergeCommit: "b".repeat(40) }; },
    closeIssue: async () => { events.push("close-issue"); },
    cleanupBranch: async () => { events.push("cleanup"); },
  };
  const parents: GitHubParentReconciliationAdapter = {
    reconcileParents: async () => { events.push("parents"); },
    reconcileOpenParents: async () => undefined,
  };
  let selected = true;
  const queue = {
    selectEligibleIssue: async () => selected
      ? (selected = false, { kind: "candidate" as const, issue: fakeSelectedIssue(179), repository: { nameWithOwner: "owner/repo" } })
      : { kind: "empty" as const },
    claimSelectedIssue: async () => fakeSelectedIssue(179),
    selectAndClaimEligibleIssue: async () => ({ kind: "empty" as const }),
  };

  const code = await new LazyWorkflowCli(
    { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    { run: async () => execution(), resume: async () => execution().result },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    queue,
    store,
    { acquire: async () => async () => undefined },
    delivery,
    parents,
  ).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(events.indexOf("parents")).toBeGreaterThan(events.indexOf("cleanup"));
  expect(events.indexOf("parents")).toBeLessThan(events.indexOf("clear"));
});

test("reconcilia padres pendientes al iniciar sin lanzar OpenCode", async () => {
  let reconciled = 0;
  let openCodeRuns = 0;
  const parents: GitHubParentReconciliationAdapter = {
    reconcileParents: async () => undefined,
    reconcileOpenParents: async () => { reconciled += 1; },
  };
  const queue = {
    selectEligibleIssue: async () => ({ kind: "empty" as const }),
    claimSelectedIssue: async () => { throw new Error("must not claim"); },
    selectAndClaimEligibleIssue: async () => ({ kind: "empty" as const }),
  };
  const store: GitHubCheckpointStore = {
    read: async () => null,
    write: async () => undefined,
    clear: async () => undefined,
  };

  const code = await new LazyWorkflowCli(
    { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    { run: async () => { openCodeRuns += 1; return execution(); }, resume: async () => execution().result },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    queue,
    store,
    { acquire: async () => async () => undefined },
    undefined,
    parents,
  ).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(reconciled).toBe(1);
  expect(openCodeRuns).toBe(0);
});
