/**
 * The CLI described as data: every command it accepts, the flags each one
 * takes, what kind of value every flag expects, and what running it changes.
 *
 * `lz catalog` prints this document so a front end — the desktop GUI in
 * `gui/`, a skill composing a command — renders the CLI the installed binary
 * actually is instead of a copy that drifts from it. Nothing here parses or
 * validates a run: the parser in `parse-cli-options.ts` stays the only
 * authority, and `test/command-catalog.test.ts` pins this description to it
 * (every supported command is described, every flag is one the parser accepts,
 * and every command built from its required flags parses).
 */

import { AGENT_CLI_PROFILES, DEFAULT_CLI, type AgentCli } from "../coding-agent/agent-cli.ts";
import {
  COMMAND_CATALOG_SCHEMA_VERSION,
  type CatalogCommand,
  type CatalogFamily,
  type CatalogFlag,
  type CatalogFlagGroup,
  type CatalogFlagGroupId,
  type CatalogEnvironmentVariable,
  type CommandCatalog,
} from "./command-catalog-schema.ts";
import { DEFAULT_IDLE_TIMEOUT_MINUTES } from "../coding-agent/idle-watchdog.ts";
import { INTERVIEW_CHANNELS } from "../interaction/question-channel.ts";
import { AZURE_ORGANIZATION_ENV } from "../azure/azure-organization.ts";
import { SAG_NORMS_REPOSITORY_ENV } from "../sag/sag-norms-service.ts";
import {
  DEFAULT_FALLBACK_WAIT_MAX_SECONDS,
  DEFAULT_FALLBACK_WAIT_SECONDS,
  DEFAULT_INTERVIEW_CHANNEL,
  DEFAULT_INTERVIEW_HOST,
  DEFAULT_INTERVIEW_PORT,
  DEFAULT_INTERVIEW_ROUNDS,
  DEFAULT_INTERVIEW_TIMEOUT_SECONDS,
  DEFAULT_NUMBER_OF_QUESTIONS,
  DEFAULT_OFF_DELAY_SECONDS,
  DEFAULT_PROMPT,
  DEFAULT_VARIANT,
  OFF_PASSWORD_ENV,
} from "./parse-cli-options.ts";

export * from "./command-catalog-schema.ts";

const FAMILIES: readonly CatalogFamily[] = [
  { id: "workflow", title: "Flujos de trabajo", description: "Planifican o entregan trabajo abriendo sesiones del agente de codificacion." },
  { id: "azure-read", title: "Azure DevOps · lectura", description: "Leen HU, tickets, ramas y gates sin abrir sesion." },
  { id: "azure-write", title: "Azure DevOps · escritura", description: "Modifican work items, ramas y evidencia con escrituras optimistas." },
  { id: "github-queue", title: "GitHub · cola", description: "Identidad, repositorio, elegibilidad y reclamo de issues." },
  { id: "github-delivery", title: "GitHub · entrega", description: "Los pasos del coordinador, para reparar una entrega a medias." },
  { id: "git", title: "Git", description: "Listar, cambiar y borrar ramas del repositorio." },
  { id: "pull-request", title: "Pull requests", description: "PR del tracker que nombra origin: GitHub o Azure DevOps." },
  { id: "credentials", title: "Credenciales", description: "Secretos en ~/.config/secrets/*.env, con chezmoi si lo administra." },
  { id: "maintenance", title: "Mantenimiento", description: "Reinstalar la herramienta y describir el propio CLI." },
];

// ---------------------------------------------------------------------------
// Flags, written once and reused by every command that takes them.
// ---------------------------------------------------------------------------

const required = (flag: CatalogFlag): CatalogFlag => ({ ...flag, required: true });

