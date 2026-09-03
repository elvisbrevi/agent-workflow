import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createCli } from "./_helpers/create-cli.ts";
import { AgentResult } from "../src/coding-agent/agent-result.ts";
import type { AgentCli } from "../src/coding-agent/agent-cli.ts";
import type { AgentResumeOverrides, CodingAgent } from "../src/coding-agent/coding-agent.ts";
import { AgentExhaustionError } from "../src/coding-agent/coding-agent.ts";
import { buildCli } from "../src/cli/parse-cli-options.ts";
import type { AutocodeCheckpointStore, VersionedAutocodeCheckpoint } from "../src/azure/autocode-checkpoint.ts";
import type { GitHubCheckpointStore, GitHubDeliveryCheckpoint } from "../src/github/github-delivery-checkpoint.ts";
import type { GitHubDeliveryAdapter } from "../src/github/github-delivery-service.ts";
import type { GitHubWorkspaceCheckpoint } from "../src/github/github-workspace-checkpoint.ts";
import type { GitHubRepositoryLockBoundary } from "../src/github/github-repository-lock.ts";
import type { GitRunner } from "../src/git/git-ticket-branch-cleaner.ts";
import { captureReporter } from "./_helpers/reporter-capture.ts";
import { fakeSelectedIssue } from "./_helpers/managed-queue-fixtures.ts";
import { createAzureWorkspaceHarness, hu, integrationBranch, remoteUrlA, remoteUrlB, ticket, ticketBranch } from "./_helpers/azure-workspace-fixtures.ts";

/** Records which CLI the run resolved and never lets a session actually open. */
function spyingAgents(): {
  requested: AgentCli[];
  resumed: AgentCli[];
  overrides: AgentResumeOverrides[];
  source: (cli: AgentCli) => CodingAgent;
} {
  const requested: AgentCli[] = [];
  const resumed: AgentCli[] = [];
  const overrides: AgentResumeOverrides[] = [];
  // The resumed session reports its terminal marker, so a recovery run ends
  // instead of retrying while the assertion only cares about which CLI resumed.
  const result = AgentResult.fromJsonLines(JSON.stringify({
    type: "text", sessionID: "ses_recovered", part: { type: "text", text: "IMPLEMENTATION_READY" },
  }));
  return {
    requested,
    resumed,
    overrides,
    source: (cli) => {
      requested.push(cli);
      return {
        run: async () => { throw new Error("recovery must resume, never start a session"); },
        resume: async (_session, _prompt, _directory, _marker, resumeOverrides = {}) => {
          resumed.push(cli);
          overrides.push(resumeOverrides);
          return result;
        },
      };
    },
  };
}

const azure = {
  getHuInfo: async () => { throw new Error("must not use Azure"); },
  waitForAccess: async () => undefined,
};

function githubDeliveryCheckpoint(cli: AgentCli): GitHubDeliveryCheckpoint {
  return {
    schemaVersion: 2,
    cli,
    workflow: "github-code",
    repository: "owner/repo",
    issue: 178,
    phase: "implementing",
    branch: null,
    sessionId: "ses_recovered",
    commit: null,
    pullRequest: null,
    receipts: {},
  };
}

function githubDeliveryCli(
  checkpoint: GitHubDeliveryCheckpoint,
  agents: ReturnType<typeof spyingAgents>,
  options: {
    onWrite?: (checkpoint: GitHubDeliveryCheckpoint) => void;
    onClear?: () => void;
    nextIssue?: number;
    readIssueDetail?: (issueNumber: number) => Promise<ReturnType<typeof fakeSelectedIssue>>;
    verifyAuthentication?: () => Promise<{ login: string }>;
    githubDelivery?: GitHubDeliveryAdapter;
  } = {},
) {
  let current: GitHubDeliveryCheckpoint | null = checkpoint;
  const store: GitHubCheckpointStore = {
    read: async () => current,
    write: async (value) => { current = value; options.onWrite?.(value); },
    clear: async () => { current = null; options.onClear?.(); },
  };
  const pending = options.nextIssue === undefined ? [] : [options.nextIssue];
  const lock: GitHubRepositoryLockBoundary = { acquire: async () => async () => undefined };
  const { reporterFn, messages: reported } = captureReporter();
  const released: Array<{ issue: number; login: string }> = [];
  const cli = createCli({
    huInfoService: azure,
    agentSource: agents.source,
    cliParser: buildCli(() => true),
    createReporterFn: reporterFn,
    githubManagedQueue: {
      reconcileClaimedIssue: async () => fakeSelectedIssue(178),
      readIssueDetail: options.readIssueDetail ?? (async (issue: number) => fakeSelectedIssue(issue)),
      selectEligibleIssue: async () => {
        const issue = pending.shift();
        return issue === undefined
          ? { kind: "empty" as const }
          : { kind: "candidate" as const, issue: fakeSelectedIssue(issue), repository: { nameWithOwner: "owner/repo" } };
      },
      claimSelectedIssue: async (issue: number) => fakeSelectedIssue(issue),
      selectAndClaimEligibleIssue: async () => ({ kind: "empty" as const }),
      verifyAuthentication: options.verifyAuthentication ?? (async () => ({ login: "elvis" })),
      releaseOwnClaim: async (issue: number, login: string) => { released.push({ issue, login }); },
    },
    githubCheckpointStore: store,
    githubRepositoryLock: lock,
    githubDelivery: options.githubDelivery,
  });
  return { cli, store, reported, released, get current() { return current; } };
}

