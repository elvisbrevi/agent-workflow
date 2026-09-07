/**
 * La coordinación de una entrega GitHub: el checkpoint que el bucle escribe y la recuperación que
 * lo retoma.
 *
 * Este archivo estaba escrito contra la máquina de ocho fases con recibos por efecto que ADR-0038
 * retiró, así que importaba `GITHUB_DELIVERY_PHASES` y dejó de cargar entero cuando ese enum
 * desapareció — nueve tests que el suite contaba como un solo error de importación. Se reescribe
 * sobre lo que quedó: un checkpoint de `{ repository, issue, branch, baseBranch, commit, summary }`
 * y una recuperación que responde una sola pregunta, si la unidad llegó a verificarse.
 *
 * Lo que ya no se puede probar porque ya no existe: reanudar una sesión desde el checkpoint
 * (ADR-0039 la retiró) y volver a preparar la rama de una unidad sin verificar (ADR-0038 la deja
 * reclamada y sigue drenando). El caso que cubría #293 —un checkpoint que quedó antes de fijar la
 * rama— vive ahora como «una unidad sin verificar no reconcilia nada», más abajo.
 */
import { expect, test } from "bun:test";
import { createCli } from "./_helpers/create-cli.ts";
import { AgentResult } from "../src/coding-agent/agent-result.ts";
import type { GitHubCheckpointStore, GitHubDeliveryCheckpoint } from "../src/github/github-delivery-checkpoint.ts";
import type { GitHubDeliveryAdapter } from "../src/github/github-delivery-service.ts";
import type { GitHubRepositoryLockBoundary } from "../src/github/github-repository-lock.ts";
import { fakeSelectedIssue, fakeSelectedOutcome } from "./_helpers/managed-queue-fixtures.ts";
import { fakeGitHubDelivery } from "./_helpers/github-delivery-fixtures.ts";

const COMMIT = "a".repeat(40);

function checkpoint(overrides: Partial<GitHubDeliveryCheckpoint> = {}): GitHubDeliveryCheckpoint {
  return {
    schemaVersion: 3,
    workflow: "github-code",
    repository: "owner/repo",
    issue: 178,
    branch: "refs/heads/issue/178",
    baseBranch: "refs/heads/main",
    commit: null,
    summary: null,
    ...overrides,
  };
}

/**
 * Cada escritura del checkpoint como el par que la distingue de la anterior: la rama fijada y si
 * la unidad ya pasó su verificación. Es lo que la secuencia de fases decía antes, expresado sobre
 * lo único que el checkpoint guarda hoy.
 */
function progression(writes: GitHubDeliveryCheckpoint[]): string[] {
  const state = ({ branch, commit }: GitHubDeliveryCheckpoint): string =>
    `${branch ? "branch" : "no-branch"}/${commit ? "verified" : "unverified"}`;
  return writes.map(state).filter((value, index, all) => value !== all[index - 1]);
}

function boundaries(initial: GitHubDeliveryCheckpoint | null = null) {
  let current = initial;
  const writes: GitHubDeliveryCheckpoint[] = [];
  let lockAcquires = 0;
  let lockReleases = 0;
  const store: GitHubCheckpointStore = {
    read: async () => current,
    write: async (value) => { current = value; writes.push(value); },
    clear: async () => { current = null; },
  };
  const lock: GitHubRepositoryLockBoundary = {
    acquire: async () => {
      lockAcquires += 1;
      return async () => { lockReleases += 1; };
    },
  };
  return {
    store,
    lock,
    writes,
    get current() { return current; },
    get lockAcquires() { return lockAcquires; },
    get lockReleases() { return lockReleases; },
  };
}

const services = () => ({
  azure: { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
  openCode: {
    run: async () => ({
      result: AgentResult.fromJsonLines(JSON.stringify({
        type: "text", sessionID: "ses_178", part: { type: "text", text: "entrega lista" },
      })),
      azureLoginRequired: false,
      failed: false,
    }),
    resume: async () => { throw new Error("ninguna sesión GitHub se reanuda (ADR-0039)"); },
  },
});

function failingDelivery(overrides: Partial<GitHubDeliveryAdapter> = {}): GitHubDeliveryAdapter {
  const unexpected = async (): Promise<never> => { throw new Error("unexpected delivery operation"); };
  return {
    prepareBranch: unexpected,
    verifySession: async () => { throw new Error("must not verify"); },
    pushCommit: unexpected,
    createOrReusePullRequest: unexpected,
    mergePullRequest: unexpected,
    closeIssue: unexpected,
    cleanupBranch: unexpected,
    ...overrides,
  };
}

/** Silencia el panel del reportador, que escribe en `console.log` igual que los marcadores. */
async function capturingLogs<T>(action: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    return { value: await action(), logs };
  } finally {
    console.log = original;
  }
}

