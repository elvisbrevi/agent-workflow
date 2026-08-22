import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEXT_EVIDENCE_REQUIRED } from "../src/azure/completion-manifest.ts";
import { HTTP_CAPTURE_BODY, SCREENSHOT_BYTES, SCREENSHOT_NAME } from "./_helpers/evidence-fixtures.ts";
import { AzureTicketInfoService } from "../src/azure/ticket-info-service.ts";
import { GitHubDeliveryService } from "../src/github/github-delivery-service.ts";
import { runDeterministicTool, type DeterministicToolServices } from "../src/cli/deterministic-tools.ts";
import { buildCli } from "../src/cli/parse-cli-options.ts";
import { createReporter } from "../src/output/reporter.ts";
import { setDefaultReporter } from "../src/output/operator-output.ts";

/**
 * The manifest a delivery session leaves behind, written by the tool that owns
 * its shape. The session used to hand-write this JSON from prose and got the
 * ticket type, the commit key and the evidence kinds wrong — so what these tests
 * pin is that the file the tool produces is the file the coordinator's own
 * validator accepts, and that a manifest it would reject never reaches disk.
 */

const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const EVIDENCE_BODY = HTTP_CAPTURE_BODY;

/** The digest the tool must arrive at, computed here from the bytes rather than copied. */
const EVIDENCE_DIGEST = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(EVIDENCE_BODY)))]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

let root: string;
let messages: string[];

/** A worktree with a Git directory, but no `git`: every command a tool runs is answered here. */
function gitRunner(overrides: { head?: string; status?: string; branch?: string } = {}) {
  return async (args: string[]): Promise<string> => {
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ".git\n";
    if (args[0] === "rev-parse") return `${overrides.head ?? COMMIT}\n`;
    if (args[0] === "status") return overrides.status ?? "";
    if (args[0] === "symbolic-ref") return `${overrides.branch ?? "ticket/23575"}\n`;
    if (args[0] === "merge-base") return "";
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };
}

function services(git = gitRunner()): DeterministicToolServices {
  const az = async (): Promise<string> => { throw new Error("un manifest no consulta Azure"); };
  const gh = async (): Promise<string> => { throw new Error("un manifest no consulta GitHub"); };
  return {
    azure: new AzureTicketInfoService(az, git),
    queue: {} as never,
    delivery: new GitHubDeliveryService(gh, git),
    branches: {} as never,
  };
}

async function runTool(args: string[], git = gitRunner()): Promise<{ code: number; printed: string[] }> {
  const parsed = buildCli(() => true)(args, { onHelp: () => 0, onError: () => 1 });
  if (parsed.kind !== "options") throw new Error(`no parseo: ${JSON.stringify(parsed)}`);
  const printed: string[] = [];
  const code = await runDeterministicTool(
    parsed.options.command as never,
    parsed.options,
    services(git),
    (line) => printed.push(line),
  );
  return { code, printed };
}

const written = async (path: string): Promise<unknown> => JSON.parse(await Bun.file(path).text());

const manifestPath = (): string => join(root, ".git/lazy-workflow/completion-manifest.json");

async function evidenceFile(name: string, content = EVIDENCE_BODY): Promise<string> {
  const path = join(root, ".git/lazy-workflow", name);
  await Bun.write(path, content);
  return path;
}

async function screenFile(name: string): Promise<string> {
  const path = join(root, ".git/lazy-workflow", name);
  await Bun.write(path, SCREENSHOT_BYTES);
  return path;
}

/**
 * The pair a backend delivery leaves behind: the capture and the browser screenshot it names.
 * They travel together because a capture that names a screenshot nobody declared is refused.
 */
async function capturePair(): Promise<string[]> {
  const capture = await evidenceFile("pago-endpoint.json");
  const screenshot = await screenFile(SCREENSHOT_NAME);
  return ["--evidence", `http-json:${capture}`, "--evidence", `screen:${screenshot}`];
}

const azureArgs = (extra: string[]): string[] => [
  "ticket-manifest-set",
  "--ticket", "23575",
  "--branch", "ticket/23575",
  "--manifest", manifestPath(),
  "--working-directory", root,
  ...extra,
];

const githubArgs = (extra: string[]): string[] => [
  "github-manifest-set",
  "--issue", "201",
  "--branch", "ticket/23575",
  "--manifest", join(root, ".git/manifest.json"),
  "--working-directory", root,
  "--summary", "Integra el pago SDUI",
  ...extra,
];

