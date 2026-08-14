import { expect, test } from "bun:test";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import type {
  GitHubDeliveryAdapter,
  GitHubReadyManifest,
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
        if (selections > 1) throw new Error("must not select a second issue");
        return { kind: "candidate", issue: fakeSelectedIssue(179), repository: { nameWithOwner: "owner/repo" } };
      },
      claimSelectedIssue: async () => fakeSelectedIssue(179),
    },
    store,
    { acquire: async () => async () => undefined },
    delivery,
  ).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(selections).toBe(1);
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
