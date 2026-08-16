import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GITHUB_DELIVERY_PHASES,
  GitHubDeliveryCheckpointStore,
  isGitHubDeliveryCheckpoint,
  type GitHubDeliveryCheckpoint,
} from "../src/github/github-delivery-checkpoint.ts";
import { GitHubRepositoryLockService } from "../src/github/github-repository-lock.ts";
import { runGit } from "../src/git/git-ticket-branch-cleaner.ts";

function checkpoint(): GitHubDeliveryCheckpoint {
  return {
    schemaVersion: 2,
    cli: "opencode",
    workflow: "github-code",
    repository: "elvisbrevi/agent-workflow",
    issue: 178,
    phase: "implementing",
    branch: "refs/heads/issue/178",
    sessionId: "ses_178",
    commit: "a".repeat(40),
    pullRequest: null,
    receipts: { selected: { verifiedAt: "2026-08-14T00:00:00.000Z" } },
  };
}

test("valida el checkpoint GitHub sin aceptar transcriptos o credenciales", () => {
  expect(isGitHubDeliveryCheckpoint(checkpoint())).toBeTrue();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), token: "secret" })).toBeFalse();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), receipts: { selected: { verifiedAt: "now", token: "secret" } } })).toBeFalse();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), branch: undefined })).toBeFalse();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), receipts: [] })).toBeFalse();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), sessionId: "ses\nsecret" })).toBeFalse();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), phase: "unknown" })).toBeFalse();
});

test("el checkpoint GitHub nombra el CLI dueño de la sesión", () => {
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), cli: "claudecode" })).toBeTrue();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), cli: "gemini" })).toBeFalse();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), cli: undefined })).toBeFalse();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), schemaVersion: 1 })).toBeFalse();
});

test("el checkpoint GitHub registra el CLI del que un traspaso movió la sesión", () => {
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), cli: "claudecode", handoffFrom: "opencode" })).toBeTrue();
  // Ausente es el caso normal: ningún traspaso movió la sesión.
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), handoffFrom: undefined })).toBeTrue();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), handoffFrom: "gemini" })).toBeFalse();
});

test("un checkpoint GitHub de la versión anterior se lee como OpenCode y se reescribe", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-github-checkpoint-legacy-"));
  const store = new GitHubDeliveryCheckpointStore();
  try {
    await runGit(["init"], root);
    const { schemaVersion: _version, cli: _cli, ...rest } = checkpoint();
    const path = join(root, (await runGit(["rev-parse", "--git-path", "lazy-workflow/github-code-checkpoint.json"], root)).trim());
    await Bun.write(path, `${JSON.stringify({ schemaVersion: 1, ...rest })}\n`);

    expect(await store.read(root)).toEqual(checkpoint());
    expect(await Bun.file(path).json()).toEqual(checkpoint());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const phase of GITHUB_DELIVERY_PHASES) {
  test(`acepta la fase GitHub ${phase}`, () => {
    expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), phase })).toBeTrue();
  });
}

test("guarda y recupera el checkpoint GitHub desde la metadata del repositorio", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-github-checkpoint-"));
  const store = new GitHubDeliveryCheckpointStore();
  try {
    await runGit(["init"], root);
    await store.write(checkpoint(), root);
    expect(await store.read(root)).toEqual(checkpoint());
    await store.clear(root);
    expect(await store.read(root)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("el lock GitHub impide dos ejecuciones y libera de forma idempotente", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-github-lock-"));
  const lock = new GitHubRepositoryLockService();
  try {
    await runGit(["init"], root);
    const release = await lock.acquire(root);
    await expect(lock.acquire(root)).rejects.toThrow("bloqueado");
    await release();
    await release();
    const secondRelease = await lock.acquire(root);
    await secondRelease();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
