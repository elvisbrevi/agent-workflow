import { expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCli } from "./_helpers/create-cli.ts";
import { buildCli } from "../src/cli/parse-cli-options.ts";
import { AgentResult } from "../src/coding-agent/agent-result.ts";
import type { AgentCli } from "../src/coding-agent/agent-cli.ts";
import type { AgentExecution, AgentResumeOverrides, AgentRunOptions, CodingAgent } from "../src/coding-agent/coding-agent.ts";
import type { GitRunner } from "../src/git/git-ticket-branch-cleaner.ts";
import type { GitHubCheckpointStore, GitHubDeliveryCheckpoint } from "../src/github/github-delivery-checkpoint.ts";
import type { GitHubDeliveryAdapter } from "../src/github/github-delivery-service.ts";
import { IMPLEMENTATION_READY_MARKER } from "../src/prompts/workflow-contract.ts";
import { fakeGitHubDelivery, fakeGitHubRepositoryLock } from "./_helpers/github-delivery-fixtures.ts";
import { fakeSelectedIssue, fakeSelectedOutcome, queueAdapter } from "./_helpers/managed-queue-fixtures.ts";

const azure = {
  getHuInfo: async () => { throw new Error("must not use Azure"); },
  waitForAccess: async () => undefined,
};

const COMMIT = "c".repeat(40);
const UNCOMMITTED = " M src/cambio-sin-commitear.ts";

function agentResult(text: string, sessionId: string): AgentResult {
  return AgentResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: sessionId,
    part: { type: "text", text },
  }));
}

/** The session died because the provider itself ran out, as the adapters classify it. */
function exhausted(model: string, cli = "OpenCode"): AgentExecution {
  return {
    result: agentResult("lo que dijo la sesión agotada", "ses_178"),
    azureLoginRequired: false,
    failed: true,
    exhaustion: { cli, model, cause: "rate_limit" },
  };
}

/**
 * One fake agent per CLI, recording which CLI was asked to open or resume what:
 * a handoff is readable as a fresh session started on the other CLI, and a
 * same-CLI descent as a resume on the one that already owns the session.
 */
function scriptedAgents(
  runs: Partial<Record<AgentCli, AgentExecution[]>> = {},
  resumes: Array<AgentResult | Error> = [],
) {
  const started: Array<{ cli: AgentCli; options: AgentRunOptions }> = [];
  const resumed: Array<{ cli: AgentCli; sessionId: string; overrides: AgentResumeOverrides }> = [];
  const pending: Record<string, AgentExecution[]> = {
    opencode: [...(runs.opencode ?? [])],
    claudecode: [...(runs.claudecode ?? [])],
    codex: [...(runs.codex ?? [])],
  };
  const pendingResumes = [...resumes];
  return {
    started,
    resumed,
    source: (cli: AgentCli): CodingAgent => ({
      run: async (options) => {
        started.push({ cli, options });
        return pending[cli]?.shift()
          ?? { result: agentResult(IMPLEMENTATION_READY_MARKER, `ses_${cli}`), azureLoginRequired: false, failed: false };
      },
      resume: async (sessionId, _prompt, _workingDirectory, _marker, overrides = {}) => {
        resumed.push({ cli, sessionId, overrides });
        const next = pendingResumes.shift();
        if (next instanceof Error) throw next;
        return next ?? agentResult(IMPLEMENTATION_READY_MARKER, sessionId);
      },
    }),
  };
}

function checkpointStore(): GitHubCheckpointStore & { written: GitHubDeliveryCheckpoint[] } {
  const written: GitHubDeliveryCheckpoint[] = [];
  let current: GitHubDeliveryCheckpoint | null = null;
  return {
    written,
    read: async () => current,
    write: async (value) => { current = value; written.push(value); },
    clear: async () => { current = null; },
  };
}

/** A worktree with one commit and one uncommitted file, so the verified progress has both. */
const fakeGit: GitRunner = async (args) => {
  if (args[0] === "log") return `${COMMIT} feat: lo que la sesión agotada alcanzó a commitear\n`;
  if (args[0] === "status") return `${UNCOMMITTED}\n`;
  return "";
};

