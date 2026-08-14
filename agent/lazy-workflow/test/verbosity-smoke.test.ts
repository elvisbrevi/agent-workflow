import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import chalk from "chalk";
import { Writable } from "node:stream";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { OpenCodeService } from "../src/opencode/open-code-service.ts";
import { OpenCodeResult } from "../src/opencode/open-code-result.ts";
import { createReporter, type Reporter, type ReporterStream } from "../src/output/reporter.ts";
import { setDefaultReporter } from "../src/output/operator-output.ts";

beforeAll(() => {
  chalk.level = 1;
});

type Captured = {
  info: string[];
  warn: string[];
  error: string[];
  debug: string[];
};

const captureStream = (): { stream: ReporterStream; captured: Captured } => {
  const captured: Captured = { info: [], warn: [], error: [], debug: [] };
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      const stripped = text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\n$/, "");
      const match = stripped.match(/^[^\s]+(\s|$)/);
      const icon = match ? match[0].trimEnd() : "";
      const rest = stripped.replace(/^[^\s]+\s?/, "");
      if (icon === "ℹ") captured.info.push(rest);
      else if (icon === "⚠") captured.warn.push(rest);
      else if (icon === "✗") captured.error.push(rest);
      else if (icon === "·") captured.debug.push(rest);
      callback();
    },
  }) as unknown as ReporterStream;
  return { stream, captured };
};

const buildReporter = (verbose: boolean, quiet = false, noColor = true): { reporter: Reporter; captured: Captured } => {
  const { stream, captured } = captureStream();
  const reporter = createReporter({ verbose, quiet, noColor, stream });
  return { reporter, captured };
};

const installReporter = (reporter: Reporter): void => {
  setDefaultReporter(reporter);
};

const restoreReporter = (): void => {
  setDefaultReporter(createReporter({ verbose: false, noColor: true }));
};

const jsonEvent = (event: Record<string, unknown>): string => JSON.stringify(event);

const buildDeliveryEvents = (sessionId: string): string[] => [
  jsonEvent({ type: "session", sessionID: sessionId }),
  jsonEvent({ type: "reasoning", sessionID: sessionId, part: { type: "reasoning", text: "Analizando cambios pendientes" } }),
  jsonEvent({
    type: "tool_use",
    sessionID: sessionId,
    part: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "git status --short" } } },
  }),
  jsonEvent({
    type: "tool_use",
    sessionID: sessionId,
    part: { type: "tool", tool: "read", state: { status: "completed", input: { description: "AGENTS.md" } } },
  }),
  jsonEvent({
    type: "tool_use",
    sessionID: sessionId,
    part: { type: "tool", tool: "edit", state: { status: "completed", input: { description: "README.md" } } },
  }),
  jsonEvent({ type: "step_start", sessionID: sessionId, part: { type: "step", reason: "agent" } }),
  jsonEvent({ type: "step_finish", sessionID: sessionId, part: { type: "step", reason: "stop" } }),
  jsonEvent({ type: "text", sessionID: sessionId, part: { type: "text", text: "TICKET_COMPLETED\nWORKFLOW_STEP_FINISHED" } }),
];

const countOperatorLines = (captured: Captured): number =>
  captured.info.length + captured.warn.length + captured.error.length + captured.debug.length;

const silentHu = {
  getHuInfo: async () => { throw new Error("must not use Azure"); },
  waitForAccess: async () => undefined,
};

const runCodeWith = (events: string[], verbose = false, quiet = false) => {
  const capture = buildReporter(verbose, quiet);
  installReporter(capture.reporter);
  const queueEmptyEvents = [
    jsonEvent({ type: "session", sessionID: "ses_empty" }),
    jsonEvent({ type: "text", sessionID: "ses_empty", part: { type: "text", text: "QUEUE_EMPTY\nWORKFLOW_STEP_FINISHED" } }),
  ];
  let spawnCount = 0;
  const spawnFor = (lines: string[]) => () => ({
    stdout: new Blob([lines.join("\n")]).stream(),
    stderr: new Blob([]).stream(),
    exited: Promise.resolve(0),
    kill: () => undefined,
  });
  const service = new OpenCodeService(() => {
    spawnCount += 1;
    return spawnCount === 1 ? spawnFor(events)() : spawnFor(queueEmptyEvents)();
  }, capture.reporter, 100);
  const cli = new LazyWorkflowCli(
    silentHu,
    { run: (options) => service.run(options), resume: (sessionId, prompt, directory) => service.resume(sessionId, prompt, directory) },
  );
  return cli
    .run(["code", ...(verbose ? ["--verbose"] : []), ...(quiet ? ["--quiet"] : []), "--working-directory", "/repo"])
    .then((code) => ({ code, captured: capture.captured }));
};

