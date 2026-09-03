import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GitHubDeliveryCheckpointStore,
  isGitHubDeliveryCheckpoint,
  type GitHubDeliveryCheckpoint,
} from "../src/github/github-delivery-checkpoint.ts";
import { GitHubRepositoryLockService } from "../src/github/github-repository-lock.ts";
import { runGit } from "../src/git/git-ticket-branch-cleaner.ts";

function checkpoint(): GitHubDeliveryCheckpoint {
  return {
    schemaVersion: 3,
    workflow: "github-code",
    repository: "elvisbrevi/agent-workflow",
    issue: 178,
    branch: "refs/heads/issue/178",
    baseBranch: "refs/heads/main",
    commit: "a".repeat(40),
  };
}

test("valida el checkpoint GitHub sin aceptar campos que ya no lleva", () => {
  expect(isGitHubDeliveryCheckpoint(checkpoint())).toBeTrue();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), commit: null })).toBeTrue();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), summary: "lo que hizo la sesión" })).toBeTrue();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), token: "secret" })).toBeFalse();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), branch: undefined })).toBeFalse();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), commit: "no-es-un-commit" })).toBeFalse();
  // Lo que la máquina de fases dejó atrás no vuelve por la puerta de la validación.
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), phase: "implementing" })).toBeFalse();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), sessionId: "ses_178" })).toBeFalse();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), cli: "opencode" })).toBeFalse();
  expect(isGitHubDeliveryCheckpoint({ ...checkpoint(), receipts: {} })).toBeFalse();
});

test("un checkpoint de un esquema anterior se descarta en vez de migrarse", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-github-checkpoint-legacy-"));
  const store = new GitHubDeliveryCheckpointStore();
  try {
    await runGit(["init"], root);
    const path = join(root, (await runGit(["rev-parse", "--git-path", "lazy-workflow/github-code-checkpoint.json"], root)).trim());
    // El esquema 2 guardaba una fase y una sesión que el coordinador ya no sabe continuar:
    // traducirlo sería inventar la única respuesta que importa.
    await Bun.write(path, JSON.stringify({
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
      receipts: {},
    }));

    expect(await store.read(root)).toBeNull();
    expect(await Bun.file(path).exists()).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