const HU: CatalogFlag = { flag: "--hu", kind: "integer", label: "HU", description: "User Story de Azure DevOps.", placeholder: "23438" };
const TICKET: CatalogFlag = { flag: "--ticket", kind: "integer", label: "Ticket", description: "Task o Bug de Azure DevOps.", placeholder: "23459" };
const ISSUE: CatalogFlag = { flag: "--issue", kind: "integer", label: "Issue", description: "Issue de GitHub.", placeholder: "263" };
const PR: CatalogFlag = { flag: "--pr", kind: "integer", label: "Pull request", description: "Numero del pull request.", placeholder: "271" };
const BRANCH: CatalogFlag = { flag: "--branch", kind: "string", label: "Rama", description: "Nombre corto (issue/201) o ref completo (refs/heads/issue/201).", placeholder: "issue/263" };
const BASE_BRANCH: CatalogFlag = { flag: "--base-branch", kind: "string", label: "Rama base", description: "Rama base remota.", placeholder: "main" };
const COMMIT: CatalogFlag = { flag: "--commit", kind: "commit", label: "Commit", description: "Nombre de objeto completo (40 o 64 hex); una abreviatura falla la comparacion con el ref.", placeholder: "0123abcd… (completo)" };
const WORKING_DIRECTORY: CatalogFlag = { flag: "--working-directory", kind: "directory", label: "Repositorio", description: "Raiz Git del repositorio objetivo." };
const DESCRIPTION_FILE: CatalogFlag = { flag: "--description-file", kind: "file", label: "Archivo de descripcion", description: "Archivo con la descripcion (HTML en Azure, Markdown en PR)." };
const STATE: CatalogFlag = { flag: "--state", kind: "string", label: "Estado destino", description: "Estado al que transiciona el work item.", placeholder: "En progreso" };
const EXPECTED_STATE: CatalogFlag = { flag: "--expected-state", kind: "string", label: "Estado esperado", description: "Estado actual esperado; si cambio por debajo, la escritura falla.", placeholder: "Nuevo" };
const EXPECTED_REV: CatalogFlag = { flag: "--expected-rev", kind: "integer", label: "Revision esperada", description: "Revision con la que se leyo el work item.", placeholder: "9" };
const NAME: CatalogFlag = { flag: "--name", kind: "string", label: "Credencial", description: "Nombre de la variable, en mayusculas.", placeholder: "OPENAI_API_KEY" };
const SERVICE: CatalogFlag = { flag: "--service", kind: "string", label: "Servicio", description: "Archivo <servicio>.env que la recibe; sin el, el que ya la declara u other.env.", placeholder: "openai" };

/** `plan` and `code` default to the current directory, but a front end has no meaningful one: it always names the repository. */
const WORKSPACE: CatalogFlag = {
  flag: "--working-directory",
  kind: "directories",
  label: "Repositorios",
  description: "Una raiz Git, o varias separadas por coma: el orden declarado es el orden de entrega.",
  required: true,
};

const AGENT_FLAGS: readonly CatalogFlag[] = [
  { flag: "--cli", kind: "choice", label: "Agente", description: "CLI que ejecuta la sesion; debe estar instalado y autenticado.", choices: Object.keys(AGENT_CLI_PROFILES), default: DEFAULT_CLI },
  { flag: "--model", kind: "string", label: "Modelo", description: "Sin declarar usa el default del agente seleccionado." },
  { flag: "--variant", kind: "string", label: "Variante / esfuerzo", description: "Claude Code y Codex aceptan un conjunto fijo; OpenCode es libre.", default: DEFAULT_VARIANT },
  { flag: "--fallback", kind: "string", label: "Respaldo", description: "Escalon <cli>:<modelo>:<variante>; el orden es la prioridad de descenso.", repeatable: true, placeholder: "codex:gpt-5.6-sol:high" },
  { flag: "--fallback-wait", kind: "integer", label: "Espera entre reintentos (s)", description: "Con la cadena agotada, segundos entre reintentos del escalon primario.", default: DEFAULT_FALLBACK_WAIT_SECONDS },
  { flag: "--fallback-wait-max", kind: "integer", label: "Tope de espera (s)", description: "Tope total del ciclo de espera; no puede ser menor que --fallback-wait.", default: DEFAULT_FALLBACK_WAIT_MAX_SECONDS },
  { flag: "--idle-timeout", kind: "integer", label: "Inactividad maxima (min)", description: "Minutos de silencio antes de terminar la sesion y descender al escalon siguiente.", default: DEFAULT_IDLE_TIMEOUT_MINUTES },
];

const INTERVIEW_FLAGS: readonly CatalogFlag[] = [
  { flag: "--interview", kind: "choice", label: "Entrevista", description: "off: la sesion toma sus recomendaciones; http: el operador responde en una pagina local.", choices: INTERVIEW_CHANNELS, default: DEFAULT_INTERVIEW_CHANNEL },
  { flag: "--interview-timeout", kind: "integer", label: "Tiempo por ronda (s)", description: "Agotado, se toman las respuestas recomendadas y el run sigue.", default: DEFAULT_INTERVIEW_TIMEOUT_SECONDS, requires: ["--interview=http"] },
  { flag: "--interview-rounds", kind: "integer", label: "Rondas maximas", description: "La ultima ronda exige el plan final.", default: DEFAULT_INTERVIEW_ROUNDS, requires: ["--interview=http"] },
  { flag: "--interview-host", kind: "string", label: "Host", description: "Fuera de loopback la URL con su token es la unica credencial.", default: DEFAULT_INTERVIEW_HOST, requires: ["--interview=http"] },
  { flag: "--interview-port", kind: "integer", label: "Puerto", description: "0 pide uno libre al sistema.", default: DEFAULT_INTERVIEW_PORT, requires: ["--interview=http"] },
];

