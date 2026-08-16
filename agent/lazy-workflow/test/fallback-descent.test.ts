import { expect, test } from "bun:test";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { buildCli } from "../src/cli/parse-cli-options.ts";
import { AgentResult } from "../src/coding-agent/agent-result.ts";
import type { AgentCli } from "../src/coding-agent/agent-cli.ts";
import { AgentExhaustionError, AgentSessionNotFoundError, type AgentExecution, type AgentResumeOverrides, type CodingAgent } from "../src/coding-agent/coding-agent.ts";
import type { GitHubCheckpointStore, GitHubDeliveryCheckpoint } from "../src/github/github-delivery-checkpoint.ts";
import { fakeGitHubDelivery, fakeGitHubRepositoryLock } from "./_helpers/github-delivery-fixtures.ts";
import { fakeSelectedIssue, fakeSelectedOutcome, queueAdapter } from "./_helpers/managed-queue-fixtures.ts";
import { getDefaultReporter, setDefaultReporter } from "../src/output/operator-output.ts";
import type { Reporter } from "../src/output/reporter.ts";

const azure = {
  getHuInfo: async () => { throw new Error("must not use Azure"); },
  waitForAccess: async () => undefined,
};

const SESSION = "ses_178";

function agentResult(text: string, sessionId = SESSION): AgentResult {
  return AgentResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: sessionId,
    part: { type: "text", text },
  }));
}

/** The session died because the provider itself ran out, as the adapters classify it. */
function exhausted(model: string, cli = "OpenCode"): AgentExecution {
  return {
    result: agentResult("sin cupo"),
    azureLoginRequired: false,
    failed: true,
    exhaustion: { cli, model, cause: "rate_limit" },
  };
}

function ordinaryFailure(): AgentExecution {
  return { result: agentResult("explotó"), azureLoginRequired: false, failed: true };
}

const terminal = (): AgentResult => agentResult("IMPLEMENTATION_READY");

interface Resumption {
  sessionId: string;
  overrides: AgentResumeOverrides;
}

/**
 * One fake agent per CLI: `run` answers the scripted executions of the primary
 * rung, `resume` the scripted results of each descent, recording what each rung
 * was asked to resume with.
 */