test("la entrega GitHub reanuda con el CLI que fijó el checkpoint", async () => {
  const agents = spyingAgents();
  const { cli } = githubDeliveryCli(githubDeliveryCheckpoint("claudecode"), agents);

  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await cli.run(["code", "--working-directory", "/repo"]);
  } finally {
    console.log = originalLog;
  }

  expect(agents.resumed).toEqual(["claudecode"]);
});

test("un --cli que contradice el checkpoint GitHub falla cerrado y lo conserva", async () => {
  const agents = spyingAgents();
  const checkpoint = githubDeliveryCheckpoint("claudecode");
  const state = githubDeliveryCli(checkpoint, agents);

  expect(await state.cli.run(["code", "--cli", "opencode", "--working-directory", "/repo"])).toBe(1);
  expect(agents.resumed).toEqual([]);
  expect(state.current).toEqual(checkpoint);
});

test("el rechazo de un --cli contradictorio nombra el CLI del checkpoint y cómo reanudar", async () => {
  const state = githubDeliveryCli(githubDeliveryCheckpoint("claudecode"), spyingAgents());

  await state.cli.run(["code", "--cli", "opencode", "--working-directory", "/repo"]);

  const rejection = state.reported.join("");
  expect(rejection).toContain("el checkpoint pertenece al CLI claudecode");
  expect(rejection).toContain("--cli claudecode");
});

