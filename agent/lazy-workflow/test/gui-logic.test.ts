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
import { finalMarker, interviewUrl, operatorFeed, parseStdout, runLogPointer, stripAnsi } from "../gui/src/lib/output.ts";
import { foldRuns, formatDuration } from "../gui/src/lib/history.ts";
import { initialRunsState, runsReducer, statusOf, type RunsAction } from "../gui/src/lib/runs.ts";
import { defaultParent, emptyRunOptions, folderName, joinPath, prepareProvision, prepareRun, prepareSetup, type RunTarget } from "../gui/src/lib/run-request.ts";
import { itemLabel, matchesPlannable, plannableTarget, scopesOf } from "../gui/src/lib/plannable.ts";
import { effortChoices, installedClis, modelGroups } from "../gui/src/lib/models.ts";
import { repairCli, repairPrompt, setupProblems } from "../gui/src/lib/setup-check.ts";
import type { AgentModels } from "../src/coding-agent/agent-models-schema.ts";
import type { Diagnostics } from "../gui/src/lib/backend.ts";

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

// ---------------------------------------------------------------------------
// Plan and Code from a piece of work, the model menus, and what is missing.
// ---------------------------------------------------------------------------

const hu: RunTarget = { kind: "azure-hu", repository: "/r/azure", hu: 50, title: "Portal" };

test("Code sobre una HU nombra la tarea elegida y omite lo que el CLI ya tiene por defecto", () => {
  const prepared = prepareRun(catalog, "code", hu, { ...emptyRunOptions("/r/azure"), ticket: "51", cli: "codex", variant: "high", fallbacks: ["claudecode:claude-x:max", ""] })!;
  expect(prepared.issues).toEqual([]);
  expect(prepared.args).toEqual(["code", "--working-directory", "/r/azure", "--hu", "50", "--ticket", "51", "--cli", "codex", "--fallback", "claudecode:claude-x:max"]);
  // Plan on the same HU never carries a ticket, and its interview is the http channel.
  expect(prepareRun(catalog, "plan", { ...hu, ticket: 51 }, { ...emptyRunOptions("/r/azure"), ticket: "51", interview: true })!.args)
    .toEqual(["plan", "--working-directory", "/r/azure", "--hu", "50", "--interview", "http"]);
});

test("un plan de GitHub exige que se describa; desde una issue la sesion la lee con gh", () => {
  const repository: RunTarget = { kind: "github-repository", repository: "/r/github", scope: "owner/repo" };
  expect(prepareRun(catalog, "plan", repository, emptyRunOptions("/r/github"))!.issues.map((issue) => issue.flag)).toEqual(["--prompt"]);
  expect(prepareRun(catalog, "code", repository, emptyRunOptions("/r/github"))!.args).toEqual(["code", "--working-directory", "/r/github"]);
  const issue: RunTarget = { kind: "github-issue", repository: "/r/github", issue: 9, title: "[Epic] Portal", url: "https://github.com/o/r/issues/9" };
  const args = prepareRun(catalog, "plan", issue, { ...emptyRunOptions("/r/github"), repositories: ["/r/github", "/r/web"], prompt: "Solo el backend" })!.args;
  expect(args.slice(0, 3)).toEqual(["plan", "--working-directory", "/r/github,/r/web"]);
  const prompt = args[args.indexOf("--prompt") + 1]!;
  expect(prompt).toContain("#9 «[Epic] Portal»");
  expect(prompt).toContain("gh issue view 9 --comments");
  expect(prompt.endsWith("Solo el backend")).toBe(true);
});

test("planificar una épica la nombra con --issue y su repositorio, esté donde esté el plan", () => {
  const epic: RunTarget = { kind: "github-epic", repository: null, nameWithOwner: "o/plans", issue: 9, title: "[Epic] Portal", url: "https://github.com/o/plans/issues/9" };
  const prepared = prepareRun(catalog, "plan", epic, { ...emptyRunOptions(null), repositories: ["/r/github", "/r/web"] })!;
  expect(prepared.issues).toEqual([]);
  expect(prepared.args).toEqual(["plan", "--working-directory", "/r/github,/r/web", "--issue", "9", "--issue-repository", "o/plans"]);
  // Code no rebana: drena la cola del repositorio, nunca nombra la épica.
  expect(prepareRun(catalog, "code", epic, emptyRunOptions("/r/github"))!.args).toEqual(["code", "--working-directory", "/r/github"]);
});

