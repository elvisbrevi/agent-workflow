import { expect, test } from "bun:test";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { OpenCodeResult } from "../src/opencode/open-code-result.ts";
import type { GitHubCheckpointStore, GitHubDeliveryCheckpoint } from "../src/github/github-delivery-checkpoint.ts";
import type { GitHubRepositoryLockBoundary } from "../src/github/github-repository-lock.ts";
import { fakeSelectedIssue, fakeSelectedOutcome, queueAdapter } from "./_helpers/managed-queue-fixtures.ts";

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
        type: "text", sessionID: "ses_178", part: { type: "text", text: "TICKET_COMPLETED\nWORKFLOW_STEP_FINISHED" },
      })),
      azureLoginRequired: false,
    }),
    resume: async () => OpenCodeResult.fromJsonLines(JSON.stringify({
      type: "text", sessionID: "ses_178", part: { type: "text", text: "still working" },
    })),
  },
});

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
    queueAdapter([fakeSelectedOutcome(178), { kind: "empty" }]),
    state.store,
    state.lock,
  ).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(state.phases).toEqual(["selected", "started", "implementing"]);
  expect(state.current).toBeNull();
  expect(state.lockAcquires).toBe(1);
  expect(state.lockReleases).toBe(1);
});

test("la recuperación usa el checkpoint y no consulta la cola", async () => {
  const state = boundaries(checkpoint("ses_178"));
  const { azure, openCode } = services();
  let selections = 0;
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
      selectAndClaimEligibleIssue: async () => { selections += 1; return fakeSelectedOutcome(999); },
      readIssueDetail: async () => fakeSelectedIssue(178),
    },
    state.store,
    state.lock,
  ).run(["code", "--session", "ses_178", "--working-directory", "/repo"]);

  expect(code).toBe(1);
  expect(selections).toBe(0);
  expect(resumes).toBe(1);
  expect(state.current?.issue).toBe(178);
  expect(state.current?.phase).toBe("implementing");
});