test("un checkpoint sin sesión ni PR se descarta si el issue ya fue cerrado por fuera, sin bloquear por --cli, y libera la claim propia", async () => {
  const agents = spyingAgents();
  let cleared = false;
  const state = githubDeliveryCli(
    { ...githubDeliveryCheckpoint("opencode"), sessionId: null, phase: "started", pullRequest: null },
    agents,
    {
      onClear: () => { cleared = true; },
      readIssueDetail: async (issue) => ({ ...fakeSelectedIssue(issue), state: "CLOSED", assignees: [{ login: "elvis" }] }),
    },
  );

  const code = await state.cli.run(["code", "--cli", "claudecode", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(cleared).toBeTrue();
  expect(agents.resumed).toEqual([]);
  expect(state.current).toBeNull();
  expect(state.released).toEqual([{ issue: 178, login: "elvis" }]);
  expect(state.reported.some((message) => message.includes("el checkpoint pertenece al CLI"))).toBeFalse();
  const report = state.reported.join("");
  expect(report).toContain("ya está cerrado sin PR asociado");
  expect(report).toContain('fase "started"');
  expect(report).toContain("fecha desconocida");
});

test("un checkpoint huérfano no toca la claim de otra identidad", async () => {
  const agents = spyingAgents();
  const state = githubDeliveryCli(
    { ...githubDeliveryCheckpoint("opencode"), sessionId: null, phase: "started", pullRequest: null },
    agents,
    {
      readIssueDetail: async (issue) => ({ ...fakeSelectedIssue(issue), state: "CLOSED", assignees: [{ login: "another-runner" }] }),
    },
  );

  const code = await state.cli.run(["code", "--cli", "claudecode", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(state.released).toEqual([]);
  expect(state.current).toBeNull();
});

test("un checkpoint reporta la fase y la antigüedad del receipt más viejo al descartarse", async () => {
  const agents = spyingAgents();
  const checkpoint = {
    ...githubDeliveryCheckpoint("opencode"),
    sessionId: null,
    phase: "implementing" as const,
    pullRequest: null,
    receipts: {
      "issue-claim": { verifiedAt: "2026-08-15T03:40:15.330Z" },
      "branch-prepared": { verifiedAt: "2026-08-15T04:10:00.000Z" },
    },
  };
  const state = githubDeliveryCli(checkpoint, agents, {
    readIssueDetail: async (issue) => ({ ...fakeSelectedIssue(issue), state: "CLOSED" }),
  });

  await state.cli.run(["code", "--cli", "claudecode", "--working-directory", "/repo"]);

  const report = state.reported.join("");
  expect(report).toContain('fase "implementing"');
  expect(report).toContain("2026-08-15T03:40:15.330Z");
});

test("si GitHub no puede consultarse, el checkpoint se conserva y no se reanuda ni se asume que el issue está cerrado", async () => {
  const agents = spyingAgents();
  let cleared = false;
  const checkpoint = { ...githubDeliveryCheckpoint("opencode"), sessionId: null, phase: "started" as const, pullRequest: null };
  const state = githubDeliveryCli(checkpoint, agents, {
    onClear: () => { cleared = true; },
    readIssueDetail: async () => { throw new Error("gh api falló"); },
  });

  expect(await state.cli.run(["code", "--cli", "opencode", "--working-directory", "/repo"])).toBe(1);

  expect(cleared).toBeFalse();
  expect(state.released).toEqual([]);
  expect(agents.resumed).toEqual([]);
  const rejection = state.reported.join("");
  expect(rejection).toContain("no se pudo coordinar la entrega GitHub");
});

test("un estado GitHub desconocido conserva el checkpoint y no lo trata como cerrado", async () => {
  const agents = spyingAgents();
  let cleared = false;
  const checkpoint = { ...githubDeliveryCheckpoint("opencode"), sessionId: null, phase: "started" as const, pullRequest: null };
  const state = githubDeliveryCli(checkpoint, agents, {
    onClear: () => { cleared = true; },
    readIssueDetail: async (issue) => ({ ...fakeSelectedIssue(issue), state: "UNKNOWN" }),
  });

  expect(await state.cli.run(["code", "--working-directory", "/repo"])).toBe(1);

  expect(cleared).toBeFalse();
  expect(state.current).toEqual(checkpoint);
  expect(agents.resumed).toEqual([]);
});

test("un checkpoint sin sesión pero con un PR propio no se descarta aunque el issue ya esté cerrado", async () => {
  const agents = spyingAgents();
  let cleared = false;
  const checkpoint = { ...githubDeliveryCheckpoint("opencode"), sessionId: null, phase: "started" as const, pullRequest: 42 };
  const state = githubDeliveryCli(checkpoint, agents, {
    onClear: () => { cleared = true; },
    readIssueDetail: async (issue) => ({ ...fakeSelectedIssue(issue), state: "CLOSED" }),
  });

  await state.cli.run(["code", "--cli", "claudecode", "--working-directory", "/repo"]);

  expect(cleared).toBeFalse();
  const rejection = state.reported.join("");
  expect(rejection).toContain("el checkpoint pertenece al CLI opencode");
});

test("un checkpoint sin sesión ni PR con el issue todavía abierto conserva el bloqueo por --cli", async () => {
  const agents = spyingAgents();
  let cleared = false;
  const checkpoint = { ...githubDeliveryCheckpoint("opencode"), sessionId: null, phase: "started" as const, pullRequest: null };
  const state = githubDeliveryCli(checkpoint, agents, {
    onClear: () => { cleared = true; },
    readIssueDetail: async (issue) => ({ ...fakeSelectedIssue(issue), state: "OPEN" }),
  });

  await state.cli.run(["code", "--cli", "claudecode", "--working-directory", "/repo"]);

  expect(cleared).toBeFalse();
  const rejection = state.reported.join("");
  expect(rejection).toContain("el checkpoint pertenece al CLI opencode");
});

test("un --variant que el CLI adoptado no acepta detiene el run antes de reanudar y conserva el checkpoint", async () => {
  const agents = spyingAgents();
  const checkpoint = githubDeliveryCheckpoint("claudecode");
  const state = githubDeliveryCli(checkpoint, agents);

  expect(await state.cli.run(["code", "--variant", "turbo", "--working-directory", "/repo"])).toBe(1);
  expect(agents.resumed).toEqual([]);
  expect(state.current).toEqual(checkpoint);

  const rejection = state.reported.join("");
  expect(rejection).toContain("claudecode");
  expect(rejection).toContain("turbo");
  expect(rejection).toContain("xhigh");
});

test("un --model y un --variant que el CLI adoptado acepta le ganan al escalón del checkpoint", async () => {
  const agents = spyingAgents();
  const state = githubDeliveryCli(
    { ...githubDeliveryCheckpoint("claudecode"), model: "claude-sonnet-5", variant: "low" },
    agents,
  );

  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await state.cli.run(["code", "--model", "claude-opus-5", "--variant", "xhigh", "--working-directory", "/repo"]);
  } finally {
    console.log = originalLog;
  }

  expect(agents.resumed).toEqual(["claudecode"]);
  expect(agents.overrides).toEqual([expect.objectContaining({ model: "claude-opus-5", variant: "xhigh" })]);
});

test("un --variant explícito sin --model le gana a la variante del escalón, que es lo que se validó al adoptar", async () => {
  const agents = spyingAgents();
  const state = githubDeliveryCli(
    { ...githubDeliveryCheckpoint("claudecode"), model: "claude-sonnet-5", variant: "low" },
    agents,
  );

  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await state.cli.run(["code", "--variant", "xhigh", "--working-directory", "/repo"]);
  } finally {
    console.log = originalLog;
  }

  expect(agents.overrides).toEqual([expect.objectContaining({ model: "claude-sonnet-5", variant: "xhigh" })]);
});

test("un --model declarado junto a un --cli no viaja al CLI que el traspaso adoptó", async () => {
  // La invocación declaró claudecode y su modelo; el traspaso movió la sesión a
  // opencode. Ese `--model` está escrito en el vocabulario del CLI que ya no
  // tiene el trabajo: aplicarlo reanudaba opencode con `claude-sonnet-5`.
  const agents = spyingAgents();
  const state = githubDeliveryCli(
    {
      ...githubDeliveryCheckpoint("opencode"),
      handoffFrom: "claudecode",
      model: "github-copilot/gpt-5.5",
      variant: "high",
    },
    agents,
  );

  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await state.cli.run([
      "code", "--cli", "claudecode", "--model", "claude-sonnet-5", "--working-directory", "/repo",
    ]);
  } finally {
    console.log = originalLog;
  }

  expect(agents.resumed).toEqual(["opencode"]);
  expect(agents.overrides).toEqual([expect.objectContaining({ model: "github-copilot/gpt-5.5", variant: "high" })]);
  expect(state.reported.some((message) => message.includes("--model claude-sonnet-5 quedó declarado para claudecode"))).toBeTrue();
});

test("un --model declarado junto al --cli que sí tiene el trabajo le sigue ganando al escalón", async () => {
  // El operador nombra explícitamente el CLI adoptado: ahí el modelo y el CLI
  // vuelven a ser un par, y el par manda.
  const agents = spyingAgents();
  const state = githubDeliveryCli(
    {
      ...githubDeliveryCheckpoint("opencode"),
      handoffFrom: "claudecode",
      model: "github-copilot/gpt-5.5",
      variant: "high",
    },
    agents,
  );

  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await state.cli.run([
      "code", "--cli", "opencode", "--model", "github-copilot/gpt-5.6", "--working-directory", "/repo",
    ]);
  } finally {
    console.log = originalLog;
  }

  expect(agents.overrides).toEqual([expect.objectContaining({ model: "github-copilot/gpt-5.6" })]);
});

