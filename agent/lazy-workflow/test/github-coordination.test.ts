import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { OpenCodeResult } from "../src/opencode/open-code-result.ts";
import { GITHUB_DELIVERY_PHASES, type GitHubCheckpointStore, type GitHubDeliveryCheckpoint } from "../src/github/github-delivery-checkpoint.ts";
import type { GitHubDeliveryAdapter } from "../src/github/github-delivery-service.ts";
import type { GitHubRepositoryLockBoundary } from "../src/github/github-repository-lock.ts";
import { fakeSelectedIssue, fakeSelectedOutcome } from "./_helpers/managed-queue-fixtures.ts";
import { fakeGitHubDelivery } from "./_helpers/github-delivery-fixtures.ts";

/** Consecutive duplicate phases collapsed, so the assertion reads as the delivery's phase progression. */
function distinctPhaseSequence(phases: string[]): string[] {
  return phases.filter((phase, index) => phase !== phases[index - 1]);
}

function checkpoint(sessionId: string | null): GitHubDeliveryCheckpoint {
  return {
    schemaVersion: 1,
    workflow: "github-code",
    repository: "owner/repo",
    issue: 178,
    phase: sessionId ? "implementing" : "reconciling",
    branch: null,
    sessionId,
    commit: null,
    pullRequest: null,
    receipts: {},
  };
}

function boundaries(initial: GitHubDeliveryCheckpoint | null = null) {
  let current = initial;
  const phases: string[] = [];
  let lockAcquires = 0;
  let lockReleases = 0;
  const store: GitHubCheckpointStore = {
    read: async () => current,
    write: async (value) => { current = value; phases.push(value.phase); },
    clear: async () => { current = null; },
  };
  const lock: GitHubRepositoryLockBoundary = {
    acquire: async () => {
      lockAcquires += 1;
      return async () => { lockReleases += 1; };
    },
  };
  return { store, lock, phases, get current() { return current; }, get lockAcquires() { return lockAcquires; }, get lockReleases() { return lockReleases; } };
}