test("la entrega GitHub checkpointa la unidad fijada y limpia tras el resultado completo", async () => {
  const state = boundaries();
  const { azure, openCode } = services();
  const events: string[] = [];
  const store: GitHubCheckpointStore = {
    ...state.store,
    write: async (value) => { events.push("write"); await state.store.write(value); },
  };
  let available = true;
  const queue = {
    selectAndClaimEligibleIssue: async () => { throw new Error("must use checkpointed selection"); },
    selectEligibleIssue: async () => {
      events.push("select");
      if (!available) return { kind: "empty" as const };
      available = false;
      return { kind: "candidate" as const, issue: fakeSelectedIssue(178), repository: { nameWithOwner: "owner/repo" } };
    },
    claimSelectedIssue: async () => {
      events.push("claim");
      if (available) throw new Error("issue was not selected");
      return fakeSelectedIssue(178);
    },
  };
  const { value: code } = await capturingLogs(() => createCli({
    huInfoService: azure,
    agentSource: openCode,
    githubManagedQueue: queue,
    githubCheckpointStore: store,
    githubRepositoryLock: state.lock,
    githubDelivery: fakeGitHubDelivery(),
  }).run(["code", "--working-directory", "/repo"]));

  expect(code).toBe(0);
  // La unidad se fija antes de reclamarla, gana su rama, y solo después de que git la verifica
  // queda con commit: es el único bit que la recuperación va a leer.
  expect(progression(state.writes)).toEqual(["no-branch/unverified", "branch/unverified", "branch/verified"]);
  // El checkpoint se escribe en la selección y recién entonces se reclama la issue.
  expect(events.slice(0, 3)).toEqual(["select", "write", "claim"]);
  expect(state.current).toBeNull();
  expect(state.lockAcquires).toBe(1);
  expect(state.lockReleases).toBe(1);
});