const REPORTER_FLAGS: readonly CatalogFlag[] = [
  { flag: "--verbose", kind: "boolean", label: "Detallado", description: "Emite el stream completo de eventos.", conflicts: ["--quiet"] },
  { flag: "--verbose-output", kind: "boolean", label: "Salida completa", description: "Implica --verbose y agrega entradas y salidas completas de cada herramienta.", conflicts: ["--quiet"] },
  { flag: "--quiet", kind: "boolean", label: "Silencioso", description: "Solo emite errores.", conflicts: ["--verbose", "--verbose-output", "--interview=http"] },
  { flag: "--no-color", kind: "boolean", label: "Sin color", description: "Deshabilita los codigos ANSI; NO_COLOR=1 tiene el mismo efecto." },
  { flag: "--log-file", kind: "file", label: "Run log", description: "Ruta del run log JSON Lines; precede a LAZY_WORKFLOW_LOG_FILE y al default.", conflicts: ["--no-log-file"] },
  { flag: "--no-log-file", kind: "boolean", label: "Sin run log", description: "Deshabilita el run log de este run.", conflicts: ["--log-file"] },
];

const SHUTDOWN_FLAGS: readonly CatalogFlag[] = [
  { flag: "--off", kind: "secret", label: "Apagar al terminar", description: `Apaga el equipo cuando el run termina; sin valor toma ${OFF_PASSWORD_ENV} o un sudo sin contrasena. Windows no usa contrasena.`, valueOptional: true },
  { flag: "--off-delay", kind: "integer", label: "Gracia antes de apagar (s)", description: "Ctrl-C dentro de la gracia cancela el apagado; 0 apaga de inmediato.", default: DEFAULT_OFF_DELAY_SECONDS, requires: ["--off"] },
];

const GROUPS: readonly CatalogFlagGroup[] = [
  { id: "agent", title: "Agente de codificacion", flags: AGENT_FLAGS },
  { id: "interview", title: "Entrevista de planificacion", flags: INTERVIEW_FLAGS },
  { id: "reporter", title: "Reportador", flags: REPORTER_FLAGS },
  { id: "shutdown", title: "Apagado del equipo", flags: SHUTDOWN_FLAGS },
];

/** The installer's own options, which `update` forwards untouched. */
const INSTALLER_FLAGS: readonly CatalogFlag[] = [
  { flag: "--all-global", kind: "boolean", label: "Todo global", description: "Skills, agentes y CLI globales (default de update).", forwarded: true },
  { flag: "--claude-global", kind: "boolean", label: "Claude global", description: "Skills, agentes y CLI globales de Claude Code.", forwarded: true },
  { flag: "--claude-local", kind: "boolean", label: "Claude local", description: "Skills, agentes y CLI del proyecto para Claude Code.", forwarded: true },
  { flag: "--global", kind: "boolean", label: "Compartido global", description: "Skills y agentes compartidos globales.", forwarded: true },
  { flag: "--local", kind: "boolean", label: "Compartido local", description: "Skills y agentes compartidos del proyecto.", forwarded: true },
  { flag: "--opencode", kind: "boolean", label: "OpenCode local", description: "Skills y agentes OpenCode del proyecto.", forwarded: true },
  { flag: "--both", kind: "boolean", label: "Compartido y OpenCode", description: "Entradas compartidas y OpenCode del proyecto.", forwarded: true },
  { flag: "--codex", kind: "boolean", label: "Codex", description: "Skills globales de Codex en ~/.codex/skills.", forwarded: true },
  { flag: "--target", kind: "directory", label: "Destino", description: "Directorio de los modos locales.", forwarded: true },
  { flag: "--ref", kind: "string", label: "Ref", description: "Rama o tag del repositorio a instalar.", forwarded: true },
  { flag: "--dry-run", kind: "boolean", label: "Simulacion", description: "Muestra lo que haria sin cambiar nada.", forwarded: true },
  { flag: "--no-gui", kind: "boolean", label: "Omitir GUI", description: "No compila ni instala la GUI.", forwarded: true },
  { flag: "--force", kind: "boolean", label: "Forzar", description: "Reemplaza entradas existentes.", forwarded: true },
  { flag: "--uninstall", kind: "boolean", label: "Desinstalar", description: "Retira lo instalado por el modo elegido.", forwarded: true },
];

