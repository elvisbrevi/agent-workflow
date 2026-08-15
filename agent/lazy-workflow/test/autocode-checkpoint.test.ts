import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GitAutocodeCheckpointStore,
  isVersionedAutocodeCheckpoint,
  migrateAutocodeCheckpoint,
  type VersionedAutocodeCheckpoint,
} from "../src/azure/autocode-checkpoint.ts";
import { runGit } from "../src/git/git-ticket-branch-cleaner.ts";

test("migra el checkpoint legacy a implementing sin adivinar efectos completados", () => {
  const migrated = migrateAutocodeCheckpoint({
    workflow: "autocode",
    hu: 23438,
    ticket: 51,
    sessionId: "ses-51",
  });

  expect(migrated).toEqual({
    schemaVersion: 3,
    cli: "opencode",
    workflow: "autocode",
    phase: "implementing",
    hu: 23438,
    ticket: 51,
    integrationBranch: null,
    ticketBranch: null,
    azureRevision: null,
    effortBaseline: { real: 0, realHours: 0 },
    activeDurationMs: 0,
    activeSince: null,
    sessionId: "ses-51",
    intent: null,
    receipts: {},
  });
});

test("reconoce solo checkpoints versionados validos", () => {
  const checkpoint: VersionedAutocodeCheckpoint = {
    schemaVersion: 3,
    cli: "claudecode",
    workflow: "autocode",
    phase: "selected",
    hu: 23438,
    ticket: 51,
    integrationBranch: "refs/heads/hu/23438",
    ticketBranch: null,
    azureRevision: 4,
    effortBaseline: { real: 1, realHours: 1 },
    activeDurationMs: 250,
    activeSince: null,
    sessionId: null,
    intent: null,
    receipts: {},
  };

  expect(isVersionedAutocodeCheckpoint(checkpoint)).toBe(true);
  expect(migrateAutocodeCheckpoint({ ...checkpoint, phase: "unknown" })).toBeNull();
});

test("contabiliza una operacion interrumpida una sola vez al migrar", () => {
  const migrated = migrateAutocodeCheckpoint({
    schemaVersion: 3,
    cli: "opencode",
    workflow: "autocode",
    phase: "started",
    hu: 23438,
    ticket: 51,
    integrationBranch: "refs/heads/hu/23438",
    ticketBranch: "refs/heads/ticket/51",
    azureRevision: 4,
    effortBaseline: { real: 1, realHours: 1 },
    activeDurationMs: 25,
    activeSince: "1970-01-01T00:00:01.000Z",
    sessionId: null,
    intent: null,
    receipts: {},
  }, 1_500);

  expect(migrated?.activeDurationMs).toBe(525);
  expect(migrated?.activeSince).toBeNull();
});

test("un checkpoint autocode de la versión anterior se lee como OpenCode", () => {
  const migrated = migrateAutocodeCheckpoint({
    schemaVersion: 2,
    workflow: "autocode",
    phase: "implementing",
    hu: 23438,
    ticket: 51,
    integrationBranch: "refs/heads/hu/23438",
    ticketBranch: "refs/heads/ticket/51",
    azureRevision: 4,
    effortBaseline: { real: 1, realHours: 1 },
    activeDurationMs: 25,
    activeSince: null,
    sessionId: "ses-51",
    intent: null,
    receipts: {},
  });

  expect(migrated?.schemaVersion).toBe(3);
  expect(migrated?.cli).toBe("opencode");
  expect(migrated?.sessionId).toBe("ses-51");
});

test("rechaza un CLI dueño desconocido en el checkpoint autocode", () => {
  expect(migrateAutocodeCheckpoint({
    schemaVersion: 3,
    cli: "gemini",
    workflow: "autocode",
    phase: "implementing",
    hu: 23438,
    ticket: 51,
    integrationBranch: null,
    ticketBranch: null,
    azureRevision: null,
    effortBaseline: { real: 0, realHours: 0 },
    activeDurationMs: 0,
    activeSince: null,
    sessionId: null,
    intent: null,
    receipts: {},
  })).toBeNull();
});

test("migra un checkpoint legacy sessionless a reconciliacion", () => {
  expect(migrateAutocodeCheckpoint({ workflow: "autocode", hu: 23438, ticket: 51, sessionId: null })?.phase).toBe("reconciling");
});

test("reescribe en disco un checkpoint autocode de la versión anterior", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-checkpoint-legacy-"));
  const store = new GitAutocodeCheckpointStore();
  try {
    await runGit(["init"], root);
    const path = join(root, (await runGit(["rev-parse", "--git-path", "lazy-workflow/autocode-checkpoint.json"], root)).trim());
    await Bun.$`mkdir -p ${join(root, ".git", "lazy-workflow")}`.quiet();
    await Bun.write(path, `${JSON.stringify({
      schemaVersion: 2,
      workflow: "autocode",
      phase: "implementing",
      hu: 23438,
      ticket: 51,
      integrationBranch: "refs/heads/hu/23438",
      ticketBranch: "refs/heads/ticket/51",
      azureRevision: 4,
      effortBaseline: { real: 1, realHours: 1 },
      activeDurationMs: 25,
      activeSince: null,
      sessionId: "ses-51",
      intent: null,
      receipts: {},
    })}\n`);

    const read = await store.read(root);
    expect(read?.schemaVersion).toBe(3);
    expect(read?.cli).toBe("opencode");
    expect(await Bun.file(path).json()).toEqual(read);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("guarda el checkpoint en el repositorio del working directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-checkpoint-"));
  const store = new GitAutocodeCheckpointStore();
  const checkpoint: VersionedAutocodeCheckpoint = {
    schemaVersion: 3,
    cli: "opencode",
    workflow: "autocode",
    phase: "selected",
    hu: 23438,
    ticket: 51,
    integrationBranch: null,
    ticketBranch: null,
    azureRevision: null,
    effortBaseline: { real: 0, realHours: 0 },
    activeDurationMs: 0,
    activeSince: null,
    sessionId: null,
    intent: null,
    receipts: {},
  };

  try {
    await runGit(["init"], root);
    await store.write(checkpoint, root);

    const checkpointPath = (await runGit(["rev-parse", "--git-path", "lazy-workflow/autocode-checkpoint.json"], root)).trim();
    expect(await Bun.file(join(root, checkpointPath)).exists()).toBeTrue();
    expect(await store.read(root)).toEqual(checkpoint);

    await store.clear(root);
    expect(await Bun.file(join(root, checkpointPath)).exists()).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
