import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { RemoteSagNormSource, SagNormsService, type SagArchitectureReviewContext, type SagNormSource } from "../src/sag/sag-norms-service.ts";
import { GitHubArchitectureReviewService } from "../src/github/architecture-review-service.ts";
import { OpenCodeResult } from "../src/opencode/open-code-result.ts";
import type { OpenCodeRunOptions } from "../src/opencode/open-code-service.ts";
import { fakeSelectedIssue, fakeSelectedOutcome, queueAdapter } from "./_helpers/managed-queue-fixtures.ts";
import { fakeCoordinatedGitHubDeps } from "./_helpers/github-delivery-fixtures.ts";

const root = `${process.env.TMPDIR ?? "/tmp"}/lazy-workflow-sag-${crypto.randomUUID()}`;

async function config(component = "api", facts: Record<string, unknown> = {}): Promise<string> {
  const directory = `${root}-${crypto.randomUUID()}`;
  await mkdir(`${directory}/.sag`, { recursive: true });
  await Bun.write(`${directory}/.sag/config.json`, JSON.stringify({ tipo: component, ...facts }));
  return directory;
}

function source(): SagNormSource {
  return {
    async load(paths) {
      expect(paths).toEqual([
        "/estandares/comunes.md",
        "/estandares/api.md",
        "/estandares/api-adonis-patrones.md",
        "/estandares/seguimiento.md",
        "/estandares/documentacion.md",
        "/estandares/integraciones.md",
        "/estandares/extraccion-documentos.md",
        "/estandares/sonarqube.md",
      ]);
      return {
        commit: "commit-master-123",
        files: {
          "/estandares/comunes.md": "# com-G1\n",
          "/estandares/api.md": "# api-R1\n# api-R9\n",
          "/estandares/api-adonis-patrones.md": "# api-R10\n",
          "/estandares/seguimiento.md": "# seg-R1\n",
          "/estandares/documentacion.md": "# doc-R1\n",
          "/estandares/integraciones.md": "# int-R1\n",
          "/estandares/extraccion-documentos.md": "# ext-R1\n",
          "/estandares/sonarqube.md": "# sonar-R1\n",
        },
      };
    },
  };
}

function codingSource(): SagNormSource {
  return {
    async load(paths) {
      expect(paths).toEqual([
        "/estandares/comunes.md",
        "/estandares/api.md",
        "/estandares/api-adonis-patrones.md",
        "/estandares/seguimiento.md",
        "/estandares/documentacion.md",
        "/estandares/integraciones.md",
        "/estandares/extraccion-documentos.md",
        "/estandares/pull-requests.md",
        "/estandares/sonarqube.md",
      ]);
      return {
        commit: "coding-commit",
        files: {
          "/estandares/comunes.md": "com-C1 com-C2 com-C3 com-C4 com-C5",
          "/estandares/api.md": "api-R1",
          "/estandares/api-adonis-patrones.md": "api-R9 api-R10",
          "/estandares/seguimiento.md": "seg-R1",
          "/estandares/documentacion.md": "doc-R1",
          "/estandares/integraciones.md": "int-R1",
          "/estandares/extraccion-documentos.md": "ext-R1",
          "/estandares/pull-requests.md": "pr-R1",
          "/estandares/sonarqube.md": "sonar-R1",
        },
      };
    },
  };
}

const reviewTracker = {
  readIssue: async (issue: number) => ({ number: issue, title: "Issue scope", body: "scope", comments: [], state: "OPEN", labels: [] }),
  publishFindings: async () => ({ specification: 200, tickets: [201] }),
};