// ---------------------------------------------------------------------------
// Commands, grouped as `--help` lists them.
// ---------------------------------------------------------------------------

const TOOL_GROUPS: readonly CatalogFlagGroupId[] = ["reporter", "shutdown"];

type CommandInput = Omit<CatalogCommand, "groups" | "output"> & Partial<Pick<CatalogCommand, "groups" | "output">>;

const tool = (command: CommandInput): CatalogCommand => ({ output: "json", groups: TOOL_GROUPS, ...command });

const WORKFLOW_COMMANDS: readonly CatalogCommand[] = [
  {
    name: "plan",
    family: "workflow",
    summary: "Planifica el trabajo pedido y publica sus issues GitHub o work items Azure con sus dependencias.",
    effect: "session",
    output: "stream",
    groups: ["agent", "interview", "reporter", "shutdown"],
    flags: [
      WORKSPACE,
      { ...HU, description: "Rebana esa HU de Azure; sin ella el plan publica issues GitHub." },
      { flag: "--prompt", kind: "text", label: "Prompt", description: "Lo que hay que planificar; complementa el workflow, no lo reemplaza.", default: DEFAULT_PROMPT },
      { flag: "--number-of-questions", kind: "integer", label: "Preguntas", description: "Presupuesto de preguntas aclaratorias de toda la entrevista.", default: DEFAULT_NUMBER_OF_QUESTIONS },
      { flag: "--normas-sag", kind: "boolean", label: "Normas SAG", description: `Carga las normas del componente de .sag/config.json; requiere ${SAG_NORMS_REPOSITORY_ENV}.` },
    ],
    notes: ["Un plan y una entrega son runs distintos: revisa lo publicado antes de ejecutar code."],
  },
  {
    name: "code",
    family: "workflow",
    summary: "Entrega el trabajo elegible, una unidad por sesion: implementa, verifica, empuja, mergea y cierra.",
    effect: "session",
    output: "stream",
    groups: ["agent", "reporter", "shutdown"],
    flags: [
      WORKSPACE,
      { ...HU, description: "Drena los Task y Bug hijos de esa HU; sin ella drena issues GitHub ready-for-agent." },
      { ...TICKET, description: "Fija una unica unidad de entrega de la HU.", requires: ["--hu"] },
      { ...BASE_BRANCH, description: "Solo al crear hu/<HU> por primera vez; sin ella master o main.", requires: ["--hu"] },
      { flag: "--session", kind: "string", label: "Sesion", description: "Reanuda esa sesion preservada; las identidades vienen del checkpoint.", placeholder: "SESSION_ID" },
      { flag: "--prompt", kind: "text", label: "Prompt", description: "Instrucciones adicionales; con --session usa continue.", default: DEFAULT_PROMPT },
      { flag: "--normas-sag", kind: "boolean", label: "Normas SAG", description: `Carga las normas de codificacion; requiere ${SAG_NORMS_REPOSITORY_ENV}.` },
    ],
    notes: [
      "Una entrega detenida despues de verificar la sesion se reanuda repitiendo el comando original.",
      "--off apaga el equipo tambien despues de un run fallido, salvo errores de argumentos.",
    ],
  },
];

const AZURE_READ_COMMANDS: readonly CatalogCommand[] = [
  tool({ name: "hu-info", family: "azure-read", summary: "Lee los detalles de la User Story.", effect: "read", flags: [required(HU)] }),
  tool({ name: "hu-children-info", family: "azure-read", summary: "Lista los work items hijos directos de la HU.", effect: "read", flags: [required(HU)] }),
  tool({ name: "hu-branch-info", family: "azure-read", summary: "Lee la rama de integracion vinculada; null significa que el primer code la crea.", effect: "read", flags: [required(HU)] }),
  tool({ name: "ticket-info", family: "azure-read", summary: "Todo lo conocido del ticket: HU, ramas, PR, evidencia y gates.", effect: "read", flags: [required(HU), required(TICKET)] }),
  tool({ name: "ticket-type-info", family: "azure-read", summary: "Lee y valida que el ticket sea Task o Bug.", effect: "read", flags: [required(TICKET)] }),
  tool({ name: "ticket-description-info", family: "azure-read", summary: "Lee la descripcion del ticket.", effect: "read", flags: [required(TICKET)] }),
  tool({ name: "ticket-state-info", family: "azure-read", summary: "Lee el estado del ticket.", effect: "read", flags: [required(TICKET)] }),
  tool({ name: "ticket-effort-info", family: "azure-read", summary: "Lee los campos de esfuerzo y la revision.", effect: "read", flags: [required(TICKET)] }),
  tool({ name: "ticket-branch-info", family: "azure-read", summary: "Lee la rama vinculada del ticket en el contexto de su HU.", effect: "read", flags: [required(HU), required(TICKET)] }),
  tool({ name: "ticket-pr-info", family: "azure-read", summary: "Lee los pull requests del ticket en el contexto de su HU.", effect: "read", flags: [required(HU), required(TICKET)] }),
  tool({ name: "ticket-completion-info", family: "azure-read", summary: "Explica que gates de completitud faltan para Done.", effect: "read", flags: [required(HU), required(TICKET)] }),
];

