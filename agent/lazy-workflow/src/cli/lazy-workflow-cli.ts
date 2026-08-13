import { dirname } from "node:path";
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
import {
  GitAutocodeCheckpointStore,
  migrateAutocodeCheckpoint,
  type AutocodeEffect,
  type AutocodePhase,
  type AutocodeCheckpointStore,
  type StoredAutocodeCheckpoint,
  type VersionedAutocodeCheckpoint,
} from "../azure/autocode-checkpoint.ts";
import { OpenCodeService, OpenCodeSessionCloseError, OpenCodeSessionNotFoundError, type OpenCodeRunOptions } from "../opencode/open-code-service.ts";
import { reportOperator } from "../output/operator-output.ts";
import { GitTicketBranchCleaner } from "../git/git-ticket-branch-cleaner.ts";
import { SagNormsService, type SagNormsContext } from "../sag/sag-norms-service.ts";

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
  normasSag: boolean;
  workingDirectory: string;
};

type AzureBoundary = Pick<HuInfoService, "getHuInfo" | "waitForAccess"> & Partial<{
  getIntegrationBranchInfo(hu: number): Promise<{ hu: number; branch: string | null }>;
  setIntegrationBranch?(hu: number, branch: string, workingDirectory: string, baseBranch?: string | null): Promise<{ hu: number; branch: string }>;
  setTicketBranch?(hu: number, ticket: number, branch: string, workingDirectory: string): Promise<{ hu: number; ticket: number; branch: string }>;
  pushTicketBranch?(branch: string, workingDirectory: string): Promise<void>;
  checkoutTicketBranch?(branch: string, workingDirectory: string): Promise<void>;
  ensureIntegrationBranch(hu: number, workingDirectory: string, baseBranch?: string | null): Promise<string | null>;
  getAutocodeState?(hu: number, integrationBranch?: string): Promise<AutocodeState>;
  getAutocodeContext(hu: number, integrationBranch?: string): Promise<AutocodeContext | null>;
  getAutocodeContextForTicket(hu: number, ticket: number, integrationBranch?: string): Promise<AutocodeContext | null>;
  verifyTicketCompletion(context: AutocodeContext): Promise<TicketCompletionVerification | null>;
  getCompletedTicketBranch(context: AutocodeContext): Promise<string | null>;
  getTicketInfo?(hu: number, ticket: number): Promise<TicketInfo>;
  getCompletionManifestPath?(workingDirectory: string): Promise<string>;
  createOrReusePullRequest?(hu: number, ticket: number): Promise<{ pullRequest: number; mergeCommit: string }>;
  validateDirectTicketContext?(hu: number, ticket: number): Promise<void>;
  getCompletionInfo?(hu: number, ticket: number): Promise<{ hu: number; ticket: number; gates: TicketInfo["gates"] }>;
  readCompletionManifest?(path: string, workingDirectory: string): Promise<CompletionManifest>;
  validateCompletionManifest?(manifest: CompletionManifest, info: TicketInfo, ticket: number, workingDirectory: string): Promise<void>;
  validateEvidenceFile?(filePath: string, kind: EvidenceKind): Promise<void>;
  validateEvidence?(ticket: number, filePath: string): Promise<void>;
  getBranch?(hu: number, ticket: number): Promise<{ hu: number; ticket: number; branch: string | null; integrationBranch: string | null }>;
  getTicket?(ticket: number): Promise<{ id: number; type: "Task" | "Bug" }>;
  getDescription?(ticket: number): Promise<{ ticket: number; description: string | null }>;
  getState?(ticket: number): Promise<{ ticket: number; state: string | null; revision: number | null }>;
  getEffort?(ticket: number): Promise<{ ticket: number; effort: { estimated?: number; real?: number; realHours?: number } }>;
  getAttachments?(ticket: number): Promise<{ ticket: number; attachments: TicketAttachment[] }>;
  getEvidence?(ticket: number): Promise<{ ticket: number; completionEvidence: string | null }>;
  setDescription?(ticket: number, filePath: string): Promise<unknown>;
  setState?(ticket: number, desiredState: string, expectedState: string, allowCompletion?: boolean, expectedRevision?: number): Promise<unknown>;
  setEffort?(ticket: number, realEffort: number, realEffortHours: number, expectedRevision: number): Promise<unknown>;
  linkPullRequest?(hu: number, ticket: number, pullRequest: number): Promise<unknown>;
  linkCommit?(ticket: number, pullRequest: number): Promise<unknown>;
  addAttachment?(ticket: number, filePath: string, kind: EvidenceKind): Promise<unknown>;
  setEvidence?(ticket: number, filePath: string): Promise<unknown>;
}>;

