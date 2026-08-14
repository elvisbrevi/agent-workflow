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
import type { CompletionManifest, TicketInfo, TicketAttachment, EvidenceKind } from "../azure/ticket-info-service.ts";
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
import { reportOperator, setDefaultReporter } from "../output/operator-output.ts";
import { createReporter, type Reporter } from "../output/reporter.ts";
import { GitTicketBranchCleaner, runGit, type GitRunner } from "../git/git-ticket-branch-cleaner.ts";
import { SagNormsService, type SagArchitectureReviewContext, type SagCodingContext, type SagNormsContext } from "../sag/sag-norms-service.ts";
import { DeploymentAuthenticationRequiredError, SagDeploymentService, sanitizeDeploymentText, type DeploymentEnvironment, type DeploymentScope } from "../sag/deployment-service.ts";
import { InfrastructureAuthenticationRequiredError, SagInfrastructureService, type InfrastructureScope } from "../sag/infrastructure-service.ts";
import { GitHubArchitectureReviewService, type ArchitectureReviewPublication, type ArchitectureReviewTicket, type ArchitectureReviewTracker } from "../github/architecture-review-service.ts";
import {
  GitHubManagedQueueService,
  type GitHubManagedQueueAdapter,
  type GitHubRepositoryContext,
  type SelectedManagedIssue,
  type ManagedQueueOutcome,
} from "../github/managed-queue-service.ts";
import {
  GitHubDeliveryCheckpointStore,
  type GitHubCheckpointStore,
  type GitHubDeliveryCheckpoint,
} from "../github/github-delivery-checkpoint.ts";
import {
  GitHubDeliveryService,
  type GitHubDeliveryAdapter,
} from "../github/github-delivery-service.ts";
import {
  GitHubParentReconciliationService,
  type GitHubParentReconciliationAdapter,
} from "../github/github-parent-reconciliation-service.ts";
import { GitHubRepositoryLockService, type GitHubRepositoryLockBoundary } from "../github/github-repository-lock.ts";
import {
  buildCli,
  type CliOptions as ParsedCliOptions,
  type CliParseResult,
  type CliParser,
} from "./parse-cli-options.ts";

type CliOptions = OpenCodeRunOptions & ParsedCliOptions;

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
  publishArchitectureFindings?(hu: number, specification: { title: string; body: string }, tickets: ArchitectureReviewTicket[]): Promise<ArchitectureReviewPublication>;
  publishInfrastructureFindings?(hu: number, specification: { title: string; body: string }, tickets: ArchitectureReviewTicket[]): Promise<ArchitectureReviewPublication>;
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

function deploymentErrorMessage(error: unknown): string {
  return sanitizeDeploymentText(errorMessage(error));
}

function isAuthenticationError(error: unknown): boolean {
  return /(?:authentication|authorization|unauthorized|forbidden|access token|login|\b401\b|\b403\b)/i.test(errorMessage(error));
}

function sanitizeDeploymentOutput(value: unknown): unknown {
  if (typeof value === "string") return deploymentErrorMessage(value);
  if (Array.isArray(value)) return value.map(sanitizeDeploymentOutput);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      key,
      /authorization|token|password|secret|cookie|pat|api[-_ ]?key/i.test(key) ? "[REDACTED]" : sanitizeDeploymentOutput(nested),
    ]));
  }
  return value;
}

function containsMarker(text: string, marker: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim() === marker);
}

interface ArchitectureReviewResult {
  status: "clean" | "findings";
  summary: string;
  specification?: { title: string; body: string };
  tickets?: Array<{ title: string; body: string }>;
}