test("plan selecciona normas por fase y componente y conserva decisiones desconocidas", async () => {
  const directory = await config();
  try {
    const context = await new SagNormsService(source()).loadPlanning(directory);

    expect(context.commit).toBe("commit-master-123");
    expect(context.branch).toBe("master");
    expect(context.component).toBe("api");
    expect(context.selectedRules.map(({ ruleId }) => ruleId)).toEqual(["com-G1", "api-R1", "api-R9", "api-R10", "doc-R1", "int-R1", "ext-R1", "sonar-R1", "seg-R1"]);
    expect(context.selectedRules.every((rule) => rule.classification === "N" && rule.commit === context.commit)).toBeTrue();
    expect(context.selectedRules[1]?.applicability).toBe("applicable");
    expect(context.selectedRules[3]?.applicability).toBe("needs-decision");
    expect(context.selectedRules[4]?.applicability).toBe("needs-decision");
    expect(context.selectedRules[1]?.source).toContain("version=GBmaster");
    expect(context.selectedRules[1]?.selectedBecause).toContain("tipo=api");
    expect(context.needsDecision).toEqual([
      "change-kind",
      "artifacts",
      "capabilities",
      "significant-change",
      "environment",
      "api-R10: requiere decidir aplicabilidad por artefacto o capacidad",
      "seg-R1: requiere decidir aplicabilidad por change-kind",
      "doc-R1: requiere decidir aplicabilidad por hechos de alcance",
      "int-R1: requiere decidir aplicabilidad por hechos de alcance",
      "ext-R1: requiere decidir aplicabilidad por hechos de alcance",
      "sonar-R1: requiere decidir aplicabilidad por hechos de alcance",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("coding selecciona normas comunes y familias condicionales por hechos explicitos", async () => {
  const directory = await config("api", {
    cambio: "feature",
    artefactos: ["source", "config"],
    capacidades: ["sonar"],
    cambioSignificativo: true,
    entorno: "dev",
  });
  try {
    const context = await new SagNormsService(codingSource()).loadCoding(directory);

    expect(context.phase).toBe("coding");
    expect(context.commit).toBe("coding-commit");
    expect(context.selectedRules.map(({ ruleId }) => ruleId)).toEqual([
      "com-C1", "com-C2", "com-C3", "com-C4", "com-C5",
      "api-R1", "api-R10", "api-R9", "seg-R1", "doc-R1", "int-R1", "sonar-R1",
    ]);
    expect(context.selectedRules.filter(({ ruleId }) => ["doc-R1", "int-R1", "sonar-R1"].includes(ruleId))
      .every(({ applicability }) => applicability === "applicable")).toBeTrue();
    expect(context.selectedRules.every(({ classification, commit }) => classification === "N" && commit === context.commit)).toBeTrue();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normas SAG rechazan una configuracion ausente sin consultar la fuente", async () => {
  let sourceCalls = 0;
  const service = new SagNormsService({
    load: async () => {
      sourceCalls += 1;
      throw new Error("unexpected source access");
    },
  });

  await expect(service.loadPlanning(root)).rejects.toThrow(".sag/config.json");
  expect(sourceCalls).toBe(0);
});

test("los hechos parciales no convierten reglas condicionales en aplicables", async () => {
  const directory = await config("api", {
    cambio: "feature",
    capacidades: [],
    cambioSignificativo: false,
  });
  try {
    const context = await new SagNormsService(source()).loadPlanning(directory);
    expect(context.selectedRules.find(({ ruleId }) => ruleId === "api-R10")?.applicability).toBe("needs-decision");
    expect(context.selectedRules.find(({ ruleId }) => ruleId === "seg-R1")?.applicability).toBe("needs-decision");
    expect(context.needsDecision).toContain("api-R10: requiere decidir aplicabilidad por artefacto o capacidad");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("los hechos explicitos seleccionan familias documentales aplicables", async () => {
  const directory = await config("api", {
    cambio: "feature",
    artefactos: ["document", "config"],
    capacidades: ["document-processing", "sonar"],
    cambioSignificativo: true,
    entorno: "none",
  });
  try {
    const context = await new SagNormsService({
      load: async (paths) => {
        expect(paths).toEqual([
          "/estandares/comunes.md",
          "/estandares/api.md",
          "/estandares/api-adonis-patrones.md",
          "/estandares/seguimiento.md",
          "/estandares/documentacion.md",
          "/estandares/integraciones.md",
          "/estandares/extraccion-documentos.md",
          "/estandares/sonarqube.md",
        ]);
        return {
          commit: "families-commit",
          files: {
            "/estandares/comunes.md": "com-G1",
            "/estandares/api.md": "api-R1",
            "/estandares/api-adonis-patrones.md": "api-R9",
            "/estandares/seguimiento.md": "seg-R1",
            "/estandares/documentacion.md": "doc-R1",
            "/estandares/integraciones.md": "int-R1",
            "/estandares/extraccion-documentos.md": "ext-R1",
            "/estandares/sonarqube.md": "sonar-R1",
          },
        };
      },
    }).loadPlanning(directory);

    expect(context.explicitFacts).toEqual({
      changeKind: "feature",
      artifacts: ["document", "config"],
      capabilities: ["document-processing", "sonar"],
      significantChange: true,
      environment: "none",
    });
    expect(context.selectedRules.filter(({ ruleId }) => ["doc-R1", "int-R1", "ext-R1", "sonar-R1"].includes(ruleId))
      .every(({ applicability }) => applicability === "applicable")).toBeTrue();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("los valores de alcance fuera del vocabulario quedan como decision explicita", async () => {
  const directory = await config("api", { capacidades: ["unknown-capability"] });
  try {
    const context = await new SagNormsService(source()).loadPlanning(directory);
    expect(context.explicitFacts.capabilities).toBeNull();
    expect(context.needsDecision).toContain("capabilities: contiene valores desconocidos");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("los hechos negativos omiten familias que no aplican", async () => {
  const directory = await config("api", {
    cambio: "bugfix",
    artefactos: [],
    capacidades: [],
    cambioSignificativo: false,
    entorno: "none",
  });
  try {
    const context = await new SagNormsService(source()).loadPlanning(directory);
    expect(context.selectedRules.some(({ ruleId }) => ["doc-R1", "int-R1", "ext-R1", "sonar-R1"].includes(ruleId))).toBeFalse();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("la fuente remota fija los archivos al commit unico de master", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const remote = new RemoteSagNormSource(async (input, init) => {
    requests.push({ url: input, authorization: new Headers(init?.headers).get("Authorization") });
    return input.includes("/refs?")
      ? new Response(JSON.stringify({ value: [{ name: "refs/heads/master", objectId: "master-commit" }] }))
      : new Response(JSON.stringify({ content: "com-G1" }));
  }, "secret-token");

  await expect(remote.load(["/estandares/comunes.md"])).resolves.toEqual({
    commit: "master-commit",
    files: { "/estandares/comunes.md": "com-G1" },
  });
  expect(requests[1]?.url).toContain("versionDescriptor.version=master-commit");
  expect(requests[1]?.url).toContain("versionDescriptor.versionType=commit");
  expect(requests[1]?.authorization).toContain("Basic");
  expect(requests[1]?.authorization).not.toContain("secret-token");
});

test("normas SAG rechazan aliases de configuracion en conflicto", async () => {
  const directory = await config("api", { cambio: "feature", changeKind: "bugfix" });
  try {
    await expect(new SagNormsService(source()).loadPlanning(directory)).rejects.toThrow("valores en conflicto");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plan GitHub agrega el commit y reglas SAG al prompt solo cuando se solicita", async () => {
  const directory = await config("bff");
  let received: OpenCodeRunOptions | null = null;
  let sourceCalls = 0;
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: "ses-plan-sag",
    part: { type: "text", text: "plan" },
  }));
  const sag = new SagNormsService({
    load: async (paths) => {
      sourceCalls += 1;
      expect(paths).toEqual([
        "/estandares/comunes.md",
        "/estandares/bff.md",
        "/estandares/bff-patrones.md",
        "/estandares/seguimiento.md",
        "/estandares/documentacion.md",
        "/estandares/integraciones.md",
        "/estandares/extraccion-documentos.md",
        "/estandares/sonarqube.md",
      ]);
      return {
        commit: "bff-commit",
        files: {
          "/estandares/comunes.md": "com-G1",
          "/estandares/bff.md": "bff-R1",
          "/estandares/bff-patrones.md": "bff-R9",
          "/estandares/seguimiento.md": "seg-R1",
          "/estandares/documentacion.md": "doc-R1",
          "/estandares/integraciones.md": "int-R1",
          "/estandares/extraccion-documentos.md": "ext-R1",
          "/estandares/sonarqube.md": "sonar-R1",
        },
      };
    },
  });
  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
      {
        run: async (options) => { received = options; return { result, azureLoginRequired: false }; },
        resume: async () => result,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      sag,
    ).run(["plan", "--normas-sag", "--working-directory", directory]);

    expect(code).toBe(0);
    expect(sourceCalls).toBe(1);
    expect(received).not.toBeNull();
    expect((received as unknown as OpenCodeRunOptions).prompt).toContain('"commit": "bff-commit"');
    expect((received as unknown as OpenCodeRunOptions).prompt).toContain('"ruleId": "bff-R1"');
    expect((received as unknown as OpenCodeRunOptions).prompt).toContain('"needsDecision"');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plan Azure agrega normas SAG despues de cargar la HU", async () => {
  const directory = await config();
  let received: OpenCodeRunOptions | null = null;
  // The planning run publishes what the session returns, so it must close its
  // contract; an empty plan is the valid "no delivery tickets needed" result.
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: "ses-plan-azure-sag",
    part: { type: "text", text: 'plan\nPLAN_READY\n{"tickets":[]}' },
  }));
  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => ({ id: 23438 }), waitForAccess: async () => undefined },
      {
        run: async (options) => { received = options; return { result, azureLoginRequired: false }; },
        resume: async () => result,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      new SagNormsService(source()),
    ).run(["plan", "--hu", "23438", "--normas-sag", "--working-directory", directory]);

    expect(code).toBe(0);
    expect(received).not.toBeNull();
    expect((received as unknown as OpenCodeRunOptions).prompt).toContain('"commit": "commit-master-123"');
    expect((received as unknown as OpenCodeRunOptions).prompt).toContain('"phase": "planning"');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("un contexto SAG inaccesible detiene plan antes de iniciar OpenCode", async () => {
  const directory = await config();
  let openCodeCalls = 0;
  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
      {
        run: async () => { openCodeCalls += 1; throw new Error("must not run"); },
        resume: async () => { openCodeCalls += 1; throw new Error("must not resume"); },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("source unavailable"); } },
    ).run(["plan", "--normas-sag", "--working-directory", directory]);

    expect(code).toBe(1);
    expect(openCodeCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("--normas-sag code se rechaza antes de servicios si falta el cargador coding", async () => {
  let calls = 0;
  const code = await new LazyWorkflowCli(
    { getHuInfo: async () => { calls += 1; throw new Error("must not call Azure"); }, waitForAccess: async () => undefined },
    { run: async () => { calls += 1; throw new Error("must not run"); }, resume: async () => { calls += 1; throw new Error("must not resume"); } },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    queueAdapter([{ kind: "empty" }]),
  ).run(["code", "--normas-sag"]);

  expect(code).toBe(1);
  expect(calls).toBe(0);
});

test("code GitHub agrega normas SAG al prompt solo cuando se solicita", async () => {
  const directory = await config();
  let received: OpenCodeRunOptions | null = null;
  let sourceCalls = 0;
  const results = ["IMPLEMENTATION_READY"].map((text, index) => OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: `ses-code-sag-${index}`,
    part: { type: "text", text },
  })));
  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
      {
        run: async (options) => { received = options; return { result: results.shift()!, azureLoginRequired: false }; },
        resume: async () => results[0]!,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      {
        loadPlanning: async () => { throw new Error("must not plan"); },
        loadCoding: async () => { sourceCalls += 1; return new SagNormsService(codingSource()).loadCoding(directory); },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      queueAdapter([fakeSelectedOutcome(201)]),
      ...fakeCoordinatedGitHubDeps(),
    ).run(["code", "--normas-sag", "--working-directory", directory]);

    expect(code).toBe(0);
    expect(received?.prompt).toContain('"phase": "coding"');
    expect(received?.prompt).toContain('"commit": "coding-commit"');
    expect(received?.prompt).toContain('"ruleId": "com-C1"');
    expect(sourceCalls).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("un contexto SAG de coding inaccesible detiene code antes de iniciar OpenCode", async () => {
  const directory = await config();
  let openCodeCalls = 0;
  try {
    const code = await new LazyWorkflowCli(
{ getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
      {
        run: async () => { openCodeCalls += 1; throw new Error("must not run"); },
        resume: async () => { openCodeCalls += 1; throw new Error("must not resume"); },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("must not plan"); }, loadCoding: async () => { throw new Error("source unavailable"); } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      queueAdapter([fakeSelectedOutcome(201)]),
    ).run(["code", "--normas-sag", "--working-directory", directory]);

    expect(code).toBe(1);
    expect(openCodeCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("code Azure agrega normas SAG al prompt despues de fijar el ticket", async () => {
  const directory = await config();
  let received: OpenCodeRunOptions | null = null;
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: "ses-code-azure-sag",
    part: { type: "text", text: "IMPLEMENTATION_READY" },
  }));
  try {
    const code = await new LazyWorkflowCli(
      {
        getHuInfo: async () => ({ id: 23438 }),
        waitForAccess: async () => undefined,
        ensureIntegrationBranch: async () => "refs/heads/hu/23438",
        getAutocodeState: async () => ({
          context: { hu: { id: 23438 }, ticket: { id: 51, type: "Task", state: "Active" }, integrationBranch: "refs/heads/hu/23438" },
          pending: true,
        }),
        getState: async () => ({ ticket: 51, state: "Active", revision: 1 }),
        getEffort: async () => ({ ticket: 51, effort: { real: 0, realHours: 0 } }),
        setState: async () => undefined,
        getBranch: async () => ({ hu: 23438, ticket: 51, branch: null, integrationBranch: "refs/heads/hu/23438" }),
        setTicketBranch: async () => ({ hu: 23438, ticket: 51, branch: "refs/heads/ticket/51" }),
      },
      {
        run: async (options) => { received = options; return { result, azureLoginRequired: false }; },
        resume: async () => result,
      },
      { read: async () => null, write: async () => undefined, clear: async () => undefined },
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("must not plan"); }, loadCoding: async () => new SagNormsService(codingSource()).loadCoding(directory) },
    ).run(["code", "--hu", "23438", "--normas-sag", "--working-directory", directory]);

    expect(code).toBe(1);
    expect(received?.prompt).toContain('"phase": "coding"');
    expect(received?.prompt).toContain('"commit": "coding-commit"');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("architecture-review selecciona normas y guidance con familias explicitas", async () => {
  const directory = await config("api", {
    cambio: "contract-change",
    artefactos: ["source", "consul", "openshift"],
    capacidades: ["server-auth", "user-session", "cache", "observability"],
    entorno: "dev",
  });
  try {
    const context = await new SagNormsService({
      load: async (paths) => {
        expect(paths).toEqual([
          "/estandares/comunes.md",
          "/estandares/api.md",
          "/estandares/api-adonis-patrones.md",
          "/estandares/integraciones.md",
          "/estandares/pull-requests.md",
          "/estandares/revision.md",
          "/core/agents/arquitecto-sag.md",
        ]);
        return {
          commit: "review-commit",
          files: {
            "/estandares/comunes.md": "com-C1",
            "/estandares/api.md": "api-R1",
            "/estandares/api-adonis-patrones.md": "api-R9",
            "/estandares/integraciones.md": "int-R1",
            "/estandares/pull-requests.md": "pr-R1",
            "/estandares/revision.md": "review guidance",
            "/core/agents/arquitecto-sag.md": "architect guidance",
          },
        };
      },
    }).loadArchitectureReview(directory);

    expect(context.phase).toBe("architecture-review");
    expect(context.commit).toBe("review-commit");
    expect(context.selectedRules.every(({ classification }) => classification === "N")).toBeTrue();
    expect(context.selectedRules.map(({ ruleId }) => ruleId)).toEqual([
      "com-C1", "api-R1", "api-R9", "int-R1", "pr-R1",
    ]);
    expect(context.guidance.every(({ classification }) => classification === "W")).toBeTrue();
    expect(context.reviewFamilies.filter(({ applicability }) => applicability === "applicable").map(({ family }) => family)).toEqual([
      "boundaries", "contracts", "auth", "session", "cache", "consul", "observability", "deployment-topology",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GitHub architecture-review publica y verifica specification y tickets", async () => {
  const commands: string[][] = [];
  let created = 200;
  const service = new GitHubArchitectureReviewService(async (args) => {
    commands.push(args);
    if (args[1] === "create") return `https://github.com/example/repo/issues/${created++}`;
    const issue = Number(args[2]);
    return JSON.stringify({ number: issue, title: "published", body: issue === 200 ? "Source Issue: #154" : "Specification: #200", state: "OPEN", labels: [], comments: [] });
  });

  await expect(service.publishFindings(
    154,
    { title: "Architecture correction", body: "spec body" },
    [{ title: "Correct boundary", body: "ticket body" }],
    "/repo",
  )).resolves.toEqual({ specification: 200, tickets: [201] });
  expect(commands.filter(([resource, action]) => resource === "issue" && action === "create")).toHaveLength(2);
  expect(commands.some((args) => args.some((arg) => arg.includes("Source Issue: #154")))).toBeTrue();
  expect(commands.filter(([resource, action]) => resource === "issue" && action === "view")).toHaveLength(2);
});

test("GitHub architecture-review redacts secretos del alcance", async () => {
  const service = new GitHubArchitectureReviewService(async () => JSON.stringify({
    number: 154,
    title: "scope",
    body: "token: ghp_fixture password=hidden",
    state: "OPEN",
    labels: [],
    comments: [{ body: "Authorization: Bearer abc123" }],
  }));

  const scope = await service.readIssue(154, "/repo");
  expect(scope.body).toBe("token: [REDACTED] password=[REDACTED]");
  expect(scope.comments[0]).toBe("Authorization: Bearer [REDACTED]");
});

test("architecture-review rechaza source SAG inaccesible antes de OpenCode", async () => {
  const directory = await config();
  let openCodeCalls = 0;
  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
      {
        run: async () => { openCodeCalls += 1; throw new Error("must not run"); },
        resume: async () => { openCodeCalls += 1; throw new Error("must not resume"); },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("must not use planning"); }, loadArchitectureReview: async () => { throw new Error("source unavailable"); } },
      async () => "",
      reviewTracker,
    ).run(["architecture-review-sag", "--issue", "154", "--working-directory", directory]);

    expect(code).toBe(1);
    expect(openCodeCalls).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("architecture-review GitHub usa un Issue explicito y no toca Azure", async () => {
  const directory = await config();
  let azureCalls = 0;
  let received: OpenCodeRunOptions | null = null;
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: "ses-architecture-review",
    part: { type: "text", text: 'ARCHITECTURE_REVIEW_RESULT\n{"status":"clean","summary":"clean"}' },
  }));
  const context: SagArchitectureReviewContext = {
    phase: "architecture-review",
    sourceRepository: "https://example.test/sag",
    branch: "master",
    commit: "review-commit",
    component: "api",
    explicitFacts: { changeKind: "feature", artifacts: ["source"], capabilities: null, significantChange: null, environment: null },
    reviewFamilies: [{ family: "boundaries", applicability: "needs-decision", selectedBecause: "scope" }],
    selectedRules: [{ classification: "N", applicability: "applicable", ruleId: "com-C1", source: "https://example.test/com-C1", commit: "review-commit", selectedBecause: "scope" }],
    guidance: [{ classification: "W", path: "/core/agents/arquitecto-sag.md", source: "https://example.test/architect", commit: "review-commit", selectedBecause: "guidance" }],
    needsDecision: ["boundaries: requiere decidir aplicabilidad por hechos de alcance"],
  };
  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { azureCalls += 1; throw new Error("must not use Azure"); }, waitForAccess: async () => { azureCalls += 1; } },
      {
        run: async (options) => { received = options; return { result, azureLoginRequired: false }; },
        resume: async () => { throw new Error("must not resume"); },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("must not plan"); }, loadArchitectureReview: async () => context },
      async () => "",
      reviewTracker,
    ).run(["architecture-review-sag", "--issue", "154", "--working-directory", directory, "--prompt", "review this Issue"]);

    expect(code).toBe(0);
    expect(azureCalls).toBe(0);
    expect(received?.prompt).toContain('"number":154');
    expect(received?.prompt).toContain("/to-spec");
    expect(received?.prompt).toContain("/to-tickets");
    expect(received?.prompt).toContain("coordinator can publish");
    expect(received?.prompt).toContain("do not modify source code");
    expect(received?.prompt).toContain('"commit": "review-commit"');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("architecture-review Azure usa la HU completa y conserva la ruta del tracker", async () => {
  const directory = await config();
  let received: OpenCodeRunOptions | null = null;
  let detectsAzure = false;
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: "ses-architecture-azure",
    part: { type: "text", text: 'ARCHITECTURE_REVIEW_RESULT\n{"status":"clean","summary":"clean"}' },
  }));
  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => ({ id: 23438, title: "HU architecture" }), waitForAccess: async () => undefined },
      {
        run: async (options, azure) => { received = options; detectsAzure = azure; return { result, azureLoginRequired: false }; },
        resume: async () => result,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("must not plan"); }, loadArchitectureReview: async () => ({
        phase: "architecture-review",
        sourceRepository: "https://example.test/sag",
        branch: "master",
        commit: "review-commit",
        component: "api",
        explicitFacts: { changeKind: null, artifacts: null, capabilities: null, significantChange: null, environment: null },
        reviewFamilies: [],
        selectedRules: [],
        guidance: [],
        needsDecision: [],
      }) },
      async () => "",
      reviewTracker,
    ).run(["architecture-review-sag", "--hu", "23438", "--working-directory", directory]);

    expect(code).toBe(0);
    expect(detectsAzure).toBeTrue();
    expect(received?.prompt).toContain('"tracker":"azure"');
    expect(received?.prompt).toContain('"id":23438');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("architecture-review Azure rechaza findings sin publication verificable", async () => {
  const directory = await config();
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: "ses-architecture-azure-findings",
    part: { type: "text", text: 'ARCHITECTURE_REVIEW_RESULT\n{"status":"findings","summary":"finding","specification":{"title":"Fix","body":"body"},"tickets":[]}' },
  }));
  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => ({ id: 23438 }), waitForAccess: async () => undefined },
      { run: async () => ({ result, azureLoginRequired: false }), resume: async () => result },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("must not plan"); }, loadArchitectureReview: async () => ({
        phase: "architecture-review",
        sourceRepository: "https://example.test/sag",
        branch: "master",
        commit: "review-commit",
        component: "api",
        explicitFacts: { changeKind: null, artifacts: null, capabilities: null, significantChange: null, environment: null },
        reviewFamilies: [],
        selectedRules: [],
        guidance: [],
        needsDecision: [],
      }) },
      async () => "",
      reviewTracker,
    ).run(["architecture-review-sag", "--hu", "23438", "--working-directory", directory]);

    expect(code).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("architecture-review GitHub publica findings through the tracker boundary", async () => {
  const directory = await config();
  let published = false;
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: "ses-architecture-findings",
    part: { type: "text", text: 'ARCHITECTURE_REVIEW_RESULT\n{"status":"findings","summary":"boundary issue","specification":{"title":"Boundary fix","body":"spec"},"tickets":[{"title":"Fix boundary","body":"ticket"}]}' },
  }));
  try {
    const tracker = {
      readIssue: async (issue: number) => ({ number: issue, title: "Issue scope", body: "scope", comments: [], state: "OPEN", labels: [] }),
      publishFindings: async (issue: number, specification: { title: string; body: string }, tickets: Array<{ title: string; body: string }>) => {
        published = issue === 154 && specification.title === "Boundary fix" && tickets.length === 1;
        return { specification: 202, tickets: [203] };
      },
    };
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
      { run: async () => ({ result, azureLoginRequired: false }), resume: async () => result },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("must not plan"); }, loadArchitectureReview: async () => ({
        phase: "architecture-review",
        sourceRepository: "https://example.test/sag",
        branch: "master",
        commit: "review-commit",
        component: "api",
        explicitFacts: { changeKind: null, artifacts: null, capabilities: null, significantChange: null, environment: null },
        reviewFamilies: [],
        selectedRules: [],
        guidance: [],
        needsDecision: [],
      }) },
      async () => "",
      tracker,
    ).run(["architecture-review-sag", "--issue", "154", "--working-directory", directory]);

    expect(code).toBe(0);
    expect(published).toBeTrue();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("architecture-review rechaza una ejecucion OpenCode fallida", async () => {
  const directory = await config();
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: "ses-architecture-failed",
    part: { type: "text", text: 'ARCHITECTURE_REVIEW_RESULT\n{"status":"clean","summary":"failed"}' },
  }));
  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
      { run: async () => ({ result, azureLoginRequired: false, failed: true }), resume: async () => result },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("must not plan"); }, loadArchitectureReview: async () => ({
        phase: "architecture-review",
        sourceRepository: "https://example.test/sag",
        branch: "master",
        commit: "review-commit",
        component: "api",
        explicitFacts: { changeKind: null, artifacts: null, capabilities: null, significantChange: null, environment: null },
        reviewFamilies: [],
        selectedRules: [],
        guidance: [],
        needsDecision: [],
      }) },
      async () => "",
      reviewTracker,
    ).run(["architecture-review-sag", "--issue", "154", "--working-directory", directory]);

    expect(code).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("architecture-review detiene la revision si OpenCode modifica el arbol", async () => {
  const directory = await config();
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: "ses-architecture-mutated",
    part: { type: "text", text: "review" },
  }));
  let statusCalls = 0;
  try {
    const code = await new LazyWorkflowCli(
      { getHuInfo: async () => { throw new Error("must not use Azure"); }, waitForAccess: async () => undefined },
      { run: async () => ({ result, azureLoginRequired: false }), resume: async () => result },
      undefined,
      undefined,
      undefined,
      undefined,
      { loadPlanning: async () => { throw new Error("must not plan"); }, loadArchitectureReview: async () => ({
        phase: "architecture-review",
        sourceRepository: "https://example.test/sag",
        branch: "master",
        commit: "review-commit",
        component: "api",
        explicitFacts: { changeKind: null, artifacts: null, capabilities: null, significantChange: null, environment: null },
        reviewFamilies: [],
        selectedRules: [],
        guidance: [],
        needsDecision: [],
      }) },
      async () => statusCalls++ === 0 ? "" : " M reviewed.ts\n",
      reviewTracker,
    ).run(["architecture-review-sag", "--issue", "154", "--working-directory", directory]);

    expect(code).toBe(1);
    expect(statusCalls).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  ["missing scope", ["architecture-review-sag"]],
  ["conflicting scope", ["architecture-review-sag", "--hu", "23438", "--issue", "154"]],
  ["invalid Issue", ["architecture-review-sag", "--issue", "abc"]],
] as const)("architecture-review rejects %s before services", async (_name, args) => {
  let calls = 0;
  const code = await new LazyWorkflowCli(
    { getHuInfo: async () => { calls += 1; throw new Error("must not call Azure"); }, waitForAccess: async () => { calls += 1; } },
    { run: async () => { calls += 1; throw new Error("must not run"); }, resume: async () => { calls += 1; throw new Error("must not resume"); } },
    undefined,
    undefined,
    undefined,
    undefined,
    { loadPlanning: async () => { calls += 1; throw new Error("must not load"); }, loadArchitectureReview: async () => { calls += 1; throw new Error("must not load"); } },
  ).run([...args, "--working-directory", root]);

  expect(code).toBe(1);
  expect(calls).toBe(0);
});