function scriptedAgents(script: {
  run: AgentExecution[];
  resume: Array<AgentResult | Error>;
}) {
  const resumed: Resumption[] = [];
  const requested: AgentCli[] = [];
  const started: string[] = [];
  const pendingRuns = [...script.run];
  const resumes = [...script.resume];
  let runs = 0;
  return {
    resumed,
    requested,
    started,
    get runs() { return runs; },
    source: (cli: AgentCli): CodingAgent => {
      requested.push(cli);
      return {
        run: async (options) => {
          runs += 1;
          started.push(options.model);
          return pendingRuns.shift() ?? { result: terminal(), azureLoginRequired: false, failed: false };
        },
        resume: async (sessionId, _prompt, _workingDirectory, _marker, overrides = {}) => {
          resumed.push({ sessionId, overrides });
          const next = resumes.shift();
          if (next instanceof Error) throw next;
          return next ?? terminal();
        },
      };
    },
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

/** Everything the run says to the operator, so a descent can be read back as it is reported. */
function captureReporter(): { reporter: Reporter; info: string[] } {
  const info: string[] = [];
  const reporter: Reporter = {
    info: (message: string) => { info.push(message); },
    warn: (message: string) => { info.push(message); },
    error: (message: string) => { info.push(message); },
    debug: () => undefined,
    start: () => ({ stop: () => undefined }) as never,
    stop: () => undefined,
  };
  return { reporter, info };
}

/**
 * The clock the fake timer advances: every wait is observed as a duration, so a
 * bounded wait-and-retry cycle is exercised without any test sleeping.
 */
function fakeTimers(): { waits: number[]; retryTimer: { wait(ms: number): Promise<void> }; clock: { now(): number } } {
  const waits: number[] = [];
  let now = 0;
  return {
    waits,
    retryTimer: { wait: async (ms: number) => { waits.push(ms); now += ms; } },
    clock: { now: () => now },
  };
}

async function runDelivery(
  agents: ReturnType<typeof scriptedAgents>,
  args: string[],
  store: GitHubCheckpointStore = checkpointStore(),
  issues: number[] = [178],
  reporter?: Reporter,
  logs: string[] = [],
  timers: ReturnType<typeof fakeTimers> = fakeTimers(),
): Promise<number> {
  const originalLog = console.log;
  const previousReporter = getDefaultReporter();
  console.log = (...values: unknown[]) => { logs.push(values.map(String).join(" ")); };
  try {
    return await new LazyWorkflowCli(
      azure,
      agents.source,
      undefined, timers.retryTimer, undefined, timers.clock, undefined,
      undefined, undefined, undefined, undefined,
      buildCli(() => true),
      reporter ? ((() => reporter) as never) : undefined,
      {
        ...queueAdapter(issues.map((issue) => fakeSelectedOutcome(issue))),
        reconcileClaimedIssue: async (issue: number) => fakeSelectedIssue(issue),
      },
      store,
      fakeGitHubRepositoryLock(),
      fakeGitHubDelivery(),
    ).run(["code", "--working-directory", "/repo", ...args]);
  } finally {
    console.log = originalLog;
    setDefaultReporter(previousReporter);
  }
}

test("un agotamiento con respaldo del mismo CLI reanuda la sesión con el modelo y la variante nuevos", async () => {
  const agents = scriptedAgents({ run: [exhausted("provider/primario")], resume: [terminal()] });

  const code = await runDelivery(agents, ["--fallback", "opencode:provider/respaldo:medium"]);

  expect(code).toBe(0);
  expect(agents.resumed).toHaveLength(1);
  expect(agents.resumed[0]?.sessionId).toBe(SESSION);
  expect(agents.resumed[0]?.overrides.model).toBe("provider/respaldo");
  expect(agents.resumed[0]?.overrides.variant).toBe("medium");
  // The descended session keeps the delivery authority the run started with.
  expect(agents.resumed[0]?.overrides.agent?.profile).toBe("lazy-github-code");
});

test("un agotamiento encadenado continúa hacia el escalón siguiente y nunca hacia atrás", async () => {
  const agents = scriptedAgents({
    run: [exhausted("provider/primario")],
    resume: [
      new AgentExhaustionError(
        { cli: "OpenCode", model: "provider/respaldo", cause: "billing" },
        agentResult("el respaldo tampoco tiene cupo"),
      ),
      terminal(),
    ],
  });

  const code = await runDelivery(agents, [
    "--fallback", "opencode:provider/respaldo:medium",
    "--fallback", "opencode:provider/ultimo:low",
  ]);

  expect(code).toBe(0);
  expect(agents.resumed.map(({ overrides }) => overrides.model)).toEqual([
    "provider/respaldo",
    "provider/ultimo",
  ]);
});

test("el orden declarado se respeta aunque el escalón siguiente sea de otro CLI", async () => {
  const agents = scriptedAgents({ run: [exhausted("provider/primario")], resume: [terminal()] });

  const code = await runDelivery(agents, [
    "--fallback", "claudecode:claude-opus-5:high",
    "--fallback", "opencode:provider/ultimo:low",
  ]);

  expect(code).toBe(0);
  // El escalón de otro CLI no tiene sesión que reanudar: se alcanza con un
  // traspaso, y el escalón siguiente ni se toca. El traspaso vive en
  // fallback-handoff.test.ts.
  expect(agents.resumed).toEqual([]);
  // El último agente resuelto vuelve a ser el primario, listo para la unidad siguiente.
  expect(agents.requested).toEqual(["opencode", "claudecode", "opencode"]);
  expect(agents.started).toEqual(["opencode-go/deepseek-v4-pro", "claude-opus-5"]);
});

test("el checkpoint refleja el modelo activo cuando el descenso lo cambia", async () => {
  const agents = scriptedAgents({ run: [exhausted("provider/primario")], resume: [terminal()] });
  const store = checkpointStore();

  const code = await runDelivery(agents, ["--fallback", "opencode:provider/respaldo:medium"], store);

  expect(code).toBe(0);
  const descended = store.written.find((checkpoint) => checkpoint.model !== undefined);
  expect(descended?.model).toBe("provider/respaldo");
  expect(descended?.sessionId).toBe(SESSION);
});

test("sin descenso el checkpoint no nombra ningún modelo", async () => {
  const agents = scriptedAgents({ run: [], resume: [] });
  const store = checkpointStore();

  const code = await runDelivery(agents, ["--fallback", "opencode:provider/respaldo:medium"], store);

  expect(code).toBe(0);
  expect(store.written.every((checkpoint) => checkpoint.model === undefined)).toBeTrue();
});

test("una sesión ausente al reanudar detiene el run sin abrir una sesión nueva", async () => {
  const agents = scriptedAgents({
    run: [exhausted("provider/primario")],
    resume: [new AgentSessionNotFoundError(SESSION, `La sesión ${SESSION} ya no existe`)],
  });
  const store = checkpointStore();

  const code = await runDelivery(agents, ["--fallback", "opencode:provider/respaldo:medium"], store);

  expect(code).toBe(1);
  expect(agents.runs).toBe(1);
  expect(store.written.at(-1)?.phase).toBe("reconciling");
  expect(store.written.at(-1)?.sessionId).toBeNull();
});

test("un fallo ordinario de la sesión no desciende la cadena", async () => {
  const agents = scriptedAgents({ run: [ordinaryFailure()], resume: [terminal()] });

  const code = await runDelivery(agents, ["--fallback", "opencode:provider/respaldo:medium"]);

  expect(code).toBe(1);
  expect(agents.resumed).toEqual([]);
});

test("la unidad siguiente vuelve a arrancar en el escalón primario", async () => {
  const agents = scriptedAgents({ run: [exhausted("provider/primario")], resume: [terminal()] });

  const code = await runDelivery(
    agents,
    ["--fallback", "opencode:provider/respaldo:medium"],
    checkpointStore(),
    [178, 179],
  );

  expect(code).toBe(0);
  // El descenso es sticky solo dentro de la unidad: la segunda arranca de nuevo
  // en el primario, aunque la primera haya terminado en un respaldo.
  expect(agents.started).toEqual(["opencode-go/deepseek-v4-pro", "opencode-go/deepseek-v4-pro"]);
  expect(agents.resumed).toHaveLength(1);
});

test("cada descenso se reporta con el escalón anterior, el nuevo y la causa", async () => {
  const agents = scriptedAgents({ run: [exhausted("provider/primario")], resume: [terminal()] });
  const { reporter, info } = captureReporter();

  const code = await runDelivery(
    agents,
    ["--fallback", "opencode:provider/respaldo:medium"],
    checkpointStore(),
    [178],
    reporter,
  );

  expect(code).toBe(0);
  const descent = info.find((line) => line.includes("desciendo a"));
  expect(descent).toContain("opencode:opencode-go/deepseek-v4-pro:high");
  expect(descent).toContain("opencode:provider/respaldo:medium");
  expect(descent).toContain("rate_limit");
});

test("un fallo ordinario al descender conserva la sesión viva en el checkpoint", async () => {
  const agents = scriptedAgents({
    run: [exhausted("provider/primario")],
    resume: [new Error("el respaldo explotó")],
  });
  const store = checkpointStore();

  const code = await runDelivery(agents, ["--fallback", "opencode:provider/respaldo:medium"], store);

  expect(code).toBe(1);
  // La sesión sigue viva: solo una sesión que el CLI declara ausente vuelve sin
  // identificador, para que la recuperación pueda reanudar esta.
  expect(store.written.at(-1)?.phase).toBe("reconciling");
  expect(store.written.at(-1)?.sessionId).toBe(SESSION);
});

test("la recuperación reanuda con el modelo descendido que el checkpoint conserva", async () => {
  const agents = scriptedAgents({ run: [], resume: [terminal()] });
  const store = checkpointStore();
  await store.write({
    schemaVersion: 2,
    cli: "opencode",
    workflow: "github-code",
    repository: "owner/repo",
    issue: 178,
    phase: "implementing",
    branch: "refs/heads/issue/178",
    sessionId: SESSION,
    model: "provider/respaldo",
    commit: null,
    pullRequest: null,
    receipts: {},
    baseBranch: "refs/heads/main",
    manifestPath: "/tmp/lazy-workflow-fake-manifest-178.json",
  });

  await runDelivery(agents, ["--session", SESSION], store);

  // Sin un --model explícito, la sesión recuperada no vuelve al escalón agotado.
  expect(agents.resumed.at(-1)?.overrides.model).toBe("provider/respaldo");
  expect(agents.runs).toBe(0);
});

test("la cadena agotada devuelve el resultado de la última sesión, no el de la anterior", async () => {
  const agents = scriptedAgents({
    run: [exhausted("provider/primario")],
    resume: [
      new AgentExhaustionError(
        { cli: "OpenCode", model: "provider/primario", cause: "rate_limit" },
        agentResult("el respaldo tampoco tiene cupo"),
      ),
      new AgentExhaustionError(
        { cli: "OpenCode", model: "provider/primario", cause: "rate_limit" },
        agentResult("el primario reintentado sigue sin cupo"),
      ),
      new AgentExhaustionError(
        { cli: "OpenCode", model: "provider/respaldo", cause: "billing" },
        agentResult("lo último que dijo el respaldo"),
      ),
    ],
  });
  const store = checkpointStore();
  const logs: string[] = [];

  const code = await runDelivery(
    agents,
    ["--fallback", "opencode:provider/respaldo:medium", "--fallback-wait", "60", "--fallback-wait-max", "60"],
    store,
    [178],
    undefined,
    logs,
  );

  expect(code).toBe(1);
  // Lo que se reporta es la sesión que realmente terminó agotada, no el texto
  // de la sesión anterior a ese descenso.
  expect(logs.join("\n")).toContain("lo último que dijo el respaldo");
  expect(logs.join("\n")).not.toContain("sin cupo");
  expect(store.written.at(-1)?.sessionId).toBe(SESSION);
});

test("con toda la cadena agotada el run espera y reintenta el escalón primario", async () => {
  const agents = scriptedAgents({
    run: [exhausted("provider/primario")],
    resume: [
      new AgentExhaustionError(
        { cli: "OpenCode", model: "provider/respaldo", cause: "billing" },
        agentResult("el respaldo tampoco tiene cupo"),
      ),
      terminal(),
    ],
  });
  const timers = fakeTimers();

  const code = await runDelivery(
    agents,
    ["--fallback", "opencode:provider/respaldo:medium", "--fallback-wait", "60"],
    checkpointStore(),
    [178],
    undefined,
    [],
    timers,
  );

  expect(code).toBe(0);
  expect(timers.waits).toEqual([60_000]);
  // Tras la espera el reintento vuelve al primario, no al respaldo ya agotado.
  expect(agents.resumed.map(({ overrides }) => overrides.model)).toEqual([
    "provider/respaldo",
    "opencode-go/deepseek-v4-pro",
  ]);
});

test("cada espera se reporta con el escalón agotado y el tiempo restante hasta el tope", async () => {
  const agents = scriptedAgents({
    run: [exhausted("provider/primario")],
    resume: [
      new AgentExhaustionError(
        { cli: "OpenCode", model: "provider/respaldo", cause: "billing" },
        agentResult("el respaldo tampoco tiene cupo"),
      ),
      terminal(),
    ],
  });
  const { reporter, info } = captureReporter();

  const code = await runDelivery(
    agents,
    ["--fallback", "opencode:provider/respaldo:medium", "--fallback-wait", "60", "--fallback-wait-max", "180"],
    checkpointStore(),
    [178],
    reporter,
  );

  expect(code).toBe(0);
  const waiting = info.find((line) => line.includes("espero"));
  expect(waiting).toContain("opencode:provider/respaldo:medium");
  expect(waiting).toContain("billing");
  expect(waiting).toContain("60s");
  expect(waiting).toContain("180s");
});

test("alcanzado el tope el run falla cerrado nombrando el último escalón y su causa", async () => {
  const exhaustedResume = (): AgentExhaustionError => new AgentExhaustionError(
    { cli: "OpenCode", model: "provider/respaldo", cause: "billing" },
    agentResult("el respaldo tampoco tiene cupo"),
  );
  const agents = scriptedAgents({
    run: [exhausted("provider/primario")],
    resume: [exhaustedResume(), exhaustedResume(), exhaustedResume()],
  });
  const store = checkpointStore();
  const { reporter, info } = captureReporter();
  const timers = fakeTimers();

  const code = await runDelivery(
    agents,
    ["--fallback", "opencode:provider/respaldo:medium", "--fallback-wait", "60", "--fallback-wait-max", "60"],
    store,
    [178],
    reporter,
    [],
    timers,
  );

  expect(code).toBe(1);
  expect(timers.waits).toEqual([60_000]);
  const failure = info.find((line) => line.includes("tope"));
  expect(failure).toContain("opencode:provider/respaldo:medium");
  expect(failure).toContain("billing");
  // El checkpoint queda intacto: misma sesión viva, lista para reanudar.
  expect(store.written.at(-1)?.phase).toBe("reconciling");
  expect(store.written.at(-1)?.sessionId).toBe(SESSION);
});

test("sin --fallback un agotamiento no espera y termina como siempre", async () => {
  const agents = scriptedAgents({ run: [exhausted("provider/primario")], resume: [terminal()] });
  const timers = fakeTimers();

  const code = await runDelivery(agents, [], checkpointStore(), [178], undefined, [], timers);

  expect(code).toBe(1);
  expect(timers.waits).toEqual([]);
  expect(agents.resumed).toEqual([]);
});

test("el checkpoint conserva el escalón completo, modelo y variante, para recuperarlo", async () => {
  const agents = scriptedAgents({ run: [exhausted("provider/primario")], resume: [terminal()] });
  const store = checkpointStore();

  await runDelivery(agents, ["--fallback", "opencode:provider/respaldo:medium"], store);

  const descended = store.written.find((checkpoint) => checkpoint.model !== undefined);
  expect(descended?.model).toBe("provider/respaldo");
  expect(descended?.variant).toBe("medium");
});
