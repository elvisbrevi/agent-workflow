import yargs from "yargs";
import type { Argv } from "yargs";
import type { EvidenceKind } from "../azure/ticket-info-service.ts";
import { CLAUDE_CODE_EFFORTS } from "../claude-code/claude-code-service.ts";
import { AGENT_CLI_BINARIES, DEFAULT_CLI, isAgentCli, type AgentCli } from "../coding-agent/agent-cli.ts";
import { INTERVIEW_CHANNELS, type InterviewChannelKind, type InterviewSettings } from "../interaction/question-channel.ts";
import { DETERMINISTIC_TOOL_COMMANDS, DETERMINISTIC_TOOL_FORMS } from "./tool-commands.ts";

/** One step of a declared fallback chain: the primary is rung zero, implicitly. */
export interface FallbackRung {
  cli: AgentCli;
  model: string;
  variant: string;
}

export interface CliOptions {
  command: string;
  cli: AgentCli;
  model: string;
  variant: string;
  hasCli: boolean;
  hasModel: boolean;
  hasVariant: boolean;
  /** Declared with `--fallback`, in declaration order; empty when the run has none. */
  fallbackChain: FallbackRung[];
  /** Seconds between retries of the primary rung once the whole chain is exhausted. */
  fallbackWaitSeconds: number;
  /** Total bound in seconds for the wait-and-retry cycle — waits and retries alike — after which the run fails closed. */
  fallbackWaitMaxSeconds: number;
  session: string | null;
  prompt: string;
  hu: number | null;
  issue: number | null;
  branch: string | null;
  baseBranch: string | null;
  ticket: number | null;
  pullRequest: number | null;
  /** The commit a deterministic tool is pinned to; always a full object name. */
  commit: string | null;
  manifest: string | null;
  file: string | null;
  descriptionFile: string | null;
  state: string | null;
  expectedState: string | null;
  realEffort: number;
  realEffortHours: number;
  expectedRevision: number;
  environment: string | null;
  hasRealEffort: boolean;
  hasRealEffortHours: boolean;
  hasExpectedRevision: boolean;
  evidenceKind: EvidenceKind | null;
  type: string | null;
  title: string | null;
  estimate: number | null;
  assignee: string | null;
  /** Explicit Azure reference names; display labels are never inferred (ADR-0006). */
  fields: Array<{ referenceName: string; value: string }>;
  parent: number | null;
  child: number | null;
  blocker: number | null;
  blocked: number | null;
  numberOfQuestions: number;
  /** How this run reaches the operator with its planning questions, if at all. */
  interview: InterviewSettings;
  normasSag: boolean;
  workingDirectory: string;
  verbose: boolean;
  /** The widest reading of a run: everything the agent streams, verbatim. */
  verboseOutput: boolean;
  quiet: boolean;
  noColor: boolean;
}

export type CliParseResult =
  | { kind: "options"; options: CliOptions }
  | { kind: "help"; output: string }
  | { kind: "error"; message: string; exitCode: number };

export interface CliParserHooks {
  onHelp(output: string): number;
  onError(message: string, exitCode: number): number;
}

export type CliParser = (args: string[], hooks: CliParserHooks) => CliParseResult;

const AGENT_CLIS = Object.keys(AGENT_CLI_BINARIES) as AgentCli[];

/** Answers whether a binary is on the PATH; injected so tests never depend on the host. */
export type BinaryProbe = (binary: string) => boolean;

const binaryOnPath: BinaryProbe = (binary) => Bun.which(binary) !== null;