async function runDelivery(
  agents: ReturnType<typeof scriptedAgents>,
  args: string[],
  store: GitHubCheckpointStore = checkpointStore(),
  delivery: GitHubDeliveryAdapter = fakeGitHubDelivery(),
  git: GitRunner = fakeGit,
  issues: number[] = [178],
): Promise<number> {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    return await createCli({
      huInfoService: azure,
      agentSource: agents.source,
      git,
      cliParser: buildCli(() => true),
      githubManagedQueue: {
        ...queueAdapter(issues.map((issue) => fakeSelectedOutcome(issue))),
        reconcileClaimedIssue: async (issue: number) => fakeSelectedIssue(issue),
      },
      githubCheckpointStore: store,
      githubRepositoryLock: fakeGitHubRepositoryLock(),
      githubDelivery: delivery,
    }).run(["code", "--working-directory", "/repo", ...args]);
  } finally {
    console.log = originalLog;
  }
}

test("un agotamiento con respaldo de otro CLI continúa la misma unidad en una sesión fresca del CLI nuevo", async () => {
  const agents = scriptedAgents({ opencode: [exhausted("provider/primario")] });

  const code = await runDelivery(agents, ["--fallback", "claudecode:claude-opus-5:high"]);

  expect(code).toBe(0);
  // No hay sesión que reanudar en el CLI nuevo: el trabajo continúa con un traspaso.
  expect(agents.resumed).toEqual([]);
  expect(agents.started.map(({ cli }) => cli)).toEqual(["opencode", "claudecode"]);
  const handoff = agents.started[1]?.options;
  expect(handoff?.model).toBe("claude-opus-5");
  expect(handoff?.variant).toBe("high");
  expect(handoff?.session).toBeNull();
});

test("la sesión traspasada recibe el mismo trabajo fijado que la original", async () => {
  const agents = scriptedAgents({ opencode: [exhausted("provider/primario")] });

  await runDelivery(agents, ["--fallback", "claudecode:claude-opus-5:high"]);

  const prompt = agents.started[1]?.options.prompt ?? "";
  expect(prompt).toContain("/implement the issue #178");
  expect(prompt).toContain("Rama: refs/heads/issue/178");

});

test("la sección de avance se arma con estado verificado y no con el texto de la sesión agotada", async () => {
  const agents = scriptedAgents({ opencode: [exhausted("provider/primario")] });

  await runDelivery(agents, ["--fallback", "claudecode:claude-opus-5:high"]);

  const prompt = agents.started[1]?.options.prompt ?? "";
  expect(prompt).toContain("Rama: refs/heads/issue/178");
  expect(prompt).toContain("Commits en esta rama:");
  expect(prompt).toContain(COMMIT);
  expect(prompt).not.toContain("lo que dijo la sesión agotada");
});


test("una rama sin commits todavía se dice como ausencia, no como el commit de la base", async () => {
  const agents = scriptedAgents({ opencode: [exhausted("provider/primario")] });
  const emptyBranch: GitRunner = async (args) => {
    if (args[0] === "log") throw new Error("fatal: your current branch does not have any commits yet");
    return "";
  };

  await runDelivery(
    agents,
    ["--fallback", "claudecode:claude-opus-5:high"],
    checkpointStore(),
    fakeGitHubDelivery(),
    emptyBranch,
  );

  const prompt = agents.started[1]?.options.prompt ?? "";
  expect(prompt).toContain("Todavía no hay commits en esta rama.");
});


test("una rama sin commits propios sobre una base con historia dice la ausencia, no el commit de la base", async () => {
  const agents = scriptedAgents({ opencode: [exhausted("provider/primario")] });
  // La base tiene historia y la rama de entrega todavía no commiteó nada propio:
  // `log -1` sin rango contestaría el tip de la base, que no es avance de la unidad.
  const noOwnCommits: GitRunner = async (args) => {
    if (args[0] === "log") return args.some((arg) => arg.includes("..")) ? "" : `${COMMIT} feat: el último commit de la base\n`;
    return "";
  };

  await runDelivery(
    agents,
    ["--fallback", "claudecode:claude-opus-5:high"],
    checkpointStore(),
    fakeGitHubDelivery(),
    noOwnCommits,
  );

  const prompt = agents.started[1]?.options.prompt ?? "";
  expect(prompt).toContain("Todavía no hay commits en esta rama.");
  expect(prompt).not.toContain(COMMIT);
});

