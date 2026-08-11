import { HuInfoService } from "../azure/hu-info-service.ts";
import {
  AzureAutocodeService,
  COMPLETION_GATE,
  type AutocodeContext,
  type AutocodeState,
  type CompletionGate,
  type IncompleteTicketCompletion,
  type TicketCompletionVerification,
  type VerifiedTicketCompletion,
} from "../azure/autocode-service.ts";
import type { CompletionManifest, EvidenceKind, TicketInfo, TicketAttachment } from "../azure/ticket-info-service.ts";
import { GitAutocodeCheckpointStore, type AutocodeCheckpointStore } from "../azure/autocode-checkpoint.ts";
import { OpenCodeService, OpenCodeSessionCloseError, OpenCodeSessionNotFoundError, type OpenCodeRunOptions } from "../opencode/open-code-service.ts";
import { reportOperator } from "../output/operator-output.ts";
import { GitTicketBranchCleaner } from "../git/git-ticket-branch-cleaner.ts";

type CliOptions = OpenCodeRunOptions & {
  hu: number | null;
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
  hasRealEffort: boolean;
  hasRealEffortHours: boolean;
  hasExpectedRevision: boolean;
  evidenceKind: EvidenceKind | null;
  numberOfQuestions: number;
  workingDirectory: string;
};

type AzureBoundary = Pick<HuInfoService, "getHuInfo" | "waitForAccess"> & Partial<{
  getIntegrationBranchInfo(hu: number): Promise<{ hu: number; branch: string | null }>;
  setIntegrationBranch?(hu: number, branch: string, workingDirectory: string, baseBranch?: string | null): Promise<{ hu: number; branch: string }>;
  setTicketBranch?(hu: number, ticket: number, branch: string, workingDirectory: string): Promise<{ hu: number; ticket: number; branch: string }>;
  ensureIntegrationBranch(hu: number, workingDirectory: string, baseBranch?: string | null): Promise<string | null>;
  getAutocodeState?(hu: number, integrationBranch?: string): Promise<AutocodeState>;
  getAutocodeContext(hu: number, integrationBranch?: string): Promise<AutocodeContext | null>;
  getAutocodeContextForTicket(hu: number, ticket: number, integrationBranch?: string): Promise<AutocodeContext | null>;
  verifyTicketCompletion(context: AutocodeContext): Promise<TicketCompletionVerification | null>;
  getCompletedTicketBranch(context: AutocodeContext): Promise<string | null>;
  getTicketInfo?(hu: number, ticket: number): Promise<TicketInfo>;
  getCompletionInfo?(hu: number, ticket: number): Promise<{ hu: number; ticket: number; gates: TicketInfo["gates"] }>;
  readCompletionManifest?(path: string, workingDirectory: string): Promise<CompletionManifest>;
  validateCompletionManifest?(manifest: CompletionManifest, info: TicketInfo, ticket: number, workingDirectory: string): Promise<void>;
  getBranch?(hu: number, ticket: number): Promise<{ hu: number; ticket: number; branch: string | null; integrationBranch: string | null }>;
  getTicket?(ticket: number): Promise<{ id: number; type: "Task" | "Bug" }>;
  getDescription?(ticket: number): Promise<{ ticket: number; description: string | null }>;
  getState?(ticket: number): Promise<{ ticket: number; state: string | null; revision: number | null }>;
  getEffort?(ticket: number): Promise<{ ticket: number; effort: { estimated?: number; real?: number; realHours?: number } }>;
  getAttachments?(ticket: number): Promise<{ ticket: number; attachments: TicketAttachment[] }>;
  getEvidence?(ticket: number): Promise<{ ticket: number; completionEvidence: string | null }>;
  setDescription?(ticket: number, filePath: string): Promise<unknown>;
  setState?(ticket: number, desiredState: string, expectedState: string, allowCompletion?: boolean): Promise<unknown>;
  setEffort?(ticket: number, realEffort: number, realEffortHours: number, expectedRevision: number): Promise<unknown>;
  linkPullRequest?(hu: number, ticket: number, pullRequest: number): Promise<unknown>;
  linkCommit?(ticket: number, pullRequest: number): Promise<unknown>;
  addAttachment?(ticket: number, filePath: string, kind: EvidenceKind): Promise<unknown>;
  setEvidence?(ticket: number, filePath: string): Promise<unknown>;
}>;

interface RetryTimer { wait(milliseconds: number): Promise<void>; }
interface TicketBranchCleaner {
  deleteTicketBranch(ticketBranch: string, integrationBranch: string, workingDirectory: string): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function containsMarker(text: string, marker: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim() === marker);
}

const COMPLETION_GATE_MESSAGES: Record<CompletionGate, string> = {
  "pinned-ticket-context": "no se pudo reconstruir el ticket fijado como hijo directo de la HU",
  "ticket-state": "el estado del ticket no es Done",
  "completion-evidence": "falta la evidencia de completion",
  "real-effort": "falta el valor requerido de Real Effort",
  "real-effort-hours": "falta el valor requerido de Real Effort HH",
  "commit-url": "falta la URL del commit",
  "attached-capture": "falta una captura adjunta",
  "hu-integration-branch": "falta la rama de integracion de la HU o no coincide",
  "completed-hu-targeted-pr": "falta un PR completado dirigido a la rama de integracion de la HU",
  "native-pr-association": "falta la asociacion nativa del PR con el ticket",
  "merge-commit-artifact-link": "falta el ArtifactLink nativo del commit exacto de merge",
};