const DEFAULT_MODEL = "opencode-go/deepseek-v4-pro";
const DEFAULT_VARIANT = "high";
const DEFAULT_PROMPT = "Follow the authoritative workflow and context.";
const DEFAULT_NUMBER_OF_QUESTIONS = 5;
/** No interview unless the operator asks for one: an unattended run is the normal one. */
const DEFAULT_INTERVIEW_CHANNEL: InterviewChannelKind = "off";
const DEFAULT_INTERVIEW_TIMEOUT_SECONDS = 900;
const DEFAULT_INTERVIEW_ROUNDS = 8;
const DEFAULT_INTERVIEW_HOST = "127.0.0.1";
const DEFAULT_INTERVIEW_PORT = 0;
const DEFAULT_FALLBACK_WAIT_SECONDS = 300;
const DEFAULT_FALLBACK_WAIT_MAX_SECONDS = 3600;
const SUPPORTED_COMMANDS = new Set([
  "plan",
  "code",
  "infra-sag",
  "architecture-review-sag",
  "deploy-sag",
  "hu-info",
  "hu-branch-info",
  "hu-branch-set",
  "ticket-info",
  "ticket-description-info",
  "ticket-state-info",
  "ticket-effort-info",
  "ticket-branch-info",
  "ticket-pr-info",
  "ticket-attachment-info",
  "ticket-evidence-info",
  "ticket-completion-info",
  "ticket-description-set",
  "ticket-state-set",
  "ticket-effort-set",
  "ticket-branch-set",
  "ticket-pr-link",
  "ticket-commit-link",
  "ticket-attachment-add",
  "ticket-evidence-set",
  "ticket-completion-apply",
  "ticket-create",
  "ticket-link-parent",
  "ticket-link-predecessor",
  ...DETERMINISTIC_TOOL_COMMANDS,
]);

const EVIDENCE_KINDS = new Set<EvidenceKind>(["http-json", "screen", "command-output"]);

type StringCoerce = (value: unknown) => string | null;

const stringCoerce = (flag: string): StringCoerce => (value) => {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${flag} requiere un valor`);
  }
  return value;
};

const positiveIntegerCoerce = (flag: string) => (value: unknown): number => {
  const text = String(value ?? "");
  const parsed = Number.parseInt(text, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || `${parsed}` !== text) {
    throw new Error(`${flag} requiere un entero positivo (recibido: ${text})`);
  }
  return parsed;
};

const nonNegativeNumberCoerce = (flag: string) => (value: unknown): number => {
  const text = String(value ?? "");
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} requiere un numero no negativo (recibido: ${text})`);
  }
  return parsed;
};

/**
 * A pinned commit is a full object name, because every deterministic tool that
 * takes one compares it against a ref: an abbreviation would make the comparison
 * fail as if the branch had moved.
 */
const commitCoerce = (value: unknown): string => {
  const text = String(value ?? "").trim();
  if (!/^[0-9a-f]{40,64}$/i.test(text)) {
    throw new Error(`--commit requiere el nombre de objeto completo del commit (recibido: ${text})`);
  }
  return text;
};

const evidenceKindCoerce = (value: unknown): EvidenceKind | null => {
  const text = String(value ?? "");
  if (text.length === 0) return null;
  return EVIDENCE_KINDS.has(text as EvidenceKind) ? (text as EvidenceKind) : null;
};

const stringOption = (name: string, flag: string, describe: string) => ({
  type: "string" as const,
  requiresArg: true,
  describe,
  coerce: stringCoerce(flag),
});

const positiveIntegerOption = (name: string, flag: string, describe: string, defaultValue?: number) => ({
  type: "string" as const,
  requiresArg: true,
  ...(defaultValue !== undefined ? { default: `${defaultValue}` } : {}),
  describe,
  coerce: positiveIntegerCoerce(flag),
});

const nonNegativeNumberOption = (name: string, flag: string, describe: string) => ({
  type: "string" as const,
  requiresArg: true,
  describe,
  coerce: nonNegativeNumberCoerce(flag),
});

/** `0` is a legitimate port: it asks the OS for a free one. */
const nonNegativeIntegerOption = (name: string, flag: string, describe: string, defaultValue: number) => ({
  type: "string" as const,
  requiresArg: true,
  default: `${defaultValue}`,
  describe,
  coerce: (value: unknown): number => {
    const text = String(value ?? "");
    const parsed = Number.parseInt(text, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || `${parsed}` !== text) {
      throw new Error(`${flag} requiere un entero no negativo (recibido: ${text})`);
    }
    return parsed;
  },
});