test("la sesión traspasada arranca con el perfil de autoridad en el formato del CLI nuevo", async () => {
  const agents = scriptedAgents({ opencode: [exhausted("provider/primario")] });

  await runDelivery(agents, ["--fallback", "claudecode:claude-opus-5:high"]);

  const authority = agents.started[1]?.options.agent;
  expect(authority?.profile).toBe("lazy-github-code");
  expect(authority?.configPath).toEndWith("claudecode/lazy-github-code.json");
});




test("un agotamiento con respaldo en Codex continúa la misma unidad en una sesión fresca de Codex", async () => {
  const agents = scriptedAgents({ opencode: [exhausted("provider/primario")] });

  const code = await runDelivery(agents, ["--fallback", "codex:gpt-5.6-sol:high"]);

  expect(code).toBe(0);
  // Codex no tiene sesión que reanudar: el trabajo continúa con un traspaso,
  // igual que hacia cualquier otro CLI (issue #301).
  expect(agents.resumed).toEqual([]);
  expect(agents.started.map(({ cli }) => cli)).toEqual(["opencode", "codex"]);
  const handoff = agents.started[1]?.options;
  expect(handoff?.model).toBe("gpt-5.6-sol");
  expect(handoff?.variant).toBe("high");
  expect(handoff?.session).toBeNull();
  expect(handoff?.agent?.configPath).toEndWith("codex/lazy-github-code.rules");
  expect(handoff?.prompt).toContain("/implement the issue #178");
});

test("un agotamiento en Codex con respaldo de otro CLI continúa la misma unidad en una sesión fresca del CLI nuevo", async () => {
  const agents = scriptedAgents({ codex: [exhausted("gpt-5.6-sol", "Codex")] });

  const code = await runDelivery(agents, ["--cli", "codex", "--fallback", "claudecode:claude-opus-5:high"]);

  expect(code).toBe(0);
  // Un escalón Codex agotado desciende como cualquier otro: hacia otro CLI hay
  // un traspaso, no una reanudación (issue #301).
  expect(agents.resumed).toEqual([]);
  expect(agents.started.map(({ cli }) => cli)).toEqual(["codex", "claudecode"]);
  const handoff = agents.started[1]?.options;
  expect(handoff?.model).toBe("claude-opus-5");
  expect(handoff?.variant).toBe("high");
  expect(handoff?.session).toBeNull();
  expect(handoff?.agent?.configPath).toEndWith("claudecode/lazy-github-code.json");
});

test("un agotamiento posterior al traspaso reanuda la sesión nueva con la autoridad del CLI nuevo", async () => {
  const agents = scriptedAgents({
    opencode: [exhausted("provider/primario")],
    claudecode: [{
      result: agentResult("el traspaso tampoco tiene cupo", "ses_claudecode"),
      azureLoginRequired: false,
      failed: true,
      exhaustion: { cli: "Claude Code", model: "claude-opus-5", cause: "usage_limit" },
    }],
  });

  const code = await runDelivery(agents, [
    "--fallback", "claudecode:claude-opus-5:high",
    "--fallback", "claudecode:claude-sonnet-5:medium",
  ]);

  expect(code).toBe(0);
  // Un escalón más dentro del mismo CLI sigue siendo un traspaso: sesión fresca, mismo prompt,
  // misma sección de avance (ADR-0039). Reanudar replayaba la transcripción entera.
  expect(agents.started).toHaveLength(3);
  expect(agents.resumed).toHaveLength(0);
  expect(agents.started[2]?.cli).toBe("claudecode");
  expect(agents.started[2]?.options.session).toBeNull();
  expect(agents.started[2]?.options.model).toBe("claude-sonnet-5");
  expect(agents.started[2]?.options.agent?.configPath).toEndWith("claudecode/lazy-github-code.json");
});







test("la unidad siguiente vuelve a arrancar en el CLI primario", async () => {
  const agents = scriptedAgents({ opencode: [exhausted("provider/primario")] });

  const code = await runDelivery(
    agents,
    ["--fallback", "claudecode:claude-opus-5:high"],
    checkpointStore(),
    fakeGitHubDelivery(),
    fakeGit,
    [178, 179],
  );

  expect(code).toBe(0);
  expect(agents.started.map(({ cli }) => cli)).toEqual(["opencode", "claudecode", "opencode"]);
});
