import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { SagNormsService } from "../src/sag/sag-norms-service.ts";

process.env["LAZY_WORKFLOW_SAG_NORMS_REPOSITORY"] ??= "https://dev.azure.com/org/Team/_git/norms";

const root = `${process.env.TMPDIR ?? "/tmp"}/lazy-workflow-sag-${crypto.randomUUID()}`;

async function config(component = "api", facts: Record<string, unknown> = {}): Promise<string> {
  const directory = `${root}-${crypto.randomUUID()}`;
  await mkdir(`${directory}/.sag`, { recursive: true });
  await Bun.write(`${directory}/.sag/config.json`, JSON.stringify({ tipo: component, ...facts }));
  return directory;
}

test("plan returns normative file paths for the component tipo", async () => {
  const directory = await config();
  try {
    const context = await new SagNormsService().loadPlanning(directory);

    expect(context.phase).toBe("planning");
    expect(context.component).toBe("api");
    expect(context.sourceRepository).toBe("https://dev.azure.com/org/Team/_git/norms");
    expect(context.paths).toEqual([
      "/estandares/comunes.md",
      "/estandares/api.md",
      "/estandares/api-adonis-patrones.md",
      "/estandares/seguimiento.md",
      "/estandares/documentacion.md",
      "/estandares/integraciones.md",
      "/estandares/extraccion-documentos.md",
      "/estandares/sonarqube.md",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("coding returns normative file paths including pull-requests", async () => {
  const directory = await config("bff");
  try {
    const context = await new SagNormsService().loadCoding(directory);

    expect(context.phase).toBe("coding");
    expect(context.component).toBe("bff");
    expect(context.paths).toEqual([
      "/estandares/comunes.md",
      "/estandares/bff.md",
      "/estandares/bff-patrones.md",
      "/estandares/seguimiento.md",
      "/estandares/documentacion.md",
      "/estandares/integraciones.md",
      "/estandares/extraccion-documentos.md",
      "/estandares/pull-requests.md",
      "/estandares/sonarqube.md",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects missing .sag/config.json", async () => {
  const service = new SagNormsService();
  await expect(service.loadPlanning(root)).rejects.toThrow(".sag/config.json");
});

test("rejects invalid component type", async () => {
  const directory = await config("invalid");
  try {
    await expect(new SagNormsService().loadPlanning(directory)).rejects.toThrow("tipo explicito");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