test("sin overrides explícitos la recuperación reanuda con el escalón que el checkpoint conserva", async () => {
  const agents = spyingAgents();
  const state = githubDeliveryCli(
    { ...githubDeliveryCheckpoint("claudecode"), model: "claude-sonnet-5", variant: "low" },
    agents,
  );

  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await state.cli.run(["code", "--working-directory", "/repo"]);
  } finally {
    console.log = originalLog;
  }

  expect(agents.resumed).toEqual(["claudecode"]);
  expect(agents.overrides).toEqual([expect.objectContaining({ model: "claude-sonnet-5", variant: "low" })]);
});

test("`code --session` reanuda con el CLI del checkpoint GitHub y rechaza uno contradictorio", async () => {
  const adopted = spyingAgents();
  const contradicted = spyingAgents();
  const checkpoint = githubDeliveryCheckpoint("claudecode");
  const state = githubDeliveryCli(checkpoint, adopted);
  const rejected = githubDeliveryCli(githubDeliveryCheckpoint("claudecode"), contradicted);

  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await state.cli.run(["code", "--session", "ses_recovered", "--prompt", "continue", "--working-directory", "/repo"]);
    expect(await rejected.cli.run([
      "code", "--session", "ses_recovered", "--prompt", "continue", "--cli", "opencode", "--working-directory", "/repo",
    ])).toBe(1);
  } finally {
    console.log = originalLog;
  }

  expect(adopted.resumed).toEqual(["claudecode"]);
  expect(contradicted.resumed).toEqual([]);
  expect(rejected.current).toEqual(checkpoint);
});

test("la unidad siguiente a una recuperación fija el CLI que realmente la ejecuta", async () => {
  const agents = spyingAgents();
  const written: string[] = [];
  const state = githubDeliveryCli(githubDeliveryCheckpoint("claudecode"), agents, {
    onWrite: (checkpoint) => written.push(checkpoint.cli),
    nextIssue: 179,
  });

  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await state.cli.run(["code", "--working-directory", "/repo"]);
  } finally {
    console.log = originalLog;
  }

  expect(agents.resumed).toEqual(["claudecode"]);
  expect(written).not.toContain("opencode");
});

test("un agotamiento al reanudar el Issue GitHub con --session desciende al mismo CLI con el modelo del escalón nuevo", async () => {
  const resumed: Array<{ model?: string; variant?: string }> = [];
  const agentSource = (): CodingAgent => ({
    run: async () => { throw new Error("must not start a fresh session: --session recovery must resume"); },
    resume: async (sessionId, _prompt, _directory, _marker, overrides = {}) => {
      resumed.push({ model: overrides.model, variant: overrides.variant });
      if (resumed.length === 1) {
        throw new AgentExhaustionError(
          { cli: "OpenCode", model: "opencode-go/deepseek-v4-pro", cause: "rate_limit" },
          AgentResult.fromJsonLines(JSON.stringify({ type: "text", sessionID: sessionId, part: { type: "text", text: "agotado" } })),
        );
      }
      return AgentResult.fromJsonLines(JSON.stringify({ type: "text", sessionID: sessionId, part: { type: "text", text: "IMPLEMENTATION_READY" } }));
    },
  });
  const state = githubDeliveryCli(githubDeliveryCheckpoint("opencode"), { requested: [], resumed: [], overrides: [], source: agentSource });

  const originalLog = console.log;
  console.log = () => undefined;
  let exit = -1;
  try {
    exit = await state.cli.run([
      "code", "--session", "ses_recovered", "--cli", "opencode", "--model", "opencode-go/deepseek-v4-pro",
      "--fallback", "opencode:opencode-go/deepseek-v4-cheap:high", "--working-directory", "/repo",
    ]);
  } finally {
    console.log = originalLog;
  }

  expect(resumed).toHaveLength(2);
  expect(resumed[1]?.model).toBe("opencode-go/deepseek-v4-cheap");
  expect(resumed[1]?.variant).toBe("high");
  expect(exit).toBe(0);
});

