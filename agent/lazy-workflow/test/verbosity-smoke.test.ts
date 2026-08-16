import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import chalk from "chalk";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import { OpenCodeService } from "../src/opencode/open-code-service.ts";
import { createReporter, type Reporter, type ReporterStream } from "../src/output/reporter.ts";
import { setDefaultReporter } from "../src/output/operator-output.ts";
import { fakeSelectedIssue, fakeSelectedOutcome, queueAdapter } from "./_helpers/managed-queue-fixtures.ts";
import { fakeCoordinatedGitHubDeps } from "./_helpers/github-delivery-fixtures.ts";
import { parseReportedChunk, type ReportedLine } from "./_helpers/reported-lines.ts";

beforeAll(() => {
  chalk.level = 1;
});

type CapturedMessage = ReportedLine;

const captureStream = (): { stream: ReporterStream; captured: CapturedMessage[] } => {
  const captured: CapturedMessage[] = [];
  const stream = {
    write(chunk: string): void {
      captured.push(...parseReportedChunk(chunk));
    },
  };
  return { stream, captured };
};

const buildReporter = (
  verbose: boolean,
  quiet = false,
  verboseOutput = false,
): { reporter: Reporter; captured: CapturedMessage[] } => {
  const { stream, captured } = captureStream();
  const reporter = createReporter({ verbose, verboseOutput, quiet, noColor: true, stream });
  return { reporter, captured };
};

const jsonEvent = (event: Record<string, unknown>): string => JSON.stringify(event);

const buildDeliveryEvents = (sessionId: string): string[] => [
  jsonEvent({ type: "session", sessionID: sessionId }),
  jsonEvent({ type: "reasoning", sessionID: sessionId, part: { type: "reasoning", text: "Analyzing pending changes" } }),
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
    part: {
      type: "tool",
      tool: "edit",
      state: {
        status: "completed",
        input: { file_path: "src/output/reporter.ts", old_string: "antes", new_string: "despues" },
        output: "1 archivo actualizado",
      },
    },
  }),
  jsonEvent({ type: "step_start", sessionID: sessionId, part: { type: "step", reason: "agent" } }),
  jsonEvent({ type: "step_finish", sessionID: sessionId, part: { type: "step", reason: "stop" } }),
  jsonEvent({ type: "text", sessionID: sessionId, part: { type: "text", text: "IMPLEMENTATION_READY" } }),
];

const countByLevel = (captured: CapturedMessage[]) => ({
  total: captured.length,
  info: captured.filter((entry) => entry.level === "info").length,
  warn: captured.filter((entry) => entry.level === "warn").length,
  error: captured.filter((entry) => entry.level === "error").length,
  debug: captured.filter((entry) => entry.level === "debug").length,
  trace: captured.filter((entry) => entry.level === "trace").length,
});

const noAzureBoundary = {
  getHuInfo: async () => { throw new Error("must not use Azure"); },
  waitForAccess: async () => undefined,
};