export function buildCli(binaryPresent: BinaryProbe = binaryOnPath): CliParser {
  return (rawArgs, hooks) => {
    const command = rawArgs[0];
    if (typeof command !== "string" || !SUPPORTED_COMMANDS.has(command)) {
      const output = renderHelp(buildParserForHelp(rawArgs.slice(1)));
      hooks.onHelp(output);
      return { kind: "help", output };
    }

    if (rawArgs.slice(1).some((arg) => arg === "--help" || arg === "-h")) {
      const output = renderHelp(buildParserForHelp(rawArgs.slice(1)));
      hooks.onHelp(output);
      return { kind: "help", output };
    }

    let captured: CliParseResult | undefined;
    const reportError = (message: string): number => {
      const exitCode = 1;
      captured = { kind: "error", message, exitCode };
      return exitCode;
    };

    const parser = buildParser(rawArgs.slice(1), reportError);

    let argv: ReturnType<typeof parser.parseSync>;
    try {
      argv = parser.parseSync();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportError(message);
      return captured ?? { kind: "error", message, exitCode: 1 };
    }

    if (captured) return captured;

    // Reading the options can still reject a malformed value (`--field` pairs),
    // and that is an argument error like any other yargs raises.
    try {
      return { kind: "options", options: readOptions(command, argv, rawArgs.slice(1), binaryPresent) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      hooks.onError(message, 1);
      return { kind: "error", message, exitCode: 1 };
    }
  };
}

type YargsInstance = Argv;

function buildParser(args: string[], reportError: (message: string) => number): YargsInstance {
  return configureParser(yargs(args), reportError);
}

function buildParserForHelp(args: string[]): YargsInstance {
  return configureParser(yargs(args), () => 1);
}

function configureParser(parser: YargsInstance, reportError: (message: string) => number): YargsInstance {
  return parser
    .scriptName("lazy-workflow")
    .usage("Usage:\n  $0 <command> [options]")
    .version(false)
    .exitProcess(false)
    .strict()
    .strictOptions()
    .fail((message, error) => {
      reportError(error?.message ?? message ?? "argumento invalido");
    })
    .group(["hu", "issue", "environment"], "Alcance:")
    .group(["cli", "session", "model", "variant", "fallback", "fallback-wait", "fallback-wait-max", "prompt"], "Agente de codificacion:")
    .group(["branch", "base-branch", "ticket", "pr", "commit", "manifest"], "Tickets Azure:")
    .group(["file", "description-file", "state", "expected-state"], "Tickets Azure (mutaciones):")
    .group(["real-effort", "real-effort-hh", "expected-rev", "kind", "number-of-questions"], "Tickets Azure (datos):")
    .group(
      ["interview", "interview-timeout", "interview-rounds", "interview-host", "interview-port", "interview-dir"],
      "Entrevista de planificacion (solo plan):",
    )
    .group(["normas-sag", "working-directory"], "Contexto:")
    .group(["verbose", "verbose-output", "quiet", "color"], "Reportador:")
    .option("hu", positiveIntegerOption("hu", "--hu", "Identificador de HU para el flujo Azure; omitir usa GitHub."))
    .option("issue", positiveIntegerOption("issue", "--issue", "Issue explicito para workflows SAG."))
    .option("cli", {
      type: "string",
      requiresArg: true,
      default: DEFAULT_CLI,
      choices: AGENT_CLIS,
      describe: "Agente CLI que ejecuta la sesion.",
    })
    .option("session", stringOption("session", "--session", "Sesion de agente opaca para reanudar."))
    .option("model", { type: "string", requiresArg: true, default: DEFAULT_MODEL, describe: "Modelo del agente CLI seleccionado.", coerce: stringCoerce("--model") })
    .option("variant", { type: "string", requiresArg: true, default: DEFAULT_VARIANT, describe: `Variante del modelo; con claudecode es el esfuerzo (${CLAUDE_CODE_EFFORTS.join("|")}).`, coerce: stringCoerce("--variant") })
    .option("fallback", {
      type: "array",
      requiresArg: true,
      describe: "Escalon de respaldo <cli>:<modelo>:<variante>; repetible, el orden de declaracion es la prioridad de descenso.",
    })
    .option("fallback-wait", positiveIntegerOption("fallback-wait", "--fallback-wait", "Segundos entre reintentos del escalon primario con la cadena agotada.", DEFAULT_FALLBACK_WAIT_SECONDS))
    .option("fallback-wait-max", positiveIntegerOption("fallback-wait-max", "--fallback-wait-max", "Tope total en segundos del ciclo de espera y reintento; alcanzado, el run falla cerrado.", DEFAULT_FALLBACK_WAIT_MAX_SECONDS))
    .option("prompt", { type: "string", requiresArg: true, default: DEFAULT_PROMPT, describe: "Prompt explicito para la sesion.", coerce: stringCoerce("--prompt") })
    .option("branch", stringOption("branch", "--branch", "Rama del repositorio (solo Azure)."))
    .option("base-branch", stringOption("base-branch", "--base-branch", "Rama base remota para crear la rama HU (solo Azure)."))
    .option("ticket", positiveIntegerOption("ticket", "--ticket", "Identificador del ticket Azure."))
    .option("pr", positiveIntegerOption("pr", "--pr", "Identificador del pull request."))
    .option("commit", { type: "string", requiresArg: true, describe: "Commit fijado (nombre de objeto completo) de la herramienta determinista.", coerce: commitCoerce })
    .option("manifest", stringOption("manifest", "--manifest", "Ruta al manifest de completion."))
    .option("file", { type: "string", alias: "evidence-file", requiresArg: true, describe: "Archivo de evidencia.", coerce: stringCoerce("--file") })
    .option("evidence-file", { type: "string", requiresArg: true, describe: "Alias de --file.", coerce: stringCoerce("--evidence-file") })
    .option("description-file", stringOption("description-file", "--description-file", "Archivo con la descripcion del ticket."))
    .option("state", stringOption("state", "--state", "Estado destino del ticket."))
    .option("expected-state", stringOption("expected-state", "--expected-state", "Estado actual esperado antes de la transicion."))
    .option("environment", stringOption("environment", "--environment", "Entorno destino de deploy-sag (dev|test|qa)."))
    .option("real-effort", nonNegativeNumberOption("real-effort", "--real-effort", "Real Effort en horas."))
    .option("real-effort-hh", nonNegativeNumberOption("real-effort-hh", "--real-effort-hh", "Real Effort HH."))
    .option("expected-rev", positiveIntegerOption("expected-rev", "--expected-rev", "Revision esperada del ticket."))
    .option("kind", { type: "string", alias: "evidence-kind", requiresArg: true, describe: "Tipo de evidencia.", coerce: evidenceKindCoerce })
    .option("evidence-kind", { type: "string", requiresArg: true, describe: "Alias de --kind.", coerce: evidenceKindCoerce })
    .option("number-of-questions", positiveIntegerOption("number-of-questions", "--number-of-questions", "Cantidad de preguntas para el modo plan.", DEFAULT_NUMBER_OF_QUESTIONS))
    .option("interview", {
      type: "string",
      requiresArg: true,
      default: DEFAULT_INTERVIEW_CHANNEL,
      choices: INTERVIEW_CHANNELS,
      describe: "Canal por el que el operador responde las preguntas del modo plan; off no pregunta nada.",
    })
    .option("interview-timeout", positiveIntegerOption("interview-timeout", "--interview-timeout", "Segundos de espera por ronda antes de aceptar las respuestas recomendadas.", DEFAULT_INTERVIEW_TIMEOUT_SECONDS))
    .option("interview-rounds", positiveIntegerOption("interview-rounds", "--interview-rounds", "Maximo de rondas de preguntas antes de exigir el plan final.", DEFAULT_INTERVIEW_ROUNDS))
    .option("interview-host", { type: "string", requiresArg: true, default: DEFAULT_INTERVIEW_HOST, describe: "Host del canal http de preguntas; fuera de loopback la URL con su token es la unica credencial.", coerce: stringCoerce("--interview-host") })
    .option("interview-port", nonNegativeIntegerOption("interview-port", "--interview-port", "Puerto del canal http de preguntas; 0 pide uno libre al sistema.", DEFAULT_INTERVIEW_PORT))
    .option("interview-dir", stringOption("interview-dir", "--interview-dir", "Directorio donde el canal file escribe las rondas y lee las respuestas."))
    .option("type", stringOption("type", "--type", "Tipo de work item de entrega (Task o Bug)."))
    .option("title", stringOption("title", "--title", "Titulo exacto del ticket."))
    .option("estimate", nonNegativeNumberOption("estimate", "--estimate", "Estimacion original en horas."))
    .option("assignee", stringOption("assignee", "--assignee", "Identidad Azure asignada al ticket."))
    .option("field", { type: "array", requiresArg: true, describe: "Campo Azure explicito como <referenceName>=<valor>; repetible." })
    .option("parent", positiveIntegerOption("parent", "--parent", "Work item padre."))
    .option("child", positiveIntegerOption("child", "--child", "Work item hijo."))
    .option("blocker", positiveIntegerOption("blocker", "--blocker", "Work item que bloquea."))
    .option("blocked", positiveIntegerOption("blocked", "--blocked", "Work item bloqueado."))
    .option("normas-sag", { type: "boolean", default: false, describe: "Carga las normas SAG del modulo remoto." })
    .option("working-directory", { type: "string", requiresArg: true, default: process.cwd(), describe: "Directorio de trabajo del repositorio objetivo.", coerce: stringCoerce("--working-directory") })
    .option("verbose", { type: "boolean", default: false, describe: "Emite el stream completo de eventos." })
    .option("verbose-output", { type: "boolean", default: false, describe: "Emite todo lo que entregan los agentes, incluidas las entradas y salidas completas de cada herramienta y el evento crudo; implica --verbose." })
    .option("quiet", { type: "boolean", default: false, describe: "Solo emite errores." })
    .option("color", { type: "boolean", default: true, describe: "Habilita codigos ANSI en la salida.", hidden: true })
    .parserConfiguration({ "camel-case-expansion": false, "boolean-negation": true });
}

/**
 * The CLI this run executes its session with. A named CLI is verified here, so a
 * missing binary is an argument error rather than a failed session; omitting the
 * flag keeps the historical OpenCode path exactly as it was.
 */
function readAgentCli(parsed: Record<string, unknown>, rawArgs: string[], binaryPresent: BinaryProbe): AgentCli {
  const cli = (parsed["cli"] as AgentCli | undefined) ?? DEFAULT_CLI;
  const binary = AGENT_CLI_BINARIES[cli];
  if (flagSupplied(rawArgs, "--cli") && !binaryPresent(binary)) {
    throw new Error(`--cli ${cli} requiere el binario ${binary} en el PATH`);
  }
  return cli;
}

const isValidVariant = (cli: AgentCli, variant: string): boolean =>
  cli !== "claudecode" || CLAUDE_CODE_EFFORTS.includes(variant as typeof CLAUDE_CODE_EFFORTS[number]);

/**
 * Why `cli` cannot execute `variant`, or null when it can. It is exported
 * because parsing is not the last word on which CLI runs the value: recovery
 * adopts the CLI its checkpoint imposes, and that one may reject a variant the
 * command's `--cli` accepted (issue #253). One definition keeps both rejections
 * naming the same CLI, value, and accepted set.
 */
export function variantRejection(cli: AgentCli, variant: string): string | null {
  if (isValidVariant(cli, variant)) return null;
  return `--variant ${variant} no es un esfuerzo de ${cli} (usa ${CLAUDE_CODE_EFFORTS.join(", ")})`;
}

/**
 * `--variant` is the effort of the selected CLI, and Claude Code accepts a fixed
 * set of them, so an unusable value is an argument error rather than a session
 * that opens and dies. OpenCode variants stay free-form.
 */
function readVariant(cli: AgentCli, variant: string): string {
  const rejection = variantRejection(cli, variant);
  if (rejection) throw new Error(rejection);
  return variant;
}

const flagSupplied = (rawArgs: string[], flag: string): boolean =>
  rawArgs.some((arg) => arg === flag || arg.startsWith(`${flag}=`));

const sameRung = (a: FallbackRung, b: FallbackRung): boolean =>
  a.cli === b.cli && a.model === b.model && a.variant === b.variant;

/**
 * `--fallback <cli>:<modelo>:<variante>`. Malformed shape, an unknown CLI, a
 * missing binary, or a variant Claude Code does not accept are all argument
 * errors that name the exact rung, so a typo is caught before the primary
 * ever spends usage (issue #236).
 */
function parseFallbackRung(entry: unknown, binaryPresent: BinaryProbe): FallbackRung {
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error("--fallback requiere <cli>:<modelo>:<variante>");
  }
  const parts = entry.split(":");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error(`--fallback ${entry} no tiene la forma <cli>:<modelo>:<variante>`);
  }
  const [cliText, model, variant] = parts as [string, string, string];
  if (!isAgentCli(cliText)) {
    throw new Error(`--fallback ${entry} nombra un CLI desconocido: ${cliText} (usa ${AGENT_CLIS.join("|")})`);
  }
  const binary = AGENT_CLI_BINARIES[cliText];
  if (!binaryPresent(binary)) {
    throw new Error(`--fallback ${entry} requiere el binario ${binary} en el PATH`);
  }
  const rejection = variantRejection(cliText, variant);
  if (rejection) throw new Error(`--fallback ${entry}: ${rejection}`);
  return { cli: cliText, model, variant };
}