test("un agotamiento al reanudar el Issue GitHub con --session desciende a otro CLI mediante traspaso", async () => {
  const resumed: string[] = [];
  const started: Array<{ cli: AgentCli; session: string | null }> = [];
  const agentSource = (cli: AgentCli): CodingAgent => ({
    run: async (options) => {
      started.push({ cli, session: options.session });
      return {
        result: AgentResult.fromJsonLines(JSON.stringify({ type: "text", sessionID: "ses_new", part: { type: "text", text: "IMPLEMENTATION_READY" } })),
        azureLoginRequired: false,
        failed: false,
      };
    },
    resume: async (sessionId) => {
      resumed.push(sessionId);
      throw new AgentExhaustionError(
        { cli: "Claude Code", model: "claude-sonnet-5", cause: "session_limit" },
        AgentResult.fromJsonLines(JSON.stringify({ type: "text", sessionID: sessionId, part: { type: "text", text: "You've hit your session limit" } })),
      );
    },
  });
  const checkpoint: GitHubDeliveryCheckpoint = {
    ...githubDeliveryCheckpoint("claudecode"),
    branch: "refs/heads/issue/178",
    baseBranch: "refs/heads/main",
    manifestPath: "/repo/lazy-workflow/completion-manifest.json",
  };
  const state = githubDeliveryCli(checkpoint, { requested: [], resumed: [], overrides: [], source: agentSource });

  const originalLog = console.log;
  console.log = () => undefined;
  let exit = -1;
  try {
    exit = await state.cli.run([
      "code", "--session", "ses_recovered", "--cli", "claudecode", "--model", "claude-sonnet-5",
      "--fallback", "opencode:github-copilot/gpt-5.5:high", "--working-directory", "/repo",
    ]);
  } finally {
    console.log = originalLog;
  }

  expect(resumed).toEqual(["ses_recovered"]);
  expect(started.map(({ cli: startedCli }) => startedCli)).toEqual(["opencode"]);
  expect(started[0]?.session).toBeNull();
  expect(exit).toBe(0);
});

/**
 * A `GitHubDeliveryAdapter` that completes the first unit's own delivery (issue 178, on
 * whatever branch its checkpoint fixed) and hands the second unit (issue 179) a fresh
 * branch to prepare into. The second unit's session never gets far enough to need more
 * than `prepareBranch`: the test's fake agent throws right after recording which CLI
 * opened it.
 */
function deliveryAdapterStub(firstUnitBranch: string): GitHubDeliveryAdapter {
  return {
    prepareBranch: async (issue) => ({
      branch: `refs/heads/issue/${issue}`,
      baseBranch: "refs/heads/main",
      manifestPath: `/repo/lazy-workflow/completion-manifest-${issue}.json`,
    }),
    readManifest: async () => ({
      issue: 178,
      branch: firstUnitBranch,
      commit: "c".repeat(40),
      validation: [],
      clean: true,
      summary: "ok",
    }),
    pushCommit: async () => undefined,
    createOrReusePullRequest: async () => ({ number: 1 }),
    mergePullRequest: async () => ({ number: 1, mergeCommit: "merge-1" }),
    closeIssue: async () => undefined,
    cleanupBranch: async () => undefined,
  };
}

/**
 * Runs the shared scenario both `restoreDeclaredCli` tests below need: a checkpointed
 * GitHub recovery whose only unit hits a mid-unit fallback handoff (claudecode ->
 * opencode), immediately followed by a second, freshly-selected unit (issue 179). Only
 * the run args differ between the two tests -- whether `--cli` is declared -- so this
 * carries everything else: the agent spies, the checkpoint, and the delivery stub.
 */
async function runMidUnitHandoffThenNextUnit(extraArgs: string[]): Promise<{
  resumed: string[];
  started: Array<{ cli: AgentCli; session: string | null }>;
}> {
  const resumed: string[] = [];
  const started: Array<{ cli: AgentCli; session: string | null }> = [];
  const STOP = new Error("la unidad siguiente ya abrió sesión; no hace falta seguir");
  const agentSource = (cli: AgentCli): CodingAgent => ({
    run: async (opts) => {
      started.push({ cli, session: opts.session });
      if (started.length > 1) throw STOP;
      return {
        result: AgentResult.fromJsonLines(JSON.stringify({ type: "text", sessionID: "ses_new", part: { type: "text", text: "IMPLEMENTATION_READY" } })),
        azureLoginRequired: false,
        failed: false,
      };
    },
    resume: async (sessionId) => {
      resumed.push(sessionId);
      throw new AgentExhaustionError(
        { cli: "Claude Code", model: "claude-sonnet-5", cause: "session_limit" },
        AgentResult.fromJsonLines(JSON.stringify({ type: "text", sessionID: sessionId, part: { type: "text", text: "You've hit your session limit" } })),
      );
    },
  });
  const checkpoint: GitHubDeliveryCheckpoint = {
    ...githubDeliveryCheckpoint("claudecode"),
    branch: "refs/heads/issue/178",
    baseBranch: "refs/heads/main",
    manifestPath: "/repo/lazy-workflow/completion-manifest.json",
  };
  const githubDelivery = deliveryAdapterStub("refs/heads/issue/178");
  const state = githubDeliveryCli(checkpoint, { requested: [], resumed: [], overrides: [], source: agentSource }, {
    nextIssue: 179,
    githubDelivery,
  });

  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await state.cli.run([
      "code", "--session", "ses_recovered", "--model", "claude-sonnet-5",
      "--fallback", "opencode:github-copilot/gpt-5.5:high", "--working-directory", "/repo",
      ...extraArgs,
    ]).catch(() => undefined);
  } finally {
    console.log = originalLog;
  }

  return { resumed, started };
}