const AZURE_WRITE_COMMANDS: readonly CatalogCommand[] = [
  tool({ name: "hu-state-set", family: "azure-write", summary: "Cambia el estado de la HU verificando estado y revision esperados.", effect: "write", flags: [required(HU), required(STATE), required(EXPECTED_STATE), required(EXPECTED_REV)] }),
  tool({ name: "hu-branch-set", family: "azure-write", summary: "Vincula una rama de integracion; con base la crea desde ese commit remoto.", effect: "write", flags: [required(HU), required(BRANCH), { ...BASE_BRANCH, description: "Crea la rama desde esta base remota y la publica primero." }, required(WORKING_DIRECTORY)] }),
  tool({ name: "hu-branch-ensure", family: "azure-write", summary: "Asegura que la HU tenga hu/<HU>, desde la base o desde master/main.", effect: "write", flags: [required(HU), BASE_BRANCH, required(WORKING_DIRECTORY)] }),
  tool({
    name: "ticket-create",
    family: "azure-write",
    summary: "Crea un Task o Bug bajo la HU.",
    effect: "write",
    flags: [
      required(HU),
      required({ flag: "--type", kind: "choice", label: "Tipo", description: "Tipo del work item de entrega.", choices: ["Task", "Bug"] }),
      required({ flag: "--title", kind: "string", label: "Titulo", description: "Titulo exacto del ticket." }),
      required({ ...DESCRIPTION_FILE, description: "Archivo HTML con la descripcion." }),
      { flag: "--estimate", kind: "number", label: "Estimacion (h)", description: "Estimacion original en horas." },
      { flag: "--assignee", kind: "string", label: "Asignado", description: "Identidad Azure asignada." },
      { flag: "--field", kind: "string", label: "Campo", description: "<referenceName>=<valor>; nombres de referencia, nunca etiquetas.", repeatable: true, placeholder: "Custom.Area=Pagos" },
    ],
  }),
  tool({ name: "ticket-link-parent", family: "azure-write", summary: "Vincula un work item hijo a su padre.", effect: "write", flags: [required({ flag: "--parent", kind: "integer", label: "Padre", description: "Work item padre." }), required({ flag: "--child", kind: "integer", label: "Hijo", description: "Work item hijo." })] }),
  tool({ name: "ticket-link-predecessor", family: "azure-write", summary: "Agrega una dependencia bloqueante entre work items.", effect: "write", flags: [required({ flag: "--blocker", kind: "integer", label: "Bloqueante", description: "Work item que bloquea." }), required({ flag: "--blocked", kind: "integer", label: "Bloqueado", description: "Work item bloqueado." })] }),
  tool({ name: "ticket-description-set", family: "azure-write", summary: "Reemplaza la descripcion desde un archivo.", effect: "write", flags: [required(TICKET), required(DESCRIPTION_FILE)] }),
  tool({ name: "ticket-state-set", family: "azure-write", summary: "Cambia el estado verificando el estado actual; Done queda reservado al coordinador.", effect: "write", flags: [required(TICKET), required(STATE), required(EXPECTED_STATE)] }),
  tool({
    name: "ticket-effort-set",
    family: "azure-write",
    summary: "Fija el esfuerzo real verificando la revision esperada.",
    effect: "write",
    flags: [
      required(TICKET),
      required({ flag: "--real-effort", kind: "number", label: "Real Effort (h)", description: "Real Effort en horas." }),
      required({ flag: "--real-effort-hh", kind: "number", label: "Real Effort HH", description: "Real Effort HH." }),
      required(EXPECTED_REV),
    ],
  }),
  tool({ name: "ticket-branch-set", family: "azure-write", summary: "Vincula una rama existente al ticket.", effect: "write", flags: [required(HU), required(TICKET), required(BRANCH), required(WORKING_DIRECTORY)] }),
  tool({ name: "ticket-branch-checkout", family: "azure-write", summary: "Cambia a la rama del ticket.", effect: "write", flags: [required(BRANCH), required(WORKING_DIRECTORY)] }),
  tool({ name: "ticket-branch-push", family: "azure-write", summary: "Empuja la rama del ticket.", effect: "write", flags: [required(BRANCH), required(WORKING_DIRECTORY)] }),
  tool({ name: "ticket-session-verify", family: "azure-write", summary: "Verifica una rama de ticket limpia y por delante de la de integracion.", effect: "read", flags: [required(BRANCH), required(BASE_BRANCH), required(WORKING_DIRECTORY)] }),
  tool({ name: "ticket-pr-create", family: "azure-write", summary: "Crea o reutiliza el PR y completa su merge en la rama de la HU.", effect: "write", flags: [required(HU), required(TICKET)] }),
  tool({ name: "ticket-pr-link", family: "azure-write", summary: "Asocia el pull request validado al ticket.", effect: "write", flags: [required(HU), required(TICKET), required(PR)] }),
  tool({ name: "ticket-commit-link", family: "azure-write", summary: "Vincula el commit de merge del PR al ticket.", effect: "write", flags: [required(TICKET), required(PR)] }),
  tool({ name: "ticket-completion-apply", family: "azure-write", summary: "Aplica evidencia y estado de completitud tras validar los gates.", effect: "write", flags: [required(HU), required(TICKET), required(PR), required({ flag: "--summary", kind: "text", label: "Resumen", description: "Resumen de la entrega, tal como lo dejo la sesion." })] }),
];