test("el checkpoint guarda el resumen de la sesión, que es el cuerpo del pull request", async () => {
  const state = boundaries();
  const { azure, openCode } = services();
  const bodies: Array<string | undefined> = [];
  let available = true;
  const { value: code } = await capturingLogs(() => createCli({
    huInfoService: azure,
    agentSource: openCode,
    githubManagedQueue: {
      selectAndClaimEligibleIssue: async () => { throw new Error("must use checkpointed selection"); },
      selectEligibleIssue: async () => {
        if (!available) return { kind: "empty" as const };
        available = false;
        return { kind: "candidate" as const, issue: fakeSelectedIssue(178), repository: { nameWithOwner: "owner/repo" } };
      },
      claimSelectedIssue: async () => fakeSelectedIssue(178),
    },
    githubCheckpointStore: state.store,
    githubRepositoryLock: state.lock,
    githubDelivery: fakeGitHubDelivery({
      createOrReusePullRequest: async (_i, _b, _bb, _c, _wd, _closes, _ref, summary) => {
        bodies.push(summary);
        return { number: 1 };
      },
    }),
  }).run(["code", "--working-directory", "/repo"]));

  expect(code).toBe(0);
  expect(bodies).toEqual(["entrega lista"]);
  expect(state.writes.at(-1)?.summary).toBe("entrega lista");
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
  const { value: code, logs } = await capturingLogs(() => createCli({
    huInfoService: azure,
    agentSource: { ...openCode, run: async () => { runs += 1; return openCode.run(); } },
    githubManagedQueue: queue,
    githubCheckpointStore: state.store,
    githubRepositoryLock: state.lock,
    githubDelivery: fakeGitHubDelivery(),
  }).run(["code", "--working-directory", "/repo"]));

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

test("un claim que no se verifica conserva el checkpoint y detiene la corrida", async () => {
  const state = boundaries();
  const { azure, openCode } = services();
  let runs = 0;
  const { value: code } = await capturingLogs(() => createCli({
    huInfoService: azure,
    agentSource: { ...openCode, run: async () => { runs += 1; return openCode.run(); } },
    githubManagedQueue: {
      selectAndClaimEligibleIssue: async () => { throw new Error("must use checkpointed selection"); },
      selectEligibleIssue: async () => ({
        kind: "candidate" as const, issue: fakeSelectedIssue(178), repository: { nameWithOwner: "owner/repo" },
      }),
      claimSelectedIssue: async () => { throw new Error("el claim no quedó registrado"); },
    },
    githubCheckpointStore: state.store,
    githubRepositoryLock: state.lock,
    githubDelivery: failingDelivery(),
  }).run(["code", "--working-directory", "/repo"]));

  expect(code).toBe(1);
  expect(runs).toBe(0);
  // La issue quedó fijada antes del claim, así que el checkpoint se conserva para reconciliarla.
  expect(state.current?.issue).toBe(178);
  expect(state.current?.commit).toBeNull();
});

test("una unidad que la sesión no dejó verificada queda reclamada y el drenaje sigue", async () => {
  const state = boundaries();
  const { azure, openCode } = services();
  const pending = [178, 179];
  let runs = 0;
  const { value: code, logs } = await capturingLogs(() => createCli({
    huInfoService: azure,
    agentSource: { ...openCode, run: async () => { runs += 1; return openCode.run(); } },
    githubManagedQueue: {
      selectAndClaimEligibleIssue: async () => { throw new Error("must use checkpointed selection"); },
      async selectEligibleIssue() {
        const next = pending[0];
        if (next === undefined) return { kind: "empty" as const };
        return { kind: "candidate" as const, issue: fakeSelectedIssue(next), repository: { nameWithOwner: "owner/repo" } };
      },
      claimSelectedIssue: async () => fakeSelectedIssue(pending.shift()!),
    },
    githubCheckpointStore: state.store,
    githubRepositoryLock: state.lock,
    githubDelivery: fakeGitHubDelivery({
      verifySession: async (branch) => {
        if (branch === "refs/heads/issue/178") throw new Error("la rama no lleva commits sobre su base");
        return { commit: COMMIT };
      },
    }),
  }).run(["code", "--working-directory", "/repo"]));

  // La 178 no se entrega y no detiene el drenaje: la 179 sí, y la corrida sale distinta de cero.
  expect(code).toBe(1);
  expect(runs).toBe(2);
  expect(logs.filter((line) => line === "TICKET_COMPLETED")).toHaveLength(1);
  expect(logs.filter((line) => line === "QUEUE_EMPTY")).toHaveLength(1);
  // Su claim es lo que la saca de la frontera; el checkpoint no guarda nada a medias.
  expect(state.current).toBeNull();
});

test("la recuperación de una unidad verificada la termina sin abrir sesión ni consultar la cola", async () => {
  const state = boundaries(checkpoint({ commit: COMMIT, summary: "entrega lista" }));
  const { azure, openCode } = services();
  let selections = 0;
  let runs = 0;
  const effects: string[] = [];
  const { value: code, logs } = await capturingLogs(() => createCli({
    huInfoService: azure,
    agentSource: { ...openCode, run: async () => { runs += 1; return openCode.run(); } },
    githubManagedQueue: {
      selectAndClaimEligibleIssue: async () => { selections += 1; return { kind: "empty" as const }; },
      selectEligibleIssue: async () => { selections += 1; return { kind: "empty" as const }; },
      claimSelectedIssue: async () => { throw new Error("must not claim"); },
    },
    githubCheckpointStore: state.store,
    githubRepositoryLock: state.lock,
    githubDelivery: fakeGitHubDelivery({
      verifySession: async () => { throw new Error("una unidad ya verificada no se vuelve a verificar"); },
      pushCommit: async () => { effects.push("push"); },
      createOrReusePullRequest: async () => { effects.push("pull-request"); return { number: 7 }; },
      mergePullRequest: async () => { effects.push("merge"); return { number: 7, mergeCommit: "b".repeat(40) }; },
      closeIssue: async () => { effects.push("close"); },
      cleanupBranch: async () => { effects.push("cleanup"); },
    }),
  }).run(["code", "--working-directory", "/repo"]));

  expect(code).toBe(0);
  expect(runs).toBe(0);
  expect(effects).toEqual(["push", "pull-request", "merge", "close", "cleanup"]);
  expect(logs.filter((line) => line === "TICKET_COMPLETED")).toHaveLength(1);
  // Terminada la unidad fijada, la corrida vuelve a la cola en vez de salir.
  expect(selections).toBe(1);
  expect(state.current).toBeNull();
  expect(state.lockAcquires).toBe(1);
  expect(state.lockReleases).toBe(1);
});

test("una unidad verificada que falla al completarse conserva el checkpoint y detiene la corrida", async () => {
  const initial = checkpoint({ commit: COMMIT });
  const state = boundaries(initial);
  const { azure, openCode } = services();
  let runs = 0;
  const { value: code } = await capturingLogs(() => createCli({
    huInfoService: azure,
    agentSource: { ...openCode, run: async () => { runs += 1; return openCode.run(); } },
    githubManagedQueue: {
      selectAndClaimEligibleIssue: async () => { throw new Error("must not select"); },
    },
    githubCheckpointStore: state.store,
    githubRepositoryLock: state.lock,
    githubDelivery: fakeGitHubDelivery({
      pushCommit: async () => { throw new Error("origin rechazó el push"); },
    }),
  }).run(["code", "--working-directory", "/repo"]));

  expect(code).toBe(1);
  expect(runs).toBe(0);
  // Ya tocó el remoto: la unidad queda con su commit fijado para que la corrida siguiente la retome.
  expect(state.current?.issue).toBe(178);
  expect(state.current?.commit).toBe(COMMIT);
  expect(state.lockAcquires).toBe(1);
  expect(state.lockReleases).toBe(1);
});

test("una unidad sin verificar no reconcilia nada: queda reclamada y el drenaje sigue", async () => {
  // El caso de #293 —un checkpoint que quedó antes de fijar la rama— entra por acá desde ADR-0038:
  // sin commit la unidad nunca tocó el remoto, así que no hay nada que retomar.
  for (const stale of [checkpoint({ branch: null, baseBranch: null }), checkpoint()]) {
    const state = boundaries(stale);
    const { azure, openCode } = services();
    let runs = 0;
    let selections = 0;
    const { value: code, logs } = await capturingLogs(() => createCli({
      huInfoService: azure,
      agentSource: { ...openCode, run: async () => { runs += 1; return openCode.run(); } },
      githubManagedQueue: {
        selectAndClaimEligibleIssue: async () => { selections += 1; return { kind: "empty" as const }; },
        selectEligibleIssue: async () => { selections += 1; return { kind: "empty" as const }; },
        claimSelectedIssue: async () => { throw new Error("must not claim"); },
      },
      githubCheckpointStore: state.store,
      githubRepositoryLock: state.lock,
      githubDelivery: failingDelivery(),
    }).run(["code", "--working-directory", "/repo"]));

    // La unidad cuenta como fallada, así que la corrida sale distinta de cero aunque drene el resto.
    expect(code).toBe(1);
    expect(runs).toBe(0);
    expect(selections).toBe(1);
    expect(logs.filter((line) => line === "QUEUE_EMPTY")).toHaveLength(1);
    expect(state.current).toBeNull();
  }
});

test("un checkpoint que nombra otra issue que la viva pide reconciliación en vez de entregar", async () => {
  const state = boundaries(checkpoint({ commit: COMMIT }));
  const { azure, openCode } = services();
  // La recuperación relee el checkpoint antes de tocar nada. Si entre la lectura del coordinador y
  // la suya el archivo pasó a nombrar otra unidad, lo que hay en el repositorio no es lo que iba a
  // entregar, así que pide reconciliación en vez de entregar la unidad equivocada.
  let reads = 0;
  const store: GitHubCheckpointStore = {
    ...state.store,
    read: async () => {
      reads += 1;
      return reads === 1 ? checkpoint({ commit: COMMIT }) : checkpoint({ issue: 999, commit: COMMIT });
    },
  };
  let selections = 0;
  const { value: code, logs } = await capturingLogs(() => createCli({
    huInfoService: azure,
    agentSource: { ...openCode, run: async () => { throw new Error("must not run"); } },
    githubManagedQueue: {
      selectAndClaimEligibleIssue: async () => { selections += 1; return fakeSelectedOutcome(1000); },
    },
    githubCheckpointStore: store,
    githubRepositoryLock: state.lock,
    githubDelivery: failingDelivery(),
  }).run(["code", "--working-directory", "/repo"]));

  expect(code).toBe(1);
  expect(selections).toBe(0);
  expect(logs.some((line) => line.includes("RECONCILIATION_REQUIRED"))).toBeTrue();
  expect(state.lockAcquires).toBe(1);
  expect(state.lockReleases).toBe(1);
});

test("sin store ni lock la entrega GitHub no se coordina: no hay checkpoint que retomar", async () => {
  const { azure, openCode } = services();
  let runs = 0;
  const { value: code, logs } = await capturingLogs(() => createCli({
    huInfoService: azure,
    agentSource: { ...openCode, run: async () => { runs += 1; return openCode.run(); } },
    githubManagedQueue: { selectAndClaimEligibleIssue: async () => fakeSelectedOutcome(178) },
    githubDelivery: undefined,
  }).run(["code", "--working-directory", "/repo"]));

  // ADR-0020: sin adaptador de entrega y sin rama fijada no hay nada que verificar, así que la
  // corrida falla cerrada en vez de abrir una sesión que nadie va a poder completar.
  expect(code).toBe(1);
  expect(runs).toBe(0);
  expect(logs.some((line) => line === "TICKET_COMPLETED")).toBeFalse();
});