describe("smoke: GitHub code run verbosity modes (end-to-end via CLI)", () => {
  let originalNoColor: string | undefined;

  beforeEach(() => {
    originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
  });

  afterEach(() => {
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    restoreReporter();
  });

  test("default mode produce entre 5 y 15 lineas para una entrega tipica", async () => {
    const events = buildDeliveryEvents("ses_default");
    const { code, captured } = await runCodeWith(events);

    expect(code).toBe(0);
    const total = countOperatorLines(captured);
    expect(total).toBeGreaterThanOrEqual(5);
    expect(total).toBeLessThanOrEqual(15);
    expect(captured.debug).toEqual([]);
    expect(captured.error).toEqual([]);
    expect(captured.info.some((line) => line.includes("TICKET_COMPLETED"))).toBeTrue();
    expect(captured.info.some((line) => line.includes("inició un paso"))).toBeTrue();
    expect(captured.info.some((line) => line.includes("terminó un paso"))).toBeTrue();
  });

  test("--verbose reproduce el stream completo: reasoning y tool_use visibles como debug", async () => {
    const events = buildDeliveryEvents("ses_verbose");
    const { code, captured } = await runCodeWith(events, true);

    expect(code).toBe(0);
    expect(captured.debug.some((line) => line.includes("razonando: Analizando cambios pendientes"))).toBeTrue();
    expect(captured.debug.some((line) => line.includes("herramienta bash"))).toBeTrue();
    expect(captured.debug.some((line) => line.includes("herramienta read"))).toBeTrue();
    expect(captured.debug.some((line) => line.includes("herramienta edit"))).toBeTrue();
    expect(captured.debug.length).toBeGreaterThanOrEqual(4);
    expect(captured.info.length).toBeGreaterThanOrEqual(3);
  });

  test("--verbose nunca reduce el volumen respecto al modo default", async () => {
    const eventsDefault = buildDeliveryEvents("ses_compare_default");
    const eventsVerbose = buildDeliveryEvents("ses_compare_verbose");
    const { captured: defaultCaptured } = await runCodeWith(eventsDefault);
    const { captured: verboseCaptured } = await runCodeWith(eventsVerbose, true);

    const defaultTotal = countOperatorLines(defaultCaptured);
    const verboseTotal = countOperatorLines(verboseCaptured);
    expect(defaultTotal).toBeGreaterThanOrEqual(5);
    expect(defaultTotal).toBeLessThanOrEqual(15);
    expect(verboseTotal).toBeGreaterThan(defaultTotal);
  });

  test("--quiet silencia el run exitoso sin emitir lineas", async () => {
    const events = buildDeliveryEvents("ses_quiet");
    const { code, captured } = await runCodeWith(events, false, true);

    expect(code).toBe(0);
    expect(captured.info).toEqual([]);
    expect(captured.warn).toEqual([]);
    expect(captured.debug).toEqual([]);
    expect(captured.error).toEqual([]);
    expect(countOperatorLines(captured)).toBe(0);
  });

  test("--quiet preserva las llamadas a error() del Reportador aunque silencia info y warn", () => {
    const { reporter, captured } = buildReporter(false, true);
    reporter.error("lazy-workflow: fallo critico");
    reporter.info("oculto");
    reporter.warn("oculto");

    expect(captured.error).toEqual(["lazy-workflow: fallo critico"]);
    expect(captured.info).toEqual([]);
    expect(captured.warn).toEqual([]);
  });
});