const GITHUB_QUEUE_COMMANDS: readonly CatalogCommand[] = [
  tool({ name: "github-auth-info", family: "github-queue", summary: "Comprueba la identidad autenticada en GitHub.", effect: "read", flags: [required(WORKING_DIRECTORY)] }),
  tool({ name: "github-repo-info", family: "github-queue", summary: "Valida el repositorio y lee su configuracion.", effect: "read", flags: [required(WORKING_DIRECTORY)] }),
  tool({ name: "github-issue-list", family: "github-queue", summary: "Lista las issues administradas, su elegibilidad y por que se saltan.", effect: "read", flags: [required(WORKING_DIRECTORY)] }),
  tool({ name: "github-issue-select", family: "github-queue", summary: "Encuentra la proxima issue elegible sin reclamarla.", effect: "read", flags: [required(WORKING_DIRECTORY)] }),
  tool({ name: "github-issue-info", family: "github-queue", summary: "Lee una issue y explica su elegibilidad.", effect: "read", flags: [required(ISSUE), required(WORKING_DIRECTORY)] }),
  tool({ name: "github-issue-claim", family: "github-queue", summary: "Asigna una issue elegible al usuario autenticado.", effect: "write", flags: [required(ISSUE), required(WORKING_DIRECTORY)] }),
  tool({ name: "github-issue-release", family: "github-queue", summary: "Retira el reclamo del usuario autenticado sobre una issue.", effect: "write", flags: [required(ISSUE), required(WORKING_DIRECTORY)] }),
];

const GITHUB_DELIVERY_COMMANDS: readonly CatalogCommand[] = [
  tool({ name: "github-issue-close", family: "github-delivery", summary: "Registra el PR y el commit de merge, y cierra la issue.", effect: "write", flags: [required(ISSUE), required(PR), required(COMMIT), required(WORKING_DIRECTORY)] }),
  tool({ name: "github-branch-prepare", family: "github-delivery", summary: "Prepara la rama de la issue desde la base actualizada.", effect: "write", flags: [required(ISSUE), required(WORKING_DIRECTORY)] }),
  tool({ name: "github-branch-checkout", family: "github-delivery", summary: "Cambia a una rama de entrega existente.", effect: "write", flags: [required(BRANCH), required(BASE_BRANCH), required(WORKING_DIRECTORY)] }),
  tool({ name: "github-branch-verify", family: "github-delivery", summary: "Comprueba la rama activa y su commit remoto, si existe.", effect: "read", flags: [required(BRANCH), required(BASE_BRANCH), required(WORKING_DIRECTORY)] }),
  tool({ name: "github-branch-cleanup", family: "github-delivery", summary: "Borra las ramas de entrega tras comprobar el commit esperado.", effect: "write", flags: [required(BRANCH), required(BASE_BRANCH), required(COMMIT), required(WORKING_DIRECTORY)] }),
  tool({ name: "github-session-verify", family: "github-delivery", summary: "Verifica una rama limpia con commits por delante de la base.", effect: "read", flags: [required(BRANCH), required(BASE_BRANCH), required(WORKING_DIRECTORY)] }),
  tool({ name: "github-commit-push", family: "github-delivery", summary: "Empuja el commit verificado de la rama.", effect: "write", flags: [required(BRANCH), required(COMMIT), required(WORKING_DIRECTORY)] }),
  tool({ name: "github-pr-create", family: "github-delivery", summary: "Crea o reutiliza el pull request de la issue.", effect: "write", flags: [required(ISSUE), required(BRANCH), required(BASE_BRANCH), required(COMMIT), required(WORKING_DIRECTORY)] }),
  tool({ name: "github-pr-merge", family: "github-delivery", summary: "Mergea el pull request y devuelve su commit de merge.", effect: "write", flags: [required(PR), required(ISSUE), required(BRANCH), required(BASE_BRANCH), required(COMMIT), required(WORKING_DIRECTORY)] }),
];

