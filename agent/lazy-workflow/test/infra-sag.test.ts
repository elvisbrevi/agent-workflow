import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import {
  InfrastructureAuthenticationRequiredError,
  SagInfrastructureService,
  type InfrastructureObservation,
  type InfrastructureSystems,
} from "../src/sag/infrastructure-service.ts";
import { SagNormsService, type SagNormSource } from "../src/sag/sag-norms-service.ts";

const root = `${process.env.TMPDIR ?? "/tmp"}/lazy-workflow-infra-${crypto.randomUUID()}`;

const observation: InfrastructureObservation = {
  repository: { id: "project/repository", baseBranch: "main", exists: true, baseBranchExists: true },
  consul: { deployKey: "project/deploy", variables: ["DATABASE_URL"], available: true },
  database: { id: "database-1", available: true },
  pipeline: { id: "pipeline-7", available: true },
  releaseDefinition: { id: "release-1", available: true },
};

const config = async (): Promise<string> => {
  const directory = `${root}-${crypto.randomUUID()}`;
  await mkdir(`${directory}/.sag`, { recursive: true });
  await Bun.write(`${directory}/.sag/config.json`, JSON.stringify({
    tipo: "api",
    infrastructure: {
      authentication: "operator",
      adapter: { command: [".sag/infra-adapter"] },
      repository: { id: "project/repository", baseBranch: "main" },
      consul: { deployKey: "project/deploy", requiredVariables: ["DATABASE_URL"] },
      database: { required: true, id: "database-1" },
      pipeline: { required: true, id: "pipeline-7" },
      releaseDefinition: { required: true, id: "release-1" },
    },
  }));
  return directory;
};

const scope = { tracker: "github" as const, id: 155, title: "Verify SAG infrastructure prerequisites" };
const context = {
  phase: "infrastructure" as const,
  sourceRepository: "https://example.test/sag",
  branch: "master" as const,
  commit: "infra-commit",
  component: "api" as const,
  explicitFacts: { changeKind: "infrastructure", artifacts: ["consul"], capabilities: null, significantChange: null, environment: "none" },
  selectedRules: [],
  needsDecision: [],
};

test("infra-sag loads traceable infrastructure norms from the canonical snapshot", async () => {
  const directory = await config();
  const source: SagNormSource = {
    load: async (paths) => {
      expect(paths).toEqual([
        "/estandares/comunes.md",
        "/estandares/api.md",
        "/estandares/api-adonis-patrones.md",
        "/estandares/integraciones.md",
      ]);
      return {
        commit: "infra-commit",
        files: {
          "/estandares/comunes.md": "com-G1",
          "/estandares/api.md": "api-R1",
          "/estandares/api-adonis-patrones.md": "api-R9",
          "/estandares/integraciones.md": "int-R1",
        },
      };
    },
  };
  try {
    const loaded = await new SagNormsService(source).loadInfrastructure(directory);
    expect(loaded.phase).toBe("infrastructure");
    expect(loaded.commit).toBe("infra-commit");
    expect(loaded.selectedRules.map(({ ruleId }) => ruleId)).toEqual(["com-G1", "api-R1", "api-R9", "int-R1"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("infra-sag succeeds only when every configured prerequisite is verified", async () => {
  const directory = await config();
  let calls = 0;
  const systems: InfrastructureSystems = {
    verify: async (_config, receivedScope) => {
      calls += 1;
      expect(receivedScope).toEqual(scope);
      return observation;
    },
  };
  try {
    await expect(new SagInfrastructureService(systems).verify(scope, directory)).resolves.toEqual({
      status: "ready",
      observations: observation,
      findings: [],
    });
    expect(calls).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("infra-sag publishes one corrective ticket for each missing prerequisite", async () => {
  const directory = await config();
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));
  try {
    const missing: InfrastructureObservation = {
      ...observation,
      repository: { ...observation.repository, baseBranchExists: false },
      consul: { ...observation.consul, variables: [] },
      database: { ...observation.database, available: false },
      pipeline: { ...observation.pipeline, available: false },
      releaseDefinition: { ...observation.releaseDefinition, available: false },
    };
    let publishedIssue = 0;
    let publishedCount = 0;
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
      { run: async () => { throw new Error("must not run OpenCode"); }, resume: async () => { throw new Error("must not resume"); } },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("must not plan"); }, loadInfrastructure: async () => context },
      undefined,
      {
        readIssue: async (issue) => ({ number: issue, title: scope.title, body: "scope", comments: [], state: "OPEN", labels: [] }),
        publishFindings: async (issue, _specification, tickets) => {
          publishedIssue = issue;
          publishedCount = tickets.length;
          return { specification: 200, tickets: tickets.map((_, index) => 201 + index) };
        },
      },
      undefined,
      new SagInfrastructureService({ verify: async () => missing }),
    ).run(["infra-sag", "--issue", "155", "--working-directory", directory]);

    expect(code).toBe(0);
    expect(publishedIssue).toBe(155);
    expect(publishedCount).toBe(5);
    expect(output[0]).toContain('"status": "findings"');
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("infra-sag retries Azure authentication once without exposing credentials", async () => {
  const directory = await config();
  let attempts = 0;
  let waits = 0;
  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => ({ id: 23438, title: "HU" }), waitForAccess: async () => { waits += 1; } },
      { run: async () => { throw new Error("must not run OpenCode"); }, resume: async () => { throw new Error("must not resume"); } },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("must not plan"); }, loadInfrastructure: async () => context },
      undefined,
      undefined,
      undefined,
      new SagInfrastructureService({ verify: async () => {
          attempts += 1;
          if (attempts === 1) throw new InfrastructureAuthenticationRequiredError();
          return observation;
        } }),
    ).run(["infra-sag", "--hu", "23438", "--working-directory", directory]);

    expect(code).toBe(0);
    expect(attempts).toBe(2);
    expect(waits).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("infra-sag rejects missing or conflicting scope before external services", async () => {
  let calls = 0;
  for (const args of [["infra-sag"], ["infra-sag", "--hu", "1", "--issue", "2"], ["infra-sag", "--issue", "bad"]]) {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { calls += 1; throw new Error("must not call Azure"); }, waitForAccess: async () => undefined },
      { run: async () => { calls += 1; throw new Error("must not run"); }, resume: async () => { calls += 1; throw new Error("must not resume"); } },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { calls += 1; throw new Error("must not load"); }, loadInfrastructure: async () => { calls += 1; throw new Error("must not load"); } },
      undefined,
      { readIssue: async () => { calls += 1; throw new Error("must not read issue"); }, publishFindings: async () => ({ specification: 1, tickets: [] }) },
      undefined,
      new SagInfrastructureService({ verify: async () => { calls += 1; throw new Error("must not verify"); } }),
    ).run([...args, "--working-directory", root]);
    expect(code).toBe(1);
  }
  expect(calls).toBe(0);
});