const VALIDATION = ["--validation", "bun test", "--validation-result", "198 pass, 0 fail"];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lazy-workflow-manifest-"));
  mkdirSync(join(root, ".git/lazy-workflow"), { recursive: true });
  messages = [];
  setDefaultReporter({
    tracing: false,
    info: (message: string) => { messages.push(message); },
    warn: () => undefined,
    error: (message: string) => { messages.push(message); },
    debug: () => undefined,
    trace: () => undefined,
    heading: () => undefined,
    start: () => ({ stop: () => undefined }) as never,
    stop: () => undefined,
    session: () => undefined,
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  setDefaultReporter(createReporter({ verbose: false, noColor: true }));
});

describe("ticket-manifest-set", () => {
  test("escribe el manifest exacto que el validador del coordinador acepta", async () => {
    const evidence = join(root, ".git/lazy-workflow", "pago-endpoint.json");

    const { code, printed } = await runTool(azureArgs([...VALIDATION, ...await capturePair()]));

    expect({ code, messages }).toEqual({ code: 0, messages: [] });
    const manifest = await written(manifestPath()) as Record<string, unknown>;
    // La regresión de 23575: el ticket como número, la clave `commit` — no
    // `currentCommit` — y un kind del enum real, nunca uno inventado.
    expect(manifest.ticket).toBe(23575);
    expect(Object.keys(manifest)).toEqual(["ticket", "ticketBranch", "commit", "validation", "evidence"]);
    expect(manifest.ticketBranch).toBe("refs/heads/ticket/23575");
    expect(manifest.commit).toBe(COMMIT);
    expect(manifest.validation).toEqual([{ command: "bun test", result: "198 pass, 0 fail" }]);
    expect((manifest.evidence as unknown[])[0]).toEqual({
      path: evidence,
      kind: "http-json",
      // El digest lo calcula la herramienta leyendo el archivo, no la sesión.
      sha256: EVIDENCE_DIGEST,
    });
    expect(JSON.parse(printed[0] ?? "null")).toEqual(manifest);
  });

  test("una evidencia http-json que no es una captura del navegador no entra al manifest", async () => {
    // El campo del ticket muestra endpoint, cabeceras, cuerpo y respuesta en tablas propias, y solo
    // puede hacerlo si el archivo dice cuál es cuál. Un JSON libre no tiene nada que maquetar, así
    // que el ticket volvía al muro de monoespaciado que esta forma existe para evitar.
    const evidence = await evidenceFile("pago-endpoint.json", '{\n  "ok": true\n}\n');

    const { code } = await runTool(azureArgs([...VALIDATION, "--evidence", `http-json:${evidence}`]));

    expect(code).toBe(1);
    expect(messages[0]).toContain("captura del navegador");
    expect(await Bun.file(manifestPath()).exists()).toBeFalse();
  });

  test("una captura que nombra una pantalla no declarada no entra al manifest", async () => {
    // La captura publicada muestra la imagen del navegador que hizo la petición: si esa imagen no
    // viaja como evidencia del mismo manifest, el ticket publica un intercambio sin su prueba.
    const evidence = await evidenceFile("pago-endpoint.json");

    const { code } = await runTool(azureArgs([...VALIDATION, "--evidence", `http-json:${evidence}`]));

    expect(code).toBe(1);
    expect(messages[0]).toContain(`La captura ${SCREENSHOT_NAME} que nombra pago-endpoint.json no está declarada`);
    expect(await Bun.file(manifestPath()).exists()).toBeFalse();
  });

  test("el manifest escrito vuelve a leerse por la misma puerta que usa la entrega", async () => {
    await runTool(azureArgs([...VALIDATION, ...await capturePair()]));

    // Sin stubs: el servicio real relee el archivo real. Si la herramienta y el
    // validador se separaran alguna vez, esto es lo que falla primero.
    const service = new AzureTicketInfoService(async () => "", gitRunner());
    await expect(service.readCompletionManifest(manifestPath(), root)).resolves.toMatchObject({ ticket: 23575 });
  });

  test("acepta evidencia en el directorio de evidencia que el coordinador mismo indica", async () => {
    // `evidenceDirectory` es el directorio del manifest, dentro del directorio
    // Git común: exigir que la evidencia estuviera fuera del repositorio volvía
    // inverificable todo manifest que siguiera la instrucción del coordinador.
    const { code } = await runTool(azureArgs([...VALIDATION, ...await capturePair()]));

    expect(code).toBe(0);
  });

  test("no escribe un manifest que solo trae capturas", async () => {
    // Solo un archivo de texto puede poblar completion-evidence, así que un manifest de puras
    // capturas nunca cierra la entrega. Antes eso se descubría en la última compuerta, con los PR
    // ya mergeados y la sesión cerrada: la corrida quedaba trabada sin nadie que pudiera arreglarla.
    const captura = await screenFile("pantalla.png");

    const { code } = await runTool(azureArgs([...VALIDATION, "--evidence", `screen:${captura}`]));

    expect(code).toBe(1);
    expect(messages).toEqual([`lazy-workflow: no se pudo ejecutar ticket-manifest-set (${TEXT_EVIDENCE_REQUIRED})`]);
    expect(await Bun.file(manifestPath()).exists()).toBeFalse();
  });

  test("no escribe un manifest que nombre evidencia que la entrega va a rechazar", async () => {
    // El manifest solo comprobaba ruta y digest, así que una evidencia inválida entraba y recién
    // se rechazaba en la última compuerta, con los PR ya mergeados y nada barato por hacer.
    const evidence = await evidenceFile("pago-endpoint.json", '{ "headers": { "authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.abc.def" } }');

    const { code } = await runTool(azureArgs([...VALIDATION, "--evidence", `http-json:${evidence}`]));

    expect(code).toBe(1);
    expect(messages).toEqual([
      "lazy-workflow: no se pudo ejecutar ticket-manifest-set (La evidencia contiene credenciales o secretos)",
    ]);
    expect(await Bun.file(manifestPath()).exists()).toBeFalse();
  });

  test("rechaza evidencia dentro del árbol de trabajo, que un commit sí podría llevarse", async () => {
    const evidence = join(root, "docs/pago.json");
    await Bun.write(evidence, "{}");

    const { code } = await runTool(azureArgs([...VALIDATION, "--evidence", `http-json:${evidence}`]));

    expect(code).toBe(1);
    expect(messages).toEqual([
      "lazy-workflow: no se pudo ejecutar ticket-manifest-set (La evidencia del manifest debe estar fuera del repositorio fuente)",
    ]);
    expect(await Bun.file(manifestPath()).exists()).toBeFalse();
  });

  test("un kind inventado se rechaza nombrando el enum real, sin escribir nada", async () => {
    const evidence = await evidenceFile("pago-endpoint.json");

    const { code } = await runTool(azureArgs([...VALIDATION, "--evidence", `validation-review:${evidence}`]));

    expect(code).toBe(1);
    expect(messages).toEqual([
      `--evidence validation-review:${evidence} nombra un tipo desconocido: validation-review (usa http-json|screen|command-output)`,
    ]);
    expect(await Bun.file(manifestPath()).exists()).toBeFalse();
  });

  test("una validación sin su resultado se rechaza nombrando ambos flags", async () => {
    const evidence = await evidenceFile("pago-endpoint.json");

    const { code } = await runTool(azureArgs([
      "--validation", "bun test", "--validation", "dotnet build",
      "--validation-result", "198 pass",
      "--evidence", `http-json:${evidence}`,
    ]));

    expect(code).toBe(1);
    expect(messages[0]).toContain("recibió 2 --validation y 1 --validation-result");
    expect(await Bun.file(manifestPath()).exists()).toBeFalse();
  });

  test("sin validaciones y sin evidencia se rechaza antes de tocar el disco", async () => {
    const evidence = await evidenceFile("pago-endpoint.json");

    const sinValidacion = await runTool(azureArgs(["--evidence", `http-json:${evidence}`]));
    const sinEvidencia = await runTool(azureArgs(VALIDATION));

    expect([sinValidacion.code, sinEvidencia.code]).toEqual([1, 1]);
    expect(messages[0]).toContain("requiere al menos un par --validation");
    expect(messages[1]).toContain("requiere al menos un --evidence");
    expect(await Bun.file(manifestPath()).exists()).toBeFalse();
  });

  test("un archivo de evidencia que no existe se nombra tal como se declaró", async () => {
    const { code } = await runTool(azureArgs([...VALIDATION, "--evidence", `http-json:${join(root, ".git/lazy-workflow/nada.json")}`]));

    expect(code).toBe(1);
    expect(messages[0]).toContain(`El archivo de evidencia no existe: ${join(root, ".git/lazy-workflow/nada.json")}`);
  });

  test("un manifest fuera del directorio Git común se rechaza", async () => {
    const evidence = await evidenceFile("pago-endpoint.json");

    const { code } = await runTool([
      "ticket-manifest-set", "--ticket", "23575", "--branch", "ticket/23575",
      "--manifest", join(root, "completion-manifest.json"),
      "--working-directory", root,
      ...VALIDATION, "--evidence", `http-json:${evidence}`,
    ]);

    expect(code).toBe(1);
    expect(messages[0]).toContain("El manifest de completion debe estar bajo el directorio Git común");
    expect(await Bun.file(join(root, "completion-manifest.json")).exists()).toBeFalse();
  });

  test("el commit es HEAD salvo que se fije uno explícito", async () => {
    const pair = await capturePair();

    await runTool(azureArgs([...VALIDATION, ...pair]));
    const porDefecto = await written(manifestPath()) as { commit: string };
    await runTool(azureArgs([...VALIDATION, "--commit", OTHER_COMMIT, ...pair]));
    const fijado = await written(manifestPath()) as { commit: string };

    expect([porDefecto.commit, fijado.commit]).toEqual([COMMIT, OTHER_COMMIT]);
  });

  test("un intento fallido deja intacto el manifest que ya estaba escrito", async () => {
    await runTool(azureArgs([...VALIDATION, ...await capturePair()]));
    const original = await Bun.file(manifestPath()).text();

    const { code } = await runTool(azureArgs([...VALIDATION, "--evidence", `http-json:${join(root, "docs/nope.json")}`]));

    expect(code).toBe(1);
    expect(await Bun.file(manifestPath()).text()).toBe(original);
  });
});

