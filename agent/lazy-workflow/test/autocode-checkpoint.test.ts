import { expect, test } from "bun:test";
import {
  isVersionedAutocodeCheckpoint,
  migrateAutocodeCheckpoint,
  type VersionedAutocodeCheckpoint,
} from "../src/azure/autocode-checkpoint.ts";

test("migra el checkpoint legacy a implementing sin adivinar efectos completados", () => {
  const migrated = migrateAutocodeCheckpoint({
    workflow: "autocode",
    hu: 23438,
    ticket: 51,
    sessionId: "ses-51",
  });

  expect(migrated).toEqual({
    schemaVersion: 2,
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
    schemaVersion: 2,
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
    schemaVersion: 2,
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

test("migra un checkpoint legacy sessionless a reconciliacion", () => {
  expect(migrateAutocodeCheckpoint({ workflow: "autocode", hu: 23438, ticket: 51, sessionId: null })?.phase).toBe("reconciling");
});