test("sin --cli declarado, un traspaso a mitad de la primera unidad no deja la unidad siguiente en el CLI equivocado", async () => {
  // La primera unidad recupera un checkpoint claudecode con --session, sin --cli.
  // Un agotamiento la traspasa a opencode a mitad de la unidad (this.activeAgent se
  // mueve a opencode sin que options.cli lo refleje nunca). Sin --cli declarado no
  // hay nada que restoreDeclaredCli reconcilie explícitamente, así que antes del fix
  // dejaba this.activeAgent en opencode: la unidad siguiente abría ahí en vez de en
  // claudecode, que es lo que options.cli y el checkpoint que ella misma escribe dicen.
  const { resumed, started } = await runMidUnitHandoffThenNextUnit([]);

  expect(resumed).toEqual(["ses_recovered"]);
  expect(started[0]).toEqual({ cli: "opencode", session: null });
  expect(started[1]?.cli).toBe("claudecode");
});

test("con --cli declarado, un traspaso a mitad de la primera unidad deja la unidad siguiente en el CLI declarado aunque coincida con el adoptado", async () => {
  // Mismo traspaso mid-unit que el test anterior, pero ahora con --cli claudecode
  // declarado explícitamente -- el mismo CLI que el checkpoint ya nombraba, así que
  // declared.cli === adopted.cli. Esto guarda contra la regresión que el comentario
  // de restoreDeclaredCli ya describía: un optimizador que salte el resolveAgent
  // cuando las dos options ya "coinciden" pasaría por alto que this.activeAgent quedó
  // en opencode por el traspaso, no en claudecode.
  const { resumed, started } = await runMidUnitHandoffThenNextUnit(["--cli", "claudecode"]);

  expect(resumed).toEqual(["ses_recovered"]);
  expect(started[0]).toEqual({ cli: "opencode", session: null });
  expect(started[1]?.cli).toBe("claudecode");
});

test("una unidad sin sesion previa adopta el default de modelo del CLI del checkpoint, no el de --cli sin declarar (issue #298)", async () => {
  // Sin --cli ni --model declarados, el parseo resuelve el default de opencode
  // (DEFAULT_CLI). El checkpoint impone claudecode y la unidad todavia no tiene
  // sesion, asi que abre una nueva a traves de codingAgent.run en vez de
  // resumir -- la ruta que getResumeOverrides nunca protege. Antes del fix,
  // options.model conservaba el default de opencode ya resuelto en el parseo.
  const started: Array<{ cli: AgentCli; model?: string }> = [];
  const agentSource = (cli: AgentCli): CodingAgent => ({
    run: async (options) => {
      started.push({ cli, model: options.model });
      return {
        result: AgentResult.fromJsonLines(JSON.stringify({ type: "text", sessionID: "ses_new", part: { type: "text", text: "IMPLEMENTATION_READY" } })),
        azureLoginRequired: false,
        failed: false,
      };
    },
    resume: async () => { throw new Error("must not resume: checkpoint has no session yet"); },
  });
  const checkpoint: GitHubDeliveryCheckpoint = {
    ...githubDeliveryCheckpoint("claudecode"),
    sessionId: null,
    phase: "started",
    branch: "refs/heads/issue/178",
    baseBranch: "refs/heads/main",
    manifestPath: "/repo/lazy-workflow/completion-manifest.json",
  };
  const state = githubDeliveryCli(checkpoint, { requested: [], resumed: [], overrides: [], source: agentSource }, {
    githubDelivery: deliveryAdapterStub("refs/heads/issue/178"),
  });

  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await state.cli.run(["code", "--working-directory", "/repo"]);
  } finally {
    console.log = originalLog;
  }

  expect(started).toEqual([{ cli: "claudecode", model: "claude-sonnet-5" }]);
});

function autocodeCheckpoint(cli: AgentCli): VersionedAutocodeCheckpoint {
  return {
    schemaVersion: 3,
    cli,
    workflow: "autocode",
    phase: "implementing",
    hu: 23438,
    ticket: 51,
    integrationBranch: "refs/heads/hu/23438",
    ticketBranch: "refs/heads/ticket/51",
    azureRevision: 7,
    effortBaseline: { real: 1, realHours: 1 },
    activeDurationMs: 0,
    activeSince: null,
    sessionId: "ses_recovered",
    intent: null,
    receipts: {},
  };
}