interface RetryTimer { wait(milliseconds: number): Promise<void>; }
interface Clock { now(): number; }
interface TicketBranchCleaner {
  deleteTicketBranch(ticketBranch: string, integrationBranch: string, workingDirectory: string): Promise<void>;
}

type CompletionEffectRunner = (
  effect: AutocodeEffect,
  target: string,
  action: () => Promise<void>,
) => Promise<void>;

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
const IMPLEMENTATION_READY_MARKER = "IMPLEMENTATION_READY";
const QUEUE_EMPTY_MARKER = "QUEUE_EMPTY";
const WORKFLOW_STEP_FINISHED_MARKER = "WORKFLOW_STEP_FINISHED";
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
    normasSag: args.includes("--normas-sag"),
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
    "  Azure ticket delivery run: el coordinador posee la entrega; OpenCode solo implementa, valida, revisa, commitea y genera el manifest",
    "  --number-of-questions <count>",
    "  --normas-sag                 carga normas SAG de planning desde master remoto; requiere .sag/config.json",
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
    private readonly clock: Clock = { now: Date.now },
    private readonly sagNormsService: Pick<SagNormsService, "loadPlanning"> = new SagNormsService(),
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

    if (options.normasSag && command !== "plan") {
      reportOperator("--normas-sag solo se permite con plan");
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
    let norms: SagNormsContext | null = null;
    if (options.normasSag) {
      try {
        norms = await this.sagNormsService.loadPlanning(options.workingDirectory);
      } catch (error) {
        reportOperator(`lazy-workflow: no se pudo cargar el contexto SAG (${errorMessage(error)}); ejecucion detenida.`);
        return 1;
      }
    }

    options.prompt = [
      JSON.stringify(huInfo),
      await readPrompt("autoplan"),
      ...(norms ? [this.formatSagContext(norms)] : []),
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
    let norms: SagNormsContext | null = null;
    if (options.normasSag) {
      try {
        norms = await this.sagNormsService.loadPlanning(options.workingDirectory);
      } catch (error) {
        reportOperator(`lazy-workflow: no se pudo cargar el contexto SAG (${errorMessage(error)}); ejecucion detenida.`);
        return 1;
      }
    }
    const prompt = [
      await readPrompt("default"),
      `Selected workflow: ${command}`,
      ...(norms ? [this.formatSagContext(norms)] : []),
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

  private formatSagContext(context: SagNormsContext): string {
    return [
      "SAG norms context (traceable retrieval metadata; normative text must be read from the listed source):",
      JSON.stringify(context, null, 2),
    ].join("\n");
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

  private async applyTicketCompletion(options: CliOptions, runEffect: CompletionEffectRunner = async (_effect, _target, action) => action()): Promise<unknown> {
    if (!this.huInfoService.getTicketInfo || !this.huInfoService.validateDirectTicketContext
      || !this.huInfoService.readCompletionManifest || !this.huInfoService.validateCompletionManifest) {
      throw new Error("El servicio Azure no soporta ticket-completion-apply");
    }
    if (!this.huInfoService.linkPullRequest || !this.huInfoService.linkCommit || !this.huInfoService.addAttachment
      || !this.huInfoService.setEvidence || !this.huInfoService.setState
      || !this.huInfoService.validateEvidenceFile || !this.huInfoService.validateEvidence) {
      throw new Error("El servicio Azure no expone todas las primitivas de completion");
    }

    await this.huInfoService.validateDirectTicketContext(options.hu!, options.ticket!);
    let info = await this.huInfoService.getTicketInfo(options.hu!, options.ticket!);
    const manifest = await this.huInfoService.readCompletionManifest(options.manifest!, options.workingDirectory);
    await this.huInfoService.validateCompletionManifest(manifest, info, options.ticket!, options.workingDirectory);

    const unreconcilableGates = info.gates.unmet.filter((gate) =>
      gate === COMPLETION_GATE.realEffort
      || gate === COMPLETION_GATE.realEffortHours
    );
    if (unreconcilableGates.length > 0) {
      throw new Error(`No se puede completar el ticket ${options.ticket}; faltan datos previos: ${unreconcilableGates.join(", ")}`);
    }

    for (const evidence of manifest.evidence) {
      await this.huInfoService.validateEvidenceFile(evidence.path, evidence.kind);
    }
    const textEvidence = manifest.evidence.find(({ kind }) => kind !== "screen");
    const completionEvidenceMissing = !info.completionEvidence;
    if (!textEvidence && completionEvidenceMissing) {
      throw new Error("El manifest no contiene evidencia textual para completion-evidence");
    }
    if (textEvidence) {
      await this.huInfoService.validateEvidence(options.ticket!, textEvidence.path);
    }

    if (info.canonicalPullRequest !== null && info.canonicalPullRequest !== options.pullRequest) {
      throw new Error(`El ticket ${options.ticket} ya tiene otro PR canónico asociado: ${info.canonicalPullRequest}`);
    }
    if (info.canonicalPullRequest === null) {
      await runEffect("pr-association", `${options.pullRequest}`, () => this.huInfoService!.linkPullRequest!(options.hu!, options.ticket!, options.pullRequest!).then(() => undefined));
      info = await this.huInfoService.getTicketInfo(options.hu!, options.ticket!);
    }

    if (info.gates.unmet.includes(COMPLETION_GATE.mergeCommitArtifact)) {
      await runEffect("merge-commit", `${options.pullRequest}`, () => this.huInfoService!.linkCommit!(options.ticket!, options.pullRequest!).then(() => undefined));
      info = await this.huInfoService.getTicketInfo(options.hu!, options.ticket!);
    }

    for (const evidence of manifest.evidence) {
      if (info.attachments.some((attachment) =>
        typeof attachment.url === "string"
        && attachment.url.trim().length > 0
        && attachment.digest?.toLowerCase() === evidence.sha256.toLowerCase()
        && attachment.evidenceKind === evidence.kind
      )) continue;
      await runEffect("attachment", evidence.sha256, () => this.huInfoService!.addAttachment!(options.ticket!, evidence.path, evidence.kind).then(() => undefined));
       info = await this.huInfoService.getTicketInfo(options.hu!, options.ticket!);
    }

    if (textEvidence && completionEvidenceMissing) {
      await runEffect("evidence", textEvidence.path, () => this.huInfoService!.setEvidence!(options.ticket!, textEvidence.path).then(() => undefined));
      info = await this.huInfoService.getTicketInfo(options.hu!, options.ticket!);
    }

    const unmetBeforeDone = info.gates.unmet.filter((gate) => gate !== COMPLETION_GATE.ticketState);
    if (unmetBeforeDone.length > 0) {
      throw new Error(`No se puede completar el ticket ${options.ticket}; gates incumplidos: ${unmetBeforeDone.join(", ")}`);
    }

    if (info.ticket.state !== "Done") {
      await runEffect("ticket-done", "Done", () => this.huInfoService!.setState!(options.ticket!, "Done", info.ticket.state ?? "", true, info.ticket.revision).then(() => undefined));
      info = await this.huInfoService.getTicketInfo(options.hu!, options.ticket!);
    }
    if (info.ticket.state !== "Done" || info.gates.unmet.length > 0) {
      throw new Error(`No se pudo verificar la finalización del ticket ${options.ticket}`);
    }
    return { hu: options.hu, ticket: options.ticket, pullRequest: options.pullRequest, manifest: options.manifest, state: "Done", gates: info.gates };
  }

  private async validateReadyManifest(
    hu: number,
    ticket: number,
    manifestPath: string,
    workingDirectory: string,
  ): Promise<CompletionManifest> {
    if (!this.huInfoService.validateDirectTicketContext || !this.huInfoService.getTicketInfo
      || !this.huInfoService.readCompletionManifest || !this.huInfoService.validateCompletionManifest) {
      throw new Error("El servicio Azure no soporta la validación del manifest de implementación");
    }
    await this.huInfoService.validateDirectTicketContext(hu, ticket);
    const info = await this.huInfoService.getTicketInfo(hu, ticket);
    const manifest = await this.huInfoService.readCompletionManifest(manifestPath, workingDirectory);
    await this.huInfoService.validateCompletionManifest(manifest, info, ticket, workingDirectory);
    return manifest;
  }

  private async runAzureCode(options: CliOptions): Promise<number> {
    const checkpoint = await this.checkpointStore.read(options.workingDirectory);
    if (options.session !== null && checkpoint === null) {
      reportOperator("lazy-workflow: no existe un checkpoint para la sesión solicitada.");
      return 1;
    }
    return this.runVersionedAzureCode(options, checkpoint);
  }

  private async runVersionedAzureCode(
    options: CliOptions,
    initialCheckpoint: StoredAutocodeCheckpoint | null,
  ): Promise<number> {
    const now = (): number => this.clock.now();
    const migrated = initialCheckpoint ? migrateAutocodeCheckpoint(initialCheckpoint, now()) : null;
    let checkpoint: VersionedAutocodeCheckpoint = migrated ?? {
      schemaVersion: 2,
      workflow: "autocode",
      phase: "preflight-hu",
      hu: options.hu!,
      ticket: null,
      integrationBranch: null,
      ticketBranch: null,
      azureRevision: null,
      effortBaseline: { real: 0, realHours: 0 },
      activeDurationMs: 0,
      activeSince: null,
      sessionId: null,
      intent: null,
      receipts: {},
    };
    const save = async (): Promise<void> => { await this.checkpointStore.write(checkpoint, options.workingDirectory); };
    const markPhase = async (phase: AutocodePhase, fields: Partial<VersionedAutocodeCheckpoint> = {}): Promise<void> => {
      checkpoint = { ...checkpoint, ...fields, phase, activeSince: null };
      await save();
    };
    const track = async <T>(effect: AutocodeEffect | null, action: () => Promise<T>, target = effect ?? ""): Promise<T> => {
      const started = now();
      checkpoint = {
        ...checkpoint,
        activeSince: new Date(started).toISOString(),
        intent: effect ? { effect, target } : null,
      };
      await save();
      try {
        const result = await action();
        const finished = now();
        checkpoint = {
          ...checkpoint,
          activeDurationMs: checkpoint.activeDurationMs + Math.max(0, finished - started),
          activeSince: null,
          intent: null,
          ...(effect ? { receipts: { ...checkpoint.receipts, [effect]: { verifiedAt: new Date(finished).toISOString() } } } : {}),
        };
        await save();
        return result;
      } catch (error) {
        const finished = now();
        checkpoint = {
          ...checkpoint,
          activeDurationMs: checkpoint.activeDurationMs + Math.max(0, finished - started),
          activeSince: null,
        };
        await save();
        throw error;
      }
    };

    if (options.hu !== null && checkpoint.hu !== options.hu) {
      reportOperator(`lazy-workflow: la HU ${options.hu} no coincide con la HU fijada ${checkpoint.hu}.`);
      return 1;
    }
    if (options.session !== null && checkpoint.sessionId !== options.session) {
      reportOperator("lazy-workflow: la sesión no coincide con el checkpoint fijado.");
      return 1;
    }
    if (options.session === null && checkpoint.sessionId !== null) {
      reportOperator(`lazy-workflow: el ticket ${checkpoint.ticket ?? "fijado"} conserva una sesión activa; reanúdala con --session.`);
      return 1;
    }
    const hu = checkpoint.hu;
    let integrationBranch = checkpoint.integrationBranch;
    try {
      if (!integrationBranch) {
        await markPhase("preflight-hu");
        integrationBranch = await track(
          "hu-integration-branch",
          async () => this.huInfoService.ensureIntegrationBranch!(hu, options.workingDirectory, options.baseBranch),
          `refs/heads/hu/${hu}`,
        );
        if (!integrationBranch) {
          reportOperator(`lazy-workflow: no se encontró la rama de integración para la HU ${hu}; ejecución detenida.`);
          return 1;
        }
      }
      checkpoint = { ...checkpoint, integrationBranch };
      if (checkpoint.phase === "preflight-hu") await markPhase("selected", { integrationBranch });
    } catch (error) {
      reportOperator(`lazy-workflow: no se pudo preparar la rama de integración de la HU ${hu} (${errorMessage(error)}); ejecución detenida.`);
      return 1;
    }

    if (checkpoint.ticket !== null && checkpoint.sessionId !== null && this.huInfoService.getTicketInfo) {
      try {
        const live = await this.huInfoService.getTicketInfo(hu, checkpoint.ticket);
        if (live.canonicalPullRequest !== null) {
          checkpoint = {
            ...checkpoint,
            phase: "integrating",
            sessionId: null,
            pullRequest: live.canonicalPullRequest,
          };
          await save();
          if (!checkpoint.manifestPath) {
            reportOperator(`lazy-workflow: el ticket ${checkpoint.ticket} tiene un PR canónico, pero falta su manifest; checkpoint sessionless conservado.`);
            return 1;
          }
        }
      } catch (error) {
        reportOperator(`lazy-workflow: no se pudo reconciliar el PR canónico del ticket ${checkpoint.ticket} (${errorMessage(error)}); ejecución detenida.`);
        return 1;
      }
    }

    if ((checkpoint.phase === "implementing" || checkpoint.phase === "reconciling") && checkpoint.ticket !== null && checkpoint.sessionId === null && !checkpoint.manifestPath) {
      if (!this.huInfoService.getAutocodeContextForTicket) return 1;
      const context = await this.huInfoService.getAutocodeContextForTicket(hu, checkpoint.ticket, integrationBranch);
      if (!context || !this.huInfoService.verifyTicketCompletion) {
        reportUnmetCompletion(checkpoint.ticket, { ticketId: checkpoint.ticket, unmetGates: [COMPLETION_GATE.pinnedTicketContext] });
        return 1;
      }
      const verification = await this.huInfoService.verifyTicketCompletion(context);
      if (!requireVerifiedCompletion(checkpoint.ticket, verification, `lazy-workflow: el ticket ${checkpoint.ticket} todavía no cumple el cierre verificable.`)) return 1;
      await this.cleanupCompletedTicketBranch(context, options.workingDirectory, verification.ticketBranch);
      await this.checkpointStore.clear(options.workingDirectory);
      return 0;
    }

    if (checkpoint.ticket !== null && checkpoint.sessionId === null && checkpoint.manifestPath
      && this.huInfoService.checkoutTicketBranch && this.huInfoService.pushTicketBranch && this.huInfoService.createOrReusePullRequest && this.huInfoService.getTicketInfo && this.huInfoService.setEffort
      && this.huInfoService.getAutocodeContextForTicket && checkpoint.ticketBranch) {
      const context = await this.huInfoService.getAutocodeContextForTicket(hu, checkpoint.ticket, integrationBranch);
      if (!context) {
        reportUnmetCompletion(checkpoint.ticket, { ticketId: checkpoint.ticket, unmetGates: [COMPLETION_GATE.pinnedTicketContext] });
        return 1;
      }
      try {
        const manifest = await this.validateReadyManifest(hu, checkpoint.ticket, checkpoint.manifestPath, options.workingDirectory);
        checkpoint = {
          ...checkpoint,
          localCommit: manifest.commit,
          manifestDigests: manifest.evidence.map(({ sha256 }) => sha256.toLowerCase()),
        };
        await save();
        const runRecoveryEffect: CompletionEffectRunner = async (effect, target, action) => {
          const started = now();
          checkpoint = { ...checkpoint, intent: { effect, target } };
          await save();
          try {
            await action();
            const finished = now();
            checkpoint = {
              ...checkpoint,
              activeDurationMs: checkpoint.activeDurationMs + Math.max(0, finished - started),
              intent: null,
              receipts: { ...checkpoint.receipts, [effect]: { verifiedAt: new Date(finished).toISOString() } },
            };
            await save();
          } catch (error) {
            checkpoint = { ...checkpoint, activeDurationMs: checkpoint.activeDurationMs + Math.max(0, now() - started) };
            await save();
            throw error;
          }
        };
        if (!checkpoint.receipts["ticket-branch-checkout"]) {
          await runRecoveryEffect("ticket-branch-checkout", checkpoint.ticketBranch!, () =>
            this.huInfoService!.checkoutTicketBranch!(checkpoint.ticketBranch!, options.workingDirectory));
        }
        if (!checkpoint.receipts["ticket-branch-push"]) {
          await runRecoveryEffect("ticket-branch-push", checkpoint.ticketBranch!, () =>
            this.huInfoService!.pushTicketBranch!(checkpoint.ticketBranch!, options.workingDirectory));
        }
        let pullRequest = checkpoint.pullRequest
          ? { pullRequest: checkpoint.pullRequest, mergeCommit: checkpoint.mergeCommit ?? null }
          : null;
        if (!pullRequest) {
          await runRecoveryEffect("pull-request", `${checkpoint.ticket}`, async () => {
            pullRequest = await this.huInfoService!.createOrReusePullRequest!(hu, checkpoint.ticket!);
          });
        }
        if (!pullRequest) throw new Error("No se pudo resolver el PR de integración");
        checkpoint = { ...checkpoint, phase: "integrating", pullRequest: pullRequest.pullRequest, mergeCommit: pullRequest.mergeCommit };
        await save();
        if (!checkpoint.receipts["ticket-effort"]) {
          const state = this.huInfoService.getState ? await this.huInfoService.getState(checkpoint.ticket!) : { revision: checkpoint.azureRevision };
          const activeHours = Math.max(0.25, Math.ceil(checkpoint.activeDurationMs / 900_000) / 4);
          await runRecoveryEffect(
            "ticket-effort",
            `${checkpoint.effortBaseline.real + activeHours}/${checkpoint.effortBaseline.realHours + activeHours}`,
            () => this.huInfoService!.setEffort!(
              checkpoint.ticket!,
              checkpoint.effortBaseline.real + activeHours,
              checkpoint.effortBaseline.realHours + activeHours,
              state.revision ?? 0,
            ).then(() => undefined),
          );
        }
        if (!checkpoint.receipts["ticket-completion"]) {
          checkpoint = { ...checkpoint, phase: "evidencing" };
          await save();
          const runEffect: CompletionEffectRunner = async (effect, target, action) => {
            if (effect === "ticket-done") {
              checkpoint = { ...checkpoint, phase: "completing" };
              await save();
            }
            await runRecoveryEffect(effect, target, action);
          };
          await this.applyTicketCompletion({ ...options, pullRequest: pullRequest.pullRequest, manifest: checkpoint.manifestPath! }, runEffect);
          checkpoint = { ...checkpoint, phase: "cleaning", receipts: { ...checkpoint.receipts, "ticket-completion": { verifiedAt: new Date(now()).toISOString() } } };
          await save();
        }
        await this.cleanupCompletedTicketBranch(context, options.workingDirectory, checkpoint.ticketBranch!);
        await this.checkpointStore.clear(options.workingDirectory);
        return this.runVersionedAzureCode({ ...options, session: null }, null);
      } catch (error) {
        reportOperator(`lazy-workflow: no se pudo reconciliar determinísticamente el ticket ${checkpoint.ticket} (${errorMessage(error)}); checkpoint conservado.`);
        return 1;
      }
    }

    let context: AutocodeContext | null = null;
    if (checkpoint.ticket !== null) {
      if (!this.huInfoService.getAutocodeContextForTicket) {
        reportOperator(`lazy-workflow: no se puede reconstruir el ticket ${checkpoint.ticket} fijado; ejecución detenida.`);
        return 1;
      }
      context = await this.huInfoService.getAutocodeContextForTicket(hu, checkpoint.ticket, integrationBranch);
    } else if (this.huInfoService.getAutocodeState) {
      await markPhase("selected", { integrationBranch });
      const state = await this.huInfoService.getAutocodeState(hu, integrationBranch);
      if (!state.context) {
        if (state.pending) {
          reportOperator(`lazy-workflow: no hay un ticket elegible todavía para la HU ${hu}.`);
          return 1;
        }
        reportOperator(`lazy-workflow: no hay tickets pendientes para la HU ${hu}.`);
        await this.checkpointStore.clear(options.workingDirectory);
        return 0;
      }
      context = state.context;
    }
    if (!context || context.hu.id !== hu || context.integrationBranch !== integrationBranch || !integrationBranch) {
      reportOperator(`lazy-workflow: no se pudo reconstruir el ticket fijado de la HU ${hu}.`);
      return 1;
    }

    const ticket = context.ticket.id;
    checkpoint = { ...checkpoint, hu, ticket, integrationBranch };
    await save();
    const stateInfo = this.huInfoService.getState ? await this.huInfoService.getState(ticket) : { ticket, state: context.ticket.state ?? null, revision: context.ticket.revision ?? null };
    const effortInfo = this.huInfoService.getEffort ? await this.huInfoService.getEffort(ticket) : { ticket, effort: context.ticket.effort ?? {} };
    const azureRevision = checkpoint.azureRevision ?? stateInfo.revision ?? context.ticket.revision ?? null;
    const effortBaseline = {
      real: checkpoint.receipts["ticket-selected"] ? checkpoint.effortBaseline.real : effortInfo.effort.real ?? context.ticket.effort?.real ?? 0,
      realHours: checkpoint.receipts["ticket-selected"] ? checkpoint.effortBaseline.realHours : effortInfo.effort.realHours ?? context.ticket.effort?.realHours ?? 0,
    };
    await markPhase(checkpoint.phase === "preflight-hu" ? "selected" : checkpoint.phase, {
      hu,
      ticket,
      integrationBranch,
      azureRevision,
      effortBaseline,
      receipts: { ...checkpoint.receipts, "ticket-selected": { verifiedAt: new Date(now()).toISOString() } },
    });

    let ticketBranch = checkpoint.ticketBranch;
    const existingBranch = this.huInfoService.getBranch
      ? await this.huInfoService.getBranch(hu, ticket)
      : null;
    ticketBranch = ticketBranch ?? existingBranch?.branch ?? `refs/heads/ticket/${ticket}`;
    if (existingBranch?.integrationBranch !== null && existingBranch?.integrationBranch !== undefined && existingBranch.integrationBranch !== integrationBranch) {
      reportOperator(`lazy-workflow: la rama de integración del ticket ${ticket} no coincide con la HU fijada; ejecución detenida.`);
      return 1;
    }
    if (checkpoint.receipts["ticket-state"] && stateInfo.state !== "En progreso" && stateInfo.state !== "In Progress") {
      reportOperator(`lazy-workflow: el recibo de estado del ticket ${ticket} no coincide con Azure; ejecución detenida.`);
      return 1;
    }
    if (checkpoint.receipts["ticket-branch"] && existingBranch?.branch !== ticketBranch) {
      reportOperator(`lazy-workflow: el recibo de rama del ticket ${ticket} no coincide con Azure; ejecución detenida.`);
      return 1;
    }
    await markPhase("started", { ticketBranch });
    if (!checkpoint.receipts["ticket-state"] && stateInfo.state !== "En progreso" && stateInfo.state !== "In Progress") {
      if (!this.huInfoService.setState) return 1;
      await track("ticket-state", () => this.huInfoService.setState!(
        ticket,
        "En progreso",
        stateInfo.state ?? context!.ticket.state ?? "Active",
        false,
        azureRevision ?? undefined,
      ).then(() => undefined), "En progreso");
    } else {
      checkpoint = { ...checkpoint, receipts: { ...checkpoint.receipts, "ticket-state": { verifiedAt: new Date(now()).toISOString() } } };
      await save();
    }
    if (!this.huInfoService.setTicketBranch) return 1;
    if (checkpoint.receipts["ticket-branch"] && existingBranch?.branch === ticketBranch) {
      await track("ticket-branch", () => this.huInfoService!.setTicketBranch!(hu, ticket, ticketBranch!, options.workingDirectory).then(() => undefined), ticketBranch);
    } else if (!checkpoint.receipts["ticket-branch"] && (!existingBranch?.branch || existingBranch.branch !== ticketBranch)) {
      await track("ticket-branch", () => this.huInfoService.setTicketBranch!(hu, ticket, ticketBranch!, options.workingDirectory).then(() => undefined), ticketBranch);
    } else {
      checkpoint = { ...checkpoint, receipts: { ...checkpoint.receipts, "ticket-branch": { verifiedAt: new Date(now()).toISOString() } } };
      await save();
    }
    if (this.huInfoService.checkoutTicketBranch) {
      await track(
        "ticket-branch-checkout",
        () => this.huInfoService!.checkoutTicketBranch!(ticketBranch!, options.workingDirectory),
        ticketBranch,
      );
    }
    await markPhase("implementing", { ticketBranch, sessionId: checkpoint.sessionId });

    let manifestPath = checkpoint.manifestPath ?? null;
    if (!manifestPath && this.huInfoService.getCompletionManifestPath) {
      manifestPath = await this.huInfoService.getCompletionManifestPath(options.workingDirectory);
      checkpoint = { ...checkpoint, manifestPath };
      await save();
    }
    let sessionId = options.session ?? checkpoint.sessionId;
    let resumePrompt = options.prompt;
    while (true) {
      try {
        const execution = await track(null, async () => sessionId
          ? { result: await this.openCodeService.resume(sessionId, resumePrompt, options.workingDirectory, IMPLEMENTATION_READY_MARKER), azureLoginRequired: false, failed: false }
          : this.openCodeService.run({ ...options, prompt: [await readPrompt("autocode"), JSON.stringify({
            ...context,
            ticketBranch,
            evidenceDirectory: manifestPath ? dirname(manifestPath) : null,
            manifestPath,
            workflowPhase: checkpoint.phase,
            completionGates: Object.values(COMPLETION_GATE),
          }), `The working directory is ${options.workingDirectory}`, "Supplemental operator request (non-authoritative):", options.prompt].join("\n"), session: null, terminalMarker: IMPLEMENTATION_READY_MARKER }, true));
        sessionId = execution.result.sessionId;
        const terminal = containsMarker(execution.result.text, IMPLEMENTATION_READY_MARKER);
        checkpoint = { ...checkpoint, sessionId: terminal ? null : sessionId };
        await save();
        if (execution.azureLoginRequired) {
          await this.huInfoService.waitForAccess(hu);
          resumePrompt = "continue";
          continue;
        }
        if (terminal) {
          if (manifestPath && this.huInfoService.checkoutTicketBranch && this.huInfoService.pushTicketBranch && this.huInfoService.createOrReusePullRequest && this.huInfoService.getTicketInfo && this.huInfoService.setEffort) {
            try {
              const manifest = await this.validateReadyManifest(hu, ticket, manifestPath, options.workingDirectory);
              checkpoint = {
                ...checkpoint,
                localCommit: manifest.commit,
                manifestDigests: manifest.evidence.map(({ sha256 }) => sha256.toLowerCase()),
              };
              await save();
              await markPhase("implementation-ready", { manifestPath, sessionId: null });
              await markPhase("integrating", { manifestPath, sessionId: null });
              if (!checkpoint.receipts["ticket-branch-checkout"]) {
                await track(
                  "ticket-branch-checkout",
                  () => this.huInfoService!.checkoutTicketBranch!(ticketBranch!, options.workingDirectory),
                  ticketBranch,
                );
              }
              await track(
                "ticket-branch-push",
                () => this.huInfoService!.pushTicketBranch!(ticketBranch!, options.workingDirectory),
                ticketBranch,
              );
              const pullRequest = await track(
                "pull-request",
                () => this.huInfoService!.createOrReusePullRequest!(hu, ticket),
                `${ticket}`,
              );
              checkpoint = { ...checkpoint, pullRequest: pullRequest.pullRequest, mergeCommit: pullRequest.mergeCommit };
              await save();

              const currentState = await this.huInfoService.getState!(ticket);
              const activeHours = Math.max(0.25, Math.ceil(checkpoint.activeDurationMs / 900_000) / 4);
              const targetReal = effortBaseline.real + activeHours;
              const targetRealHours = effortBaseline.realHours + activeHours;
              if (!checkpoint.receipts["ticket-effort"]) {
                await track(
                  "ticket-effort",
                  () => this.huInfoService!.setEffort!(ticket, targetReal, targetRealHours, currentState.revision ?? azureRevision ?? 0).then(() => undefined),
                  `${targetReal}/${targetRealHours}`,
                );
              }

              await markPhase("evidencing", { pullRequest: pullRequest.pullRequest });
              await this.applyTicketCompletion(
                { ...options, pullRequest: pullRequest.pullRequest, manifest: manifestPath },
                async (effect, target, action) => {
                  if (effect === "ticket-done") await markPhase("completing", { pullRequest: pullRequest.pullRequest });
                  await track(effect, action, target);
                },
              );
              checkpoint = { ...checkpoint, receipts: { ...checkpoint.receipts, "ticket-completion": { verifiedAt: new Date(now()).toISOString() } } };
              await save();
              await markPhase("cleaning", { pullRequest: pullRequest.pullRequest });
              await this.cleanupCompletedTicketBranch(context, options.workingDirectory, ticketBranch!);
              await this.checkpointStore.clear(options.workingDirectory);
              return this.runVersionedAzureCode({ ...options, session: null }, null);
            } catch (error) {
              reportOperator(`lazy-workflow: no se pudo completar determinísticamente el ticket ${ticket} después del marcador (${errorMessage(error)}); checkpoint conservado.`);
              return 1;
            }
          }
          reportOperator(`lazy-workflow: el coordinador no expone todas las primitivas de completion para el ticket ${ticket}; ejecución detenida.`);
          return 1;
        }
        if (execution.failed) throw new Error("OpenCode termino con error");
        await this.retryTimer.wait(10_000);
        resumePrompt = options.prompt;
      } catch (error) {
        if (error instanceof OpenCodeSessionNotFoundError || error instanceof OpenCodeSessionCloseError) {
          checkpoint = { ...checkpoint, phase: "reconciling", sessionId: null, activeSince: null, intent: null };
          await save();
          reportOperator(`lazy-workflow: la sesión ${error.sessionId} no está disponible; checkpoint sessionless conservado para reconciliación.`);
          return 1;
        }
        reportOperator(`lazy-workflow: OpenCode falló (${errorMessage(error)}); conservaré el checkpoint y reintentaré en 10s.`);
        await this.retryTimer.wait(10_000);
        resumePrompt = options.prompt;
      }
    }
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