const runCodeWith = (events: string[], verbose = false, quiet = false, verboseOutput = false) => {
  const capture = buildReporter(verbose, quiet, verboseOutput);
  setDefaultReporter(capture.reporter);
  const spawnWithEvents = (lines: string[]) => () => ({
    stdout: new Blob([lines.join("\n")]).stream(),
    stderr: new Blob([]).stream(),
    exited: Promise.resolve(0),
    kill: () => undefined,
  });
  const service = new OpenCodeService(() => spawnWithEvents(events)(), capture.reporter, 100);
  const cli = new LazyWorkflowCli(
    noAzureBoundary,
    { run: (options) => service.run(options), resume: (sessionId, prompt, directory) => service.resume(sessionId, prompt, directory) },
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
    queueAdapter([fakeSelectedOutcome(201), { kind: "empty" }]),
    ...fakeCoordinatedGitHubDeps(),
  );
  return cli
    .run([
      "code",
      ...(verbose ? ["--verbose"] : []),
      ...(verboseOutput ? ["--verbose-output"] : []),
      ...(quiet ? ["--quiet"] : []),
      "--working-directory",
      "/repo",
    ])
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
    setDefaultReporter(createReporter({ verbose: false, noColor: true }));
  });

  test("default mode produces between 5 and 15 lines for a typical delivery", async () => {
    const events = buildDeliveryEvents("ses_default");
    const { code, captured } = await runCodeWith(events);

    expect(code).toBe(0);
    const counts = countByLevel(captured);
    expect(counts.total).toBeGreaterThanOrEqual(5);
    expect(counts.total).toBeLessThanOrEqual(15);
    expect(counts.debug).toBe(0);
    expect(counts.error).toBe(0);
    expect(captured.some((entry) => entry.message.includes("IMPLEMENTATION_READY"))).toBeTrue();
    expect(captured.some((entry) => entry.message.includes("inició un paso"))).toBeTrue();
    expect(captured.some((entry) => entry.message.includes("terminó un paso"))).toBeTrue();
  });

  test("--verbose reproduces the full event stream: reasoning and tool_use visible as debug", async () => {
    const events = buildDeliveryEvents("ses_verbose");
    const { code, captured } = await runCodeWith(events, true);

    expect(code).toBe(0);
    expect(captured.some((entry) => entry.level === "debug" && entry.message.includes("razonando: Analyzing pending changes"))).toBeTrue();
    expect(captured.some((entry) => entry.level === "debug" && entry.message.includes("herramienta bash"))).toBeTrue();
    expect(captured.some((entry) => entry.level === "debug" && entry.message.includes("herramienta read"))).toBeTrue();
    expect(captured.some((entry) => entry.level === "debug" && entry.message.includes("herramienta edit"))).toBeTrue();
    const counts = countByLevel(captured);
    expect(counts.debug).toBeGreaterThanOrEqual(4);
    expect(counts.info).toBeGreaterThanOrEqual(3);
  });

  test("--verbose never reduces volume relative to default mode", async () => {
    const { captured: defaultCaptured } = await runCodeWith(buildDeliveryEvents("ses_compare_default"));
    const { captured: verboseCaptured } = await runCodeWith(buildDeliveryEvents("ses_compare_verbose"), true);

    const defaultCounts = countByLevel(defaultCaptured);
    const verboseCounts = countByLevel(verboseCaptured);
    expect(defaultCounts.total).toBeGreaterThanOrEqual(5);
    expect(defaultCounts.total).toBeLessThanOrEqual(15);
    expect(verboseCounts.total).toBeGreaterThan(defaultCounts.total);
  });

  test("--verbose names the file a tool edits, without the raw stream", async () => {
    const { code, captured } = await runCodeWith(buildDeliveryEvents("ses_file"), true);

    expect(code).toBe(0);
    expect(captured.some((entry) =>
      entry.level === "debug"
      && entry.message.includes("herramienta edit")
      && entry.message.includes("en src/output/reporter.ts"))).toBeTrue();
    expect(countByLevel(captured).trace).toBe(0);
  });

  test("--verbose-output adds every tool input, its output and the raw event", async () => {
    const { code, captured } = await runCodeWith(buildDeliveryEvents("ses_full"), false, false, true);

    expect(code).toBe(0);
    const traces = captured.filter((entry) => entry.level === "trace");
    // The whole input, not only the summary the parsed line carries.
    expect(traces.some((entry) =>
      entry.message.includes("herramienta edit entrada:")
      && entry.message.includes("src/output/reporter.ts")
      && entry.message.includes("old_string"))).toBeTrue();
    expect(traces.some((entry) => entry.message.includes("herramienta edit salida: 1 archivo actualizado"))).toBeTrue();
    expect(traces.some((entry) => entry.message.startsWith("OpenCode evento crudo: {"))).toBeTrue();
    // It is strictly wider than --verbose, so the reasoning and tool lines are there too.
    expect(captured.some((entry) => entry.level === "debug" && entry.message.includes("razonando: Analyzing pending changes"))).toBeTrue();
  });

  test("--verbose-output never reduces volume relative to --verbose", async () => {
    const { captured: verboseCaptured } = await runCodeWith(buildDeliveryEvents("ses_wide_verbose"), true);
    const { captured: fullCaptured } = await runCodeWith(buildDeliveryEvents("ses_wide_full"), false, false, true);

    expect(countByLevel(fullCaptured).total).toBeGreaterThan(countByLevel(verboseCaptured).total);
  });

  test("--quiet silences a successful run and emits zero lines", async () => {
    const { code, captured } = await runCodeWith(buildDeliveryEvents("ses_quiet"), false, true);

    expect(code).toBe(0);
    expect(captured).toEqual([]);
  });

  test("--quiet preserves Reporter error() calls while silencing info and warn", () => {
    const { reporter, captured } = buildReporter(false, true);
    reporter.error("lazy-workflow: critical failure");
    reporter.info("hidden");
    reporter.warn("hidden");

    expect(captured.filter((entry) => entry.level === "error")).toEqual([
      { level: "error", message: "lazy-workflow: critical failure" },
    ]);
    expect(captured.filter((entry) => entry.level === "info")).toEqual([]);
    expect(captured.filter((entry) => entry.level === "warn")).toEqual([]);
  });

  test("GitHub-only code run never touches the Azure boundary across all verbosity modes", async () => {
    let azureCalls = 0;
    const trackingBoundary = {
      getHuInfo: async () => { azureCalls += 1; throw new Error("must not use Azure"); },
      waitForAccess: async () => { azureCalls += 1; },
    };
    const spawnWithEvents = (lines: string[]) => () => ({
      stdout: new Blob([lines.join("\n")]).stream(),
      stderr: new Blob([]).stream(),
      exited: Promise.resolve(0),
      kill: () => undefined,
    });
    const events = buildDeliveryEvents("ses_boundary");

    for (const [verbose, quiet] of [[false, false], [true, false], [false, true]] as const) {
      const capture = buildReporter(verbose, quiet);
      setDefaultReporter(capture.reporter);
      const service = new OpenCodeService(() => spawnWithEvents(events)(), capture.reporter, 100);
      const cli = new LazyWorkflowCli(
        trackingBoundary,
        { run: (options) => service.run(options), resume: (sessionId, prompt, directory) => service.resume(sessionId, prompt, directory) },
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
        queueAdapter([fakeSelectedOutcome(201), { kind: "empty" }]),
        ...fakeCoordinatedGitHubDeps(),
      );
      const code = await cli.run([
        "code",
        ...(verbose ? ["--verbose"] : []),
        ...(quiet ? ["--quiet"] : []),
        "--working-directory",
        "/repo",
      ]);
      expect(code).toBe(0);
    }
    expect(azureCalls).toBe(0);
  });
});
