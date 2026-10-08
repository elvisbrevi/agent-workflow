/**
 * La lógica de la GUI que no necesita una ventana: cómo un formulario se
 * vuelve una línea de comando, qué la bloquea, qué se oculta, cómo se leen la
 * salida y el run log, y cómo se ordenan los eventos de un run. Todo corre con
 * el catálogo real, así que una GUI que mostrara un comando distinto del que
 * ejecuta fallaría aquí antes que en manos del operador.
 */
import { expect, test } from "bun:test";
import { commandCatalog, type CatalogCommand } from "../src/cli/command-catalog.ts";
import { buildArgs, renderCommandLine, shellQuote, validateFlags, MASK } from "../gui/src/lib/command-line.ts";
import { initialValues } from "../gui/src/lib/form-defaults.ts";
import { finalMarker, interviewUrl, parseStdout, runLogPointer, stripAnsi } from "../gui/src/lib/output.ts";
import { foldRuns, formatDuration } from "../gui/src/lib/history.ts";
import { initialRunsState, runsReducer, statusOf, type RunsAction } from "../gui/src/lib/runs.ts";

const catalog = commandCatalog();
const command = (name: string): CatalogCommand => catalog.commands.find((candidate) => candidate.name === name)!;

test("un valor igual al default del catalogo no se envia: la linea es la mas corta con el mismo efecto", () => {
  const args = buildArgs(catalog, command("plan"), {
    "--working-directory": "/repo",
    "--cli": "opencode",
    "--variant": "high",
    "--interview": "off",
    "--prompt": "Agregar paginacion",
    "--normas-sag": false,
  });
  expect(args).toEqual(["plan", "--working-directory", "/repo", "--prompt", "Agregar paginacion"]);
});

test("una opcion cuyo requisito falta no se envia y se avisa", () => {
  const values = { "--working-directory": "/repo", "--ticket": "51", "--base-branch": "main" };
  expect(buildArgs(catalog, command("code"), values)).toEqual(["code", "--working-directory", "/repo"]);
  expect(validateFlags(catalog, command("code"), values).map((issue) => [issue.flag, issue.severity])).toEqual([
    ["--ticket", "warning"],
    ["--base-branch", "warning"],
  ]);
  expect(buildArgs(catalog, command("code"), { ...values, "--hu": "23438" })).toEqual([
    "code", "--working-directory", "/repo", "--hu", "23438", "--ticket", "51", "--base-branch", "main",
  ]);
});

test("las repetibles se envian una vez por valor, en orden, sin las vacias", () => {
  const args = buildArgs(catalog, command("code"), {
    "--working-directory": "/repo",
    "--fallback": ["codex:gpt-5.6-sol:high", " ", "opencode:x:low"],
  });
  expect(args).toEqual(["code", "--working-directory", "/repo", "--fallback", "codex:gpt-5.6-sol:high", "--fallback", "opencode:x:low"]);
});

test("validar bloquea lo que el parser rechazaria: obligatorias, numeros, commits y exclusiones", () => {
  const errors = (name: string, values: Record<string, string | boolean>) =>
    validateFlags(catalog, command(name), values).filter((issue) => issue.severity === "error").map((issue) => issue.flag);
  expect(errors("ticket-info", {})).toEqual(["--hu", "--ticket"]);
  expect(errors("ticket-info", { "--hu": "abc", "--ticket": "7" })).toEqual(["--hu"]);
  expect(errors("github-issue-close", { "--issue": "1", "--pr": "2", "--commit": "abc123", "--working-directory": "/r" })).toEqual(["--commit"]);
  expect(errors("pr-create", { "--branch": "b", "--base-branch": "main", "--title": "t", "--description": "x", "--description-file": "/f", "--working-directory": "/r" }))
    .toEqual(["--description"]);
  expect(errors("plan", { "--working-directory": "/r", "--interview": "http", "--quiet": true })).toEqual(["--quiet"]);
});

test("la vista previa cita para el shell y nunca muestra un secreto", () => {
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  expect(shellQuote("issue/201")).toBe("issue/201");
  const plan = command("plan");
  expect(renderCommandLine(catalog, plan, ["plan", "--prompt", "Agregar paginacion", "--off", "hunter2"]))
    .toBe(`lz plan --prompt 'Agregar paginacion' --off ${MASK}`);
  expect(renderCommandLine(catalog, plan, ["plan", "--off", "--off-delay", "0"])).toBe("lz plan --off --off-delay 0");
});

