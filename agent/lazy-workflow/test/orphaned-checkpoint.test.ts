import { expect, test } from "bun:test";
import { createCli } from "./_helpers/create-cli.ts";
import { AgentResult } from "../src/coding-agent/agent-result.ts";
import type { GitHubCheckpointStore, GitHubDeliveryCheckpoint } from "../src/github/github-delivery-checkpoint.ts";
import { fakeGitHubDelivery, fakeGitHubRepositoryLock } from "./_helpers/github-delivery-fixtures.ts";
import { fakeSelectedIssue } from "./_helpers/managed-queue-fixtures.ts";
import { getDefaultReporter, setDefaultReporter } from "../src/output/operator-output.ts";
import type { Reporter } from "../src/output/reporter.ts";

const azure = {
  getHuInfo: async () => { throw new Error("must not use Azure"); },
  waitForAccess: async () => undefined,
};

/**
 * Un checkpoint sin entrega verificada cuya issue ya cerró por fuera.
 *
 * Es el único caso en que el coordinador descarta un checkpoint por su cuenta: no hay entrega a
 * medias que reconciliar, la issue ya no está en la cola, y dejarlo ahí bloquearía cada corrida
 * siguiente sobre trabajo que alguien ya resolvió a mano.
 */
function checkpoint(overrides: Partial<GitHubDeliveryCheckpoint> = {}): GitHubDeliveryCheckpoint {
  return {
    schemaVersion: 3,
    workflow: "github-code",
    repository: "owner/repo",
    issue: 178,
    branch: "refs/heads/issue/178",
    baseBranch: "refs/heads/main",
    commit: null,
    ...overrides,
  };
}

function harness(
  initial: GitHubDeliveryCheckpoint,
  readIssueDetail: (issue: number) => Promise<ReturnType<typeof fakeSelectedIssue>>,
) {
  let current: GitHubDeliveryCheckpoint | null = initial;
  const released: Array<{ issue: number; login: string }> = [];
  const reported: string[] = [];
  const store: GitHubCheckpointStore = {
    read: async () => current,
    write: async (value) => { current = value; },
    clear: async () => { current = null; },
  };
  const reporter: Reporter = {
    ...getDefaultReporter(),
    info: (message: string) => { reported.push(message); },
    warn: (message: string) => { reported.push(message); },
    error: (message: string) => { reported.push(message); },
  };
  const cli = createCli({
    huInfoService: azure,
    agentSource: {
      run: async () => { throw new Error("un checkpoint huérfano no abre sesión"); },
      resume: async () => { throw new Error("un checkpoint huérfano no reanuda"); },
    },
    githubManagedQueue: {
      verifyAuthentication: async () => ({ login: "elvis" }),
      selectAndClaimEligibleIssue: async () => ({ kind: "empty" as const }),
      selectEligibleIssue: async () => ({ kind: "empty" as const }),
      claimSelectedIssue: async () => fakeSelectedIssue(178),
      readIssueDetail,
      releaseOwnClaim: async (issue: number, login: string) => { released.push({ issue, login }); },
    },
    githubCheckpointStore: store,
    githubRepositoryLock: fakeGitHubRepositoryLock(),
    githubDelivery: fakeGitHubDelivery(),
    createReporterFn: (() => reporter) as never,
  });
  return { cli, store, released, reported, get current() { return current; } };
}

test("un checkpoint sin verificar se descarta si la issue ya se cerró por fuera, y libera la claim propia", async () => {
  const state = harness(
    checkpoint(),
    async (issue) => ({ ...fakeSelectedIssue(issue), state: "CLOSED", assignees: [{ login: "elvis" }] }),
  );
  const previous = getDefaultReporter();

  try {
    expect(await state.cli.run(["code", "--working-directory", "/repo"])).toBe(0);
  } finally {
    setDefaultReporter(previous);
  }

  expect(state.current).toBeNull();
  expect(state.released).toEqual([{ issue: 178, login: "elvis" }]);
  expect(state.reported.join("")).toContain("ya está cerrado sin PR asociado");
});

test("un checkpoint huérfano no toca la claim de otra identidad", async () => {
  const state = harness(
    checkpoint(),
    async (issue) => ({ ...fakeSelectedIssue(issue), state: "CLOSED", assignees: [{ login: "otra-persona" }] }),
  );
  const previous = getDefaultReporter();

  try {
    await state.cli.run(["code", "--working-directory", "/repo"]);
  } finally {
    setDefaultReporter(previous);
  }

  expect(state.released).toEqual([]);
});

test("una entrega ya verificada no se descarta aunque la issue figure cerrada", async () => {
  // Con commit fijado hay efectos deterministas pendientes —o ya hechos— que reconciliar; el
  // checkpoint es la entrega en vuelo, no un huérfano.
  const state = harness(
    checkpoint({ commit: "a".repeat(40) }),
    async (issue) => ({ ...fakeSelectedIssue(issue), state: "CLOSED", assignees: [{ login: "elvis" }] }),
  );
  const previous = getDefaultReporter();

  try {
    await state.cli.run(["code", "--working-directory", "/repo"]);
  } finally {
    setDefaultReporter(previous);
  }

  expect(state.released).toEqual([]);
});

test("si GitHub no puede consultarse, el checkpoint se conserva", async () => {
  const state = harness(checkpoint(), async () => { throw new Error("gh no responde"); });
  const previous = getDefaultReporter();

  try {
    await state.cli.run(["code", "--working-directory", "/repo"]);
  } finally {
    setDefaultReporter(previous);
  }

  expect(state.current).not.toBeNull();
  expect(state.released).toEqual([]);
});