function isIncompleteCompletion(
  verification: TicketCompletionVerification | null,
): verification is IncompleteTicketCompletion {
  return verification !== null && "unmetGates" in verification;
}

function reportUnmetCompletion(ticket: number, verification: IncompleteTicketCompletion): void {
  reportOperator([
    `lazy-workflow: el ticket ${ticket} no cumple los gates de cierre; checkpoint sessionless conservado.`,
    ...verification.unmetGates.map((gate) => `- ${gate}: ${COMPLETION_GATE_MESSAGES[gate]}`),
  ].join("\n"));
}

function requireVerifiedCompletion(
  ticket: number,
  verification: TicketCompletionVerification | null,
  fallbackMessage: string,
): verification is VerifiedTicketCompletion {
  if (isIncompleteCompletion(verification)) {
    reportUnmetCompletion(ticket, verification);
  } else if (!verification) {
    reportOperator(fallbackMessage);
  }
  return verification !== null && !isIncompleteCompletion(verification);
}

const DEFAULT_MODEL = "opencode-go/deepseek-v4-pro";
const DEFAULT_VARIANT = "high";
const DEFAULT_PROMPT = "Follow the authoritative workflow and context.";
const DEFAULT_NUMBER_OF_QUESTIONS = 5;
const TICKET_COMPLETED_MARKER = "TICKET_COMPLETED";
const QUEUE_EMPTY_MARKER = "QUEUE_EMPTY";
const WORKFLOW_STEP_FINISHED_MARKER = "WORKFLOW_STEP_FINISHED";
const MAX_BRANCH_PREFLIGHT_RETRIES = 3;
const TICKET_READ_COMMANDS = new Set([
  "ticket-info",
  "ticket-description-info",
  "ticket-state-info",
  "ticket-effort-info",
  "ticket-branch-info",
  "ticket-pr-info",
  "ticket-attachment-info",
  "ticket-evidence-info",
  "ticket-completion-info",
]);
const TICKET_MUTATION_COMMANDS = new Set([
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

function isStableIntegrationBranchFailure(error: unknown): boolean {
  return /ArtifactLink|rama .* (malformada|conflicto|no existe|no válida|ambigua)|indique --base-branch|cambios sin guardar|origin .* (no es|no contiene)|repositorio Azure .* no coincide|proyecto .* no al proyecto/i.test(errorMessage(error));
}

function isTransientAzureFailure(error: unknown): boolean {
  return /Azure command failed|azure .* (temporar|unavailable|unreachable)|timeout|timed out|network|connection|\b(?:429|500|502|503|504)\b/i.test(errorMessage(error));
}

function optionValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function isValidHu(hu: number | null): hu is number {
  return hu !== null && Number.isInteger(hu) && hu > 0;
}

function readPrompt(name: "default" | "autoplan" | "autocode"): Promise<string> {
  return Bun.file(new URL(`../../prompts/${name}-prompt.md`, import.meta.url)).text();
}

function parseOptions(args: string[]): CliOptions {
  const hu = optionValue(args, "--hu");
  const ticket = optionValue(args, "--ticket");
  const realEffort = optionValue(args, "--real-effort");
  const realEffortHours = optionValue(args, "--real-effort-hh");
  const expectedRevision = optionValue(args, "--expected-rev");
  const presentValue = (value: string | null): boolean => value !== null && value.trim() !== "" && !value.startsWith("--");
  return {
    model: optionValue(args, "--model") ?? DEFAULT_MODEL,
    variant: optionValue(args, "--variant") ?? DEFAULT_VARIANT,
    session: optionValue(args, "--session"),
    prompt: optionValue(args, "--prompt") ?? DEFAULT_PROMPT,
    hu: args.includes("--hu") ? Number(hu) : null,
    branch: optionValue(args, "--branch"),
    baseBranch: optionValue(args, "--base-branch"),
    ticket: args.includes("--ticket") ? Number(ticket) : null,
    pullRequest: args.includes("--pr") ? Number(optionValue(args, "--pr")) : null,
    manifest: optionValue(args, "--manifest"),
    file: optionValue(args, "--evidence-file") ?? optionValue(args, "--file"),
    descriptionFile: optionValue(args, "--description-file"),
    state: optionValue(args, "--state"),
    expectedState: optionValue(args, "--expected-state"),
    realEffort: Number(realEffort),
    realEffortHours: Number(realEffortHours),
    expectedRevision: Number(expectedRevision),
    hasRealEffort: presentValue(realEffort),
    hasRealEffortHours: presentValue(realEffortHours),
    hasExpectedRevision: presentValue(expectedRevision),
    evidenceKind: (optionValue(args, "--kind") ?? optionValue(args, "--evidence-kind")) as EvidenceKind | null,
    numberOfQuestions: Number.parseInt(optionValue(args, "--number-of-questions") ?? `${DEFAULT_NUMBER_OF_QUESTIONS}`, 10),
    workingDirectory: optionValue(args, "--working-directory") ?? process.cwd(),
  };
}

function printHelp(): void {
  console.log([
    "Usage:",
    "  lazy-workflow plan [options]",
    "  lazy-workflow plan --hu <id> [options]",
    "  lazy-workflow code [options]",
    "  lazy-workflow code --hu <id> [options]",
    "  lazy-workflow code --session <id> --prompt continue",
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
    "",
    "Options:",
    "  --hu <id>                    selecciona el flujo Azure; omitir usa GitHub",
    "  --session <id>",
    "  --model <model>",
    "  --variant <variant>",
    "  --prompt <prompt>",
    "  --branch <name>",
    "  --base-branch <name>",
    "  --ticket <id>",
    "  --pr <id>",
    "  --description-file <path>",
    "  --state <state>",
    "  --expected-state <state>",
    "  --real-effort <hours>",
    "  --real-effort-hh <hours>",
    "  --expected-rev <rev>",
    "  --file <path>",
    "  --kind <http-json|screen|command-output>",
    "  --evidence-file <path>",
    "  code: --base-branch solo es obligatorio al crear hu/<HU> por primera vez",
    "  --number-of-questions <count>",
    "  --working-directory <path>",
  ].join("\n"));
}

export class LazyWorkflowCli {
  constructor(
    private readonly huInfoService: AzureBoundary = new AzureAutocodeService(),
    private readonly openCodeService: Pick<OpenCodeService, "run" | "resume"> = new OpenCodeService(),
    private readonly checkpointStore: AutocodeCheckpointStore = new GitAutocodeCheckpointStore(),
    private readonly retryTimer: RetryTimer = { wait: Bun.sleep },
    private readonly ticketBranchCleaner: TicketBranchCleaner = new GitTicketBranchCleaner(),
  ) {}

  async run(args: string[]): Promise<number> {
    const command = args[0];
    if (typeof command !== "string" || (command !== "plan" && command !== "code" && command !== "hu-info" && command !== "hu-branch-info" && command !== "hu-branch-set" && !TICKET_READ_COMMANDS.has(command) && !TICKET_MUTATION_COMMANDS.has(command))) {
      printHelp();
      return 1;
    }

    const options = parseOptions(args);

    if (options.hu !== null && !isValidHu(options.hu)) {
      reportOperator(`La HU debe ser un entero positivo: ${options.hu}`);
      return 1;
    }

    if (TICKET_READ_COMMANDS.has(command)) return this.runTicketRead(command, options);

    if (command === "ticket-completion-apply") {
      if (!isValidHu(options.hu)) {
        reportOperator("ticket-completion-apply requiere --hu <id>");
        return 1;
      }
      if (options.ticket === null || !Number.isInteger(options.ticket) || options.ticket <= 0) {
        reportOperator("ticket-completion-apply requiere --ticket <id> con un entero positivo");
        return 1;
      }
      if (options.pullRequest === null || !Number.isInteger(options.pullRequest) || options.pullRequest <= 0) {
        reportOperator("ticket-completion-apply requiere --pr <id> con un entero positivo");
        return 1;
      }
      if (!options.manifest?.trim()) {
        reportOperator("ticket-completion-apply requiere --manifest <path>");
        return 1;
      }
      try {
        console.log(JSON.stringify(await this.applyTicketCompletion(options), null, 2));
        return 0;
      } catch (error) {
        reportOperator(`lazy-workflow: no se pudo ejecutar ticket-completion-apply (${errorMessage(error)})`);
        return 1;
      }
    }

    if (command === "ticket-description-set" || command === "ticket-state-set" || command === "ticket-effort-set") {
      if (options.ticket === null || !Number.isInteger(options.ticket) || options.ticket <= 0) {
        reportOperator(`${command} requiere --ticket <id> con un entero positivo`);
        return 1;
      }
      if (command === "ticket-description-set" && !options.descriptionFile?.trim()) {
        reportOperator("ticket-description-set requiere --description-file <path>");
        return 1;
      }
      if (command === "ticket-state-set" && (!options.state?.trim() || !options.expectedState?.trim())) {
        reportOperator("ticket-state-set requiere --state <state> y --expected-state <state>");
        return 1;
      }
      if (command === "ticket-effort-set" && (
        !options.hasRealEffort || !options.hasRealEffortHours || !options.hasExpectedRevision
        ||
        !Number.isFinite(options.realEffort) || options.realEffort < 0
        || !Number.isFinite(options.realEffortHours) || options.realEffortHours < 0
        || !Number.isInteger(options.expectedRevision) || options.expectedRevision <= 0
      )) {
        reportOperator("ticket-effort-set requiere --real-effort <hours>, --real-effort-hh <hours> y --expected-rev <rev> válidos");
        return 1;
      }
      try {
        let result: unknown;
        if (command === "ticket-description-set") {
          if (!this.huInfoService.setDescription) throw new Error("El servicio Azure no soporta ticket-description-set");
          result = await this.huInfoService.setDescription(options.ticket, options.descriptionFile!);
        } else if (command === "ticket-state-set") {
          if (!this.huInfoService.setState) throw new Error("El servicio Azure no soporta ticket-state-set");
          result = await this.huInfoService.setState(options.ticket, options.state!, options.expectedState!);
        } else {
          if (!this.huInfoService.setEffort) throw new Error("El servicio Azure no soporta ticket-effort-set");
          result = await this.huInfoService.setEffort(options.ticket, options.realEffort, options.realEffortHours, options.expectedRevision);
        }
        console.log(JSON.stringify(result, null, 2));
        return 0;
      } catch (error) {
        reportOperator(`lazy-workflow: no se pudo ejecutar ${command} (${errorMessage(error)})`);
        return 1;
      }
    }

    if (command === "ticket-pr-link" || command === "ticket-commit-link" || command === "ticket-attachment-add" || command === "ticket-evidence-set") {
      if (command === "ticket-pr-link" && !isValidHu(options.hu)) {
        reportOperator("ticket-pr-link requiere --hu <id>");
        return 1;
      }
      if (options.ticket === null || !Number.isInteger(options.ticket) || options.ticket <= 0) {
        reportOperator(`${command} requiere --ticket <id> con un entero positivo`);
        return 1;
      }
      if ((command === "ticket-pr-link" || command === "ticket-commit-link")
        && (options.pullRequest === null || !Number.isInteger(options.pullRequest) || options.pullRequest <= 0)) {
        reportOperator(`${command} requiere --pr <id> con un entero positivo`);
        return 1;
      }
      if ((command === "ticket-attachment-add" || command === "ticket-evidence-set") && !options.file?.trim()) {
        reportOperator(`${command} requiere --file <path>`);
        return 1;
      }
      if (command === "ticket-attachment-add" && !options.evidenceKind) {
        reportOperator("ticket-attachment-add requiere --kind <http-json|screen|command-output>");
        return 1;
      }
      try {
        let result: unknown;
        if (command === "ticket-pr-link") {
          if (!this.huInfoService.linkPullRequest) throw new Error("El servicio Azure no soporta ticket-pr-link");
          result = await this.huInfoService.linkPullRequest(options.hu!, options.ticket, options.pullRequest!);
        } else if (command === "ticket-commit-link") {
          if (!this.huInfoService.linkCommit) throw new Error("El servicio Azure no soporta ticket-commit-link");
          result = await this.huInfoService.linkCommit(options.ticket, options.pullRequest!);
        } else if (command === "ticket-attachment-add") {
          if (!this.huInfoService.addAttachment) throw new Error("El servicio Azure no soporta ticket-attachment-add");
          result = await this.huInfoService.addAttachment(options.ticket, options.file!, options.evidenceKind!);
        } else {
          if (!this.huInfoService.setEvidence) throw new Error("El servicio Azure no soporta ticket-evidence-set");
          result = await this.huInfoService.setEvidence(options.ticket, options.file!);
        }
        console.log(JSON.stringify(result, null, 2));
        return 0;
      } catch (error) {
        reportOperator(`lazy-workflow: no se pudo ejecutar ${command} (${errorMessage(error)})`);
        return 1;
      }
    }

    if (command === "ticket-branch-set") {
      if (!isValidHu(options.hu)) {
        reportOperator("ticket-branch-set requiere --hu <id>");
        return 1;
      }
      if (options.ticket === null || !Number.isInteger(options.ticket) || options.ticket <= 0) {
        reportOperator("ticket-branch-set requiere --ticket <id> con un entero positivo");
        return 1;
      }
      if (!options.branch?.trim()) {
        reportOperator("ticket-branch-set requiere --branch <name>");
        return 1;
      }
      const workingDirectory = optionValue(args, "--working-directory");
      if (!workingDirectory?.trim() || workingDirectory.startsWith("--")) {
        reportOperator("ticket-branch-set requiere --working-directory <path>");
        return 1;
      }
      if (!this.huInfoService.setTicketBranch) {
        reportOperator("El servicio Azure no soporta ticket-branch-set");
        return 1;
      }
      try {
        console.log(JSON.stringify(
          await this.huInfoService.setTicketBranch(options.hu, options.ticket, options.branch, options.workingDirectory),
          null,
          2,
        ));
        return 0;
      } catch (error) {
        reportOperator(`lazy-workflow: no se pudo vincular la rama del ticket ${options.ticket} (${errorMessage(error)})`);
        return 1;
      }
    }

    if (command === "hu-info") {
      if (!isValidHu(options.hu)) {
        reportOperator("hu-info requiere --hu <id>");
        return 1;
      }
      const huInfo = await this.huInfoService.getHuInfo(options.hu);
      console.log(JSON.stringify(huInfo, null, 2));
      return 0;
    }

    if (command === "hu-branch-info") {
      if (!isValidHu(options.hu)) {
        reportOperator("hu-branch-info requiere --hu <id>");
        return 1;
      }
      if (!this.huInfoService.getIntegrationBranchInfo) {
        reportOperator("El servicio Azure no soporta hu-branch-info");
        return 1;
      }
      try {
        console.log(JSON.stringify(await this.huInfoService.getIntegrationBranchInfo(options.hu), null, 2));
        return 0;
      } catch (error) {
        reportOperator(`lazy-workflow: no se pudo consultar la rama de la HU ${options.hu} (${errorMessage(error)})`);
        return 1;
      }
    }

    if (command === "hu-branch-set") {
      if (!isValidHu(options.hu)) {
        reportOperator("hu-branch-set requiere --hu <id>");
        return 1;
      }
      if (!options.branch?.trim()) {
        reportOperator("hu-branch-set requiere --branch <name>");
        return 1;
      }
      if (!this.huInfoService.setIntegrationBranch) {
        reportOperator("El servicio Azure no soporta hu-branch-set");
        return 1;
      }
      try {
        console.log(JSON.stringify(
          await this.huInfoService.setIntegrationBranch(
            options.hu,
            options.branch,
            options.workingDirectory,
            options.baseBranch,
          ),
          null,
          2,
        ));
        return 0;
      } catch (error) {
        reportOperator(`lazy-workflow: no se pudo vincular la rama de la HU ${options.hu} (${errorMessage(error)})`);
        return 1;
      }
    }

    const recoveringAzureCode = command === "code" && options.session !== null;
    if (options.hu === null && !recoveringAzureCode && (args.includes("--branch") || args.includes("--base-branch"))) {
      reportOperator("--branch y --base-branch solo se permiten en flujos Azure");
      return 1;
    }

    if (command === "code") {
      if (recoveringAzureCode || options.hu !== null) return this.runAzureCode(options);
      return this.runDefaultWorkflow(command, options);
    }

    if (options.hu === null) return this.runDefaultWorkflow("plan", options);

    const huInfo = await this.huInfoService.getHuInfo(options.hu);

    options.prompt = [
      JSON.stringify(huInfo),
      await readPrompt("autoplan"),
      `The number of questions must be ${options.numberOfQuestions}`,
      options.prompt,
      `The working directory is ${options.workingDirectory}`,
    ].join("\n");

    const execution = await this.openCodeService.run(options, true);
    let result = execution.result;
    if (execution.azureLoginRequired && options.hu > 0) {
      reportOperator(`Sesion OpenCode detenida: ${result.sessionId}`);
      await this.huInfoService.waitForAccess(options.hu);
      result = await this.openCodeService.resume(result.sessionId, "continue", options.workingDirectory);
    }
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  private async runDefaultWorkflow(command: "plan" | "code", options: CliOptions): Promise<number> {
    const prompt = [
      await readPrompt("default"),
      `Selected workflow: ${command}`,
      ...(command === "plan" ? [`The number of questions must be ${options.numberOfQuestions}`] : []),
      `The working directory is ${options.workingDirectory}`,
      "Operator request:",
      options.prompt,
    ].join("\n");
    if (command === "plan") {
      const execution = await this.openCodeService.run({ ...options, prompt, session: null }, false);
      console.log(JSON.stringify(execution.result, null, 2));
      return execution.failed ? 1 : 0;
    }

    while (true) {
      const execution = await this.openCodeService.run({
        ...options,
        prompt,
        session: null,
        terminalMarker: WORKFLOW_STEP_FINISHED_MARKER,
      }, false);
      const result = execution.result;
      console.log(JSON.stringify(result, null, 2));
      if (execution.failed) return 1;

      if (!containsMarker(result.text, WORKFLOW_STEP_FINISHED_MARKER)) {
        reportOperator(`lazy-workflow: la sesión GitHub terminó sin ${WORKFLOW_STEP_FINISHED_MARKER}.`);
        return 1;
      }
      const ticketCompleted = containsMarker(result.text, TICKET_COMPLETED_MARKER);
      const queueEmpty = containsMarker(result.text, QUEUE_EMPTY_MARKER);
      if (ticketCompleted === queueEmpty) {
        reportOperator(`lazy-workflow: la sesión GitHub debe terminar con exactamente ${TICKET_COMPLETED_MARKER} o ${QUEUE_EMPTY_MARKER}.`);
        return 1;
      }
      if (queueEmpty) {
        reportOperator("lazy-workflow: no quedan issues GitHub elegibles.");
        return 0;
      }
    }
  }

  private async runTicketRead(command: string, options: CliOptions): Promise<number> {
    if (options.ticket === null || !Number.isInteger(options.ticket) || options.ticket <= 0) {
      reportOperator(`${command} requiere --ticket <id> con un entero positivo`);
      return 1;
    }
    const ticket = options.ticket;
    const needsHu = command === "ticket-info" || command === "ticket-branch-info"
      || command === "ticket-pr-info" || command === "ticket-completion-info";
    if (needsHu && !isValidHu(options.hu)) {
      reportOperator(`${command} requiere --hu <id>`);
      return 1;
    }
    try {
      let result: unknown;
      if (command === "ticket-info") {
        if (!this.huInfoService.getTicketInfo) throw new Error("El servicio Azure no soporta ticket-info");
        result = await this.huInfoService.getTicketInfo(options.hu!, ticket);
      } else if (command === "ticket-description-info") {
        if (!this.huInfoService.getDescription) throw new Error("El servicio Azure no soporta ticket-description-info");
        result = await this.huInfoService.getDescription(ticket);
      } else if (command === "ticket-state-info") {
        if (!this.huInfoService.getState) throw new Error("El servicio Azure no soporta ticket-state-info");
        result = await this.huInfoService.getState(ticket);
      } else if (command === "ticket-effort-info") {
        if (!this.huInfoService.getEffort) throw new Error("El servicio Azure no soporta ticket-effort-info");
        result = await this.huInfoService.getEffort(ticket);
      } else if (command === "ticket-attachment-info") {
        if (!this.huInfoService.getAttachments) throw new Error("El servicio Azure no soporta ticket-attachment-info");
        result = await this.huInfoService.getAttachments(ticket);
      } else if (command === "ticket-evidence-info") {
        if (!this.huInfoService.getEvidence) throw new Error("El servicio Azure no soporta ticket-evidence-info");
        result = await this.huInfoService.getEvidence(ticket);
      } else if (command === "ticket-branch-info") {
        if (!this.huInfoService.getBranch) throw new Error("El servicio Azure no soporta ticket-branch-info");
        result = await this.huInfoService.getBranch(options.hu!, ticket);
      } else if (command === "ticket-completion-info" && this.huInfoService.getCompletionInfo) {
        result = await this.huInfoService.getCompletionInfo(options.hu!, ticket);
      } else {
        if (!this.huInfoService.getTicketInfo) throw new Error(`El servicio Azure no soporta ${command}`);
        const info = await this.huInfoService.getTicketInfo(options.hu!, ticket);
        result = command === "ticket-pr-info"
          ? {
            hu: options.hu,
            ticket,
            pullRequests: info.pullRequests,
            canonicalPullRequest: info.canonicalPullRequest,
            mergeCommit: info.mergeCommit,
          }
          : { hu: options.hu, ticket, gates: info.gates };
      }
      console.log(JSON.stringify(result, null, 2));
      return 0;
    } catch (error) {
      reportOperator(`lazy-workflow: no se pudo consultar ${command} (${errorMessage(error)})`);
      return 1;
    }
  }

  private async applyTicketCompletion(options: CliOptions): Promise<unknown> {
    if (!this.huInfoService.getTicketInfo || !this.huInfoService.readCompletionManifest || !this.huInfoService.validateCompletionManifest) {
      throw new Error("El servicio Azure no soporta ticket-completion-apply");
    }
    if (!this.huInfoService.linkPullRequest || !this.huInfoService.linkCommit || !this.huInfoService.addAttachment
      || !this.huInfoService.setEvidence || !this.huInfoService.setState) {
      throw new Error("El servicio Azure no expone todas las primitivas de completion");
    }

    let info = await this.huInfoService.getTicketInfo(options.hu!, options.ticket!);
    const manifest = await this.huInfoService.readCompletionManifest(options.manifest!, options.workingDirectory);
    await this.huInfoService.validateCompletionManifest(manifest, info, options.ticket!, options.workingDirectory);

    const unreconcilableGates = info.gates.unmet.filter((gate) =>
      gate === COMPLETION_GATE.realEffort
      || gate === COMPLETION_GATE.realEffortHours
      || gate === COMPLETION_GATE.commitUrl
    );
    if (unreconcilableGates.length > 0) {
      throw new Error(`No se puede completar el ticket ${options.ticket}; faltan datos previos: ${unreconcilableGates.join(", ")}`);
    }

    const textEvidence = manifest.evidence.find(({ kind }) => kind !== "screen");
    if (!textEvidence && !info.completionEvidence) {
      throw new Error("El manifest no contiene evidencia textual para completion-evidence");
    }
    if (textEvidence) {
      await this.huInfoService.setEvidence(options.ticket!, textEvidence.path);
      info = await this.huInfoService.getTicketInfo(options.hu!, options.ticket!);
    }

    if (info.canonicalPullRequest !== null && info.canonicalPullRequest !== options.pullRequest) {
      throw new Error(`El ticket ${options.ticket} ya tiene otro PR canónico asociado: ${info.canonicalPullRequest}`);
    }
    if (info.canonicalPullRequest === null) {
      await this.huInfoService.linkPullRequest(options.hu!, options.ticket!, options.pullRequest!);
      info = await this.huInfoService.getTicketInfo(options.hu!, options.ticket!);
    }

    if (info.gates.unmet.includes(COMPLETION_GATE.mergeCommitArtifact)) {
      await this.huInfoService.linkCommit(options.ticket!, options.pullRequest!);
      info = await this.huInfoService.getTicketInfo(options.hu!, options.ticket!);
    }

    for (const evidence of manifest.evidence) {
      if (info.attachments.some((attachment) =>
        attachment.digest?.toLowerCase() === evidence.sha256.toLowerCase() && attachment.evidenceKind === evidence.kind
      )) continue;
      await this.huInfoService.addAttachment(options.ticket!, evidence.path, evidence.kind);
      info = await this.huInfoService.getTicketInfo(options.hu!, options.ticket!);
    }

    const unmetBeforeDone = info.gates.unmet.filter((gate) => gate !== COMPLETION_GATE.ticketState);
    if (unmetBeforeDone.length > 0) {
      throw new Error(`No se puede completar el ticket ${options.ticket}; gates incumplidos: ${unmetBeforeDone.join(", ")}`);
    }

    if (info.ticket.state !== "Done") {
      await this.huInfoService.setState(options.ticket!, "Done", info.ticket.state ?? "", true);
      info = await this.huInfoService.getTicketInfo(options.hu!, options.ticket!);
    }
    if (info.ticket.state !== "Done" || info.gates.unmet.length > 0) {
      throw new Error(`No se pudo verificar la finalización del ticket ${options.ticket}`);
    }
    return { hu: options.hu, ticket: options.ticket, pullRequest: options.pullRequest, manifest: options.manifest, state: "Done", gates: info.gates };
  }

  private async runAzureCode(options: CliOptions): Promise<number> {
    if (!this.huInfoService.getAutocodeContext || !this.huInfoService.verifyTicketCompletion) {
      reportOperator("El servicio Azure no soporta autocode");
      return 1;
    }

    if (!this.huInfoService.ensureIntegrationBranch) {
      reportOperator("El servicio Azure no soporta autocode");
      return 1;
    }
    const checkpoint = await this.checkpointStore.read();
    let recovering = options.session !== null;
    let reconciling = !recovering && checkpoint?.sessionId === null;
    if (recovering && (!checkpoint || checkpoint.sessionId !== options.session)) return 1;
    if (!recovering && checkpoint && !reconciling) return 1;
    const hu = recovering || reconciling ? checkpoint!.hu : options.hu!;
    let integrationBranch: string | null = null;
    let sessionId = options.session;
    let lastResult;
    if ((recovering || reconciling) && !this.huInfoService.getAutocodeContextForTicket) {
      reportOperator("lazy-workflow: el servicio Azure no puede reconstruir el ticket interrumpido.");
      return 1;
    }
    integrationBranch = await this.prepareIntegrationBranch(
      hu,
      options,
      recovering || reconciling,
    );
    if (!integrationBranch) {
      return 1;
    }
    reportOperator(`lazy-workflow: buscando la rama de integración y los tickets de la HU ${hu}...`);
    while (true) {
      let state: AutocodeState;
      try {
        if (!integrationBranch) {
          reportOperator(`lazy-workflow: no se encontró la rama de integración para la HU ${hu}; ejecución detenida.`);
          return 1;
        }
        if (recovering || reconciling) {
          const pinnedContext = await this.huInfoService.getAutocodeContextForTicket!(
            hu,
            checkpoint!.ticket,
            integrationBranch,
          );
          if (!pinnedContext) {
            reportUnmetCompletion(checkpoint!.ticket, {
              ticketId: checkpoint!.ticket,
              unmetGates: [COMPLETION_GATE.pinnedTicketContext],
            });
            return 1;
          }
          if (recovering) {
            const verification = await this.huInfoService.verifyTicketCompletion(pinnedContext);
            const ticketIsDone = verification !== null
              && (!isIncompleteCompletion(verification)
                || !verification.unmetGates.includes(COMPLETION_GATE.ticketState));
            if (ticketIsDone) {
              await this.checkpointStore.write({
                workflow: "autocode",
                hu,
                ticket: pinnedContext.ticket.id,
                sessionId: null,
              });
              recovering = false;
              sessionId = null;
              if (!requireVerifiedCompletion(
                pinnedContext.ticket.id,
                verification,
                `lazy-workflow: el ticket ${pinnedContext.ticket.id} todavía no cumple el cierre verificable.`,
              )) return 1;
              try {
                await this.cleanupCompletedTicketBranch(
                  pinnedContext,
                  options.workingDirectory,
                  verification.ticketBranch,
                );
              } catch (error) {
                reportOperator(`lazy-workflow: la limpieza Git del ticket ${pinnedContext.ticket.id} falló (${errorMessage(error)}); checkpoint conservado.`);
                return 1;
              }
              await this.checkpointStore.clear();
              continue;
            }
          }
          if (reconciling) {
            const verification = await this.huInfoService.verifyTicketCompletion(pinnedContext);
            if (!requireVerifiedCompletion(
              checkpoint!.ticket,
              verification,
              `lazy-workflow: el ticket ${checkpoint!.ticket} todavía no cumple el cierre verificable.`,
            )) return 1;
            try {
              await this.cleanupCompletedTicketBranch(
                pinnedContext,
                options.workingDirectory,
                verification.ticketBranch,
              );
            } catch (error) {
              reportOperator(`lazy-workflow: la limpieza Git del ticket ${pinnedContext.ticket.id} falló (${errorMessage(error)}); checkpoint conservado.`);
              return 1;
            }
            await this.checkpointStore.clear();
            reconciling = false;
            continue;
          }
          state = { context: pinnedContext, pending: true };
        } else {
          state = this.huInfoService.getAutocodeState
            ? await this.huInfoService.getAutocodeState(hu, integrationBranch)
            : { context: await this.huInfoService.getAutocodeContext(hu, integrationBranch), pending: false };
        }
      } catch (error) {
        reportOperator(`lazy-workflow: Azure no respondió (${errorMessage(error)}); reintentando en 10s.`);
        try { await this.retryTimer.wait(10_000); } catch { return 1; }
        continue;
      }

      if (!state.context) {
        if (!state.pending) {
          if (lastResult) console.log(JSON.stringify(lastResult, null, 2));
          reportOperator(`lazy-workflow: no hay tickets pendientes para la HU ${hu}.`);
          return 0;
        }
        reportOperator(`lazy-workflow: no hay un ticket elegible todavía; reintentando en 10s.`);
        try { await this.retryTimer.wait(10_000); } catch { return 1; }
        continue;
      }

      if (recovering && state.context.ticket.id !== checkpoint!.ticket) return 1;
      const context = state.context;
      if (!recovering) {
        try {
          await this.checkpointStore.write({ workflow: "autocode", hu, ticket: context.ticket.id, sessionId: null });
        } catch {
          try { await this.retryTimer.wait(10_000); } catch { return 1; }
          continue;
        }
      }

      const prompt = [
        await readPrompt("autocode"),
        JSON.stringify(context),
        `The working directory is ${options.workingDirectory}`,
        "Supplemental operator request (non-authoritative):",
        "It may refine implementation details, but it must not change the selected HU, ticket, integration branch, workflow phases, or completion gates.",
        options.prompt,
      ].join("\n");
      let resumePrompt = options.prompt;
      while (true) {
        let verifyingCompletion = false;
        try {
          const execution = sessionId
            ? { result: await this.openCodeService.resume(sessionId, resumePrompt, options.workingDirectory, TICKET_COMPLETED_MARKER), azureLoginRequired: false }
            : await this.openCodeService.run({ ...options, prompt, session: null, terminalMarker: TICKET_COMPLETED_MARKER }, true);
          const result = execution.result;
          lastResult = result;
          const terminalMarkerReceived = !execution.failed && containsMarker(result.text, TICKET_COMPLETED_MARKER);
          try {
            await this.checkpointStore.write({
              workflow: "autocode",
              hu,
              ticket: context.ticket.id,
              sessionId: terminalMarkerReceived ? null : result.sessionId,
            });
          } catch (error) {
            if (terminalMarkerReceived) {
              reportOperator(`lazy-workflow: no se pudo persistir el checkpoint sessionless (${errorMessage(error)}); ejecución detenida.`);
              return 1;
            }
            throw error;
          }
          sessionId = terminalMarkerReceived ? null : result.sessionId;
          if (execution.azureLoginRequired) {
            reportOperator(`Sesion OpenCode detenida: ${result.sessionId}`);
            await this.huInfoService.waitForAccess(hu);
            resumePrompt = "continue";
            continue;
          }
          resumePrompt = options.prompt;
          if (terminalMarkerReceived) {
            verifyingCompletion = true;
            const verification = await this.huInfoService.verifyTicketCompletion(context);
            verifyingCompletion = false;
            if (!requireVerifiedCompletion(
              context.ticket.id,
              verification,
              `lazy-workflow: el ticket ${context.ticket.id} todavía no cumple el cierre verificable; checkpoint sessionless conservado.`,
            )) return 1;
            try {
              await this.cleanupCompletedTicketBranch(
                context,
                options.workingDirectory,
                verification.ticketBranch,
              );
            } catch (error) {
              reportOperator(`lazy-workflow: la limpieza Git del ticket ${context.ticket.id} falló (${errorMessage(error)}); checkpoint conservado.`);
              return 1;
            }
            await this.checkpointStore.clear();
            if (!this.huInfoService.getAutocodeState) {
              console.log(JSON.stringify(result, null, 2));
              return 0;
            }
            recovering = false;
            sessionId = null;
            break;
          }
        } catch (error) {
          if (verifyingCompletion) {
            reportOperator("lazy-workflow: Azure no respondió durante la verificación; checkpoint sessionless conservado.");
            return 1;
          }
          if (error instanceof OpenCodeSessionCloseError) {
            try {
              await this.checkpointStore.write({
                workflow: "autocode",
                hu,
                ticket: context.ticket.id,
                sessionId: null,
              });
            } catch { /* preserve the existing checkpoint when persistence is unavailable */ }
            reportOperator(`lazy-workflow: no se pudo cerrar la sesión ${error.sessionId} (${errorMessage(error)}); checkpoint sessionless conservado y ejecución detenida.`);
            return 1;
          }
          if (error instanceof OpenCodeSessionNotFoundError) {
            try {
              await this.checkpointStore.write({
                workflow: "autocode",
                hu,
                ticket: context.ticket.id,
                sessionId: null,
              });
            } catch { /* preserve the existing checkpoint when persistence is unavailable */ }
            reportOperator(`lazy-workflow: la sesión ${error.sessionId} ya no existe; checkpoint sessionless conservado para reconciliación.`);
            return 1;
          }
          reportOperator(`lazy-workflow: OpenCode falló (${errorMessage(error)}); conservaré la sesión y reintentaré en 10s.`);
        }
        try { await this.retryTimer.wait(10_000); } catch { return 1; }
      }
    }
  }

  private async prepareIntegrationBranch(
    hu: number,
    options: CliOptions,
    retryTransient: boolean,
  ): Promise<string | null> {
    for (let attempt = 0; attempt <= MAX_BRANCH_PREFLIGHT_RETRIES; attempt += 1) {
      try {
        const branch = await this.huInfoService.ensureIntegrationBranch!(
          hu,
          options.workingDirectory,
          options.baseBranch,
        );
        if (branch) return branch;
        reportOperator(`lazy-workflow: no se encontró la rama de integración para la HU ${hu}; ejecución detenida.`);
        return null;
      } catch (error) {
        const retryable = retryTransient
          && !isStableIntegrationBranchFailure(error)
          && isTransientAzureFailure(error)
          && attempt < MAX_BRANCH_PREFLIGHT_RETRIES;
        if (!retryable) {
          reportOperator(`lazy-workflow: no se pudo preparar la rama de integración de la HU ${hu} (${errorMessage(error)}); ejecución detenida.`);
          return null;
        }
        reportOperator(`lazy-workflow: Azure no respondió al preparar la rama de integración (${errorMessage(error)}); reintentando ${attempt + 1}/${MAX_BRANCH_PREFLIGHT_RETRIES} en 10s.`);
        try { await this.retryTimer.wait(10_000); } catch { return null; }
      }
    }
    return null;
  }

  private async cleanupCompletedTicketBranch(
    context: AutocodeContext,
    workingDirectory: string,
    verifiedTicketBranch: string,
  ): Promise<void> {
    await this.ticketBranchCleaner.deleteTicketBranch(verifiedTicketBranch, context.integrationBranch, workingDirectory);
    reportOperator(`lazy-workflow: rama completada ${verifiedTicketBranch} eliminada local y remotamente.`);
  }
}
