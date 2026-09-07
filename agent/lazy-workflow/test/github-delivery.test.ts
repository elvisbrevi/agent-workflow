import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCli } from "./_helpers/create-cli.ts";
import {
  GitHubDeliveryService,
  GitHubPullRequestConflictError,
  type GitHubDeliveryAdapter,
  GitHubSessionNotVerifiedError,
} from "../src/github/github-delivery-service.ts";
import type { GitHubParentReconciliationAdapter } from "../src/github/github-parent-reconciliation-service.ts";
import type { GitHubCheckpointStore, GitHubDeliveryCheckpoint } from "../src/github/github-delivery-checkpoint.ts";
import { AgentResult } from "../src/coding-agent/agent-result.ts";
import { fakeSelectedIssue } from "./_helpers/managed-queue-fixtures.ts";
import { fakeCoordinatedGitHubDeps, fakeGitHubDelivery } from "./_helpers/github-delivery-fixtures.ts";

function execution() {
  return {
    result: AgentResult.fromJsonLines(JSON.stringify({
      type: "text",
      sessionID: "ses_179",
      part: { type: "text", text: "IMPLEMENTATION_READY" },
    })),
    azureLoginRequired: false,
    failed: false,
  };
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

test("checkout de recuperación guarda en stash un worktree sucio en vez de rechazarlo o comitearlo", async () => {
  const commands: string[][] = [];
  const delivery = new GitHubDeliveryService(
    async () => { throw new Error("must not use GitHub"); },
    async (command) => {
      commands.push(command);
      if (command[0] === "rev-parse") return "";
      if (command[0] === "symbolic-ref") return "issue/198\n";
      if (command[0] === "status") return " M src/app.ts\n";
      if (command[0] === "stash") return "";
      throw new Error(`unexpected git command: ${command.join(" ")}`);
    },
  );

  await delivery.checkoutBranch("refs/heads/issue/198", "refs/heads/main", "/repo");

  const stashCommand = commands.find(([command]) => command === "stash");
  expect(stashCommand).toBeDefined();
  expect(stashCommand).toEqual(expect.arrayContaining(["stash", "push"]));
  // Los archivos sin trackear son el andamiaje del agente (un .env.test para
  // correr la suite): guardarlos en el stash se los quita al siguiente intento.
  expect(stashCommand).not.toContain("--include-untracked");
  // Never a commit: a stash never lands on any branch's history, so it can't
  // mix unrelated work into whatever the recovery flow commits next.
  expect(commands.some(([command]) => command === "commit")).toBeFalse();
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

test("el prompt de entrega GitHub es la instrucción del trabajo y nada más", async () => {
  let prompt = "";
  const queue = {
    verifyAuthentication: async () => ({ login: "bot" }),
    verifyRepository: async () => ({ nameWithOwner: "owner/repo" }),
    selectAndClaimEligibleIssue: async () => { throw new Error("must use checkpointed selection"); },
    selectEligibleIssue: async function () {
      if (this.done) return { kind: "empty" as const };
      this.done = true;
      return { kind: "candidate" as const, issue: fakeSelectedIssue(179), repository: { nameWithOwner: "owner/repo" } };
    },
    claimSelectedIssue: async () => fakeSelectedIssue(179),
    done: false,
  };

  await createCli({
    huInfoService: { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    agentSource: { run: async (options) => { prompt = options.prompt; throw new Error("stop after capturing prompt"); }, resume: async () => { throw new Error("must not resume"); } },
    githubManagedQueue: queue,
    ...fakeCoordinatedGitHubDeps(),
  }).run(["code", "--working-directory", "/repo"]);

  expect(prompt).toBe([
    "/implement the issue #179 usando /tdd /caveman /ponytail y /code-review.",
    "trabaja y comitea en esta misma branch.",
    "no abras PR, no me hagas preguntas.",
    "termina con un resumen de lo realizado entendible por un humano.",
  ].join("\n"));
});

test("entrega GitHub desde la sesión verificada hasta la limpieza", async () => {
  const calls: string[] = [];
  let selections = 0;
  let current: GitHubDeliveryCheckpoint | null = null;
  const store: GitHubCheckpointStore = {
    read: async () => current,
    write: async (checkpoint) => { current = checkpoint; },
    clear: async () => { current = null; },
  };
  const delivery: GitHubDeliveryAdapter = {
    prepareBranch: async () => {
      calls.push("prepare-branch");
      return { branch: "refs/heads/issue/179", baseBranch: "refs/heads/main" };
    },
    verifySession: async () => {
      calls.push("verify-session");
      return { commit: "a".repeat(40) };
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

  const code = await createCli({
    huInfoService: { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    agentSource: { run: async () => execution(), resume: async () => execution().result },
    githubManagedQueue: {
      selectAndClaimEligibleIssue: async () => ({ kind: "empty" }),
      selectEligibleIssue: async () => {
        selections += 1;
        if (selections > 1) return { kind: "empty" };
        return { kind: "candidate", issue: fakeSelectedIssue(179), repository: { nameWithOwner: "owner/repo" } };
      },
      claimSelectedIssue: async () => fakeSelectedIssue(179),
    },
    githubCheckpointStore: store,
    githubRepositoryLock: { acquire: async () => async () => undefined },
    githubDelivery: delivery,
  }).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(selections).toBe(2);
  expect(calls).toEqual(["prepare-branch", "verify-session", "push", "pull-request", "merge", "close-issue", "cleanup"]);
  expect(current).toBeNull();
});


function drainDelivery(closed: number[]): GitHubDeliveryAdapter {
  let pendingIssue = 179;
  let pendingBranch = "refs/heads/issue/179";
  return {
    prepareBranch: async (issueNumber) => {
      pendingIssue = issueNumber;
      pendingBranch = `refs/heads/issue/${issueNumber}`;
      return { branch: pendingBranch, baseBranch: "refs/heads/main" };
    },
    verifySession: async () => ({ commit: "a".repeat(40) }),
    pushCommit: async () => undefined,
    createOrReusePullRequest: async () => ({ number: 200 + pendingIssue }),
    mergePullRequest: async () => ({ number: 200 + pendingIssue, mergeCommit: "b".repeat(40) }),
    closeIssue: async (issueNumber) => { closed.push(issueNumber); },
    cleanupBranch: async () => undefined,
  };
}

function drainQueue(next: number) {
  let offered = true;
  return {
    selectAndClaimEligibleIssue: async () => ({ kind: "empty" as const }),
    reconcileClaimedIssue: async (n: number) => fakeSelectedIssue(n),
    selectEligibleIssue: async () => {
      if (!offered) return { kind: "empty" as const };
      offered = false;
      return { kind: "candidate" as const, issue: fakeSelectedIssue(next), repository: { nameWithOwner: "owner/repo" } };
    },
    claimSelectedIssue: async () => fakeSelectedIssue(next),
  };
}

test("un checkpoint sin verificar no se entrega: queda reclamado y el drenaje sigue", async () => {
  const closed: number[] = [];
  const delivery = drainDelivery(closed);
  let current: GitHubDeliveryCheckpoint | null = {
    schemaVersion: 3,
    workflow: "github-code",
    repository: "owner/repo",
    issue: 179,
    branch: "refs/heads/issue/179",
    baseBranch: "refs/heads/main",
    commit: null,
  };
  const store: GitHubCheckpointStore = {
    read: async () => current,
    write: async (c) => { current = c; },
    clear: async () => { current = null; },
  };

  const code = await createCli({
    huInfoService: { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    agentSource: { run: async () => execution(), resume: async () => execution().result },
    githubManagedQueue: drainQueue(180),
    githubCheckpointStore: store,
    githubRepositoryLock: { acquire: async () => async () => undefined },
    githubDelivery: delivery,
  }).run(["code", "--working-directory", "/repo"]);

  // La #179 nunca se verificó: se la deja reclamada con su rama y se sigue con la #180. El
  // código de salida dice que algo quedó roto detrás (ADR-0038).
  expect(code).toBe(1);
  expect(closed).toEqual([180]);
  expect(current).toBeNull();
});

test("un checkpoint sin verificar tampoco se entrega con --session", async () => {
  const closed: number[] = [];
  const delivery = drainDelivery(closed);
  let current: GitHubDeliveryCheckpoint | null = {
    schemaVersion: 3,
    workflow: "github-code",
    repository: "owner/repo",
    issue: 179,
    branch: "refs/heads/issue/179",
    baseBranch: "refs/heads/main",
    commit: null,
  };
  const store: GitHubCheckpointStore = {
    read: async () => current,
    write: async (c) => { current = c; },
    clear: async () => { current = null; },
  };

  const code = await createCli({
    huInfoService: { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    agentSource: { run: async () => execution(), resume: async () => execution().result },
    githubManagedQueue: drainQueue(180),
    githubCheckpointStore: store,
    githubRepositoryLock: { acquire: async () => async () => undefined },
    githubDelivery: delivery,
  }).run(["code", "--session", "ses_179", "--working-directory", "/repo"]);

  // La #179 nunca se verificó: se la deja reclamada con su rama y se sigue con la #180. El
  // código de salida dice que algo quedó roto detrás (ADR-0038).
  expect(code).toBe(1);
  expect(closed).toEqual([180]);
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
    prepareBranch: async () => ({ branch: "refs/heads/issue/179", baseBranch: "refs/heads/main" }),
    verifySession: async () => ({ commit: "a".repeat(40) }),
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
  const makeCli = () => createCli({
    huInfoService: { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    agentSource: { run: async () => { openCodeRuns += 1; return execution(); }, resume: async () => execution().result },
    githubManagedQueue: queue,
    githubCheckpointStore: store,
    githubRepositoryLock: { acquire: async () => async () => undefined },
    githubDelivery: delivery,
  });

  expect(await makeCli().run(["code", "--working-directory", "/repo"])).toBe(1);
  // La entrega quedó a medias tras verificarse: el checkpoint la conserva con su commit. Se lee
  // por el store y no por `current`, que el análisis de flujo estrecha a `null` fuera del closure.
  expect((await store.read())?.commit).toBe("a".repeat(40));
  failMerge = false;
  expect(await makeCli().run(["code", "--working-directory", "/repo"])).toBe(0);
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
    schemaVersion: 3,
    workflow: "github-code",
    repository: "owner/repo",
    issue: 179,
    branch: "refs/heads/issue/179",
    baseBranch: "refs/heads/main",
    commit: originalCommit,
  };
  const store: GitHubCheckpointStore = {
    read: async () => current,
    write: async (checkpoint) => { current = checkpoint; },
    clear: async () => { current = null; },
  };
  const delivery: GitHubDeliveryAdapter = {
    verifyRepository: async () => undefined,
    verifyBranch: async () => undefined,
    prepareBranch: async () => { throw new Error("must not prepare"); },
    verifySession: async () => ({ commit: reconciled ? reconciledCommit : originalCommit }),
    pushCommit: async (_branch, commit) => { events.push(`push:${commit}`); },
    // Sin recibos, el efecto se vuelve a ejecutar y el adaptador reusa el PR canónico (ADR-0038).
    createOrReusePullRequest: async () => { events.push("pull-request"); return { number: 201 }; },
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
  const code = await createCli({
    huInfoService: { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    agentSource: {
      run: async (options) => {
        prompt = options.prompt;
        reconciled = true;
        return execution();
      },
      resume: async () => { throw new Error("must not resume"); },
    },
    githubManagedQueue: { selectAndClaimEligibleIssue: async () => { selections += 1; return { kind: "empty" as const }; }, reconcileClaimedIssue: async () => fakeSelectedIssue(179) },
    githubCheckpointStore: store,
    githubRepositoryLock: { acquire: async () => async () => undefined },
    githubDelivery: delivery,
  }).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(selections).toBe(1);
  expect(prompt).toContain(originalCommit);
  expect(prompt).toContain(baseCommit);
  expect(prompt).toContain("Coordinator-fixed pull request: #201");
  // Sin recibos, retomar la entrega vuelve a correr push y PR, que son idempotentes.
  expect(events).toEqual([
    `push:${originalCommit}`,
    "pull-request",
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

test("retoma una reconciliación conflictiva sin seleccionar un reemplazo y luego drena la cola", async () => {
  const originalCommit = "a".repeat(40);
  const baseCommit = "b".repeat(40);
  const reconciledCommit = "c".repeat(40);
  let current: GitHubDeliveryCheckpoint | null = {
    schemaVersion: 3,
    workflow: "github-code",
    repository: "owner/repo",
    issue: 179,
    branch: "refs/heads/issue/179",
    baseBranch: "refs/heads/main",
    commit: originalCommit,
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
    preparePullRequestReconciliation: async () => { events.push("verify-pending"); return { baseCommit }; },
    prepareBranch: async () => { throw new Error("must not prepare"); },
    verifySession: async () => ({ commit: reconciled ? reconciledCommit : originalCommit }),
    pushCommit: async (_branch, commit) => { events.push(`push:${commit}`); },
    // Sin recibos, el efecto se vuelve a ejecutar y el adaptador reusa el PR canónico (ADR-0038).
    createOrReusePullRequest: async () => { events.push("pull-request"); return { number: 201 }; },
    verifyPullRequestReconciliation: async () => { events.push("verify-reconciled"); },
    // El conflicto sigue ahí hasta que la sesión de reconciliación lo resuelve: sin estado de
    // reconciliación en el checkpoint, retomar es volver a chocar y abrir una sesión nueva.
    mergePullRequest: async () => {
      events.push("merge");
      if (!reconciled) throw new GitHubPullRequestConflictError(201);
      return { number: 201, mergeCommit: "d".repeat(40) };
    },
    closeIssue: async () => { events.push("close"); },
    cleanupBranch: async () => { events.push("cleanup"); },
  };
  const code = await createCli({
    huInfoService: { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    agentSource: {
      run: async (options) => {
        runs += 1;
        expect(options.session).toBeNull();
        expect(options.prompt).toContain(baseCommit);
        expect(options.prompt).toContain("Coordinator-fixed pull request: #201");
        reconciled = true;
        return execution();
      },
      resume: async () => { throw new Error("la reconciliación no reanuda"); },
    },
    githubManagedQueue: { selectAndClaimEligibleIssue: async () => { selections += 1; return { kind: "empty" as const }; }, reconcileClaimedIssue: async () => fakeSelectedIssue(179) },
    githubCheckpointStore: store,
    githubRepositoryLock: { acquire: async () => async () => undefined },
    githubDelivery: delivery,
  }).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  // La reconciliación interrumpida se retoma con una sesión nueva, no reanudando la anterior
  // (ADR-0039): el conflicto sigue en el árbol y el prompt vuelve a nombrarlo.
  expect({ selections, runs, resumes }).toEqual({ selections: 1, runs: 1, resumes: 0 });
  expect(events.indexOf("verify-reconciled")).toBeLessThan(events.indexOf(`push:${reconciledCommit}`));
  expect(events.indexOf(`push:${reconciledCommit}`)).toBeLessThan(events.lastIndexOf("merge"));
  expect(events.lastIndexOf("merge")).toBeLessThan(events.indexOf("close"));
  expect(events.indexOf("close")).toBeLessThan(events.indexOf("cleanup"));
  expect(current).toBeNull();
});


test("reconciliación de padres ocurre después de la limpieza y antes de borrar el checkpoint", async () => {
  const events: string[] = [];
  let current: GitHubDeliveryCheckpoint | null = null;
  const store: GitHubCheckpointStore = {
    read: async () => current,
    write: async (checkpoint) => { current = checkpoint; events.push(checkpoint.commit ? "write:verified" : "write:unverified"); },
    clear: async () => { events.push("clear"); current = null; },
  };
  const delivery: GitHubDeliveryAdapter = {
    prepareBranch: async () => ({ branch: "refs/heads/issue/179", baseBranch: "refs/heads/main" }),
    verifySession: async () => ({ commit: "a".repeat(40) }),
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

  const code = await createCli({
    huInfoService: { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    agentSource: { run: async () => execution(), resume: async () => execution().result },
    githubManagedQueue: queue,
    githubCheckpointStore: store,
    githubRepositoryLock: { acquire: async () => async () => undefined },
    githubDelivery: delivery,
    githubParentReconciliation: parents,
  }).run(["code", "--working-directory", "/repo"]);

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

  const code = await createCli({
    huInfoService: { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    agentSource: { run: async () => { openCodeRuns += 1; return execution(); }, resume: async () => execution().result },
    githubManagedQueue: queue,
    githubCheckpointStore: store,
    githubRepositoryLock: { acquire: async () => async () => undefined },
    githubParentReconciliation: parents,
  }).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(reconciled).toBe(1);
  expect(openCodeRuns).toBe(0);
});

/** Una sesión que termina sin el marcador; la reanudación sí lo alcanza. */
function pendingExecution() {
  return {
    result: AgentResult.fromJsonLines(JSON.stringify({
      type: "text",
      sessionID: "ses_179",
      part: { type: "text", text: "still working" },
    })),
    azureLoginRequired: false,
    failed: false,
  };
}


/**
 * El resumen de entrega (ADR-0037): lo último que dijo la sesión es lo que un
 * revisor abre. No hay manifest que renderizar ni evidencia que mostrar, así que
 * el cuerpo del PR es la referencia al Issue y ese texto, y nada más.
 */
function deliveryService(calls: string[][]) {
  return new GitHubDeliveryService(
    async (command) => {
      calls.push(command);
      if (command[0] === "repo") return JSON.stringify({ nameWithOwner: "acme/app", defaultBranchRef: { name: "main" } });
      if (command[0] === "pr" && command[1] === "list") return "[]";
      if (command[0] === "pr" && command[1] === "create") return "https://github.com/acme/app/pull/7\n";
      if (command[0] === "issue" && command[1] === "view") return JSON.stringify({ state: "OPEN", comments: [] });
      if (command[0] === "issue") return "";
      throw new Error(`unexpected gh command: ${command.join(" ")}`);
    },
    async (command) => {
      if (command[0] === "remote") return "git@github.com:acme/app.git\n";
      if (command[0] === "ls-remote") return `${"a".repeat(40)}\trefs/heads/issue/42\n`;
      throw new Error(`unexpected git command: ${command.join(" ")}`);
    },
  );
}

test("el cuerpo del PR es la referencia al Issue y el resumen del agente", async () => {
  const calls: string[][] = [];

  await deliveryService(calls).createOrReusePullRequest(
    42, "refs/heads/issue/42", "refs/heads/main", "a".repeat(40), "/repo", true, "#42",
    "Agregué el parser de X y cubrí el caso vacío con tests.",
  );

  const body = calls.find(([verb, action]) => verb === "pr" && action === "create")!.at(-1);
  expect(body).toBe("Closes #42\n\nAgregué el parser de X y cubrí el caso vacío con tests.");
});

test("un PR sin resumen lleva solo la referencia", async () => {
  const calls: string[][] = [];

  await deliveryService(calls).createOrReusePullRequest(42, "refs/heads/issue/42", "refs/heads/main", "a".repeat(40), "/repo");

  expect(calls.find(([verb, action]) => verb === "pr" && action === "create")!.at(-1)).toBe("Closes #42");
});

test("el comentario que cierra el Issue es solo el marcador de entrega", async () => {
  const calls: string[][] = [];
  const service = new GitHubDeliveryService(
    async (command) => {
      calls.push(command);
      if (command[0] === "issue" && command[1] === "view") {
        return JSON.stringify(calls.some(([verb, action]) => verb === "issue" && action === "close")
          ? { state: "CLOSED" }
          : { state: "OPEN", comments: [] });
      }
      return "";
    },
    async () => { throw new Error("must not use git"); },
  );

  await service.closeIssue(42, 7, "c".repeat(40), "/repo");

  const comment = calls.find(([verb, action]) => verb === "issue" && action === "comment")!.at(-1);
  expect(comment).toBe("lazy-workflow: delivered PR #7 (ccccccccccccccccccccccccccccccccccccccccc".slice(0, -1) + ")");
});

test("el resumen del agente llega al cuerpo del PR que abre el coordinador", async () => {
  const bodies: string[] = [];
  const queue = {
    verifyAuthentication: async () => ({ login: "bot" }),
    verifyRepository: async () => ({ nameWithOwner: "owner/repo" }),
    selectAndClaimEligibleIssue: async () => { throw new Error("must use checkpointed selection"); },
    selectEligibleIssue: async function () {
      if (this.done) return { kind: "empty" as const };
      this.done = true;
      return { kind: "candidate" as const, issue: fakeSelectedIssue(178), repository: { nameWithOwner: "owner/repo" } };
    },
    claimSelectedIssue: async () => fakeSelectedIssue(178),
    done: false,
  };

  const code = await createCli({
    huInfoService: { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    agentSource: {
      run: async () => ({
        result: AgentResult.fromJsonLines(JSON.stringify({
          type: "text",
          sessionID: "ses_178",
          part: { type: "text", text: "Reescribí el parser y agregué tests del caso vacío.\nIMPLEMENTATION_READY" },
        })),
        azureLoginRequired: false,
      }),
      resume: async () => { throw new Error("must not resume"); },
    },
    githubManagedQueue: queue,
    ...fakeCoordinatedGitHubDeps(),
    githubDelivery: fakeGitHubDelivery({
      createOrReusePullRequest: async (_issue, _branch, _base, _commit, _dir, _closes, _ref, summary) => {
        bodies.push(summary ?? "");
        return { number: 1 };
      },
    }),
  }).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(0);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toContain("Reescribí el parser y agregué tests del caso vacío.");
});

/**
 * La verificación de sesión (ADR-0035): lo que el coordinador pregunta cuando el
 * proceso del agente sale. No hay marcador que leer ni manifest que validar, así
 * que responde git — la rama activa, el árbol y los commits sobre la base.
 */
function verifyingService(answers: Record<string, string>) {
  return new GitHubDeliveryService(
    async () => { throw new Error("must not use GitHub"); },
    async (command) => {
      const key = command.slice(0, 2).join(" ");
      const answer = answers[key] ?? answers[command[0]!];
      if (answer === undefined) throw new Error(`unexpected git command: ${command.join(" ")}`);
      return answer;
    },
  );
}

const verified = {
  "symbolic-ref --quiet": "issue/42\n",
  "status --porcelain": "",
  "rev-list --count": "3\n",
  "rev-parse HEAD^{commit}": `${"a".repeat(40)}\n`,
};

test("una sesión verificada devuelve el commit que git tiene en HEAD", async () => {
  expect(await verifyingService(verified).verifySession("refs/heads/issue/42", "refs/heads/main", "/repo"))
    .toEqual({ commit: "a".repeat(40) });
});

test("una rama sin commits sobre la base no es una sesión verificada", async () => {
  await expect(verifyingService({ ...verified, "rev-list --count": "0\n" })
    .verifySession("refs/heads/issue/42", "refs/heads/main", "/repo"))
    .rejects.toThrow("no tiene commits sobre");
});

test("un árbol sucio no es una sesión verificada", async () => {
  await expect(verifyingService({ ...verified, "status --porcelain": " M src/x.ts\n" })
    .verifySession("refs/heads/issue/42", "refs/heads/main", "/repo"))
    .rejects.toThrow("sin commitear");
});

test("otra rama activa no es una sesión verificada", async () => {
  await expect(verifyingService({ ...verified, "symbolic-ref --quiet": "main\n" })
    .verifySession("refs/heads/issue/42", "refs/heads/main", "/repo"))
    .rejects.toThrow("no coincide");
});

test("una sesión sin commits sobre la base no abre PR y deja la issue reclamada", async () => {
  const effects: string[] = [];
  const queue = {
    verifyAuthentication: async () => ({ login: "bot" }),
    verifyRepository: async () => ({ nameWithOwner: "owner/repo" }),
    selectAndClaimEligibleIssue: async () => { throw new Error("must use checkpointed selection"); },
    selectEligibleIssue: async function () {
      if (this.done) return { kind: "empty" as const };
      this.done = true;
      return { kind: "candidate" as const, issue: fakeSelectedIssue(178), repository: { nameWithOwner: "owner/repo" } };
    },
    claimSelectedIssue: async () => fakeSelectedIssue(178),
    releaseOwnClaim: async () => { effects.push("release"); },
    done: false,
  };

  const code = await createCli({
    huInfoService: { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    agentSource: {
      run: async () => ({
        result: AgentResult.fromJsonLines(JSON.stringify({
          type: "text", sessionID: "ses_178", part: { type: "text", text: "No entendí el issue, ¿podrías aclararlo?\nIMPLEMENTATION_READY" },
        })),
        azureLoginRequired: false,
      }),
      resume: async () => { throw new Error("must not resume"); },
    },
    githubManagedQueue: queue,
    ...fakeCoordinatedGitHubDeps(),
    githubDelivery: fakeGitHubDelivery({
      verifySession: async () => { throw new GitHubSessionNotVerifiedError("la rama refs/heads/issue/178 no tiene commits sobre refs/heads/main"); },
      pushCommit: async () => { effects.push("push"); },
      createOrReusePullRequest: async () => { effects.push("pr"); return { number: 1 }; },
    }),
  }).run(["code", "--working-directory", "/repo"]);

  expect(code).toBe(1);
  expect(effects).toEqual([]);
});

/**
 * El drenaje no se detiene por una unidad (ADR-0038): la issue que falla conserva
 * su claim, que es lo que la saca de la frontera, y el bucle sigue con la
 * siguiente. Una issue mal escrita a mitad de la cola no puede parar las diez que
 * vienen detrás.
 */
test("una issue que falla no detiene el drenaje: la siguiente se entrega igual", async () => {
  const delivered: number[] = [];
  const pending = [178, 179];
  const queue = {
    verifyAuthentication: async () => ({ login: "bot" }),
    verifyRepository: async () => ({ nameWithOwner: "owner/repo" }),
    selectAndClaimEligibleIssue: async () => { throw new Error("must use checkpointed selection"); },
    selectEligibleIssue: async () => {
      const next = pending.shift();
      return next
        ? { kind: "candidate" as const, issue: fakeSelectedIssue(next), repository: { nameWithOwner: "owner/repo" } }
        : { kind: "empty" as const };
    },
    claimSelectedIssue: async (issue: number) => fakeSelectedIssue(issue),
    releaseOwnClaim: async () => { throw new Error("una unidad que falla conserva su claim"); },
  };

  const code = await createCli({
    huInfoService: { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
    agentSource: {
      run: async () => ({
        result: AgentResult.fromJsonLines(JSON.stringify({
          type: "text", sessionID: "ses", part: { type: "text", text: "hecho" },
        })),
        azureLoginRequired: false,
      }),
      resume: async () => { throw new Error("must not resume"); },
    },
    githubManagedQueue: queue,
    ...fakeCoordinatedGitHubDeps(),
    githubDelivery: fakeGitHubDelivery({
      verifySession: async (_branch, _base, _dir) => {
        if (delivered.length === 0) {
          delivered.push(-178);
          throw new GitHubSessionNotVerifiedError("la rama refs/heads/issue/178 no tiene commits sobre refs/heads/main");
        }
        return { commit: "a".repeat(40) };
      },
      closeIssue: async (issue) => { delivered.push(issue); },
    }),
  }).run(["code", "--working-directory", "/repo"]);

  // La #179 se entrega igual; el código de salida dice que algo quedó roto detrás.
  expect(delivered).toEqual([-178, 179]);
  expect(code).toBe(1);
});