function autocodeCli(checkpoint: VersionedAutocodeCheckpoint, agents: ReturnType<typeof spyingAgents>) {
  const writes: VersionedAutocodeCheckpoint[] = [];
  const store: AutocodeCheckpointStore = {
    read: async () => checkpoint,
    write: async (value) => { writes.push(value as VersionedAutocodeCheckpoint); },
    clear: async () => undefined,
  };
  const cli = createCli({
    huInfoService: {
      ...azure,
      getHuInfo: async () => ({ id: 23438 }),
      ensureIntegrationBranch: async () => checkpoint.integrationBranch!,
      getAutocodeContextForTicket: async () => ({ hu: { id: 23438 }, ticket: { id: 51, type: "Task" as const }, integrationBranch: checkpoint.integrationBranch! }),
      getState: async () => ({ ticket: 51, state: "En progreso", revision: 7 }),
      getEffort: async () => ({ ticket: 51, effort: { real: 1, realHours: 1 } }),
      getBranch: async () => ({ hu: 23438, ticket: 51, branch: checkpoint.ticketBranch!, integrationBranch: checkpoint.integrationBranch! }),
      setTicketBranch: async () => ({ hu: 23438, ticket: 51, branch: checkpoint.ticketBranch! }),
    },
    agentSource: agents.source,
    checkpointStore: store,
    retryTimer: { wait: async () => undefined },
    ticketBranchCleaner: { deleteTicketBranch: async () => undefined },
    cliParser: buildCli(() => true),
  });
  return { cli, writes };
}

test("la entrega Azure reanuda con el CLI que fijó el checkpoint", async () => {
  const agents = spyingAgents();
  const { cli } = autocodeCli(autocodeCheckpoint("claudecode"), agents);

  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await cli.run(["code", "--hu", "23438", "--session", "ses_recovered", "--working-directory", "/repo"]);
  } finally {
    console.log = originalLog;
  }

  expect(agents.resumed).toEqual(["claudecode"]);
});

test("un --cli que contradice el checkpoint Azure falla cerrado y lo conserva", async () => {
  const agents = spyingAgents();
  const state = autocodeCli(autocodeCheckpoint("claudecode"), agents);

  expect(await state.cli.run([
    "code", "--hu", "23438", "--session", "ses_recovered", "--working-directory", "/repo", "--cli", "opencode",
  ])).toBe(1);
  expect(agents.resumed).toEqual([]);
  expect(state.writes).toEqual([]);
});

test("un agotamiento al reanudar el ticket Azure single-repo desciende a otro CLI", async () => {
  const resumed: AgentCli[] = [];
  const started: Array<{ cli: AgentCli; session: string | null }> = [];
  const agentSource = (cli: AgentCli): CodingAgent => ({
    run: async (options) => {
      started.push({ cli, session: options.session });
      return {
        result: AgentResult.fromJsonLines(JSON.stringify({ type: "text", sessionID: "ses_new", part: { type: "text", text: "IMPLEMENTATION_READY" } })),
        azureLoginRequired: false,
        failed: false,
      };
    },
    resume: async (sessionId) => {
      resumed.push(cli);
      throw new AgentExhaustionError(
        { cli: "Claude Code", model: "claude-sonnet-5", cause: "session_limit" },
        AgentResult.fromJsonLines(JSON.stringify({ type: "text", sessionID: sessionId, part: { type: "text", text: "You've hit your session limit" } })),
      );
    },
  });
  const { cli } = autocodeCli(autocodeCheckpoint("claudecode"), { requested: [], resumed: [], overrides: [], source: agentSource });

  const originalLog = console.log;
  console.log = () => undefined;
  let exit = -1;
  try {
    exit = await cli.run([
      "code", "--hu", "23438", "--session", "ses_recovered", "--cli", "claudecode", "--model", "claude-sonnet-5",
      "--fallback", "opencode:github-copilot/gpt-5.5:high", "--working-directory", "/repo",
    ]);
  } finally {
    console.log = originalLog;
  }

  expect(resumed).toEqual(["claudecode"]);
  expect(started.map(({ cli: startedCli }) => startedCli)).toEqual(["opencode"]);
  expect(started[0]?.session).toBeNull();
  // The minimal boundary here exposes no completion primitives, so a terminal turn
  // stops with that dedicated message rather than looping — the exhaustion descent
  // itself is what these assertions cover.
  expect(exit).toBe(1);
});

