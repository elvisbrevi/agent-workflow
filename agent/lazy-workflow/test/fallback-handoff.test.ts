import { expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
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
    return await new LazyWorkflowCli(
      azure,
      agents.source,
      undefined, undefined, undefined, undefined, undefined,
      git,
      undefined, undefined, undefined,
      buildCli(() => true),
      undefined,
      {
        ...queueAdapter(issues.map((issue) => fakeSelectedOutcome(issue))),
        reconcileClaimedIssue: async (issue: number) => fakeSelectedIssue(issue),
      },
      store,
      fakeGitHubRepositoryLock(),
      delivery,
    ).run(["code", "--working-directory", "/repo", ...args]);
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
  expect(prompt).toContain("Coordinator-fixed issue branch: refs/heads/issue/178");
  expect(prompt).toContain("/tmp/lazy-workflow-fake-manifest-178.json");
  expect(prompt).toContain(IMPLEMENTATION_READY_MARKER);
  expect(prompt).toContain('"number":178');
});

test("la sección de avance se arma con estado verificado y no con el texto de la sesión agotada", async () => {
  const agents = scriptedAgents({ opencode: [exhausted("provider/primario")] });

  await runDelivery(agents, ["--fallback", "claudecode:claude-opus-5:high"]);

  const prompt = agents.started[1]?.options.prompt ?? "";
  expect(prompt).toContain("Fase del checkpoint: implementing");
  expect(prompt).toContain("Rama fijada: refs/heads/issue/178");
  expect(prompt).toContain(COMMIT);
  expect(prompt).toContain(UNCOMMITTED.trim());
  expect(prompt).not.toContain("lo que dijo la sesión agotada");
});

test("el manifest ya escrito viaja en la sección de avance, y su ausencia se dice", async () => {
  const manifestPath = join(tmpdir(), `lazy-workflow-handoff-manifest-${process.pid}.json`);
  await Bun.write(manifestPath, JSON.stringify({ issue: 178, branch: "refs/heads/issue/178", clean: true }));
  const delivery = fakeGitHubDelivery({
    prepareBranch: async () => ({ branch: "refs/heads/issue/178", baseBranch: "refs/heads/main", manifestPath }),
  });
  const withManifest = scriptedAgents({ opencode: [exhausted("provider/primario")] });
  const withoutManifest = scriptedAgents({ opencode: [exhausted("provider/primario")] });

  try {
    await runDelivery(withManifest, ["--fallback", "claudecode:claude-opus-5:high"], checkpointStore(), delivery);
    await runDelivery(withoutManifest, ["--fallback", "claudecode:claude-opus-5:high"], checkpointStore(), fakeGitHubDelivery({
      prepareBranch: async () => ({ branch: "refs/heads/issue/178", baseBranch: "refs/heads/main", manifestPath: `${manifestPath}.ausente` }),
    }));
  } finally {
    await unlink(manifestPath);
  }

  expect(withManifest.started[1]?.options.prompt).toContain('"issue":178,"branch":"refs/heads/issue/178"');
  expect(withoutManifest.started[1]?.options.prompt).toContain("Todavía no hay completion manifest escrito.");
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
  expect(prompt).toContain("todavía no hay commits en la rama");
  expect(prompt).toContain("El árbol de trabajo no tiene cambios sin commitear.");
});

test("un manifest de otra issue o de otra rama no se cita como avance de esta unidad", async () => {
  // La ruta del manifest es fija por repositorio: el que dejó una entrega
  // anterior sigue ahí, y solo pertenece a esta unidad si la nombra.
  const foreignIssue = join(tmpdir(), `lazy-workflow-handoff-otra-issue-${process.pid}.json`);
  const foreignBranch = join(tmpdir(), `lazy-workflow-handoff-otra-rama-${process.pid}.json`);
  await Bun.write(foreignIssue, JSON.stringify({ issue: 177, branch: "refs/heads/issue/177", clean: true }));
  await Bun.write(foreignBranch, JSON.stringify({ issue: 178, branch: "refs/heads/issue/178-anterior", clean: true }));
  const agents = { issue: scriptedAgents({ opencode: [exhausted("provider/primario")] }), branch: scriptedAgents({ opencode: [exhausted("provider/primario")] }) };

  try {
    for (const [key, manifestPath] of [["issue", foreignIssue], ["branch", foreignBranch]] as const) {
      await runDelivery(agents[key], ["--fallback", "claudecode:claude-opus-5:high"], checkpointStore(), fakeGitHubDelivery({
        prepareBranch: async () => ({ branch: "refs/heads/issue/178", baseBranch: "refs/heads/main", manifestPath }),
      }));
    }
  } finally {
    await unlink(foreignIssue);
    await unlink(foreignBranch);
  }

  for (const agent of [agents.issue, agents.branch]) {
    const prompt = agent.started[1]?.options.prompt ?? "";
    expect(prompt).toContain("Todavía no hay completion manifest escrito.");
    expect(prompt).not.toContain('"clean":true');
  }
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
  expect(prompt).toContain("todavía no hay commits en la rama");
  expect(prompt).not.toContain(COMMIT);
});

