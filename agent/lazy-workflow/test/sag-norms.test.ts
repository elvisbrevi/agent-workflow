import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { RemoteSagNormSource, SagNormsService, type SagNormSource } from "../src/sag/sag-norms-service.ts";
import { OpenCodeResult } from "../src/opencode/open-code-result.ts";
import type { OpenCodeRunOptions } from "../src/opencode/open-code-service.ts";

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
        "/estandares/api-patrones.md",
        "/estandares/seguimiento.md",
      ]);
      return {
        commit: "commit-master-123",
        files: {
          "/estandares/comunes.md": "# com-G1\n",
          "/estandares/api.md": "# api-R1\n# api-R9\n",
          "/estandares/api-patrones.md": "# api-R10\n",
          "/estandares/seguimiento.md": "# seg-R1\n",
        },
      };
    },
  };
}

test("plan selecciona normas por fase y componente y conserva decisiones desconocidas", async () => {
  const directory = await config();
  try {
    const context = await new SagNormsService(source()).loadPlanning(directory);

    expect(context.commit).toBe("commit-master-123");
    expect(context.branch).toBe("master");
    expect(context.component).toBe("api");
    expect(context.selectedRules.map(({ ruleId }) => ruleId)).toEqual(["com-G1", "api-R1", "api-R9", "api-R10", "seg-R1"]);
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
      "api-R10: requiere decidir aplicabilidad por artefacto o capacidad",
      "seg-R1: requiere decidir aplicabilidad por change-kind",
    ]);
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
    artefactos: ["source"],
    capacidades: [],
    cambioSignificativo: true,
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
      ]);
      return {
        commit: "bff-commit",
        files: {
          "/estandares/comunes.md": "com-G1",
          "/estandares/bff.md": "bff-R1",
          "/estandares/bff-patrones.md": "bff-R9",
          "/estandares/seguimiento.md": "seg-R1",
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
  const result = OpenCodeResult.fromJsonLines(JSON.stringify({
    type: "text",
    sessionID: "ses-plan-azure-sag",
    part: { type: "text", text: "plan" },
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

test("--normas-sag no cambia el flujo code y se rechaza antes de servicios", async () => {
  let calls = 0;
  const code = await new LazyWorkflowCli(
    { getHuInfo: async () => { calls += 1; throw new Error("must not call Azure"); }, waitForAccess: async () => undefined },
    { run: async () => { calls += 1; throw new Error("must not run"); }, resume: async () => { calls += 1; throw new Error("must not resume"); } },
  ).run(["code", "--normas-sag"]);

  expect(code).toBe(1);
  expect(calls).toBe(0);
});