/**
 * The resolved chain always starts at `primary`; a declared rung identical to
 * the primary, or repeated among the declared ones, leaves the chain with a
 * useless step and fails at parse time instead of silently deduping.
 */
function parseFallbackChain(value: unknown, primary: FallbackRung, binaryPresent: BinaryProbe): FallbackRung[] {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const chain: FallbackRung[] = [];
  for (const raw of entries) {
    const rung = parseFallbackRung(raw, binaryPresent);
    if (sameRung(rung, primary) || chain.some((existing) => sameRung(existing, rung))) {
      throw new Error(`--fallback ${raw} repite un escalon ya declarado (${rung.cli}:${rung.model}:${rung.variant})`);
    }
    chain.push(rung);
  }
  return chain;
}

/** `--field <referenceName>=<value>`; the value may contain `=`. */
function parseFields(value: unknown): Array<{ referenceName: string; value: string }> {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return entries.map((entry) => {
    if (typeof entry !== "string") throw new Error("--field requiere <referenceName>=<valor>");
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error(`--field ${entry} no tiene la forma <referenceName>=<valor>`);
    return { referenceName: entry.slice(0, separator), value: entry.slice(separator + 1) };
  });
}

function readOptions(command: string, argv: unknown, rawArgs: string[], binaryPresent: BinaryProbe): CliOptions {
  const parsed = argv as Record<string, unknown>;
  const asNumber = (key: string): number | null => {
    const value = parsed[key];
    return typeof value === "number" ? value : null;
  };
  const asString = (key: string): string | null => {
    const value = parsed[key];
    return typeof value === "string" ? value : null;
  };

  const cli = readAgentCli(parsed, rawArgs, binaryPresent);
  const model = asString("model") ?? DEFAULT_MODEL;
  const variant = readVariant(cli, asString("variant") ?? DEFAULT_VARIANT);
  const waitSeconds = asNumber("fallback-wait") ?? DEFAULT_FALLBACK_WAIT_SECONDS;
  const waitMaxSeconds = asNumber("fallback-wait-max") ?? DEFAULT_FALLBACK_WAIT_MAX_SECONDS;
  // A bound below one interval would fail closed before ever retrying the primary,
  // which is a declared policy that cannot do what it says.
  if (waitMaxSeconds < waitSeconds) {
    throw new Error(`--fallback-wait-max ${waitMaxSeconds} no puede ser menor que --fallback-wait ${waitSeconds}`);
  }

  return {
    command,
    cli,
    model,
    variant,
    hasCli: flagSupplied(rawArgs, "--cli"),
    hasModel: flagSupplied(rawArgs, "--model"),
    hasVariant: flagSupplied(rawArgs, "--variant"),
    fallbackChain: parseFallbackChain(parsed["fallback"], { cli, model, variant }, binaryPresent),
    fallbackWaitSeconds: waitSeconds,
    fallbackWaitMaxSeconds: waitMaxSeconds,
    session: asString("session"),
    prompt: asString("prompt") ?? DEFAULT_PROMPT,
    hu: asNumber("hu"),
    issue: asNumber("issue"),
    branch: asString("branch"),
    baseBranch: asString("base-branch"),
    ticket: asNumber("ticket"),
    pullRequest: asNumber("pr"),
    commit: asString("commit"),
    manifest: asString("manifest"),
    file: asString("file") ?? asString("evidence-file"),
    descriptionFile: asString("description-file"),
    state: asString("state"),
    expectedState: asString("expected-state"),
    environment: asString("environment"),
    realEffort: asNumber("real-effort") ?? 0,
    realEffortHours: asNumber("real-effort-hh") ?? 0,
    expectedRevision: asNumber("expected-rev") ?? 0,
    hasRealEffort: parsed["real-effort"] !== undefined,
    hasRealEffortHours: parsed["real-effort-hh"] !== undefined,
    hasExpectedRevision: parsed["expected-rev"] !== undefined,
    evidenceKind: (parsed["kind"] as EvidenceKind | null | undefined) ?? (parsed["evidence-kind"] as EvidenceKind | null | undefined) ?? null,
    type: asString("type"),
    title: asString("title"),
    estimate: asNumber("estimate"),
    assignee: asString("assignee"),
    fields: parseFields(parsed["field"]),
    parent: asNumber("parent"),
    child: asNumber("child"),
    blocker: asNumber("blocker"),
    blocked: asNumber("blocked"),
    numberOfQuestions: asNumber("number-of-questions") ?? DEFAULT_NUMBER_OF_QUESTIONS,
    interview: readInterview(parsed, rawArgs, asString, asNumber),
    normasSag: parsed["normas-sag"] === true,
    workingDirectory: asString("working-directory") ?? process.cwd(),
    // `--verbose-output` is strictly wider than `--verbose`, so it turns the
    // narrower one on rather than standing beside it as a third mode.
    verbose: parsed["verbose"] === true || parsed["verbose-output"] === true,
    verboseOutput: parsed["verbose-output"] === true,
    quiet: parsed["quiet"] === true,
    noColor: parsed["color"] === false,
  };
}