test("planificar una HU o un Bug pide elegir el repositorio, en palabras del operador", () => {
  const bug: RunTarget = { kind: "azure-hu", repository: "/r/azure", hu: 70, title: "Falla el login", bug: true };
  const blocked = prepareRun(catalog, "plan", bug, { ...emptyRunOptions("/r/azure"), repositories: [] })!;
  expect(blocked.issues.filter((issue) => issue.flag === "--working-directory").map((issue) => issue.message)).toEqual(["Elige el repositorio donde trabajar."]);
  expect(prepareRun(catalog, "plan", bug, { ...emptyRunOptions("/r/azure"), repositories: ["/r/api", "/r/web"] })!.args)
    .toEqual(["plan", "--working-directory", "/r/api,/r/web", "--hu", "70"]);
});

test("descargar o crear un repositorio arma su comando y exige lo que el tracker necesita", () => {
  const clone = prepareProvision(catalog, { action: "repo-clone", tracker: "azure", project: "Portal", repository: "api", destination: "/home/me/src/api" })!;
  expect(clone.issues).toEqual([]);
  expect(clone.args).toEqual(["repo-clone", "--tracker", "azure", "--repository", "api", "--project", "Portal", "--destination", "/home/me/src/api"]);
  const github = prepareProvision(catalog, { action: "repo-create", tracker: "github", project: "", repository: "acme/nuevo", destination: "/home/me/src/nuevo" })!;
  expect(github.args).toEqual(["repo-create", "--tracker", "github", "--repository", "acme/nuevo", "--destination", "/home/me/src/nuevo"]);
  expect(prepareProvision(catalog, { action: "repo-clone", tracker: "github", project: "", repository: "nuevo", destination: "/x/nuevo" })!.issues.map((issue) => issue.flag)).toEqual(["--repository"]);
  expect(prepareProvision(catalog, { action: "repo-create", tracker: "azure", project: "", repository: "api", destination: "/x/api" })!.issues.map((issue) => issue.flag)).toEqual(["--project"]);
  expect(folderName("acme/nuevo")).toBe("nuevo");
  expect(joinPath("/home/me/src/", "api")).toBe("/home/me/src/api");
  expect(joinPath("C:\\code", "api")).toBe("C:\\code\\api");
  expect(defaultParent(["/home/me/src/agent-workflow", "/srv/other"])).toBe("/home/me/src");
  expect(defaultParent([])).toBe("");
});

test("Planificar lista lo leído en el tracker y lo planifica sin carpeta de origen", () => {
  const bug = { id: 70, title: "Falla el login", type: "Bug", state: "En progreso", url: "https://dev.azure.com/o/Portal/_workitems/edit/70", scope: "Portal" };
  const epic = { id: 9, title: "[Epic] Pagos", type: "Epic", state: "OPEN", url: "https://github.com/o/plans/issues/9", scope: "o/plans" };
  expect(itemLabel(bug, "azure")).toBe("Bug #70");
  expect(itemLabel(epic, "github")).toBe("o/plans #9");
  expect(plannableTarget(bug, "azure")).toEqual({ kind: "azure-hu", repository: null, hu: 70, title: "Falla el login", bug: true, project: "Portal" });
  expect(plannableTarget(epic, "github")).toEqual({ kind: "github-epic", repository: null, nameWithOwner: "o/plans", issue: 9, title: "[Epic] Pagos", url: epic.url });
  expect(matchesPlannable(bug, "login", "")).toBe(true);
  expect(matchesPlannable(bug, "", "Otro")).toBe(false);
  expect(scopesOf([bug, epic, bug])).toEqual(["o/plans", "Portal"]);
});

const models: AgentModels[] = [
  { cli: "opencode", installed: true, defaultModel: "opencode-go/pro", error: null, models: [{ id: "deepseek/flash", name: "flash", provider: "deepseek", efforts: null, defaultEffort: null }] },
  { cli: "claudecode", installed: false, defaultModel: "claude-x", error: "claude no esta en el PATH", models: [] },
  { cli: "codex", installed: true, defaultModel: "gpt-x", error: null, models: [{ id: "gpt-new", name: "GPT New", provider: "openai", efforts: ["low", "medium"], defaultEffort: "medium" }] },
];

