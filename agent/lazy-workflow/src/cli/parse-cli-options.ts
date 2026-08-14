import yargs from "yargs";
import type { Argv } from "yargs";
import type { EvidenceKind } from "../azure/ticket-info-service.ts";

export interface CliOptions {
  command: string;
  model: string;
  variant: string;
  hasModel: boolean;
  hasVariant: boolean;
  session: string | null;
  prompt: string;
  hu: number | null;
  issue: number | null;
  branch: string | null;
  baseBranch: string | null;
  ticket: number | null;
  pullRequest: number | null;
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
  numberOfQuestions: number;
  normasSag: boolean;
  workingDirectory: string;
  verbose: boolean;
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

const DEFAULT_MODEL = "opencode-go/deepseek-v4-pro";
const DEFAULT_VARIANT = "high";
const DEFAULT_PROMPT = "Follow the authoritative workflow and context.";
const DEFAULT_NUMBER_OF_QUESTIONS = 5;
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

export function buildCli(): CliParser {
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

    return { kind: "options", options: readOptions(command, argv, rawArgs.slice(1)) };
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
    .group(["session", "model", "variant", "prompt"], "OpenCode:")
    .group(["branch", "base-branch", "ticket", "pr", "manifest"], "Tickets Azure:")
    .group(["file", "description-file", "state", "expected-state"], "Tickets Azure (mutaciones):")
    .group(["real-effort", "real-effort-hh", "expected-rev", "kind", "number-of-questions"], "Tickets Azure (datos):")
    .group(["normas-sag", "working-directory"], "Contexto:")
    .group(["verbose", "quiet", "color"], "Reportador:")
    .option("hu", positiveIntegerOption("hu", "--hu", "Identificador de HU para el flujo Azure; omitir usa GitHub."))
    .option("issue", positiveIntegerOption("issue", "--issue", "Issue explicito para workflows SAG."))
    .option("session", stringOption("session", "--session", "Sesion OpenCode opaca para reanudar."))
    .option("model", { type: "string", requiresArg: true, default: DEFAULT_MODEL, describe: "Modelo de OpenCode.", coerce: stringCoerce("--model") })
    .option("variant", { type: "string", requiresArg: true, default: DEFAULT_VARIANT, describe: "Variante del modelo.", coerce: stringCoerce("--variant") })
    .option("prompt", { type: "string", requiresArg: true, default: DEFAULT_PROMPT, describe: "Prompt explicito para OpenCode.", coerce: stringCoerce("--prompt") })
    .option("branch", stringOption("branch", "--branch", "Rama del repositorio (solo Azure)."))
    .option("base-branch", stringOption("base-branch", "--base-branch", "Rama base remota para crear la rama HU (solo Azure)."))
    .option("ticket", positiveIntegerOption("ticket", "--ticket", "Identificador del ticket Azure."))
    .option("pr", positiveIntegerOption("pr", "--pr", "Identificador del pull request."))
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
    .option("normas-sag", { type: "boolean", default: false, describe: "Carga las normas SAG del modulo remoto." })
    .option("working-directory", { type: "string", requiresArg: true, default: process.cwd(), describe: "Directorio de trabajo del repositorio objetivo.", coerce: stringCoerce("--working-directory") })
    .option("verbose", { type: "boolean", default: false, describe: "Emite el stream completo de eventos." })
    .option("quiet", { type: "boolean", default: false, describe: "Solo emite errores." })
    .option("color", { type: "boolean", default: true, describe: "Habilita codigos ANSI en la salida.", hidden: true })
    .parserConfiguration({ "camel-case-expansion": false, "boolean-negation": true });
}

function readOptions(command: string, argv: unknown, rawArgs: string[]): CliOptions {
  const parsed = argv as Record<string, unknown>;
  const asNumber = (key: string): number | null => {
    const value = parsed[key];
    return typeof value === "number" ? value : null;
  };
  const asString = (key: string): string | null => {
    const value = parsed[key];
    return typeof value === "string" ? value : null;
  };

  return {
    command,
    model: asString("model") ?? DEFAULT_MODEL,
    variant: asString("variant") ?? DEFAULT_VARIANT,
    hasModel: rawArgs.some((arg) => arg === "--model" || arg.startsWith("--model=")),
    hasVariant: rawArgs.some((arg) => arg === "--variant" || arg.startsWith("--variant=")),
    session: asString("session"),
    prompt: asString("prompt") ?? DEFAULT_PROMPT,
    hu: asNumber("hu"),
    issue: asNumber("issue"),
    branch: asString("branch"),
    baseBranch: asString("base-branch"),
    ticket: asNumber("ticket"),
    pullRequest: asNumber("pr"),
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
    numberOfQuestions: asNumber("number-of-questions") ?? DEFAULT_NUMBER_OF_QUESTIONS,
    normasSag: parsed["normas-sag"] === true,
    workingDirectory: asString("working-directory") ?? process.cwd(),
    verbose: parsed["verbose"] === true,
    quiet: parsed["quiet"] === true,
    noColor: parsed["color"] === false,
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
];