test("un agotamiento al reanudar el ticket Azure single-repo desciende al mismo CLI con el modelo del escalón nuevo", async () => {
  const resumed: Array<{ cli: AgentCli; model?: string; variant?: string }> = [];
  const agentSource = (cli: AgentCli): CodingAgent => ({
    run: async () => { throw new Error("must not start a fresh session: a checkpointed one exists"); },
    resume: async (sessionId, _prompt, _directory, _marker, overrides = {}) => {
      resumed.push({ cli, model: overrides.model, variant: overrides.variant });
      if (resumed.length === 1) {
        throw new AgentExhaustionError(
          { cli: "OpenCode", model: "opencode-go/deepseek-v4-pro", cause: "rate_limit" },
          AgentResult.fromJsonLines(JSON.stringify({ type: "text", sessionID: sessionId, part: { type: "text", text: "agotado" } })),
        );
      }
      return AgentResult.fromJsonLines(JSON.stringify({ type: "text", sessionID: sessionId, part: { type: "text", text: "IMPLEMENTATION_READY" } }));
    },
  });
  const { cli } = autocodeCli(autocodeCheckpoint("opencode"), { requested: [], resumed: [], overrides: [], source: agentSource });

  const originalLog = console.log;
  console.log = () => undefined;
  let exit = -1;
  try {
    exit = await cli.run([
      "code", "--hu", "23438", "--session", "ses_recovered", "--cli", "opencode", "--model", "opencode-go/deepseek-v4-pro",
      "--fallback", "opencode:opencode-go/deepseek-v4-cheap:high", "--working-directory", "/repo",
    ]);
  } finally {
    console.log = originalLog;
  }

  expect(resumed).toHaveLength(2);
  expect(resumed[1]?.model).toBe("opencode-go/deepseek-v4-cheap");
  expect(resumed[1]?.variant).toBe("high");
  // The minimal boundary here exposes no completion primitives, so a terminal turn
  // stops with that dedicated message rather than looping — the exhaustion descent
  // itself is what these assertions cover.
  expect(exit).toBe(1);
});

async function githubWorkspace(cli: AgentCli, agents: ReturnType<typeof spyingAgents>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lazy-workflow-workspace-cli-")));
  const paths = [join(root, "repo-a"), join(root, "repo-b")];
  await Bun.$`mkdir -p ${paths[0]} ${paths[1]}`.quiet();
  const checkpoint: GitHubWorkspaceCheckpoint = {
    schemaVersion: 2,
    cli,
    workflow: "github-workspace-code",
    issue: 188,
    phase: "implementing",
    sessionId: "ses_recovered",
    branch: "refs/heads/issue/188",
    parentDirectory: root,
    repositories: paths.map((path) => ({ path, remote: `git@github.com:owner/${basename(path)}.git`, repository: `owner/${basename(path)}` })),
    units: [],
    receipts: {},
    intent: null,
  };
  const checkpointPath = join(root, ".lazy-workflow", "github-workspace-code-checkpoint.json");
  await Bun.write(checkpointPath, `${JSON.stringify(checkpoint)}\n`);
  const git: GitRunner = async (args, directory) => {
    if (args[0] === "rev-parse" && args[1] === "HEAD^{commit}") return "c".repeat(40);
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "remote") return `git@github.com:owner/${basename(directory)}.git`;
    return "";
  };
  const workflow = createCli({
    huInfoService: azure,
    agentSource: agents.source,
    git,
    cliParser: buildCli(() => true),
    githubManagedQueue: { selectAndClaimEligibleIssue: async () => ({ kind: "empty" as const }) },
  });
  return {
    workflow,
    paths,
    readCheckpoint: async (): Promise<unknown> => Bun.file(checkpointPath).json(),
    checkpoint,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("el workspace GitHub reanuda con el CLI que fijó el checkpoint", async () => {
  const agents = spyingAgents();
  const state = await githubWorkspace("claudecode", agents);
  try {
    await state.workflow.run(["code", "--working-directory", state.paths.join(",")]);
    expect(agents.resumed).toEqual(["claudecode"]);
  } finally {
    await state.cleanup();
  }
});

test("un --cli que contradice el checkpoint workspace GitHub falla cerrado y lo conserva", async () => {
  const agents = spyingAgents();
  const state = await githubWorkspace("claudecode", agents);
  try {
    expect(await state.workflow.run(["code", "--cli", "opencode", "--working-directory", state.paths.join(",")])).toBe(1);
    expect(agents.resumed).toEqual([]);
    expect(await state.readCheckpoint()).toEqual(state.checkpoint);
  } finally {
    await state.cleanup();
  }
});

test("el workspace Azure reanuda con el CLI que fijó el checkpoint y rechaza uno contradictorio", async () => {
  const requested: AgentCli[] = [];
  const harness = createAzureWorkspaceHarness({ observeCli: (cli) => requested.push(cli) });
  try {
    const { cli, pathA, pathB } = await harness.setupCli();
    await harness.writeCheckpoint({
      schemaVersion: 2,
      cli: "claudecode",
      workflow: "azure-workspace-code",
      hu,
      ticket,
      phase: "implementing",
      sessionId: "ses_recovered",
      integrationBranch,
      ticketBranch,
      parentDirectory: harness.stateDirectory().replace(/\/\.lazy-workflow$/, ""),
      activeDurationMs: 0,
      repositories: [{ path: pathA, remote: remoteUrlA }, { path: pathB, remote: remoteUrlB }],
      units: [],
      receipts: {},
      intent: null,
    });
    const scope = ["--hu", `${hu}`, "--ticket", `${ticket}`, "--working-directory", `${pathA},${pathB}`];

    expect(await cli.run(["code", ...scope, "--cli", "opencode"])).toBe(1);
    expect(harness.events).not.toContain("opencode:resume");
    expect((await harness.readCheckpoint())?.cli).toBe("claudecode");

    await cli.run(["code", ...scope]);
    expect(requested).toContain("claudecode");
    expect(harness.events).toContain("opencode:resume");
  } finally {
    await harness.cleanup();
  }
});