const GIT_COMMANDS: readonly CatalogCommand[] = [
  tool({ name: "git-branch-list", family: "git", summary: "Lista ramas locales y remotas, la mas reciente primero, con la activa aparte.", effect: "read", flags: [required(WORKING_DIRECTORY)] }),
  tool({ name: "git-branch-checkout", family: "git", summary: "Hace fetch, cambia a una rama local o remota y la adelanta sin mergear.", effect: "write", flags: [required({ ...BRANCH, description: "Un nombre tal como lo imprime git-branch-list; origin/x se rastrea como x." }), required(WORKING_DIRECTORY)] }),
  tool({ name: "git-branch-delete", family: "git", summary: "Borra la rama de entrega local y remota con verificacion.", effect: "write", flags: [required(BRANCH), required(BASE_BRANCH), COMMIT, required(WORKING_DIRECTORY)] }),
];

const PULL_REQUEST_COMMANDS: readonly CatalogCommand[] = [
  tool({ name: "pr-list", family: "pull-request", summary: "Lista los pull requests abiertos.", effect: "read", flags: [required(WORKING_DIRECTORY)] }),
  tool({ name: "pr-info", family: "pull-request", summary: "Un pull request con descripcion, estado y revisores.", effect: "read", flags: [required(PR), required(WORKING_DIRECTORY)] }),
  tool({ name: "pr-thread-list", family: "pull-request", summary: "Hilos de discusion y comentarios de codigo, con archivo y linea.", effect: "read", flags: [required(PR), required(WORKING_DIRECTORY)] }),
  tool({
    name: "pr-thread-reply",
    family: "pull-request",
    summary: "Responde un hilo del pull request.",
    effect: "write",
    flags: [
      required(PR),
      required({ flag: "--thread", kind: "string", label: "Hilo", description: "El id tal como lo imprime pr-thread-list; conversation en GitHub.", placeholder: "12" }),
      required({ flag: "--body", kind: "text", label: "Respuesta", description: "Texto que se publica." }),
      required(WORKING_DIRECTORY),
    ],
  }),
  tool({
    name: "pr-create",
    family: "pull-request",
    summary: "Abre un pull request con titulo y descripcion en linea o desde archivo.",
    effect: "write",
    flags: [
      required(BRANCH),
      required(BASE_BRANCH),
      required({ flag: "--title", kind: "string", label: "Titulo", description: "Titulo del pull request." }),
      { flag: "--description", kind: "text", label: "Descripcion", description: "En linea; Azure DevOps rechaza mas de 4000 caracteres.", conflicts: ["--description-file"] },
      { ...DESCRIPTION_FILE, conflicts: ["--description"] },
      required(WORKING_DIRECTORY),
    ],
  }),
];