/**
 * The interview a run declares. A sub-flag that only one channel reads is an
 * argument error when another channel is selected: a setting that will never be
 * consulted is a typo, and catching it here costs nothing, where catching it
 * later costs a session.
 */
function readInterview(
  parsed: Record<string, unknown>,
  rawArgs: string[],
  asString: (key: string) => string | null,
  asNumber: (key: string) => number | null,
): InterviewSettings {
  const channel = ((parsed["interview"] as InterviewChannelKind | undefined) ?? DEFAULT_INTERVIEW_CHANNEL);
  const directory = asString("interview-dir");

  const supplied = (flag: string) => flagSupplied(rawArgs, flag);
  if (channel === "off") {
    const declared = ["--interview-timeout", "--interview-rounds", "--interview-host", "--interview-port", "--interview-dir"]
      .filter(supplied);
    if (declared.length > 0) {
      throw new Error(`${declared.join(", ")} requiere --interview con un canal; sin entrevista no hay ronda que acotar`);
    }
  }
  if (channel !== "http" && (supplied("--interview-host") || supplied("--interview-port"))) {
    throw new Error(`--interview-host y --interview-port solo aplican a --interview http (recibido: ${channel})`);
  }
  if (channel !== "file" && supplied("--interview-dir")) {
    throw new Error(`--interview-dir solo aplica a --interview file (recibido: ${channel})`);
  }
  if (channel === "file" && !directory) {
    throw new Error("--interview file requiere --interview-dir <ruta>");
  }

  return {
    channel,
    host: asString("interview-host") ?? DEFAULT_INTERVIEW_HOST,
    port: asNumber("interview-port") ?? DEFAULT_INTERVIEW_PORT,
    directory,
    timeoutSeconds: asNumber("interview-timeout") ?? DEFAULT_INTERVIEW_TIMEOUT_SECONDS,
    rounds: asNumber("interview-rounds") ?? DEFAULT_INTERVIEW_ROUNDS,
  };
}