test("el menu de modelos agrupa por proveedor y conserva el default y lo ya elegido", () => {
  expect(modelGroups(catalog, models, "opencode", "custom/model").map((group) => [group.provider, group.models.map((model) => model.id)])).toEqual([
    ["deepseek", ["deepseek/flash"]],
    ["opencode-go", ["opencode-go/pro"]],
    ["custom", ["custom/model"]],
  ]);
  expect(effortChoices(catalog, models, "codex", "gpt-new")).toEqual(["low", "medium"]);
  // Without a list, a CLI's fixed efforts come from the catalog.
  expect(effortChoices(catalog, null, "codex", "gpt-new")).toEqual(catalog.agents.find((agent) => agent.cli === "codex")!.efforts!);
  expect(installedClis(catalog, models)).toEqual(["opencode", "codex"]);
  expect(installedClis(catalog, null)).toEqual(catalog.agents.map((agent) => agent.cli));
});

const diagnostics = (missing: string[], organization: boolean): Diagnostics => ({
  settingsPath: "", runLogPath: "", lzLauncher: "lz", lzError: null, credentialsError: null, shellEnvironment: true,
  binaries: ["lz", "git", "gh", "az", "opencode", "claude", "codex"].map((name) => ({ name, path: missing.includes(name) ? null : `/bin/${name}` })),
  variables: [{ name: "LAZY_WORKFLOW_AZURE_ORGANIZATION", present: organization, value: organization ? "https://dev.azure.com/o" : null, source: organization ? "credentials" : "missing" }],
});

test("lo que falta se deriva de los trackers en uso, los binarios y las lecturas fallidas", () => {
  const problems = setupProblems({
    catalog, models, preferredCli: "claudecode",
    diagnostics: diagnostics(["gh", "az"], false),
    repositories: [
      { repository: "/r/azure", tracker: "azure", error: null },
      { repository: "/r/broken", tracker: null, error: "gh: not logged in" },
    ],
  });
  // gh is missing but no repository is known to be GitHub: it is not asked for.
  expect(problems.map((problem) => problem.id)).toEqual(["agent-claudecode", "az", "azure-organization", "read:/r/broken"]);
  expect(repairCli(catalog, models, null, "claudecode")).toBe("opencode");
  expect(repairPrompt(problems).split("\n")).toHaveLength(4);
  const setup = prepareSetup(catalog, "/r/azure", repairPrompt(problems), "codex")!;
  expect(setup.args.slice(0, 3)).toEqual(["setup", "--working-directory", "/r/azure"]);
  expect(setup.args).toContain("codex");
  // Nothing can repair anything without an agent to run it.
  const stranded = setupProblems({ catalog, models: null, preferredCli: "opencode", diagnostics: diagnostics(["opencode", "claude", "codex"], true), repositories: [] });
  expect(stranded).toEqual([expect.objectContaining({ id: "agents", fixable: false })]);
  expect(repairCli(catalog, null, diagnostics(["opencode", "claude", "codex"], true), "opencode")).toBeNull();
});

test("el progreso de un run se lee como hora y mensaje, sin el panel ni los margenes del reporter", () => {
  const feed = operatorFeed([
    "╭──────────────────────────────╮",
    "│ lazy-workflow · code         │",
    "╰──────────────────────────────╯",
    "12/10/26 00:22:29 │ ● Sesion abierta con codex",
    "12/10/26 00:22:31 │ ▲ La rama ya existia",
    "                  │   se reutiliza",
    "12/10/26 00:22:40 │ ✖ La verificacion fallo",
    "salida propia del agente",
  ]);
  expect(feed).toEqual([
    { time: "00:22:29", level: "info", text: "Sesion abierta con codex" },
    { time: "00:22:31", level: "warn", text: "La rama ya existia\nse reutiliza" },
    { time: "00:22:40", level: "error", text: "La verificacion fallo" },
    { time: null, level: "info", text: "salida propia del agente" },
  ]);
});