const CREDENTIALS_COMMANDS: readonly CatalogCommand[] = [
  tool({ name: "credentials-audit", family: "credentials", summary: "Informa que archivos y Keychain contienen una credencial, sin su valor.", effect: "read", flags: [NAME] }),
  tool({ name: "credentials-list", family: "credentials", summary: "Imprime los nombres guardados en los archivos de secretos.", effect: "read", output: "lines", flags: [] }),
  tool({
    name: "credentials-get",
    family: "credentials",
    summary: "Imprime una credencial.",
    effect: "read",
    output: "value",
    flags: [required(NAME), { flag: "--force", kind: "boolean", label: "Permitir sin terminal", description: "Necesario cuando la salida no es una terminal: una tuberia o una GUI." }],
    notes: ["El valor queda en la salida del run: no lo compartas ni lo pegues en un chat."],
  }),
  tool({
    name: "credentials-set",
    family: "credentials",
    summary: "Guarda o rota una credencial; con chezmoi tambien publica su fuente cifrada.",
    effect: "write",
    flags: [required(NAME), SERVICE, { flag: "--stdin", kind: "boolean", label: "Leer de stdin", description: "Lee el valor de la entrada estandar en vez del prompt oculto." }],
    stdinFlag: "--stdin",
  }),
  tool({ name: "credentials-migrate", family: "credentials", summary: "Copia una credencial heredada del Keychain de macOS a los archivos de secretos.", effect: "write", flags: [required(NAME), SERVICE] }),
  tool({ name: "credentials-update", family: "credentials", summary: "Trae la fuente chezmoi y aplica sus secretos, reemplazando cambios locales.", effect: "write", flags: [] }),
];

const MAINTENANCE_COMMANDS: readonly CatalogCommand[] = [
  {
    name: "gui",
    family: "maintenance",
    summary: "Abre la GUI de escritorio instalada y devuelve la terminal de inmediato.",
    effect: "read",
    output: "stream",
    groups: [],
    flags: [],
  },
  {
    name: "update",
    family: "maintenance",
    summary: "Ejecuta el instalador de Bun; sin opciones usa --all-global.",
    effect: "maintenance",
    output: "stream",
    groups: [],
    flags: INSTALLER_FLAGS,
    notes: ["Todo lo declarado despues de update se reenvia al instalador."],
  },
  {
    name: "catalog",
    family: "maintenance",
    summary: "Describe como JSON cada comando, sus opciones y su efecto.",
    effect: "read",
    output: "json",
    groups: [],
    flags: [],
  },
];

const COMMANDS: readonly CatalogCommand[] = [
  ...WORKFLOW_COMMANDS,
  ...AZURE_READ_COMMANDS,
  ...AZURE_WRITE_COMMANDS,
  ...GITHUB_QUEUE_COMMANDS,
  ...GITHUB_DELIVERY_COMMANDS,
  ...GIT_COMMANDS,
  ...PULL_REQUEST_COMMANDS,
  ...CREDENTIALS_COMMANDS,
  ...MAINTENANCE_COMMANDS,
];

const ENVIRONMENT: readonly CatalogEnvironmentVariable[] = [
  { name: "LAZY_WORKFLOW_GUI", description: "Ruta alternativa del binario que abre lz gui.", secret: false },
  { name: AZURE_ORGANIZATION_ENV, description: "https://dev.azure.com/<organizacion>; requerida por todo flujo y herramienta Azure.", secret: false },
  { name: SAG_NORMS_REPOSITORY_ENV, description: "Repositorio canonico de las normas SAG que carga --normas-sag.", secret: false },
  { name: "LAZY_WORKFLOW_LOG_FILE", description: "Ruta del run log; --log-file la precede y el default es ~/.local/state/lazy-workflow/runs.jsonl.", secret: false },
  { name: "LAZY_WORKFLOW_SECRETS_DIR", description: "Directorio de los archivos de secretos; default ~/.config/secrets.", secret: false },
  { name: OFF_PASSWORD_ENV, description: "Contrasena de sudo que --off usa sin dejarla en ps ni en el historial.", secret: true },
  { name: "AZURE_DEVOPS_EXT_PAT", description: "PAT de Azure DevOps para az y para leer normas SAG autenticadas; nunca se envia al agente.", secret: true },
  { name: "NO_COLOR", description: "Con cualquier valor deshabilita los colores ANSI, como --no-color.", secret: false },
];

/** The whole document `lz catalog` prints. */
export function commandCatalog(): CommandCatalog {
  return {
    schemaVersion: COMMAND_CATALOG_SCHEMA_VERSION,
    binary: "lz",
    defaultCli: DEFAULT_CLI,
    agents: (Object.entries(AGENT_CLI_PROFILES) as Array<[AgentCli, (typeof AGENT_CLI_PROFILES)[AgentCli]]>).map(([cli, profile]) => ({
      cli,
      binary: profile.binary,
      defaultModel: profile.defaultModel,
      efforts: profile.efforts ? [...profile.efforts] : null,
    })),
    environment: ENVIRONMENT,
    families: FAMILIES,
    groups: GROUPS,
    commands: COMMANDS,
  };
}