function renderHelp(parser: YargsInstance): string {
  let autoHelp = "";
  parser.showHelp((text) => { autoHelp = text; });
  return [
    COMMAND_FORMS.join("\n"),
    "",
    autoHelp.trimEnd(),
    "",
    "Notas:",
    "  code: --base-branch solo es obligatorio al crear hu/<HU> por primera vez",
    "  code: --working-directory CSV acepta --hu para preparar la topología multi-repositorio Azure",
    "  Azure ticket delivery run: el coordinador posee la entrega; OpenCode solo implementa, valida, revisa, commitea y genera el manifest",
    "  infra-sag: verifica prerequisitos sin provisionar y publica hallazgos en el tracker del alcance",
    "  architecture-review-sag: revisa arquitectura sin mutar codigo; publica hallazgos en el tracker del alcance",
    "  deploy-sag: descubre una ruta unica autenticada, ejecuta DEV/TEST/QA y verifica el resultado; PROD siempre esta prohibido",
    "  herramientas deterministas: no abren sesion, imprimen su resultado como JSON y son las mismas que usa el workflow",
    "  --verbose-output: implica --verbose y agrega la entrada y salida completas de cada herramienta mas el evento crudo del agente",
  ].join("\n");
}

const COMMAND_FORMS = [
  "Formas de invocacion:",
  "  lazy-workflow plan [options]",
  "  lazy-workflow plan --hu <id> [options]",
  "  lazy-workflow code [options]",
  "  lazy-workflow code --hu <id> [options]",
  "  lazy-workflow code --hu <id> --working-directory <repo1,repo2,...> [--base-branch <name>]",
  "  lazy-workflow code --session <id> --prompt continue",
  "  lazy-workflow infra-sag --hu <id> [options]",
  "  lazy-workflow infra-sag --issue <id> [options]",
  "  lazy-workflow architecture-review-sag --hu <id> [options]",
  "  lazy-workflow architecture-review-sag --issue <id> [options]",
  "  lazy-workflow deploy-sag --hu <id> [options]",
  "  lazy-workflow deploy-sag --issue <id> [options]",
  "  lazy-workflow hu-info --hu <id>",
  "  lazy-workflow hu-branch-info --hu <id>",
  "  lazy-workflow hu-branch-set --hu <id> --branch <name> [--base-branch <name>] --working-directory <path>",
  "  lazy-workflow ticket-info --hu <id> --ticket <id>",
  "  lazy-workflow ticket-{description,state,effort,attachment,evidence}-info --ticket <id>",
  "  lazy-workflow ticket-{branch,pr,completion}-info --hu <id> --ticket <id>",
  "  lazy-workflow ticket-branch-set --hu <id> --ticket <id> --branch <name> --working-directory <path>",
  "  lazy-workflow ticket-pr-link --hu <id> --ticket <id> --pr <id>",
  "  lazy-workflow ticket-commit-link --ticket <id> --pr <id>",
  "  lazy-workflow ticket-description-set --ticket <id> --description-file <path>",
  "  lazy-workflow ticket-state-set --ticket <id> --state <state> --expected-state <state>",
  "  lazy-workflow ticket-effort-set --ticket <id> --real-effort <hours> --real-effort-hh <hours> --expected-rev <rev>",
  "  lazy-workflow ticket-attachment-add --ticket <id> --file <path> --kind <http-json|screen|command-output>",
  "  lazy-workflow ticket-evidence-set --ticket <id> --evidence-file <path>",
  "  lazy-workflow ticket-completion-apply --hu <id> --ticket <id> --pr <id> --manifest <path>",
  "  lazy-workflow ticket-create --hu <id> --type <Task|Bug> --title <titulo> --description-file <path> [--estimate <hours>] [--assignee <identity>] [--field <referenceName>=<valor>]",
  "  lazy-workflow ticket-link-parent --parent <id> --child <id>",
  "  lazy-workflow ticket-link-predecessor --blocker <id> --blocked <id>",
  "",
  "Herramientas deterministas (sin sesion):",
  ...DETERMINISTIC_TOOL_FORMS,
];