test("la sesión traspasada arranca con el perfil de autoridad en el formato del CLI nuevo", async () => {
  const agents = scriptedAgents({ opencode: [exhausted("provider/primario")] });

  await runDelivery(agents, ["--fallback", "claudecode:claude-opus-5:high"]);

  const authority = agents.started[1]?.options.agent;
  expect(authority?.profile).toBe("lazy-github-code");
  expect(authority?.configPath).toEndWith("claudecode/lazy-github-code.json");
});

test("el checkpoint nombra el CLI nuevo y la sesión nueva en la misma escritura", async () => {
  const agents = scriptedAgents({ opencode: [exhausted("provider/primario")] });
  const store = checkpointStore();

  await runDelivery(agents, ["--fallback", "claudecode:claude-opus-5:high"], store);

  const handoff = store.written.find(({ cli }) => cli === "claudecode");
  expect(handoff?.sessionId).toBe("ses_claudecode");
  expect(handoff?.phase).toBe("implementing");
  expect(handoff?.model).toBe("claude-opus-5");
  expect(handoff?.variant).toBe("high");
  // Ninguna escritura deja el CLI nuevo apuntando a la sesión que quedó agotada.
  expect(store.written.every(({ sessionId }) => sessionId !== "ses_178")).toBeTrue();
});

test("una recuperación posterior al traspaso reanuda contra el CLI que quedó registrado", async () => {
  const agents = scriptedAgents();
  const store = checkpointStore();
  await store.write({
    schemaVersion: 2,
    cli: "claudecode",
    workflow: "github-code",
    repository: "owner/repo",
    issue: 178,
    phase: "implementing",
    branch: "refs/heads/issue/178",
    sessionId: "ses_claudecode",
    model: "claude-opus-5",
    variant: "high",
    commit: null,
    pullRequest: null,
    receipts: {},
    baseBranch: "refs/heads/main",
    manifestPath: "/tmp/lazy-workflow-fake-manifest-178.json",
  });

  await runDelivery(agents, ["--session", "ses_claudecode"], store);

  expect(agents.resumed[0]?.cli).toBe("claudecode");
  expect(agents.resumed[0]?.sessionId).toBe("ses_claudecode");
  expect(agents.resumed[0]?.overrides.model).toBe("claude-opus-5");
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
  // Ya hay sesión que reanudar en el CLI nuevo: el escalón siguiente la reanuda
  // en vez de traspasar otra vez, y con la autoridad del CLI que la tiene.
  expect(agents.started).toHaveLength(2);
  expect(agents.resumed[0]?.cli).toBe("claudecode");
  expect(agents.resumed[0]?.sessionId).toBe("ses_claudecode");
  expect(agents.resumed[0]?.overrides.model).toBe("claude-sonnet-5");
  expect(agents.resumed[0]?.overrides.agent?.configPath).toEndWith("claudecode/lazy-github-code.json");
});

test("un fallo posterior al traspaso conserva la sesión traspasada, no la agotada", async () => {
  const agents = scriptedAgents(
    {
      opencode: [exhausted("provider/primario")],
      claudecode: [{
        result: agentResult("el traspaso tampoco tiene cupo", "ses_claudecode"),
        azureLoginRequired: false,
        failed: true,
        exhaustion: { cli: "Claude Code", model: "claude-opus-5", cause: "usage_limit" },
      }],
    },
    [new Error("el escalón siguiente explotó")],
  );
  const store = checkpointStore();

  const code = await runDelivery(agents, [
    "--fallback", "claudecode:claude-opus-5:high",
    "--fallback", "claudecode:claude-sonnet-5:medium",
  ], store);

  expect(code).toBe(1);
  // El checkpoint tiene que nombrar la sesión que el CLI registrado realmente
  // tiene; la sesión agotada del CLI anterior ya no se puede reanudar ahí.
  expect(store.written.at(-1)?.cli).toBe("claudecode");
  expect(store.written.at(-1)?.sessionId).toBe("ses_claudecode");
});