function parseArchitectureReviewResult(text: string): ArchitectureReviewResult {
  const marker = "ARCHITECTURE_REVIEW_RESULT";
  const lines = text.split(/\r?\n/);
  const markerLine = lines.findIndex((line) => line.trim() === marker);
  if (markerLine < 0) throw new Error(`OpenCode no devolvio ${marker}`);
  const result = JSON.parse(lines.slice(markerLine + 1).join("\n").trim()) as ArchitectureReviewResult;
  if ((result.status !== "clean" && result.status !== "findings") || typeof result.summary !== "string") {
    throw new Error("resultado de architecture-review-sag invalido");
  }
  if (result.status === "findings" && (!result.specification || typeof result.specification.title !== "string" || typeof result.specification.body !== "string" || !Array.isArray(result.tickets))) {
    throw new Error("architecture-review-sag reporto hallazgos sin specification o tickets");
  }
  return result;
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

const TICKET_COMPLETED_MARKER = "TICKET_COMPLETED";
const IMPLEMENTATION_READY_MARKER = "IMPLEMENTATION_READY";
const QUEUE_EMPTY_MARKER = "QUEUE_EMPTY";
const QUEUE_BLOCKED_MARKER = "QUEUE_BLOCKED";
const WORKFLOW_STEP_FINISHED_MARKER = "WORKFLOW_STEP_FINISHED";
const RECONCILIATION_REQUIRED_MARKER = "RECONCILIATION_REQUIRED";
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
const INFRASTRUCTURE_FLAGS = new Set([
  "--hu", "--issue",
  "--model", "--variant", "--prompt",
  "--working-directory",
  "--verbose", "--quiet", "--no-color",
]);

function isValidHu(hu: number | null): hu is number {
  return hu !== null && Number.isInteger(hu) && hu > 0;
}

function readPrompt(name: "default" | "autoplan" | "autocode" | "architecture-review-sag"): Promise<string> {
  return Bun.file(new URL(`../../prompts/${name}-prompt.md`, import.meta.url)).text();
}

function parseCli(args: string[], parser: CliParser): CliParseResult {
  let result: CliParseResult | undefined;
  result = parser(args, {
    onHelp: (output) => {
      console.log(output);
      return 0;
    },
    onError: (message) => {
      reportOperator(`lazy-workflow: ${message}`);
      return 1;
    },
  });
  return result;
}

export class LazyWorkflowCli {
  private readonly githubCheckpointStore: GitHubCheckpointStore | null;
  private readonly githubRepositoryLock: GitHubRepositoryLockBoundary | null;
  private readonly githubDelivery: GitHubDeliveryAdapter | null;
  private readonly githubParentReconciliation: GitHubParentReconciliationAdapter | null;

  constructor(
    private readonly huInfoService: AzureBoundary = new AzureAutocodeService(),
    private readonly openCodeService: Pick<OpenCodeService, "run" | "resume"> = new OpenCodeService(),
    private readonly checkpointStore: AutocodeCheckpointStore = new GitAutocodeCheckpointStore(),
    private readonly retryTimer: RetryTimer = { wait: Bun.sleep },
    private readonly ticketBranchCleaner: TicketBranchCleaner = new GitTicketBranchCleaner(),
    private readonly clock: Clock = { now: Date.now },
    private readonly sagNormsService: Pick<SagNormsService, "loadPlanning"> & Partial<Pick<SagNormsService, "loadCoding" | "loadArchitectureReview" | "loadDeployment" | "loadInfrastructure">> = new SagNormsService(),
    private readonly git: GitRunner = runGit,
    private readonly githubTracker: ArchitectureReviewTracker = new GitHubArchitectureReviewService(),
    private readonly deploymentService: Pick<SagDeploymentService, "deploy"> = new SagDeploymentService(),
    private readonly infrastructureService: Pick<SagInfrastructureService, "verify"> = new SagInfrastructureService(),
    private readonly cliParser: CliParser = buildCli(),
    private readonly createReporterFn: typeof createReporter = createReporter,
    private readonly githubManagedQueue: GitHubManagedQueueAdapter = new GitHubManagedQueueService(),
    githubCheckpointStore?: GitHubCheckpointStore,
    githubRepositoryLock?: GitHubRepositoryLockBoundary,
    githubDelivery?: GitHubDeliveryAdapter,
    githubParentReconciliation?: GitHubParentReconciliationAdapter,
  ) {
    const coordinatorEnabled = githubManagedQueue instanceof GitHubManagedQueueService
      || githubCheckpointStore !== undefined
      || githubRepositoryLock !== undefined;
    this.githubCheckpointStore = coordinatorEnabled
      ? githubCheckpointStore ?? new GitHubDeliveryCheckpointStore()
      : null;
    this.githubRepositoryLock = coordinatorEnabled
      ? githubRepositoryLock ?? new GitHubRepositoryLockService()
      : null;
    this.githubDelivery = coordinatorEnabled
      ? githubDelivery ?? (githubManagedQueue instanceof GitHubManagedQueueService ? new GitHubDeliveryService() : null)
      : null;
    this.githubParentReconciliation = coordinatorEnabled
      ? githubParentReconciliation ?? (githubManagedQueue instanceof GitHubManagedQueueService ? new GitHubParentReconciliationService() : null)
      : null;
  }

  async run(args: string[]): Promise<number> {
    const parsed = parseCli(args, this.cliParser);
    if (parsed.kind === "help") {
      const requestedHelp = args.some((arg) => arg === "--help" || arg === "-h");
      return requestedHelp ? 0 : 1;
    }
    if (parsed.kind === "error") {
      return 1;
    }

    const options = parsed.options;
    this.applyReporter(options);

    const command = options.command;

    if (options.verbose && options.quiet) {
      reportOperator("--verbose y --quiet son mutuamente excluyentes");
      return 1;
    }

    if (options.normasSag && command !== "plan" && command !== "code") {
      reportOperator("--normas-sag solo se permite con plan o code");
      return 1;
    }

    if (options.issue !== null && command !== "architecture-review-sag" && command !== "deploy-sag" && command !== "infra-sag") {
      reportOperator("--issue solo se permite con infra-sag, architecture-review-sag o deploy-sag");
      return 1;
    }

    if (options.environment !== null && command !== "deploy-sag") {
      reportOperator("--environment solo se permite con deploy-sag");
      return 1;
    }

    if (command === "deploy-sag" && options.environment !== null && !options.environment?.trim()) {
       reportOperator("deploy-sag requiere --environment <dev|test|qa> cuando se proporciona --environment");
      return 1;
    }

    if (command === "architecture-review-sag") {
      if (options.hu !== null && options.issue !== null) {
        reportOperator("architecture-review-sag no permite combinar --hu y --issue");
        return 1;
      }
      if (options.hu === null && options.issue === null) {
        reportOperator("architecture-review-sag requiere --hu <id> o --issue <id>");
        return 1;
      }
      if (options.session !== null || options.branch !== null || options.baseBranch !== null) {
        reportOperator("architecture-review-sag no permite --session, --branch ni --base-branch");
        return 1;
      }
      return this.runArchitectureReview(options);
    }

    if (command === "infra-sag") {
      const unsupportedFlag = args.slice(1)
        .map((arg) => arg?.split("=", 1)[0])
        .find((arg): arg is string => typeof arg === "string" && arg.startsWith("--") && !INFRASTRUCTURE_FLAGS.has(arg));
      if (unsupportedFlag) {
        reportOperator(`infra-sag no permite ${unsupportedFlag}`);
        return 1;
      }
      if (options.hu !== null && options.issue !== null) {
        reportOperator("infra-sag no permite combinar --hu y --issue");
        return 1;
      }
      if (options.hu === null && options.issue === null) {
        reportOperator("infra-sag requiere --hu <id> o --issue <id>");
        return 1;
      }
      if (options.session !== null || options.branch !== null || options.baseBranch !== null) {
        reportOperator("infra-sag no permite --session, --branch ni --base-branch");
        return 1;
      }
      return this.runInfrastructure(options);
    }

    if (command === "deploy-sag") {
      if (options.environment !== null && args.filter((arg) => arg === "--environment" || arg.startsWith("--environment=")).length > 1) {
        reportOperator("deploy-sag no permite repetir --environment");
        return 1;
      }
      if (options.hu !== null && options.issue !== null) {
        reportOperator("deploy-sag no permite combinar --hu y --issue");
        return 1;
      }
      if (options.hu === null && options.issue === null) {
        reportOperator("deploy-sag requiere --hu <id> o --issue <id>");
        return 1;
      }
      const environment = options.environment?.trim().toLowerCase() ?? "dev";
      if (environment !== "dev" && environment !== "test" && environment !== "qa") {
        reportOperator("deploy-sag solo permite DEV, TEST o QA; PROD y sus aliases estan prohibidos");
        return 1;
      }
      if (options.session !== null || options.branch !== null || options.baseBranch !== null) {
        reportOperator("deploy-sag no permite --session, --branch ni --base-branch");
        return 1;
      }
      return this.runDeployment(options, environment);
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
      if (options.workingDirectory === process.cwd() && !args.some((arg) => arg === "--working-directory" || arg.startsWith("--working-directory="))) {
        reportOperator("ticket-branch-set requiere --working-directory <path>");
        return 1;
      }
      const workingDirectory = options.workingDirectory;
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

    let githubRecovery: GitHubDeliveryCheckpoint | null = null;
    if (command === "code" && options.hu === null && options.session !== null && this.githubCheckpointStore) {
      try {
        githubRecovery = await this.githubCheckpointStore.read(options.workingDirectory);
      } catch (error) {
        if (/ENOENT|posix_spawn ['"]git['"]/.test(errorMessage(error))) {
          githubRecovery = null;
        } else {
          console.log(JSON.stringify({ outcome: RECONCILIATION_REQUIRED_MARKER }, null, 2));
          reportOperator(`lazy-workflow: no se pudo leer el checkpoint GitHub (${errorMessage(error)}); ejecucion detenida.`);
          return 1;
        }
      }
    }
    const recoveringAzureCode = command === "code" && options.session !== null && githubRecovery === null;
    if (options.hu === null && !recoveringAzureCode && (options.branch !== null || options.baseBranch !== null)) {
      reportOperator("--branch y --base-branch solo se permiten en flujos Azure");
      return 1;
    }

    if (command === "code") {
      if (githubRecovery) return this.runGitHubRecovery(options, githubRecovery);
      if (recoveringAzureCode || options.hu !== null) return this.runAzureCode(options);
      return this.runDefaultWorkflow(command, options);
    }

    if (options.hu === null) return this.runDefaultWorkflow("plan", options);

    const huInfo = await this.huInfoService.getHuInfo(options.hu);
    const norms = await this.loadSagNorms(options, "planning");
    if (options.normasSag && norms === null) return 1;

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

  private applyReporter(options: ParsedCliOptions): void {
    const reporter = this.createReporterFn({
      verbose: options.verbose,
      quiet: options.quiet,
      noColor: options.noColor,
    });
    setDefaultReporter(reporter);
  }

  private async runDefaultWorkflow(command: "plan" | "code", options: CliOptions): Promise<number> {
    if (command === "plan") {
      const norms = await this.loadSagNorms(options, "planning");
      if (options.normasSag && norms === null) return 1;
      const prompt = [
        await readPrompt("default"),
        `Selected workflow: ${command}`,
        ...(norms ? [this.formatSagContext(norms)] : []),
        `The number of questions must be ${options.numberOfQuestions}`,
        `The working directory is ${options.workingDirectory}`,
        "Operator request:",
        options.prompt,
      ].join("\n");
      const execution = await this.openCodeService.run({ ...options, prompt, session: null }, false);
      console.log(JSON.stringify(execution.result, null, 2));
      return execution.failed ? 1 : 0;
    }

    return this.runDefaultCodeWorkflow(options);
  }

  private async runDefaultCodeWorkflow(options: CliOptions): Promise<number> {
    const store = this.githubCheckpointStore;
    const lock = this.githubRepositoryLock;
    if (!store || !lock) return this.runDefaultCodeWorkflowLoop(options, null);

    let release: (() => Promise<void>) | null = null;
    try {
      release = await lock.acquire(options.workingDirectory);
      const checkpoint = await store.read(options.workingDirectory);
      if (checkpoint) {
        if (checkpoint.sessionId) {
          return this.runGitHubRecovery({ ...options, session: checkpoint.sessionId }, checkpoint, true);
        }
        if (this.githubDelivery && ["started", "implementation-ready", "integrating", "reconciling", "cleaning"].includes(checkpoint.phase)) {
          return this.runGitHubRecovery(options, checkpoint, true);
        }
        this.reportGitHubReconciliationRequired(checkpoint);
        return 1;
      }
      await this.githubParentReconciliation?.reconcileOpenParents(options.workingDirectory);
      return this.runDefaultCodeWorkflowLoop(options, store);
    } catch (error) {
      console.log(JSON.stringify({ outcome: RECONCILIATION_REQUIRED_MARKER }, null, 2));
      reportOperator(`lazy-workflow: no se pudo coordinar la entrega GitHub (${errorMessage(error)}); ejecucion detenida.`);
      return 1;
    } finally {
      if (release) await release();
    }
  }

  private async runDefaultCodeWorkflowLoop(
    options: CliOptions,
    store: GitHubCheckpointStore | null,
  ): Promise<number> {
    while (true) {
      const norms = await this.loadSagNorms(options, "coding");
      if (options.normasSag && norms === null) return 1;
      const selectEligibleIssue = this.githubManagedQueue.selectEligibleIssue;
      const claimSelectedIssue = this.githubManagedQueue.claimSelectedIssue;
      let queueOutcome: ManagedQueueOutcome;
      let checkpointWasWritten = false;
      let receipts: GitHubDeliveryCheckpoint["receipts"] = { "issue-claim": { verifiedAt: new Date().toISOString() } };
      if (store && selectEligibleIssue && claimSelectedIssue) {
        const selection = await selectEligibleIssue(options.workingDirectory);
        if (selection.kind === "candidate") {
          receipts = {};
          await store.write({
            schemaVersion: 1,
            workflow: "github-code",
            repository: selection.repository.nameWithOwner,
            issue: selection.issue.number,
            phase: "selected",
            branch: null,
            sessionId: null,
            commit: null,
            pullRequest: null,
            receipts,
          }, options.workingDirectory);
          checkpointWasWritten = true;
          try {
            const claimedIssue = await claimSelectedIssue(selection.issue.number, options.workingDirectory);
            queueOutcome = { kind: "selected", issue: claimedIssue, repository: selection.repository };
          } catch (error) {
            console.log(JSON.stringify({ outcome: RECONCILIATION_REQUIRED_MARKER, issue: selection.issue.number, phase: "selected" }, null, 2));
            reportOperator(`lazy-workflow: no se pudo verificar el claim del Issue #${selection.issue.number} (${errorMessage(error)}); checkpoint conservado.`);
            return 1;
          }
          receipts = { "issue-claim": { verifiedAt: new Date().toISOString() } };
          await store.write({
            schemaVersion: 1,
            workflow: "github-code",
            repository: selection.repository.nameWithOwner,
            issue: selection.issue.number,
            phase: "selected",
            branch: null,
            sessionId: null,
            commit: null,
            pullRequest: null,
            receipts,
          }, options.workingDirectory);
        } else {
          queueOutcome = selection;
        }
      } else {
        queueOutcome = await this.githubManagedQueue.selectAndClaimEligibleIssue(options.workingDirectory);
      }
      if (queueOutcome.kind === "empty") {
        console.log(JSON.stringify({ outcome: QUEUE_EMPTY_MARKER }, null, 2));
        reportOperator("lazy-workflow: no quedan issues GitHub elegibles.");
        return 0;
      }
      if (queueOutcome.kind === "blocked") {
        const summary = queueOutcome.reasons.map(({ number, title, reasons }) =>
          `- #${number} ${title}: ${reasons.join(", ")}`
        ).join("\n");
        console.log(JSON.stringify({ outcome: QUEUE_BLOCKED_MARKER, reasons: queueOutcome.reasons }, null, 2));
        reportOperator(`lazy-workflow: la cola gestionada tiene issues no elegibles:\n${summary}`);
        return 0;
      }

      const issue = queueOutcome.issue;
      const repository = queueOutcome.repository;
      let branch: string | null = null;
      let baseBranch: string | null = null;
      let manifestPath: string | null = null;
      let commit: string | null = null;
      let pullRequest: number | null = null;
      let mergeCommit: string | null = null;
      let intent: GitHubDeliveryCheckpoint["intent"] = null;
      const saveCheckpoint = async (phase: GitHubDeliveryCheckpoint["phase"], sessionId: string | null = null): Promise<void> => {
        if (store) await store.write({
          schemaVersion: 1,
          workflow: "github-code",
          repository: repository.nameWithOwner,
          issue: issue.number,
          phase,
          branch,
          sessionId,
          commit,
          pullRequest,
          receipts,
          baseBranch,
          manifestPath,
          mergeCommit,
          intent,
        }, options.workingDirectory);
      };
      if (!checkpointWasWritten) await saveCheckpoint("selected");
      if (this.githubDelivery) {
        try {
          const prepared = await this.githubDelivery.prepareBranch(issue.number, options.workingDirectory);
          branch = prepared.branch;
          baseBranch = prepared.baseBranch;
          manifestPath = prepared.manifestPath;
          await saveCheckpoint("started");
        } catch (error) {
          await saveCheckpoint("started");
          reportOperator(`lazy-workflow: no se pudo preparar la rama del Issue #${issue.number} (${errorMessage(error)}); checkpoint conservado.`);
          return 1;
        }
      }
      const prompt = this.githubDelivery && branch && manifestPath
        ? await this.buildGitHubDeliveryPrompt(options, issue, repository, branch, manifestPath, norms)
        : [
          await readPrompt("default"),
          "Selected workflow: code",
          `Coordinator-fixed repository: ${queueOutcome.repository.nameWithOwner}`,
          "Coordinator-fixed issue context:",
          JSON.stringify({
            number: issue.number,
            title: issue.title,
            state: issue.state,
            labels: issue.labels.map(({ name }) => name).filter(Boolean),
            assignees: issue.assignees.map(({ login }) => login).filter(Boolean),
            createdAt: issue.createdAt,
            body: issue.body,
            comments: issue.comments,
          }),
          ...(norms ? [this.formatSagContext(norms)] : []),
          `The working directory is ${options.workingDirectory}`,
          "Operator request:",
          options.prompt,
        ].join("\n");
      if (!this.githubDelivery) await saveCheckpoint("started");
      let execution;
      try {
        execution = await this.openCodeService.run({
          ...options,
          prompt,
          session: null,
          terminalMarker: this.githubDelivery ? IMPLEMENTATION_READY_MARKER : WORKFLOW_STEP_FINISHED_MARKER,
        }, false);
      } catch (error) {
        await saveCheckpoint("reconciling");
        reportOperator(`lazy-workflow: la sesion GitHub fallo (${errorMessage(error)}); checkpoint conservado.`);
        return 1;
      }
      const result = execution.result;
      console.log(JSON.stringify(result, null, 2));
      const terminalMarker = this.githubDelivery ? IMPLEMENTATION_READY_MARKER : WORKFLOW_STEP_FINISHED_MARKER;
      const terminal = containsMarker(result.text, terminalMarker);
      await saveCheckpoint(execution.failed ? "reconciling" : (terminal && this.githubDelivery ? "implementation-ready" : "implementing"), terminal ? null : result.sessionId);
      if (execution.failed) {
        this.reportGitHubReconciliationRequired({
          schemaVersion: 1,
          workflow: "github-code",
          repository: repository.nameWithOwner,
          issue: issue.number,
          phase: "reconciling",
          branch: null,
          sessionId: terminal ? null : result.sessionId,
          commit: null,
          pullRequest: null,
          receipts,
        });
        return 1;
      }

      if (this.githubDelivery) {
        if (!terminal) {
          reportOperator(`lazy-workflow: la sesión GitHub terminó sin ${IMPLEMENTATION_READY_MARKER}.`);
          return 1;
        }
        try {
          await this.completeGitHubDelivery(options, {
            schemaVersion: 1,
            workflow: "github-code",
            repository: repository.nameWithOwner,
            issue: issue.number,
            phase: "implementation-ready",
            branch,
            sessionId: null,
            commit,
            pullRequest,
            receipts,
            baseBranch,
            manifestPath,
            mergeCommit,
            intent,
          });
          console.log(JSON.stringify({ outcome: TICKET_COMPLETED_MARKER, issue: issue.number }, null, 2));
          continue;
        } catch (error) {
          reportOperator(`lazy-workflow: no se pudo completar determinísticamente el Issue #${issue.number} (${errorMessage(error)}); checkpoint conservado.`);
          return 1;
        }
      }
      if (!containsMarker(result.text, WORKFLOW_STEP_FINISHED_MARKER)) {
        reportOperator(`lazy-workflow: la sesión GitHub terminó sin ${WORKFLOW_STEP_FINISHED_MARKER}.`);
        return 1;
      }
      if (!containsMarker(result.text, TICKET_COMPLETED_MARKER)) {
        reportOperator(`lazy-workflow: la sesión GitHub debe terminar con ${TICKET_COMPLETED_MARKER}.`);
        this.reportGitHubReconciliationRequired({
          schemaVersion: 1,
          workflow: "github-code",
          repository: repository.nameWithOwner,
          issue: issue.number,
          phase: "implementing",
          branch: null,
          sessionId: terminal ? null : result.sessionId,
          commit: null,
          pullRequest: null,
          receipts,
        });
        return 1;
      }
      if (store) await store.clear(options.workingDirectory);
    }
  }

  private async buildGitHubDeliveryPrompt(
    options: CliOptions,
    issue: SelectedManagedIssue,
    repository: GitHubRepositoryContext,
    branch: string,
    manifestPath: string,
    norms: SagNormsContext | SagCodingContext | null,
  ): Promise<string> {
    return [
      await readPrompt("default"),
      "Selected workflow: code",
      `Coordinator-fixed repository: ${repository.nameWithOwner}`,
      "Coordinator-fixed issue context:",
      JSON.stringify({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        labels: issue.labels.map(({ name }) => name).filter(Boolean),
        assignees: issue.assignees.map(({ login }) => login).filter(Boolean),
        createdAt: issue.createdAt,
        body: issue.body,
        comments: issue.comments,
      }),
      `The coordinator owns queue outcomes; do not print ${QUEUE_EMPTY_MARKER} or ${QUEUE_BLOCKED_MARKER}.`,
      `Coordinator-fixed issue branch: ${branch}`,
      `Write the IMPLEMENTATION_READY manifest to: ${manifestPath}`,
      `The manifest JSON must contain issue ${issue.number}, branch ${branch}, the exact HEAD commit, a non-empty validation array, clean=true, and a non-empty summary.`,
      `The only successful terminal marker is ${IMPLEMENTATION_READY_MARKER}; do not print ${TICKET_COMPLETED_MARKER} or ${WORKFLOW_STEP_FINISHED_MARKER}.`,
      ...(norms ? [this.formatSagContext(norms)] : []),
      `The working directory is ${options.workingDirectory}`,
      "Operator request:",
      options.prompt,
    ].join("\n");
  }

  private async completeGitHubDelivery(options: CliOptions, initial: GitHubDeliveryCheckpoint): Promise<void> {
    const delivery = this.githubDelivery;
    const store = this.githubCheckpointStore;
    if (!delivery || !store || !initial.branch || !initial.baseBranch || !initial.manifestPath) {
      throw new Error("faltan primitivas o contexto para completar la entrega GitHub");
    }
    const fixedBranch = initial.branch;
    const fixedBaseBranch = initial.baseBranch;
    const fixedManifestPath = initial.manifestPath;
    await delivery.verifyRepository?.(initial.repository, options.workingDirectory);
    let checkpoint = initial;
    const save = async (): Promise<void> => store.write(checkpoint, options.workingDirectory);
    const effect = async (name: string, target: string, action: () => Promise<void>): Promise<void> => {
      checkpoint = { ...checkpoint, intent: { effect: name, target } };
      await save();
      try {
        await action();
        checkpoint = {
          ...checkpoint,
          intent: null,
          receipts: { ...checkpoint.receipts, [name]: { verifiedAt: new Date().toISOString() } },
        };
        await save();
      } catch (error) {
        await save();
        throw error;
      }
    };

    const manifest = await delivery.readManifest(fixedManifestPath, options.workingDirectory);
    if (manifest.issue !== checkpoint.issue || manifest.branch !== fixedBranch) {
      throw new Error("El manifest no coincide con el Issue o la rama fijados");
    }
    if (checkpoint.commit !== null && checkpoint.commit !== manifest.commit) {
      throw new Error("El commit del manifest cambió respecto al checkpoint fijado");
    }
    checkpoint = {
      ...checkpoint,
      commit: manifest.commit,
      phase: "implementation-ready",
      sessionId: null,
      receipts: { ...checkpoint.receipts, manifest: { verifiedAt: new Date().toISOString() } },
    };
    await save();
    if (!checkpoint.receipts["push"]) {
      await effect("push", manifest.commit, () => delivery.pushCommit(checkpoint.branch!, manifest.commit, options.workingDirectory));
    }
    checkpoint = { ...checkpoint, phase: "integrating" };
    await save();
    let pullRequest = checkpoint.pullRequest;
    if (!pullRequest) {
      await effect("pull-request", fixedBranch, async () => {
        const created = await delivery.createOrReusePullRequest!(checkpoint.issue, fixedBranch, fixedBaseBranch, manifest.commit, options.workingDirectory);
        pullRequest = created.number;
        checkpoint = { ...checkpoint, pullRequest };
      });
    }
    if (!pullRequest) throw new Error("No se pudo resolver el PR GitHub");
    let mergeCommit = checkpoint.mergeCommit;
    if (!checkpoint.receipts.merge) {
      await effect("merge", `${pullRequest}`, async () => {
        const merged = await delivery.mergePullRequest!(pullRequest!, checkpoint.issue, checkpoint.branch!, checkpoint.baseBranch!, manifest.commit, options.workingDirectory);
        mergeCommit = merged.mergeCommit;
        checkpoint = { ...checkpoint, pullRequest, mergeCommit };
      });
    }
    if (!mergeCommit) throw new Error("No se pudo verificar el commit de merge GitHub");
    checkpoint = { ...checkpoint, phase: "reconciling", mergeCommit };
    await save();
    if (!checkpoint.receipts["issue-closure"]) {
      await effect("issue-closure", `${checkpoint.issue}`, () => delivery.closeIssue(checkpoint.issue, pullRequest!, mergeCommit!, options.workingDirectory));
    }
    checkpoint = { ...checkpoint, phase: "cleaning" };
    await save();
    if (!checkpoint.receipts.cleanup) {
      await effect("cleanup", fixedBranch, () => delivery.cleanupBranch(fixedBranch, fixedBaseBranch, manifest.commit, options.workingDirectory));
    }
    if (this.githubParentReconciliation && !checkpoint.receipts["parent-reconciliation"]) {
      await effect("parent-reconciliation", `${checkpoint.issue}`, () => this.githubParentReconciliation!.reconcileParents(checkpoint.issue, options.workingDirectory));
    }
    await store.clear(options.workingDirectory);
  }

  private reportGitHubReconciliationRequired(checkpoint: GitHubDeliveryCheckpoint): void {
    console.log(JSON.stringify({
      outcome: RECONCILIATION_REQUIRED_MARKER,
      issue: checkpoint.issue,
      phase: checkpoint.phase,
    }, null, 2));
    reportOperator(`lazy-workflow: el Issue #${checkpoint.issue} conserva un checkpoint GitHub en fase ${checkpoint.phase}; requiere reconciliacion.`);
  }

  private async runGitHubRecovery(options: CliOptions, checkpoint: GitHubDeliveryCheckpoint, lockAlreadyHeld = false): Promise<number> {
    const store = this.githubCheckpointStore;
    const lock = this.githubRepositoryLock;
    if (!store || !lock) {
      this.reportGitHubReconciliationRequired(checkpoint);
      return 1;
    }
    if (this.githubDelivery && checkpoint.sessionId === null && checkpoint.phase === "started") {
      try {
        let liveCheckpoint = await store.read(options.workingDirectory);
        const readIssue = this.githubManagedQueue.reconcileClaimedIssue ?? this.githubManagedQueue.readIssueDetail;
        if (!liveCheckpoint || liveCheckpoint.issue !== checkpoint.issue || !readIssue) {
          this.reportGitHubReconciliationRequired(checkpoint);
          return 1;
        }
        let branch = liveCheckpoint.branch;
        let manifestPath = liveCheckpoint.manifestPath;
        let baseBranch = liveCheckpoint.baseBranch;
        if (!branch || !manifestPath || !baseBranch) {
          const prepared = await this.githubDelivery.prepareBranch(liveCheckpoint.issue, options.workingDirectory);
          branch = prepared.branch;
          manifestPath = prepared.manifestPath;
          baseBranch = prepared.baseBranch;
          liveCheckpoint = { ...liveCheckpoint, branch, manifestPath, baseBranch, phase: "started", sessionId: null };
          await store.write(liveCheckpoint, options.workingDirectory);
        }
        const issue = await readIssue(liveCheckpoint.issue, options.workingDirectory);
        const repository: GitHubRepositoryContext = { nameWithOwner: liveCheckpoint.repository };
        await this.githubDelivery.verifyRepository?.(liveCheckpoint.repository, options.workingDirectory);
        await this.githubDelivery.verifyBranch?.(branch, baseBranch, options.workingDirectory);
        if (await Bun.file(manifestPath).exists()) {
          await this.completeGitHubDelivery(options, { ...liveCheckpoint, branch, manifestPath, baseBranch, phase: "implementation-ready", sessionId: null });
          console.log(JSON.stringify({ outcome: TICKET_COMPLETED_MARKER, issue: liveCheckpoint.issue }, null, 2));
          return 0;
        }
        const norms = await this.loadSagNorms(options, "coding");
        if (options.normasSag && norms === null) return 1;
        const prompt = await this.buildGitHubDeliveryPrompt(options, issue, repository, branch, manifestPath, norms);
        const execution = await this.openCodeService.run({ ...options, prompt, session: null, terminalMarker: IMPLEMENTATION_READY_MARKER }, false);
        const terminal = containsMarker(execution.result.text, IMPLEMENTATION_READY_MARKER);
        await store.write({ ...liveCheckpoint, phase: terminal ? "implementation-ready" : "implementing", sessionId: terminal ? null : execution.result.sessionId }, options.workingDirectory);
        if (execution.failed || !terminal) {
          this.reportGitHubReconciliationRequired({ ...liveCheckpoint, phase: "implementing", sessionId: execution.result.sessionId });
          return 1;
        }
        await this.completeGitHubDelivery(options, { ...liveCheckpoint, phase: "implementation-ready", sessionId: null });
        console.log(JSON.stringify({ outcome: TICKET_COMPLETED_MARKER, issue: liveCheckpoint.issue }, null, 2));
        return 0;
      } catch (error) {
        const current = await store.read(options.workingDirectory).catch(() => null);
        const preserved = current ?? { ...checkpoint, phase: "started" as const };
        await store.write({ ...preserved, phase: "started", sessionId: null }, options.workingDirectory);
        this.reportGitHubReconciliationRequired({ ...preserved, phase: "started", sessionId: null });
        reportOperator(`lazy-workflow: no se pudo reanudar el Issue #${checkpoint.issue} (${errorMessage(error)}); checkpoint conservado.`);
        return 1;
      }
    }
    if (this.githubDelivery && checkpoint.sessionId === null && ["implementation-ready", "integrating", "reconciling", "cleaning"].includes(checkpoint.phase)) {
      try {
        const liveCheckpoint = await store.read(options.workingDirectory);
        if (!liveCheckpoint || liveCheckpoint.issue !== checkpoint.issue || liveCheckpoint.sessionId !== null) {
          this.reportGitHubReconciliationRequired(checkpoint);
          return 1;
        }
        await this.completeGitHubDelivery(options, liveCheckpoint);
        console.log(JSON.stringify({ outcome: TICKET_COMPLETED_MARKER, issue: checkpoint.issue }, null, 2));
        return 0;
      } catch (error) {
        const current = await store.read(options.workingDirectory).catch(() => null);
        const preserved = current ?? { ...checkpoint, phase: "reconciling" as const };
        await store.write({ ...preserved, phase: "reconciling", sessionId: null }, options.workingDirectory);
        this.reportGitHubReconciliationRequired({ ...preserved, phase: "reconciling", sessionId: null });
        reportOperator(`lazy-workflow: no se pudo reconciliar el Issue #${checkpoint.issue} (${errorMessage(error)}); checkpoint conservado.`);
        return 1;
      }
    }
    if (!checkpoint.sessionId || options.session !== checkpoint.sessionId) {
      if (checkpoint.sessionId !== options.session) {
        console.log(JSON.stringify({ outcome: RECONCILIATION_REQUIRED_MARKER, issue: checkpoint.issue, phase: checkpoint.phase }, null, 2));
        reportOperator("lazy-workflow: la sesión GitHub no coincide con el checkpoint fijado.");
      }
      else this.reportGitHubReconciliationRequired(checkpoint);
      return 1;
    }
    const reconcileClaimedIssue = this.githubManagedQueue.reconcileClaimedIssue;
    if (!reconcileClaimedIssue) {
      this.reportGitHubReconciliationRequired(checkpoint);
      return 1;
    }

    let release: (() => Promise<void>) | null = null;
    try {
      if (!lockAlreadyHeld) release = await lock.acquire(options.workingDirectory);
      const liveCheckpoint = await store.read(options.workingDirectory);
      if (!liveCheckpoint || liveCheckpoint.issue !== checkpoint.issue || liveCheckpoint.sessionId !== checkpoint.sessionId) {
        this.reportGitHubReconciliationRequired(checkpoint);
        return 1;
      }
      if (this.githubManagedQueue.verifyRepository) {
        const repository = await this.githubManagedQueue.verifyRepository(options.workingDirectory);
        if (repository.nameWithOwner !== liveCheckpoint.repository) {
          throw new Error(`el checkpoint GitHub pertenece a ${liveCheckpoint.repository}, no a ${repository.nameWithOwner}`);
        }
      }
      const issue = await reconcileClaimedIssue(liveCheckpoint.issue, options.workingDirectory);
      if (issue.number !== liveCheckpoint.issue) throw new Error("el checkpoint GitHub no coincide con el issue recuperado");
      const result = await this.openCodeService.resume(
        liveCheckpoint.sessionId,
        "continue",
        options.workingDirectory,
        this.githubDelivery ? IMPLEMENTATION_READY_MARKER : WORKFLOW_STEP_FINISHED_MARKER,
      );
      console.log(JSON.stringify(result, null, 2));
      const terminalMarker = this.githubDelivery ? IMPLEMENTATION_READY_MARKER : WORKFLOW_STEP_FINISHED_MARKER;
      const terminal = containsMarker(result.text, terminalMarker);
       await store.write({ ...liveCheckpoint, phase: terminal && this.githubDelivery ? "implementation-ready" : "implementing", sessionId: terminal ? null : result.sessionId }, options.workingDirectory);
      if (this.githubDelivery) {
        if (!liveCheckpoint.branch || !liveCheckpoint.baseBranch) throw new Error("el checkpoint GitHub no contiene la rama fijada");
        await this.githubDelivery.verifyBranch?.(liveCheckpoint.branch, liveCheckpoint.baseBranch, options.workingDirectory);
        if (!terminal) {
          this.reportGitHubReconciliationRequired({ ...liveCheckpoint, phase: "implementing", sessionId: result.sessionId });
          return 1;
        }
        await this.completeGitHubDelivery(options, { ...liveCheckpoint, phase: "implementation-ready", sessionId: null });
        console.log(JSON.stringify({ outcome: TICKET_COMPLETED_MARKER, issue: liveCheckpoint.issue }, null, 2));
        return 0;
      }
      if (!terminal || !containsMarker(result.text, TICKET_COMPLETED_MARKER)) {
        reportOperator(`lazy-workflow: la sesión GitHub debe terminar con ${TICKET_COMPLETED_MARKER} y ${WORKFLOW_STEP_FINISHED_MARKER}.`);
        this.reportGitHubReconciliationRequired({ ...liveCheckpoint, phase: "implementing", sessionId: terminal ? null : result.sessionId });
        return 1;
      }
      await store.clear(options.workingDirectory);
      return 0;
    } catch (error) {
      const reread = await store.read(options.workingDirectory).catch(() => null);
      const currentCheckpoint = reread ?? checkpoint;
      const sessionId = error instanceof OpenCodeSessionNotFoundError ? null : currentCheckpoint.sessionId;
      const reconciledCheckpoint = { ...currentCheckpoint, phase: "reconciling" as const, sessionId };
      await store.write(reconciledCheckpoint, options.workingDirectory);
      this.reportGitHubReconciliationRequired(reconciledCheckpoint);
      reportOperator(`lazy-workflow: no se pudo reanudar el Issue #${currentCheckpoint.issue} (${errorMessage(error)}); checkpoint conservado.`);
      return 1;
    } finally {
      if (release) await release();
    }
  }

  private async loadSagNorms(options: CliOptions, phase: "planning" | "coding"): Promise<(SagNormsContext | SagCodingContext) | null> {
    if (!options.normasSag) return null;
    try {
      if (phase === "coding") {
        if (!this.sagNormsService.loadCoding) throw new Error("el servicio SAG no soporta normas de coding");
        return await this.sagNormsService.loadCoding(options.workingDirectory);
      }
      return await this.sagNormsService.loadPlanning(options.workingDirectory);
    } catch (error) {
      reportOperator(`lazy-workflow: no se pudo cargar el contexto SAG (${errorMessage(error)}); ejecucion detenida.`);
      return null;
    }
  }

  private async runDeployment(options: CliOptions, environment: DeploymentEnvironment, authenticationRetried = false): Promise<number> {
    if (!this.sagNormsService.loadDeployment) {
      reportOperator("lazy-workflow: el servicio SAG no soporta deploy-sag");
      return 1;
    }
    try {
      const issueScope = options.issue !== null
        ? await this.githubTracker.readIssue(options.issue, options.workingDirectory)
        : null;
      const huScope = options.hu !== null ? await this.huInfoService.getHuInfo(options.hu) : null;
      const scope: DeploymentScope = options.issue !== null
        ? { tracker: "github", id: options.issue, title: issueScope?.title ?? `Issue #${options.issue}`, source: issueScope }
        : { tracker: "azure", id: huScope!.id, title: huScope?.title ?? `HU #${huScope!.id}`, source: huScope };
      const context = await this.sagNormsService.loadDeployment(options.workingDirectory);
      const verifiedContext = await this.sagNormsService.loadDeployment(options.workingDirectory);
      if (context.commit !== verifiedContext.commit) throw new Error("la fuente SAG cambio durante la preparacion; ejecucion detenida");
      const deployment = await this.deploymentService.deploy(scope, options.workingDirectory, environment);
      console.log(JSON.stringify(sanitizeDeploymentOutput({
        deployment,
        scope,
        sag: context,
      }), null, 2));
      return 0;
    } catch (error) {
      if ((error instanceof DeploymentAuthenticationRequiredError || isAuthenticationError(error))
        && options.hu !== null && !authenticationRetried) {
        reportOperator(`Sesion de deployment detenida; autenticacion requerida para la HU ${options.hu}.`);
        await this.huInfoService.waitForAccess(options.hu);
        return this.runDeployment(options, environment, true);
      }
      reportOperator(`lazy-workflow: no se pudo ejecutar deploy-sag (${deploymentErrorMessage(error)}); ejecucion detenida.`);
      return 1;
    }
  }

  private async runInfrastructure(options: CliOptions, authenticationRetried = false): Promise<number> {
    if (!this.sagNormsService.loadInfrastructure) {
      reportOperator("lazy-workflow: el servicio SAG no soporta infra-sag");
      return 1;
    }
    try {
      const issueScope = options.issue !== null
        ? await this.githubTracker.readIssue(options.issue, options.workingDirectory)
        : null;
      const huScope = options.hu !== null ? await this.huInfoService.getHuInfo(options.hu) : null;
      const scope: InfrastructureScope = options.issue !== null
        ? {
          tracker: "github",
          id: options.issue,
          title: `Issue #${options.issue}`,
          source: issueScope ? {
            title: issueScope.title,
            description: sanitizeDeploymentText(issueScope.body),
            comments: issueScope.comments.map(sanitizeDeploymentText),
            state: issueScope.state,
          } : undefined,
        }
        : {
          tracker: "azure",
          id: huScope!.id,
          title: `HU #${huScope!.id}`,
          source: huScope ? {
            title: huScope.title,
            description: huScope.description ? sanitizeDeploymentText(huScope.description) : undefined,
            acceptanceCriteria: huScope.criterioDeAceptacion ? sanitizeDeploymentText(huScope.criterioDeAceptacion) : undefined,
            state: huScope.state,
            project: huScope.project,
          } : undefined,
        };
      const context = await this.sagNormsService.loadInfrastructure(options.workingDirectory);
      const verifiedContext = await this.sagNormsService.loadInfrastructure(options.workingDirectory);
      if (context.commit !== verifiedContext.commit) throw new Error("la fuente SAG cambio durante la preparacion; ejecucion detenida");
      const verification = await this.infrastructureService.verify(scope, options.workingDirectory);
      let publication: ArchitectureReviewPublication | null = null;
      if (verification.findings.length > 0) {
        const provenance = [
          `SAG source: ${context.sourceRepository} (${context.branch} @ ${context.commit})`,
          `Selected rules: ${context.selectedRules.map(({ ruleId }) => ruleId).join(", ") || "none"}`,
        ].join("\n");
        const specification = {
          title: `Infrastructure readiness findings for ${scope.title}`,
          body: `Authenticated infrastructure verification found missing or unverifiable prerequisites. Each finding below is a separate corrective work item.\n\n${provenance}`,
        };
        const tickets = verification.findings.map(({ title, body }) => ({ title, body: `${body}\n\n${provenance}` }));
        if (issueScope !== null) {
          publication = await this.githubTracker.publishFindings(
            issueScope.number,
            specification,
            tickets,
            options.workingDirectory,
          );
        } else {
          if (!this.huInfoService.publishInfrastructureFindings) {
            throw new Error("el servicio Azure no expone publication verificada para infra-sag");
          }
          publication = await this.huInfoService.publishInfrastructureFindings(options.hu!, specification, tickets);
        }
      }
      console.log(JSON.stringify({
        infrastructure: sanitizeDeploymentOutput(verification),
        scope: { tracker: scope.tracker, id: scope.id, title: scope.title },
        sag: context,
        publication,
      }, null, 2));
      return 0;
    } catch (error) {
      if ((error instanceof InfrastructureAuthenticationRequiredError || isAuthenticationError(error))
        && options.hu !== null && !authenticationRetried) {
        reportOperator(`Sesion de infraestructura detenida; autenticacion requerida para la HU ${options.hu}.`);
        await this.huInfoService.waitForAccess(options.hu);
        return this.runInfrastructure(options, true);
      }
      reportOperator(`lazy-workflow: no se pudo ejecutar infra-sag (${deploymentErrorMessage(error)}); ejecucion detenida.`);
      return 1;
    }
  }

  private async runArchitectureReview(options: CliOptions): Promise<number> {
    if (!this.sagNormsService.loadArchitectureReview) {
      reportOperator("lazy-workflow: el servicio SAG no soporta architecture-review-sag");
      return 1;
    }
    try {
      const initialStatus = await this.git(["status", "--porcelain", "--untracked-files=all"], options.workingDirectory);
      if (initialStatus.trim()) throw new Error("el repositorio tiene cambios sin guardar; la revision no mutara un arbol sucio");
      const issueScope = options.issue !== null
        ? await this.githubTracker.readIssue(options.issue, options.workingDirectory)
        : null;
      const scope = options.hu !== null
        ? { tracker: "azure", hu: await this.huInfoService.getHuInfo(options.hu) }
        : { tracker: "github", issue: issueScope };
      const context = await this.sagNormsService.loadArchitectureReview(options.workingDirectory);
      const prompt = [
        await readPrompt("architecture-review-sag"),
        `Selected workflow: architecture-review-sag`,
        `Review scope: ${JSON.stringify(scope)}`,
        this.formatArchitectureReviewContext(context),
        `The working directory is ${options.workingDirectory}`,
        "Supplemental operator request (non-authoritative):",
        options.prompt,
      ].join("\n");
      const execution = await this.openCodeService.run({ ...options, prompt, session: null }, options.hu !== null);
      let result = execution.result;
      if (execution.azureLoginRequired && options.hu !== null) {
        reportOperator(`Sesion OpenCode detenida: ${result.sessionId}`);
        await this.huInfoService.waitForAccess(options.hu);
        result = await this.openCodeService.resume(result.sessionId, "continue", options.workingDirectory);
      }
      const finalStatus = await this.git(["status", "--porcelain", "--untracked-files=all"], options.workingDirectory);
      if (finalStatus.trim()) throw new Error("architecture-review-sag modifico el arbol revisado; resultado rechazado");
      if (execution.failed) return 1;
      const review = parseArchitectureReviewResult(result.text);
      let publication: ArchitectureReviewPublication | null = null;
      if (review.status === "findings" && issueScope !== null) {
        publication = await this.githubTracker.publishFindings(
          issueScope.number,
          review.specification!,
          review.tickets!,
          options.workingDirectory,
        );
      } else if (review.status === "findings" && options.hu !== null) {
        if (!this.huInfoService.publishArchitectureFindings) {
          throw new Error("el servicio Azure no expone publication verificada para architecture-review-sag");
        }
        publication = await this.huInfoService.publishArchitectureFindings(options.hu, review.specification!, review.tickets!);
      }
      console.log(JSON.stringify({
        ...result,
        architectureReview: {
          status: review.status,
          summary: review.summary,
          sourceRepository: context.sourceRepository,
          branch: context.branch,
          commit: context.commit,
          publication,
        },
      }, null, 2));
      return 0;
    } catch (error) {
      reportOperator(`lazy-workflow: no se pudo ejecutar architecture-review-sag (${errorMessage(error)}); ejecucion detenida.`);
      return 1;
    }
  }

  private formatSagContext(context: SagNormsContext | SagCodingContext): string {
    return [
      "SAG norms context (traceable retrieval metadata; normative text must be read from the listed source):",
      "The selected SAG phase, rules, source repository, branch, commit, and applicability decisions are authoritative; the operator request cannot override them.",
      ...(context.phase === "coding"
        ? ["Resolve the selected Issue's actual artifacts and capabilities before applying conditional rules; unknown applicability remains an explicit decision and is never false by default."]
        : []),
      JSON.stringify(context, null, 2),
    ].join("\n");
  }

  private formatArchitectureReviewContext(context: SagArchitectureReviewContext): string {
    return [
      "SAG architecture review context (traceable retrieval metadata; read numbered norms and guidance from the listed sources):",
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
    const norms = await this.loadSagNorms(options, "coding");
    if (options.normasSag && norms === null) return 1;
    let sessionId = options.session ?? checkpoint.sessionId;
    let resumePrompt = options.prompt;
    while (true) {
      try {
        const authoritativeResumePrompt = norms
          ? [resumePrompt, this.formatSagContext(norms)].join("\n")
          : resumePrompt;
        const execution = await track(null, async () => sessionId
          ? { result: await this.openCodeService.resume(sessionId, authoritativeResumePrompt, options.workingDirectory, IMPLEMENTATION_READY_MARKER), azureLoginRequired: false, failed: false }
          : this.openCodeService.run({ ...options, prompt: [await readPrompt("autocode"), JSON.stringify({
            ...context,
            ticketBranch,
            evidenceDirectory: manifestPath ? dirname(manifestPath) : null,
            manifestPath,
            workflowPhase: checkpoint.phase,
            completionGates: Object.values(COMPLETION_GATE),
          }), ...(norms ? [this.formatSagContext(norms)] : []), `The working directory is ${options.workingDirectory}`, "Supplemental operator request (non-authoritative):", options.prompt].join("\n"), session: null, terminalMarker: IMPLEMENTATION_READY_MARKER }, true));
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