test("un formulario abre con el repositorio activo y los defaults del operador, los del comando primero", () => {
  const values = initialValues(catalog, command("plan"), {
    activeRepository: "/repo",
    flagDefaults: { "--cli": "claudecode", "--verbose": true, "--fallback": "codex:gpt-5.6-sol:high" },
    commandDefaults: { plan: { "--cli": "codex", "--interview": "http" } },
  });
  expect(values).toEqual({
    "--working-directory": "/repo",
    "--cli": "codex",
    "--interview": "http",
    "--verbose": true,
    "--fallback": ["codex:gpt-5.6-sol:high"],
  });
  expect(initialValues(catalog, command("hu-info"), { activeRepository: "/repo", flagDefaults: {}, commandDefaults: {} })).toEqual({});
});

test("la salida ofrece la URL de la entrevista, el run del run log y el marcador final", () => {
  const stderr = [
    "\u001b[32m[08/10/26 18:00:00] Responde las preguntas del plan en http://127.0.0.1:41234/i/Zx9_token\u001b[0m",
    "lazy-workflow: revisa el run log para el detalle del fallo: grep 0b1c2d3e-1111-4222-8333-444455556666 /home/u/.local/state/lazy-workflow/runs.jsonl",
  ].map(stripAnsi);
  expect(interviewUrl(stderr)).toBe("http://127.0.0.1:41234/i/Zx9_token");
  expect(runLogPointer(stderr)).toEqual({ runId: "0b1c2d3e-1111-4222-8333-444455556666", path: "/home/u/.local/state/lazy-workflow/runs.jsonl" });
  expect(finalMarker(['{"outcome":"QUEUE_EMPTY"}', "QUEUE_EMPTY", "WORKFLOW_STEP_FINISHED"])).toBe("Cola vacia");
  expect(parseStdout(["{", '  "hu": 1', "}"])).toEqual({ kind: "json", value: { hu: 1 } });
  expect(parseStdout(['{"a":1}', "QUEUE_EMPTY"]).kind).toBe("text");
  expect(parseStdout([]).kind).toBe("empty");
});

test("el run log se agrupa por run, el mas reciente primero, con su resultado y contexto", () => {
  const base = { command: "code", workflow: "code", provider: "github", cli: "claudecode", model: "m", variant: "high", message: "" };
  const runs = foldRuns([
    { ...base, run_id: "a", ts: "2026-10-01T10:00:00Z", severity: "info", event: "run.started", context: { issue: null } },
    { ...base, run_id: "a", ts: "2026-10-01T10:01:00Z", severity: "error", event: "event", failure_kind: "delivery-failure", context: { issue: 7 } },
    { ...base, run_id: "a", ts: "2026-10-01T10:02:00Z", severity: "error", event: "run.finished", outcome: "failure", exit_code: 1, duration_ms: 120000, context: {} },
    { ...base, run_id: "b", ts: "2026-10-02T09:00:00Z", severity: "info", event: "run.started", context: {} },
    "no es un registro",
  ]);
  expect(runs.map((run) => [run.runId, run.outcome, run.exitCode, run.errors, run.context])).toEqual([
    ["b", "unfinished", null, 0, {}],
    ["a", "failure", 1, 1, { issue: 7 }],
  ]);
  expect(formatDuration(120000)).toBe("2m 0s");
  expect(formatDuration(null)).toBe("—");
});

test("las lineas que llegan antes de que start_run responda no se pierden", () => {
  const started: RunsAction = {
    type: "started",
    started: { id: 1, program: "lz", args: ["hu-info"], cwd: "/", startedAt: 0 },
    args: ["hu-info", "--hu", "1"],
    command: "hu-info",
    line: "lz hu-info --hu 1",
    effect: "read",
    output: "json",
  };
  const actions: RunsAction[] = [
    { type: "output", lines: [{ id: 1, stream: "stdout", line: "{}" }, { id: 1, stream: "stderr", line: "\u001b[1mpanel\u001b[0m" }] },
    { type: "exit", exit: { id: 1, code: 0, signal: null, durationMs: 5, cancelled: false, error: null } },
    started,
  ];
  const state = actions.reduce(runsReducer, initialRunsState);
  expect(state.runs[0]).toMatchObject({ stdout: ["{}"], stderr: ["panel"], status: "success", args: ["hu-info", "--hu", "1"] });
  expect(state.orphans).toEqual({});
  expect(state.activeId).toBe(1);
});

test("Ctrl-C se lee como interrumpido, no como fallo", () => {
  const exit = { id: 1, signal: null, durationMs: 1, error: null };
  expect(statusOf({ ...exit, code: 130, cancelled: true })).toBe("interrupted");
  expect(statusOf({ ...exit, code: null, signal: 9, cancelled: true } as never)).toBe("interrupted");
  expect(statusOf({ ...exit, code: 1, cancelled: false })).toBe("failure");
  expect(statusOf({ ...exit, code: 0, cancelled: false })).toBe("success");
});