const services = () => ({
  azure: { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
  openCode: {
    run: async () => ({
      result: OpenCodeResult.fromJsonLines(JSON.stringify({
        type: "text", sessionID: "ses_178", part: { type: "text", text: "IMPLEMENTATION_READY" },
      })),
      azureLoginRequired: false,
    }),
    resume: async () => OpenCodeResult.fromJsonLines(JSON.stringify({
      type: "text", sessionID: "ses_178", part: { type: "text", text: "still working" },
    })),
  },
});

function failingDelivery(overrides: Partial<GitHubDeliveryAdapter> = {}): GitHubDeliveryAdapter {
  const unexpected = async (): Promise<never> => { throw new Error("unexpected delivery operation"); };
  return {
    prepareBranch: unexpected,
    readManifest: unexpected,
    pushCommit: unexpected,
    createOrReusePullRequest: unexpected,
    mergePullRequest: unexpected,
    closeIssue: unexpected,
    cleanupBranch: unexpected,
    ...overrides,
  };
}

test("checkpoint GitHub bloquea la selección de un issue sustituto", async () => {
  const state = boundaries(checkpoint(null));
  const { azure, openCode } = services();
  let selections = 0;
  const code = await new LazyWorkflowCli(
    azure,
    { ...openCode, run: async () => { throw new Error("must not run"); } },
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
    { selectAndClaimEligibleIssue: async () => { selections += 1; return fakeSelectedOutcome(999); } },
    state.store,
    state.lock,
  ).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(1);
  expect(selections).toBe(0);
  expect(state.lockAcquires).toBe(1);
  expect(state.lockReleases).toBe(1);
});

test("la entrega GitHub checkpointa el issue fijado y limpia tras el resultado completo", async () => {
  const state = boundaries();
  const { azure, openCode } = services();
  const events: string[] = [];
  const store: GitHubCheckpointStore = {
    ...state.store,
    write: async (value) => { events.push(`write:${value.phase}`); await state.store.write(value); },
  };
  const queue = {
    available: true,
    selectAndClaimEligibleIssue: async () => { throw new Error("must use checkpointed selection"); },
    async selectEligibleIssue() {
      events.push("select");
      if (!this.available) return { kind: "empty" as const };
      this.available = false;
      return { kind: "candidate" as const, issue: fakeSelectedIssue(178), repository: { nameWithOwner: "owner/repo" } };
    },
    async claimSelectedIssue() {
      events.push("claim");
      if (this.available) throw new Error("issue was not selected");
      return fakeSelectedIssue(178);
    },
  };
  const code = await new LazyWorkflowCli(
    azure,
    openCode,
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
    state.lock,
    fakeGitHubDelivery(),
  ).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(distinctPhaseSequence(state.phases)).toEqual([
    "selected", "started", "implementation-ready", "integrating", "reconciling", "cleaning",
  ]);
  // The checkpoint is written once on selection and again after claim verification.
  expect(state.phases.filter((phase) => phase === "selected")).toHaveLength(2);
  expect(state.current).toBeNull();
  expect(events.slice(0, 3)).toEqual(["select", "write:selected", "claim"]);
  expect(state.lockAcquires).toBe(1);
  expect(state.lockReleases).toBe(1);
});

test("el coordinador continúa con la siguiente issue elegible hasta vaciar la cola", async () => {
  const state = boundaries();
  const { azure, openCode } = services();
  const pending = [178, 179];
  let claims = 0;
  let runs = 0;
  const queue = {
    selectAndClaimEligibleIssue: async () => { throw new Error("must use checkpointed selection"); },
    async selectEligibleIssue() {
      const next = pending[0];
      if (next === undefined) return { kind: "empty" as const };
      return { kind: "candidate" as const, issue: fakeSelectedIssue(next), repository: { nameWithOwner: "owner/repo" } };
    },
    async claimSelectedIssue() {
      claims += 1;
      return fakeSelectedIssue(pending.shift()!);
    },
  };
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  let code: number;
  try {
    code = await new LazyWorkflowCli(
      azure,
      { ...openCode, run: async () => { runs += 1; return openCode.run(); } },
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      queue,
      state.store,
      state.lock,
      fakeGitHubDelivery(),
    ).run(["code", "--working-directory", "/repo"]);
  } finally {
    console.log = original;
  }

  expect(code).toBe(0);
  expect(claims).toBe(2);
  expect(runs).toBe(2);
  expect(logs.filter((line) => line === "TICKET_COMPLETED")).toHaveLength(2);
  expect(logs.filter((line) => line === "QUEUE_EMPTY")).toHaveLength(1);
  expect(logs.at(-1)).toBe("WORKFLOW_STEP_FINISHED");
  expect(state.current).toBeNull();
  expect(state.lockAcquires).toBe(1);
  expect(state.lockReleases).toBe(1);
});

test("la recuperación usa el checkpoint y no consulta la cola", async () => {
  const state = boundaries(checkpoint("ses_178"));
  const { azure, openCode } = services();
  let selections = 0;
  let resumes = 0;
  let resumeOverrides: unknown;
  const queue = {
    issue: fakeSelectedIssue(178),
    selectAndClaimEligibleIssue: async () => { selections += 1; return fakeSelectedOutcome(999); },
    async reconcileClaimedIssue(issueNumber: number) {
      if (this.issue.number !== issueNumber) throw new Error("wrong issue");
      return this.issue;
    },
  };
  const code = await new LazyWorkflowCli(
    azure,
    { ...openCode, resume: async (_session, _prompt, _directory, _marker, overrides) => {
      resumes += 1;
      resumeOverrides = overrides;
      return openCode.resume();
    } },
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
    state.store,
    state.lock,
  ).run([
    "code", "--working-directory", "/repo",
    "--model", "openai/gpt-5.6-luna", "--variant", "high",
  ]);

  expect(code).toBe(1);
  expect(selections).toBe(0);
  expect(resumes).toBe(1);
  expect(resumeOverrides).toEqual({ model: "openai/gpt-5.6-luna", variant: "high" });
  expect(state.current?.issue).toBe(178);
  expect(state.current?.phase).toBe("implementing");
});

test("la recuperación conserva el checkpoint si el checkout seguro falla", async () => {
  const initial = checkpoint("ses_178");
  initial.branch = "refs/heads/issue/178";
  initial.baseBranch = "refs/heads/main";
  const state = boundaries(initial);
  const { azure, openCode } = services();
  let reconciliations = 0;
  let resumes = 0;
  const delivery = failingDelivery({
    verifyRepository: async () => undefined,
    checkoutBranch: async () => { throw new Error("El repositorio tiene cambios sin guardar"); },
    verifyBranch: async () => { throw new Error("must not verify after checkout failure"); },
  });
  const queue = {
    selectAndClaimEligibleIssue: async () => { throw new Error("must not select"); },
    reconcileClaimedIssue: async () => { reconciliations += 1; return fakeSelectedIssue(178); },
  };

  const code = await new LazyWorkflowCli(
    azure,
    { ...openCode, resume: async () => { resumes += 1; return openCode.resume(); } },
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
    state.store,
    state.lock,
    delivery,
  ).run(["code", "--session", "ses_178", "--working-directory", "/repo"]);

  expect(code).toBe(1);
  expect(reconciliations).toBe(0);
  expect(resumes).toBe(0);
  expect(state.current).toEqual(initial);
  expect(state.lockAcquires).toBe(1);
  expect(state.lockReleases).toBe(1);
});

test("la recuperación no usa queue ni OpenCode si falta la rama fijada", async () => {
  const initial = checkpoint("ses_178");
  const state = boundaries(initial);
  const { azure, openCode } = services();
  let reconciliations = 0;
  let resumes = 0;

  const code = await new LazyWorkflowCli(
    azure,
    { ...openCode, resume: async () => { resumes += 1; return openCode.resume(); } },
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
      selectAndClaimEligibleIssue: async () => { throw new Error("must not select"); },
      reconcileClaimedIssue: async () => { reconciliations += 1; return fakeSelectedIssue(178); },
    },
    state.store,
    state.lock,
    failingDelivery(),
  ).run(["code", "--session", "ses_178", "--working-directory", "/repo"]);

  expect(code).toBe(1);
  expect(reconciliations).toBe(0);
  expect(resumes).toBe(0);
  expect(state.current).toEqual(initial);
});