test("un rerun del mismo comando que declaró --cli reanuda el traspaso interrumpido en el CLI del checkpoint", async () => {
  const store = checkpointStore();
  const delivery = fakeGitHubDelivery();
  const command = ["--cli", "opencode", "--fallback", "claudecode:claude-opus-5:high"];
  const interrupted = scriptedAgents({
    opencode: [exhausted("provider/primario")],
    claudecode: [{
      result: agentResult("la sesión traspasada se cortó", "ses_claudecode"),
      azureLoginRequired: false,
      failed: true,
    }],
  });

  expect(await runDelivery(interrupted, command, store, delivery)).toBe(1);
  expect(store.written.at(-1)?.cli).toBe("claudecode");

  const rerun = scriptedAgents();
  await runDelivery(rerun, command, store, delivery);

  expect(rerun.resumed[0]?.cli).toBe("claudecode");
  expect(rerun.resumed[0]?.sessionId).toBe("ses_claudecode");
});

test("el traspaso deja registrado en el checkpoint el CLI del que movió la sesión", async () => {
  const agents = scriptedAgents({ opencode: [exhausted("provider/primario")] });
  const store = checkpointStore();

  await runDelivery(agents, ["--cli", "opencode", "--fallback", "claudecode:claude-opus-5:high"], store);

  expect(store.written.find(({ cli }) => cli === "claudecode")?.handoffFrom).toBe("opencode");
  // Antes del traspaso no hay nada que registrar: la sesión sigue en el CLI del run.
  expect(store.written.filter(({ cli }) => cli === "opencode").every(({ handoffFrom }) => handoffFrom === undefined)).toBeTrue();
});

test("un --cli que contradice un checkpoint sin traspaso falla cerrado aunque el comando declare la cadena", async () => {
  const agents = scriptedAgents();
  const store = checkpointStore();
  await store.write({
    schemaVersion: 2,
    cli: "claudecode",
    workflow: "github-code",
    repository: "owner/repo",
    issue: 178,
    phase: "implementing",
    branch: "refs/heads/issue/178",
    sessionId: "ses_claudecode",
    commit: null,
    pullRequest: null,
    receipts: {},
    baseBranch: "refs/heads/main",
    manifestPath: "/tmp/lazy-workflow-fake-manifest-178.json",
  });
  const preserved = store.written.at(-1);

  // La cadena declarada nombra el CLI del checkpoint, pero el checkpoint no dice
  // que un traspaso lo haya movido: la contradicción sigue siendo del operador.
  const code = await runDelivery(agents, [
    "--cli", "opencode", "--fallback", "claudecode:claude-opus-5:high",
  ], store);

  expect(code).toBe(1);
  expect(agents.resumed).toEqual([]);
  expect(agents.started).toEqual([]);
  expect(store.written.at(-1)).toEqual(preserved!);
});

test("una entrega traspasada que falla al completarse sigue siendo reanudable por el mismo comando", async () => {
  const store = checkpointStore();
  let pushes = 0;
  const delivery = fakeGitHubDelivery({
    pushCommit: async () => { if (++pushes === 1) throw new Error("el push no salió"); },
  });
  const command = ["--cli", "opencode", "--fallback", "claudecode:claude-opus-5:high"];
  const agents = scriptedAgents({ opencode: [exhausted("provider/primario")] });

  // El traspaso llega a IMPLEMENTATION_READY y es la integración la que falla:
  // el checkpoint conservado sigue perteneciendo al CLI del respaldo.
  expect(await runDelivery(agents, command, store, delivery)).toBe(1);
  expect(store.written.at(-1)?.cli).toBe("claudecode");

  // Ninguna sesión que reanudar, pero el mismo comando tiene que poder terminar
  // la entrega en vez de quedar rechazado por el CLI que él mismo dejó fijado.
  const rerun = scriptedAgents();
  expect(await runDelivery(rerun, command, store, delivery, fakeGit, [])).toBe(0);
});

test("la unidad siguiente a un traspaso adoptado vuelve al CLI que el operador declaró", async () => {
  const store = checkpointStore();
  const delivery = fakeGitHubDelivery();
  const command = ["--cli", "opencode", "--fallback", "claudecode:claude-opus-5:high"];
  const interrupted = scriptedAgents({
    opencode: [exhausted("provider/primario")],
    claudecode: [{
      result: agentResult("la sesión traspasada se cortó", "ses_claudecode"),
      azureLoginRequired: false,
      failed: true,
    }],
  });
  await runDelivery(interrupted, command, store, delivery);

  const rerun = scriptedAgents();
  await runDelivery(rerun, command, store, delivery, fakeGit, [179]);

  // El traspaso se adoptó para la unidad que el checkpoint tenía en curso; la
  // siguiente arranca en el escalón primario, igual que tras un descenso.
  expect(rerun.resumed.map(({ cli }) => cli)).toEqual(["claudecode"]);
  expect(rerun.started.map(({ cli }) => cli)).toEqual(["opencode"]);
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