describe("github-manifest-set", () => {
  test("escribe exactamente las claves que el validador GitHub permite", async () => {
    const evidence = join(root, "docs/evidence/run.json");
    await Bun.write(evidence, EVIDENCE_BODY);

    const { code, printed } = await runTool(githubArgs([...VALIDATION, "--evidence", evidence]));

    expect({ code, messages }).toEqual({ code: 0, messages: [] });
    const manifest = await written(join(root, ".git/manifest.json")) as Record<string, unknown>;
    expect(Object.keys(manifest)).toEqual(["issue", "branch", "commit", "validation", "clean", "summary", "evidence"]);
    expect(manifest.issue).toBe(201);
    expect(manifest.branch).toBe("refs/heads/ticket/23575");
    expect(manifest.commit).toBe(COMMIT);
    expect(manifest.clean).toBeTrue();
    expect(manifest.summary).toBe("Integra el pago SDUI");
    // La evidencia GitHub vive dentro del repositorio y se guarda relativa a él.
    expect(manifest.evidence).toEqual([{
      path: "docs/evidence/run.json",
      sha256: EVIDENCE_DIGEST,
    }]);
    expect(JSON.parse(printed[0] ?? "null")).toEqual(manifest);
  });

  test("una entrega sin evidencia omite la clave en vez de escribirla vacía", async () => {
    const { code } = await runTool(githubArgs(VALIDATION));

    expect(code).toBe(0);
    expect(Object.keys(await written(join(root, ".git/manifest.json")) as object))
      .toEqual(["issue", "branch", "commit", "validation", "clean", "summary"]);
  });

  test("un worktree sucio no se declara limpio: se rechaza", async () => {
    const { code } = await runTool(githubArgs(VALIDATION), gitRunner({ status: " M src/app.ts\n" }));

    expect(code).toBe(1);
    expect(messages[0]).toContain("El worktree no está limpio para publicar el manifest");
    expect(await Bun.file(join(root, ".git/manifest.json")).exists()).toBeFalse();
  });

  test("un commit que no es HEAD se rechaza en vez de escribirse", async () => {
    const { code } = await runTool(githubArgs([...VALIDATION, "--commit", OTHER_COMMIT]));

    expect(code).toBe(1);
    expect(messages[0]).toContain("El commit del manifest no coincide con HEAD");
  });

  test("sin --summary no se escribe manifest", async () => {
    const { code } = await runTool([
      "github-manifest-set", "--issue", "201", "--branch", "ticket/23575",
      "--manifest", join(root, ".git/manifest.json"), "--working-directory", root, ...VALIDATION,
    ]);

    expect(code).toBe(1);
    expect(messages).toEqual(["github-manifest-set requiere --summary <text>"]);
  });
});