test("la recuperación sessionless cambia a la rama fijada antes de continuar", async () => {
  const state = boundaries({
    ...checkpoint(null),
    phase: "started",
    branch: "refs/heads/issue/178",
    baseBranch: "refs/heads/main",
    manifestPath: "/missing-manifest.json",
  });
  const { azure, openCode } = services();
  const events: string[] = [];
  let reconciliations = 0;
  let runs = 0;
  const queue = {
    issue: fakeSelectedIssue(178),
    selectAndClaimEligibleIssue: async () => fakeSelectedOutcome(999),
    async reconcileClaimedIssue(issueNumber: number) {
      events.push("read-issue");
      reconciliations += 1;
      if (this.issue.number !== issueNumber) throw new Error("wrong issue");
      return this.issue;
    },
  };
  const delivery = failingDelivery({
    verifyRepository: async () => { events.push("verify-repository"); },
    checkoutBranch: async () => { events.push("checkout-branch"); },
    verifyBranch: async () => { events.push("verify-branch"); },
  });

  const code = await new LazyWorkflowCli(
    azure,
    { ...openCode, run: async () => { events.push("opencode"); runs += 1; throw new Error("stop after recovery preflight"); } },
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
    state.store,
    state.lock,
    delivery,
  ).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(1);
  expect(reconciliations).toBe(1);
  expect(runs).toBe(1);
  expect(events).toEqual(["verify-repository", "checkout-branch", "verify-branch", "read-issue", "opencode"]);
  expect(state.current?.phase).toBe("started");
});

test("la recuperación sessionless ignora un manifest ajeno de un issue previo", async () => {
  const root = mkdtempSync(join(tmpdir(), "lazy-workflow-stale-manifest-"));
  const manifestPath = join(root, "github-completion-manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ issue: 177, branch: "refs/heads/issue/177", commit: "a".repeat(40) }));
  const state = boundaries({
    ...checkpoint(null),
    phase: "started",
    branch: "refs/heads/issue/178",
    baseBranch: "refs/heads/main",
    manifestPath,
  });
  const { azure, openCode } = services();
  const events: string[] = [];
  let runs = 0;
  const queue = {
    selectAndClaimEligibleIssue: async () => fakeSelectedOutcome(999),
    reconcileClaimedIssue: async () => fakeSelectedIssue(178),
  };
  const delivery = failingDelivery({
    verifyRepository: async () => { events.push("verify-repository"); },
    checkoutBranch: async () => { events.push("checkout-branch"); },
    verifyBranch: async () => { events.push("verify-branch"); },
    readManifest: async () => { events.push("read-manifest"); throw new Error("must not read stale manifest"); },
  });

  try {
    const code = await new LazyWorkflowCli(
      azure,
      { ...openCode, run: async () => { events.push("opencode"); runs += 1; throw new Error("stop after recovery preflight"); } },
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
      state.store,
      state.lock,
      delivery,
    ).run(["code", "--working-directory", "/repo"]);

    expect(code).toBe(1);
    expect(runs).toBe(1);
    expect(events).not.toContain("read-manifest");
    expect(events.at(-1)).toBe("opencode");
    expect(state.current?.phase).toBe("started");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const phase of GITHUB_DELIVERY_PHASES) {
  test(`la recuperación conserva el issue fijado en fase ${phase}`, async () => {
    const state = boundaries({ ...checkpoint("ses_178"), phase });
    const { azure, openCode } = services();
    let selections = 0;
    const code = await new LazyWorkflowCli(
      azure,
      openCode,
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
        selectAndClaimEligibleIssue: async () => { selections += 1; return fakeSelectedOutcome(999); },
        reconcileClaimedIssue: async () => fakeSelectedIssue(178),
      },
      state.store,
      state.lock,
    ).run(["code", "--working-directory", "/repo"]);

    expect(code).toBe(1);
    expect(selections).toBe(0);
    expect(state.current?.issue).toBe(178);
  });
}
