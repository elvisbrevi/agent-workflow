import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, unlink } from "node:fs/promises";
import { HuInfoService } from "../azure/hu-info-service.ts";
import type { HuInfo } from "../azure/hu-info.ts";
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
import type { AzurePullRequestTarget, AzureWorkspaceBranchTopology, AzureWorkspaceRepositoryInput } from "../azure/autocode-service.ts";
import { AzureWorkspaceCheckpointStore, writeAzureWorkspaceManifest, type AzureWorkspaceCheckpoint, type AzureWorkspaceCheckpointUnit } from "../azure/azure-workspace-checkpoint.ts";
import {
  GitAutocodeCheckpointStore,
  migrateAutocodeCheckpoint,
  type AutocodeEffect,
  type AutocodePhase,
  type AutocodeCheckpointStore,
  type StoredAutocodeCheckpoint,
  type VersionedAutocodeCheckpoint,
} from "../azure/autocode-checkpoint.ts";
import { AgentExhaustionError, AgentSessionCloseError, AgentSessionNotFoundError, type AgentAuthority, type AgentExecution, type AgentResumeOverrides, type AgentRunOptions, type CodingAgent, type ProviderExhaustion } from "../coding-agent/coding-agent.ts";
import type { AgentResult } from "../coding-agent/agent-result.ts";
import { createCodingAgent, type CodingAgentFactory } from "../coding-agent/create-coding-agent.ts";
import { DEFAULT_CLI, type AgentCli } from "../coding-agent/agent-cli.ts";
import { reportOperator, setDefaultReporter } from "../output/operator-output.ts";
import { createReporter, type Reporter } from "../output/reporter.ts";
import { GitTicketBranchCleaner, runGit, type GitRunner } from "../git/git-ticket-branch-cleaner.ts";
import { SagNormsService } from "../sag/sag-norms-service.ts";
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
  type GitHubDeliveryPhase,
} from "../github/github-delivery-checkpoint.ts";
import {
  GitHubDeliveryService,
  GitHubPullRequestConflictError,
  githubRepositoryFromRemote,
  type GitHubDeliveryAdapter,
  type GitHubReadyManifest,
} from "../github/github-delivery-service.ts";
import {
  GitHubParentReconciliationService,
  type GitHubParentReconciliationAdapter,
} from "../github/github-parent-reconciliation-service.ts";
import { GitHubRepositoryLockService, type GitHubRepositoryLockBoundary } from "../github/github-repository-lock.ts";
import {
  GitHubWorkspaceCheckpointStore,
  writeGitHubWorkspaceManifest,
  type GitHubWorkspaceCheckpoint,
  type GitHubWorkspaceUnit,
} from "../github/github-workspace-checkpoint.ts";
import { normalizeWorkspaceScope, type WorkspaceScope } from "../workspace/repository-scope.ts";
import {
  IMPLEMENTATION_READY_MARKER,
  QUEUE_BLOCKED_MARKER,
  QUEUE_EMPTY_MARKER,
  RECONCILIATION_REQUIRED_MARKER,
  TICKET_COMPLETED_MARKER,
  WORKFLOW_STEP_FINISHED_MARKER,
} from "../prompts/workflow-contract.ts";
import {
  buildResumePrompt,
  buildWorkflowPrompt,
  resolveWorkflowRun,
  type HandoffProgress,
  type SagContext,
  type WorkflowPromptSpec,
  type WorkflowRun,
} from "../prompts/workflow-prompt.ts";
import { authorityConfigPath, authorityProfile } from "../prompts/authority-profile.ts";
import { AzurePlanPublicationService, parsePlan } from "../azure/plan-publication-service.ts";
import {
  buildCli,
  type CliOptions as ParsedCliOptions,
  type CliParseResult,
  type CliParser,
  type FallbackRung,
} from "./parse-cli-options.ts";

type CliOptions = AgentRunOptions & ParsedCliOptions;

type GitHubReconciliationOutcome =
  | { kind: "pending"; sessionId: string }
  | { kind: "ready"; manifest: GitHubReadyManifest };

export type AzureBoundary = Pick<HuInfoService, "getHuInfo" | "waitForAccess"> & Partial<{
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
  createOrReusePullRequest?(hu: number, ticket: number, participant?: AzurePullRequestTarget): Promise<{ pullRequest: number; mergeCommit: string }>;
  validateDirectTicketContext?(hu: number, ticket: number): Promise<void>;
  getCompletionInfo?(hu: number, ticket: number): Promise<{ hu: number; ticket: number; gates: TicketInfo["gates"] }>;
  readCompletionManifest?(path: string, workingDirectory: string): Promise<CompletionManifest>;
  validateCompletionManifest?(manifest: CompletionManifest, info: TicketInfo, ticket: number, workingDirectory: string): Promise<void>;
  validateEvidenceFile?(filePath: string, kind: EvidenceKind): Promise<void>;
  validateEvidence?(ticket: number, filePath: string): Promise<void>;
  prepareWorkspaceBranches?(options: { hu: number; repositories: readonly AzureWorkspaceRepositoryInput[]; baseBranch?: string | null; integrationBranch?: string }): Promise<AzureWorkspaceBranchTopology>;
  prepareWorkspaceTicketBranches?(options: { hu: number; ticket: number; integrationBranch: string; repositories: readonly AzureWorkspaceRepositoryInput[]; ticketBranch?: string; ticketBranchAnchor?: string | null }): Promise<AzureWorkspaceBranchTopology>;
  linkTicketBranch?(hu: number, ticket: number, ticketBranch: string, candidates: readonly string[]): Promise<unknown>;
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
  setHuState?(hu: number, desiredState: string, expectedState: string, expectedRevision: number): Promise<{ hu: number; state: string; revision: number }>;
  getHuChildren?(hu: number): Promise<Array<{ id: number; type: string; state: string; title?: string }>>;
  hasOpenDeliveryChildren?(hu: number): Promise<boolean>;
  createTicket?(input: {
    hu: number;
    type: string;
    title: string;
    descriptionFile: string;
    estimate?: number;
    assignee?: string;
    fields?: Array<{ referenceName: string; value: string }>;
  }): Promise<{ hu: number; ticket: number; type: string; title: string; created: boolean }>;
  linkParent?(parent: number, child: number): Promise<{ parent: number; child: number; linked: boolean }>;
  linkPredecessor?(blocker: number, blocked: number): Promise<{ blocker: number; blocked: number; linked: boolean }>;
  linkPullRequest?(hu: number, ticket: number, pullRequest: number, participant?: AzurePullRequestTarget): Promise<unknown>;
  linkCommit?(ticket: number, pullRequest: number, participant?: AzurePullRequestTarget): Promise<unknown>;
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

/** ADR 0009: active duration in hours, rounded upward to a quarter, never below one quarter. */
function activeEffortHours(activeDurationMs: number): number {
  return Math.max(0.25, Math.ceil(activeDurationMs / 900_000) / 4);
}

function revisionOf(result: unknown): number | null {
  const revision = (result as { revision?: unknown } | null)?.revision;
  return typeof revision === "number" && Number.isInteger(revision) ? revision : null;
}

async function manifestBelongsToDelivery(manifestPath: string, issue: number, branch: string): Promise<boolean> {
  try {
    if (!(await Bun.file(manifestPath).exists())) return false;
    const value: unknown = await Bun.file(manifestPath).json();
    return typeof value === "object"
      && value !== null
      && (value as { issue?: unknown }).issue === issue
      && (value as { branch?: unknown }).branch === branch;
  } catch {
    return false;
  }
}

function getResumeOverrides(options: CliOptions): AgentResumeOverrides {
  return {
    ...(options.hasModel ? { model: options.model } : {}),
    ...(options.hasVariant ? { variant: options.variant } : {}),
  };
}

/**
 * The overrides a recovered session resumes with: an explicit `--model` still
 * wins, and otherwise the rung the checkpoint recorded when a fallback descent
 * moved the run off its primary one, so recovery resumes on the rung that was
 * actually running rather than the one already exhausted (issue #238).
 */
function getRecoveryOverrides(options: CliOptions, checkpoint: Pick<GitHubDeliveryCheckpoint, "model" | "variant">): AgentResumeOverrides {
  const overrides = getResumeOverrides(options);
  if (!checkpoint.model || options.hasModel) return overrides;
  return { ...overrides, model: checkpoint.model, ...(checkpoint.variant ? { variant: checkpoint.variant } : {}) };
}

/** The declared chain with the run's own rung at the head, which is where a descent always starts. */
function fallbackChainOf(options: ParsedCliOptions): FallbackRung[] {
  return [{ cli: options.cli, model: options.model, variant: options.variant }, ...options.fallbackChain];
}

/**
 * The rung a descent from `fromIndex` lands on: the next one in declared order,
 * whichever CLI it names. A rung sharing the active CLI resumes its session; a
 * rung naming another one has no session to resume and is reached through a
 * handoff instead, so the declared order is never reordered (issues #238, #239).
 */
function nextRung(options: CliOptions, fromIndex: number): { rung: FallbackRung; index: number } | null {
  const index = fromIndex + 1;
  const rung = fallbackChainOf(options)[index];
  return rung ? { rung, index } : null;
}

function describeRung(rung: FallbackRung): string {
  return `${rung.cli}:${rung.model}:${rung.variant}`;
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

// The markers and the manifest contract are defined once in src/prompts/workflow-contract.ts.
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
  "ticket-create",
  "ticket-link-parent",
  "ticket-link-predecessor",
]);
const INFRASTRUCTURE_FLAGS = new Set([
  "--hu", "--issue",
  "--cli", "--model", "--variant", "--prompt",
  "--working-directory",
  "--verbose", "--quiet", "--no-color",
]);

function isValidHu(hu: number | null): hu is number {
  return hu !== null && Number.isInteger(hu) && hu > 0;
}

function isAzureRemote(origin: string): boolean {
  const trimmed = origin.trim();
  return /^https:\/\/dev\.azure\.com\/|^git@ssh\.dev\.azure\.com:|^https?:\/\/[^\/]*\.visualstudio\.com\//.test(trimmed);
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
  private readonly githubWorkspaceCheckpoint = new GitHubWorkspaceCheckpointStore();
  /** The agent of the run in course, resolved once from `--cli` (ADR-0023). */
  private activeAgent: CodingAgent | null = null;

  constructor(
    private readonly huInfoService: AzureBoundary = new AzureAutocodeService(),
    /** The agent itself when a caller injects one; otherwise the factory `--cli` selects from. */
    private readonly agentSource: CodingAgent | CodingAgentFactory = createCodingAgent,
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
    private readonly azureWorkspaceCheckpoint: AzureWorkspaceCheckpointStore = new AzureWorkspaceCheckpointStore(),
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

  /** The agent executing this run; every call site reads the one already resolved. */
  private get codingAgent(): CodingAgent {
    return this.activeAgent ?? this.resolveAgent(DEFAULT_CLI);
  }

  private resolveAgent(cli: AgentCli): CodingAgent {
    this.activeAgent = typeof this.agentSource === "function" ? this.agentSource(cli) : this.agentSource;
    return this.activeAgent;
  }

  /**
   * A checkpoint owns the CLI that opened its session, so recovery resumes
   * against that one without the operator declaring it. An explicit `--cli` that
   * contradicts the checkpoint fails closed, with the checkpoint untouched, so a
   * session is never resumed against the wrong binary (ADR-0023).
   *
   * The exception is the contradiction the run itself created: a cross-CLI
   * handoff moved the session off the `--cli` the operator declared, and the
   * checkpoint says so in `handoffFrom`. That same command has to be able to
   * resume its own work where it stands, so it adopts the CLI holding it instead
   * of failing closed on itself (issue #252). The distinction is the checkpoint's
   * record, never the chain the rerun happens to declare.
   *
   * The adopted CLI comes back as the run's own, because everything the run does
   * afterwards — the sessions it opens, the checkpoints it writes, the CLI it
   * names to the operator — is executed by the agent this resolved. Returns null
   * when the run must stop.
   */
  private adoptCheckpointCli(cli: AgentCli, options: CliOptions, handoffFrom: AgentCli | null = null): CliOptions | null {
    if (options.hasCli && options.cli !== cli && options.cli !== handoffFrom) {
      reportOperator(
        `lazy-workflow: el checkpoint pertenece al CLI ${cli}, no a ${options.cli}; checkpoint conservado. `
        + `Reanuda con --cli ${cli}, o sin --cli, para continuar el trabajo donde quedó.`,
      );
      return null;
    }
    this.resolveAgent(cli);
    return options.cli === cli ? options : { ...options, cli };
  }

  /**
   * The CLI a run goes back to once the checkpointed unit is done. Adopting a
   * handoff is scoped to that unit, exactly as a descent is: the next one starts
   * on the rung the operator declared. Without an explicit `--cli` there is
   * nothing declared to go back to, so the adopted CLI stays the run's own.
   */
  private restoreDeclaredCli(declared: CliOptions, adopted: CliOptions): CliOptions {
    if (!declared.hasCli || declared.cli === adopted.cli) return adopted;
    this.resolveAgent(declared.cli);
    return declared;
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
    this.resolveAgent(options.cli);
    this.reportFallbackChain(options);

    const command = options.command;

    if (options.verbose && options.quiet) {
      reportOperator("--verbose y --quiet son mutuamente excluyentes");
      return 1;
    }

    if (options.workingDirectory.includes(",")) {
      if (command !== "plan" && command !== "code") {
        reportOperator("--working-directory CSV solo se permite con plan o code");
        return 1;
      }
      // `plan` never mutates branches or tracker state, in either provider.
      if (command === "plan") return this.runWorkspacePlan(options);
      if (options.hu !== null) return this.runAzureWorkspaceCode(options);
      return this.runWorkspaceCode(options);
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

    if (command === "ticket-create") {
      if (!isValidHu(options.hu)) {
        reportOperator("ticket-create requiere --hu <id>");
        return 1;
      }
      if (options.type !== "Task" && options.type !== "Bug") {
        reportOperator("ticket-create requiere --type Task o --type Bug");
        return 1;
      }
      if (!options.title?.trim()) {
        reportOperator("ticket-create requiere --title <titulo>");
        return 1;
      }
      if (!options.descriptionFile?.trim()) {
        reportOperator("ticket-create requiere --description-file <path>");
        return 1;
      }
      try {
        if (!this.huInfoService.createTicket) throw new Error("El servicio Azure no soporta ticket-create");
        const result = await this.huInfoService.createTicket({
          hu: options.hu,
          type: options.type,
          title: options.title,
          descriptionFile: options.descriptionFile,
          ...(options.estimate !== null ? { estimate: options.estimate } : {}),
          ...(options.assignee ? { assignee: options.assignee } : {}),
          ...(options.fields.length > 0 ? { fields: options.fields } : {}),
        });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      } catch (error) {
        reportOperator(`lazy-workflow: no se pudo ejecutar ${command} (${errorMessage(error)})`);
        return 1;
      }
    }

    if (command === "ticket-link-parent" || command === "ticket-link-predecessor") {
      const [first, second] = command === "ticket-link-parent"
        ? [options.parent, options.child]
        : [options.blocker, options.blocked];
      const flags = command === "ticket-link-parent" ? "--parent <id> y --child <id>" : "--blocker <id> y --blocked <id>";
      if (first === null || second === null) {
        reportOperator(`${command} requiere ${flags} con enteros positivos`);
        return 1;
      }
      try {
        const service = this.huInfoService;
        const link = command === "ticket-link-parent"
          ? service.linkParent?.bind(service)
          : service.linkPredecessor?.bind(service);
        if (!link) throw new Error(`El servicio Azure no soporta ${command}`);
        console.log(JSON.stringify(await link(first, second), null, 2));
        return 0;
      } catch (error) {
        reportOperator(`lazy-workflow: no se pudo ejecutar ${command} (${errorMessage(error)})`);
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
    // Resolved once: an explicit --hu or a recovered Azure checkpoint both mean
    // this "code" invocation is an Azure HU run; every branch below consumes
    // this instead of reinspecting --hu or recovery state again.
    const isAzureHuRun = recoveringAzureCode || options.hu !== null;
    if (!isAzureHuRun && (options.branch !== null || options.baseBranch !== null)) {
      reportOperator("--branch y --base-branch solo se permiten en flujos Azure");
      return 1;
    }

    if (command === "code") {
      if (githubRecovery) {
        const adopted = this.adoptCheckpointCli(githubRecovery.cli, options, githubRecovery.handoffFrom ?? null);
        if (!adopted) return 1;
        const code = await this.runGitHubRecovery(adopted, githubRecovery);
        return code === 0 ? this.continueQueueAfterRecovery(this.restoreDeclaredCli(options, adopted), false) : code;
      }
      if (isAzureHuRun) return this.runAzureCode(options);
      return this.runDefaultWorkflow(command, options);
    }

    if (options.hu === null) return this.runDefaultWorkflow("plan", options);

    const huInfo = await this.huInfoService.getHuInfo(options.hu);
    const norms = await this.loadSagNorms(options, "planning");
    if (options.normasSag && norms === null) return 1;

    const run = await this.prompt({ kind: "azure-plan", huInfo }, options, norms);

    const execution = await this.codingAgent.run({ ...options, ...run }, true);
    const result = await this.continuePlanAfterAzureLogin(execution, resolveWorkflowRun(options.hu), options.workingDirectory, run.agent);
    console.log(JSON.stringify(result, null, 2));
    if (execution.failed) return 1;
    return this.publishAzurePlan(options.hu, result.text);
  }

  /**
   * Publish the plan the session returned. OpenCode decided the slices; creating
   * the work items and their blocking relations is the coordinator's mechanical
   * work, verified through the same ticket-* primitives.
   */
  private async publishAzurePlan(hu: number, text: string): Promise<number> {
    try {
      const tickets = parsePlan(text);
      if (tickets.length === 0) {
        reportOperator(`lazy-workflow: el plan de la HU ${hu} no requiere tickets de entrega.`);
        return 0;
      }
      // Only a plan with work to publish needs the publication primitives.
      const { createTicket, linkPredecessor } = this.huInfoService;
      if (!createTicket || !linkPredecessor) {
        reportOperator("lazy-workflow: el coordinador no expone las primitivas de publicación de plan; ejecución detenida.");
        return 1;
      }
      const service = new AzurePlanPublicationService(
        {
          createTicket: createTicket.bind(this.huInfoService),
          linkPredecessor: linkPredecessor.bind(this.huInfoService),
        },
        async (body) => {
          const path = join(await mkdtemp(join(tmpdir(), "lazy-workflow-plan-")), "description.html");
          await Bun.write(path, body);
          return path;
        },
      );
      const publication = await service.publish(hu, tickets);
      console.log(JSON.stringify(publication, null, 2));
      return 0;
    } catch (error) {
      reportOperator(`lazy-workflow: no se pudo publicar el plan de la HU ${hu} (${errorMessage(error)}); no se creó trabajo parcial sin verificar.`);
      return 1;
    }
  }

  private applyReporter(options: ParsedCliOptions): void {
    const reporter = this.createReporterFn({
      verbose: options.verbose,
      quiet: options.quiet,
      noColor: options.noColor,
    });
    setDefaultReporter(reporter);
  }

  /**
   * Names the resolved chain to the operator before anything runs, so a run
   * that declares `--fallback` shows what it will end up on if the primary
   * gets exhausted. Silent without `--fallback`, so the historical output is
   * unchanged (issue #236).
   */
  private reportFallbackChain(options: ParsedCliOptions): void {
    if (options.fallbackChain.length === 0) return;
    const rungs = fallbackChainOf(options);
    rungs.forEach((rung, index) => {
      const label = index === 0 ? "primario" : `respaldo ${index}`;
      reportOperator(`lazy-workflow: cadena de fallback escalon ${index + 1}/${rungs.length} (${label}): ${rung.cli} modelo=${rung.model} variante=${rung.variant}`);
    });
  }

  /**
   * Provider exhaustion descends the declared chain instead of ending the unit of
   * work. A rung sharing the active CLI resumes the same session with its model
   * and variant, so the work continues with the context already built; a rung
   * naming another CLI has no session to resume and continues the same unit
   * through `handOff`. The descent is sticky — the chain is only walked forward,
   * never back — and it keeps descending while each new rung exhausts too. An
   * ordinary failure, an exhausted chain, and a run without `--fallback` all come
   * back untouched, so the caller decides exactly as it does today (issues #238,
   * #239).
   */
  private async descendFallbackChain(
    options: CliOptions,
    execution: AgentExecution,
    resume: (sessionId: string, overrides: AgentResumeOverrides) => Promise<AgentResult>,
    onDescent: (rung: FallbackRung, sessionId: string) => Promise<void>,
    handOff: (rung: FallbackRung) => Promise<AgentExecution>,
  ): Promise<AgentExecution> {
    let current = execution;
    let active: FallbackRung = { cli: options.cli, model: options.model, variant: options.variant };
    let index = 0;
    /** When the bounded wait ends, set on the first exhausted chain rather than at the start of the run. */
    let waitDeadline: number | null = null;
    while (current.exhaustion) {
      let next = nextRung(options, index);
      if (!next) {
        waitDeadline ??= this.clock.now() + options.fallbackWaitMaxSeconds * 1000;
        if (!await this.waitForPrimaryRetry(options, active, current.exhaustion, waitDeadline)) return current;
        // The retry starts over at the head of the chain, so whichever rung
        // recovers its quota first is the one the unit continues on.
        index = -1;
        next = nextRung(options, index)!;
      }
      const sessionId = current.result.sessionId;
      const handedOff = next.rung.cli !== active.cli;
      reportOperator(
        `lazy-workflow: escalón ${describeRung(active)} agotado (${current.exhaustion.cause}); desciendo a ${describeRung(next.rung)} ${
          handedOff ? "traspasando el trabajo a una sesión nueva" : `reanudando la sesión ${sessionId}`
        }.`,
      );
      active = next.rung;
      index = next.index;
      try {
        if (handedOff) {
          current = await handOff(next.rung);
        } else {
          await onDescent(next.rung, sessionId);
          const result = await resume(sessionId, { model: next.rung.model, variant: next.rung.variant });
          current = { result, azureLoginRequired: false, failed: false };
        }
      } catch (error) {
        // Only exhaustion keeps descending; a missing session or any ordinary
        // failure belongs to the caller's own error handling, untouched.
        if (!(error instanceof AgentExhaustionError)) throw error;
        current = { result: error.result, azureLoginRequired: false, failed: true, exhaustion: error.exhaustion };
      }
    }
    return current;
  }

  /**
   * Every rung of the declared chain is exhausted for the unit in course. Usage
   * lapses on its own, so the run waits a fixed interval and retries the chain
   * from its primary rung, up to a total bound counted from the first wait. When
   * the bound is spent it answers false and the caller fails closed with the
   * checkpoint intact, so a failure misclassified as exhaustion — a stale
   * credential, a revoked key — surfaces instead of waiting forever (ADR-0024).
   *
   * A run without `--fallback` declared no chain to exhaust, so it never waits
   * and ends exactly as it does today.
   */
  private async waitForPrimaryRetry(
    options: CliOptions,
    active: FallbackRung,
    exhaustion: ProviderExhaustion,
    deadline: number,
  ): Promise<boolean> {
    if (options.fallbackChain.length === 0) return false;
    const remaining = deadline - this.clock.now();
    const exhausted = `escalón ${describeRung(active)} (causa ${exhaustion.cause})`;
    if (remaining < options.fallbackWaitSeconds * 1000) {
      reportOperator(
        `lazy-workflow: la cadena de fallback sigue agotada al alcanzar el tope de ${options.fallbackWaitMaxSeconds}s de espera; último ${exhausted}; checkpoint conservado.`,
      );
      return false;
    }
    reportOperator(
      `lazy-workflow: cadena de fallback agotada, último ${exhausted}; espero ${options.fallbackWaitSeconds}s y reintento el escalón primario; quedan ${Math.round(remaining / 1000)}s hasta el tope.`,
    );
    await this.retryTimer.wait(options.fallbackWaitSeconds * 1000);
    return true;
  }

  private async runDefaultWorkflow(command: "plan" | "code", options: CliOptions): Promise<number> {
    if (command === "plan") {
      const norms = await this.loadSagNorms(options, "planning");
      if (options.normasSag && norms === null) return 1;
      const run = await this.prompt({ kind: "github-plan" }, options, norms);
      const execution = await this.codingAgent.run({ ...options, ...run, session: null }, false);
      console.log(JSON.stringify(execution.result, null, 2));
      return execution.failed ? 1 : 0;
    }

    return this.runDefaultCodeWorkflow(options);
  }

  private async workspaceScope(options: CliOptions): Promise<WorkspaceScope> {
    const scope = await normalizeWorkspaceScope(options.workingDirectory, this.git, githubRepositoryFromRemote);
    if (scope.repositories.some(({ providerIdentity }) => providerIdentity === null)) {
      throw new Error("todos los repositorios del alcance deben tener un remote GitHub");
    }
    for (const repository of scope.repositories) {
      await this.githubDelivery?.verifyRepository?.(repository.providerIdentity!, repository.path);
    }
    return scope;
  }

  private async azureWorkspaceScope(options: CliOptions): Promise<WorkspaceScope> {
    const scope = await normalizeWorkspaceScope(options.workingDirectory, this.git, () => null);
    for (const repository of scope.repositories) {
      const origin = await this.git(["remote", "get-url", "origin"], repository.path);
      if (!isAzureRemote(origin)) {
        throw new Error(`El repositorio ${repository.path} no tiene un remote Azure DevOps`);
      }
    }
    return scope;
  }

  private async runAzureWorkspaceCode(options: CliOptions): Promise<number> {
    if (!this.huInfoService.prepareWorkspaceBranches || !this.huInfoService.prepareWorkspaceTicketBranches) {
      reportOperator("El servicio Azure no expone la preparación workspace de ramas");
      return 1;
    }
    if (!isValidHu(options.hu)) {
      reportOperator("runAzureWorkspaceCode requiere --hu");
      return 1;
    }
    if (!options.ticket || !Number.isInteger(options.ticket) || options.ticket <= 0) {
      reportOperator("runAzureWorkspaceCode requiere --ticket <id> con un entero positivo");
      return 1;
    }
    if (!this.huInfoService.createOrReusePullRequest || !this.huInfoService.checkoutTicketBranch
      || !this.huInfoService.pushTicketBranch || !this.huInfoService.linkPullRequest
      || !this.huInfoService.linkCommit || !this.huInfoService.getTicketInfo
      || !this.huInfoService.setEffort || !this.huInfoService.setState
      || !this.huInfoService.getCompletionManifestPath || !this.huInfoService.readCompletionManifest
      || !this.huInfoService.validateCompletionManifest || !this.huInfoService.getBranch
      || !this.huInfoService.validateEvidenceFile || !this.huInfoService.addAttachment
      || !this.huInfoService.setEvidence || !this.huInfoService.getState
      || !this.huInfoService.getEffort || !this.huInfoService.validateEvidence
      || !this.huInfoService.setHuState || !this.huInfoService.hasOpenDeliveryChildren
      || !this.huInfoService.getAutocodeContextForTicket || !this.huInfoService.getTicket
      || !this.huInfoService.getDescription || !this.huInfoService.getAttachments
      || !this.huInfoService.getEvidence || !this.huInfoService.validateDirectTicketContext
      || !this.huInfoService.linkTicketBranch) {
      reportOperator("El servicio Azure no expone todas las primitivas de entrega workspace");
      return 1;
    }
    const ticket = options.ticket;
    const hu = options.hu;
    const boundary = this.huInfoService;
    const startedAt = this.clock.now();
    let scope: WorkspaceScope;
    let checkpoint: AzureWorkspaceCheckpoint | null;
    try {
      scope = await this.azureWorkspaceScope(options);
      checkpoint = await this.azureWorkspaceCheckpoint.read(scope.stateDirectory);
    } catch (error) {
      reportOperator(`lazy-workflow: no se pudo leer el alcance workspace Azure (${errorMessage(error)}); ejecución detenida.`);
      return 1;
    }
    if (checkpoint) {
      const adopted = this.adoptCheckpointCli(checkpoint.cli, options);
      if (!adopted) return 1;
      options = adopted;
    }
    if (options.session !== null && (!checkpoint || checkpoint.sessionId !== options.session)) {
      reportOperator("lazy-workflow: la sesión no coincide con el checkpoint workspace Azure fijado.");
      return 1;
    }
    // Fail closed before any external effect: the recovered scope must be the same repositories,
    // in the same order, with the same remotes, for the same HU and ticket.
    if (checkpoint) {
      const mismatch = this.azureWorkspaceScopeMismatch(checkpoint, scope, hu, ticket);
      if (mismatch) {
        reportOperator(`lazy-workflow: ${mismatch}; ejecución detenida.`);
        return 1;
      }
    }
    try {
      await boundary.validateDirectTicketContext!(hu, ticket);
      const topology = await this.huInfoService.prepareWorkspaceBranches({
        hu,
        repositories: scope.repositories.map(({ path, remote }) => ({ path, remote })),
        baseBranch: options.baseBranch,
      });
      const ticketTopology = await this.huInfoService.prepareWorkspaceTicketBranches({
        hu,
        ticket,
        integrationBranch: topology.integrationBranch,
        repositories: scope.repositories.map(({ path, remote }) => ({ path, remote })),
      });
      if (checkpoint) {
        const drift = this.azureWorkspaceTopologyMismatch(checkpoint, topology, ticketTopology);
        if (drift) {
          reportOperator(`lazy-workflow: ${drift}; ejecución detenida.`);
          return 1;
        }
      }
      let phaseStart = startedAt;
      const accrue = (): number => {
        const now = this.clock.now();
        const elapsed = Math.max(0, now - phaseStart);
        phaseStart = now;
        return elapsed;
      };
      if (!checkpoint) {
        // Write the intent before the first external effect so a crashed session is recoverable.
        checkpoint = this.createAzureWorkspaceCheckpoint(hu, ticket, scope, topology, ticketTopology, options.cli);
        await this.azureWorkspaceCheckpoint.write(checkpoint, scope.stateDirectory);
      }
      if (checkpoint.phase === "started" || checkpoint.phase === "implementing") {
        const resuming = checkpoint.sessionId;
        const session = resuming
          ? { ...await this.codingAgent.resume(resuming, "continue", scope.parentDirectory, IMPLEMENTATION_READY_MARKER, getResumeOverrides(options)), failed: false }
          : await this.runAzureWorkspaceSession(options, scope, topology, ticketTopology);
        const terminal = !session.failed && containsMarker(session.text, IMPLEMENTATION_READY_MARKER);
        checkpoint = {
          ...checkpoint,
          phase: terminal ? "implementation-ready" : "implementing",
          sessionId: terminal ? null : (session.sessionId ?? resuming),
          activeDurationMs: checkpoint.activeDurationMs + accrue(),
        };
        await this.azureWorkspaceCheckpoint.write(checkpoint, scope.stateDirectory);
        if (session.failed) return 1;
        if (!terminal) {
          reportOperator(`lazy-workflow: la sesión ${options.cli} workspace Azure terminó sin ${IMPLEMENTATION_READY_MARKER}.`);
          return 1;
        }
      }
      return await this.integrateAzureWorkspaceCode(options, hu, ticket, scope, topology, ticketTopology, checkpoint, accrue);
    } catch (error) {
      reportOperator(`lazy-workflow: no se pudo preparar la topología multi-repositorio Azure (${errorMessage(error)}); ejecución detenida.`);
      return 1;
    }
  }

  private async runAzureWorkspaceSession(
    options: CliOptions,
    scope: WorkspaceScope,
    topology: AzureWorkspaceBranchTopology,
    ticketTopology: AzureWorkspaceBranchTopology,
  ): Promise<{ text: string; sessionId: string | null; failed: boolean }> {
    const run = await this.azureWorkspacePrompt(options, scope, topology, ticketTopology);
    const execution = await this.codingAgent.run({
      ...options,
      workingDirectory: scope.parentDirectory,
      ...run,
      session: null,
      terminalMarker: IMPLEMENTATION_READY_MARKER,
    }, true);
    if (execution.failed) {
      reportOperator(`lazy-workflow: ${options.cli} falló durante la entrega workspace Azure (${errorMessage(execution.result.text)}); ejecución detenida.`);
    }
    return { text: execution.result.text, sessionId: execution.result.sessionId ?? null, failed: !!execution.failed };
  }

  private azureWorkspaceScopeMismatch(
    checkpoint: AzureWorkspaceCheckpoint,
    scope: WorkspaceScope,
    hu: number,
    ticket: number,
  ): string | null {
    if (checkpoint.hu !== hu || checkpoint.ticket !== ticket) {
      return `el checkpoint workspace Azure pertenece a la HU ${checkpoint.hu} y al ticket ${checkpoint.ticket}`;
    }
    if (checkpoint.repositories.length !== scope.repositories.length) {
      return "el checkpoint workspace Azure declara otra cantidad de repositorios";
    }
    const drifted = scope.repositories.find((repository, index) =>
      repository.path !== checkpoint.repositories[index]?.path
      || repository.remote !== checkpoint.repositories[index]?.remote
    );
    if (drifted) return `el repositorio ${drifted.path} no coincide con la identidad remota del checkpoint workspace Azure`;
    return null;
  }

  /** The resolved branches and per-repository Azure identity must still be the checkpointed ones. */
  private azureWorkspaceTopologyMismatch(
    checkpoint: AzureWorkspaceCheckpoint,
    topology: AzureWorkspaceBranchTopology,
    ticketTopology: AzureWorkspaceBranchTopology,
  ): string | null {
    if (checkpoint.integrationBranch !== topology.integrationBranch) {
      return `la rama de integración cambió respecto del checkpoint workspace Azure (${checkpoint.integrationBranch})`;
    }
    const ticketBranch = ticketTopology.ticketBranch ?? `refs/heads/ticket/${checkpoint.ticket}`;
    if (checkpoint.ticketBranch !== ticketBranch) {
      return `la rama del ticket cambió respecto del checkpoint workspace Azure (${checkpoint.ticketBranch})`;
    }
    for (const unit of checkpoint.units) {
      const resolved = ticketTopology.units.find(({ path }) => path === unit.path);
      if (!resolved) return `el repositorio ${unit.path} del checkpoint workspace Azure ya no pertenece al alcance`;
      if (resolved.repository !== unit.repository || resolved.project !== unit.project) {
        return `el repositorio ${unit.path} cambió de identidad Azure respecto del checkpoint workspace`;
      }
    }
    return null;
  }

  private createAzureWorkspaceCheckpoint(
    hu: number,
    ticket: number,
    scope: WorkspaceScope,
    topology: AzureWorkspaceBranchTopology,
    ticketTopology: AzureWorkspaceBranchTopology,
    cli: AgentCli,
  ): AzureWorkspaceCheckpoint {
    return {
      schemaVersion: 2,
      cli,
      workflow: "azure-workspace-code",
      hu,
      ticket,
      phase: "started",
      sessionId: null,
      integrationBranch: topology.integrationBranch,
      ticketBranch: ticketTopology.ticketBranch ?? `refs/heads/ticket/${ticket}`,
      parentDirectory: scope.parentDirectory,
      activeDurationMs: 0,
      repositories: scope.repositories.map(({ path, remote }) => ({ path, remote })),
      units: [],
      receipts: {},
      intent: null,
    };
  }

  private async azureWorkspacePrompt(
    options: CliOptions,
    scope: WorkspaceScope,
    topology: AzureWorkspaceBranchTopology,
    ticketTopology: AzureWorkspaceBranchTopology,
  ): Promise<{ prompt: string; agent: AgentAuthority }> {
    return this.prompt(
      { kind: "azure-workspace-delivery", scope, hu: options.hu, ticket: options.ticket, topology, ticketTopology },
      options,
    );
  }

  private async integrateAzureWorkspaceCode(
    options: CliOptions,
    hu: number,
    ticket: number,
    scope: WorkspaceScope,
    topology: AzureWorkspaceBranchTopology,
    ticketTopology: AzureWorkspaceBranchTopology,
    initial: AzureWorkspaceCheckpoint,
    accrue: () => number,
  ): Promise<number> {
    let checkpoint = initial;
    const save = async (): Promise<void> => { await this.azureWorkspaceCheckpoint.write(checkpoint, scope.stateDirectory); };
    const integrationBranch = topology.integrationBranch;
    const ticketBranch = ticketTopology.ticketBranch ?? `refs/heads/ticket/${ticket}`;
    const ticketBranchAnchor = ticketTopology.ticketBranchAnchor ?? topology.anchor.workingDirectory;
    const boundary = this.huInfoService;

    const azureIdentity = new Map(ticketTopology.units.map((unit) => [unit.path, unit]));
    const units: Array<{ path: string; manifestPath: string; manifest?: unknown; commit?: string; pullRequest?: number; mergeCommit?: string; changed: boolean }> = [];
    for (const repository of scope.repositories) {
      const manifestPath = await boundary.getCompletionManifestPath!(repository.path);
      const exists = await Bun.file(manifestPath).exists();
      if (!exists) {
        const status = await this.git(["status", "--porcelain", "--untracked-files=all"], repository.path);
        if (status.trim()) {
          reportOperator(`lazy-workflow: el repositorio ${repository.path} quedó sucio sin manifest; ejecución detenida.`);
          return 1;
        }
        units.push({ path: repository.path, manifestPath, changed: false });
        continue;
      }
      units.push({ path: repository.path, manifestPath, changed: true });
    }

    const changedUnits = units.filter((unit) => unit.changed);
    if (changedUnits.length === 0) {
      reportOperator("lazy-workflow: el workspace no contiene cambios entregables; ejecución detenida.");
      return 1;
    }

    // Verify every manifest before anything is pinned: the ticket's Branch ArtifactLink is
    // permanent, so an unverified manifest must never be able to name the primary repository.
    // The coordinator's own fixed ticket branch stands in for the not-yet-written link.
    for (const unit of changedUnits) {
      try {
        const manifest = await boundary.readCompletionManifest!(unit.manifestPath, unit.path);
        const info = await boundary.getTicketInfo!(hu, ticket);
        await boundary.validateCompletionManifest!(manifest, { ...info, branch: ticketBranch }, ticket, unit.path);
        unit.manifest = manifest;
        unit.commit = manifest.commit;
      } catch (error) {
        reportOperator(`lazy-workflow: el manifest de ${unit.path} no es verificable (${errorMessage(error)}); ejecución detenida.`);
        return 1;
      }
    }

    // Azure allows the ticket exactly one native Branch ArtifactLink and it must name the primary
    // implementation repository: the first declared repository that actually changed. An existing
    // link stays authoritative, so the boundary reports which repository the ticket ended up on.
    let primaryRepository: string;
    try {
      const candidates = checkpoint.primaryRepository
        ? [checkpoint.primaryRepository, ...changedUnits.map(({ path }) => path)]
        : changedUnits.map(({ path }) => path);
      const linked = await boundary.linkTicketBranch!(hu, ticket, ticketBranch, candidates);
      primaryRepository = (linked as { workingDirectory?: string }).workingDirectory ?? candidates[0]!;
    } catch (error) {
      reportOperator(`lazy-workflow: no se pudo fijar la rama primaria del ticket (${errorMessage(error)}); ejecución detenida.`);
      return 1;
    }
    checkpoint = { ...checkpoint, primaryRepository };
    await save();

    const checkpointUnit = (path: string): AzureWorkspaceCheckpointUnit | undefined =>
      checkpoint.units.find((candidate) => candidate.path === path);
    checkpoint = {
      ...checkpoint,
      phase: "integrating",
      units: units.map((unit) => {
        const identity = azureIdentity.get(unit.path);
        const existing = checkpointUnit(unit.path);
        return {
          path: unit.path,
          remote: identity?.remote ?? existing?.remote ?? "",
          repository: identity?.repository ?? existing?.repository ?? "",
          project: identity?.project ?? existing?.project ?? "",
          changed: unit.changed,
          commit: unit.commit ?? null,
          pullRequest: existing?.pullRequest ?? null,
          mergeCommit: existing?.mergeCommit ?? null,
          receipts: existing?.receipts ?? {},
        };
      }),
    };
    await save();

    const delivered: Array<{ path: string; commit: string; pullRequest: number; mergeCommit: string }> = [];
    for (const unit of changedUnits) {
      const commit = unit.commit!;
      const identity = azureIdentity.get(unit.path);
      if (!identity) {
        reportOperator(`lazy-workflow: el repositorio ${unit.path} no tiene identidad Azure en la topología; ejecución detenida.`);
        return 1;
      }
      // Azure GUIDs, not names: `az` accepts either, but pull-request payloads only ever carry the
      // GUIDs that the identity checks compare against.
      const participant: AzurePullRequestTarget = {
        project: identity.projectId,
        repository: identity.repositoryId,
        source: identity.ticketBranch ?? ticketBranch,
        target: identity.integrationBranch,
      };
      const recorded = checkpointUnit(unit.path);
      // A verified receipt means the PR was created, associated and merged for this repository on
      // an earlier run; reuse it instead of creating a second pull request.
      if (recorded?.receipts.delivery && recorded.pullRequest && recorded.mergeCommit) {
        delivered.push({ path: unit.path, commit, pullRequest: recorded.pullRequest, mergeCommit: recorded.mergeCommit });
        continue;
      }
      checkpoint = { ...checkpoint, intent: { effect: "azure-delivery", target: unit.path } };
      await save();
      try {
        await boundary.checkoutTicketBranch!(ticketBranch, unit.path);
        await boundary.pushTicketBranch!(ticketBranch, unit.path);
        const created = await boundary.createOrReusePullRequest!(hu, ticket, participant);
        const pullRequest = created.pullRequest;
        const mergeCommit = created.mergeCommit;
        await boundary.linkPullRequest!(hu, ticket, pullRequest, participant);
        await boundary.linkCommit!(ticket, pullRequest, participant);
        delivered.push({ path: unit.path, commit, pullRequest, mergeCommit });
        checkpoint = {
          ...checkpoint,
          intent: null,
          units: checkpoint.units.map((candidate) => candidate.path === unit.path
            ? { ...candidate, pullRequest, mergeCommit, receipts: { ...candidate.receipts, delivery: { verifiedAt: new Date(this.clock.now()).toISOString() } } }
            : candidate),
        };
        await save();
      } catch (error) {
        // Fail closed: later repositories stay pending and no merge is rolled back or reverted.
        await save();
        reportOperator(`lazy-workflow: no se pudo entregar el repositorio ${unit.path} (${errorMessage(error)}); ejecución detenida.`);
        return 1;
      }
    }

    const completionManifest = await boundary.readCompletionManifest!(changedUnits[0]!.manifestPath, changedUnits[0]!.path);
    const completionInfo = await boundary.getTicketInfo!(hu, ticket);
    await boundary.validateCompletionManifest!(completionManifest, completionInfo, ticket, changedUnits[0]!.path);

    const ticketEffortBefore = await boundary.getEffort!(ticket);
    const baselineReal = ticketEffortBefore.effort.real ?? 0;
    const baselineRealHours = ticketEffortBefore.effort.realHours ?? 0;
    const ticketStateBefore = await boundary.getState!(ticket);

    for (const evidence of completionManifest.evidence) {
      await boundary.validateEvidenceFile!(evidence.path, evidence.kind);
    }

    const textEvidence = completionManifest.evidence.find(({ kind }) => kind !== "screen");
    if (!textEvidence) {
      reportOperator("lazy-workflow: el manifest workspace no contiene evidencia textual para completion-evidence; ejecución detenida.");
      return 1;
    }
    await boundary.validateEvidence!(ticket, textEvidence.path);

    for (const evidence of completionManifest.evidence) {
      const existingAttachment = completionInfo.attachments.find((attachment) =>
        typeof attachment.url === "string"
        && attachment.url.trim().length > 0
        && attachment.digest?.toLowerCase() === evidence.sha256.toLowerCase()
        && attachment.evidenceKind === evidence.kind
      );
      if (!existingAttachment) {
        await boundary.addAttachment!(ticket, evidence.path, evidence.kind);
      }
    }

    const refreshedInfo = await boundary.getTicketInfo!(hu, ticket);
    if (!refreshedInfo.completionEvidence) {
      await boundary.setEvidence!(ticket, textEvidence.path);
    }

    const finalInfo = await boundary.getTicketInfo!(hu, ticket);
    const unmetBeforeDone = finalInfo.gates.unmet.filter((gate) => gate !== COMPLETION_GATE.ticketState);
    if (unmetBeforeDone.length > 0) {
      reportOperator(`lazy-workflow: gates incumplidos en el ticket workspace ${ticket}: ${unmetBeforeDone.join(", ")}`);
      return 1;
    }

    // The ticket and the HU only move once every changed repository carries a verified receipt.
    const pending = checkpoint.units.filter((unit) => unit.changed && !unit.receipts.delivery);
    if (pending.length > 0) {
      reportOperator(`lazy-workflow: quedan repositorios sin entregar (${pending.map(({ path }) => path).join(", ")}); ejecución detenida.`);
      return 1;
    }
    checkpoint = { ...checkpoint, phase: "completing" };
    await save();

    let effortRevision = finalInfo.ticket.revision ?? ticketStateBefore.revision ?? 0;
    if (finalInfo.ticket.state !== "Done") {
      const currentState = await boundary.getState!(ticket);
      const done = await boundary.setState!(ticket, "Done", currentState.state ?? ticketStateBefore.state ?? "Active", true, currentState.revision ?? ticketStateBefore.revision ?? 0);
      // The state change advances the work item revision; setEffort must test against the new one.
      effortRevision = revisionOf(done) ?? (await boundary.getState!(ticket)).revision ?? effortRevision;
    }
    // Effort is cumulative and published exactly once: a receipt stops a rerun from adding the
    // accrued hours on top of the value it already published.
    if (!checkpoint.receipts.effort) {
      const activeHours = activeEffortHours(checkpoint.activeDurationMs + accrue());
      await boundary.setEffort!(ticket, baselineReal + activeHours, baselineRealHours + activeHours, effortRevision);
      checkpoint = { ...checkpoint, receipts: { ...checkpoint.receipts, effort: { verifiedAt: new Date(this.clock.now()).toISOString() } } };
      await save();
    }

    const verifyAfter = await boundary.getTicketInfo!(hu, ticket);
    if (verifyAfter.ticket.state !== "Done") {
      reportOperator(`lazy-workflow: no se pudo verificar la finalización del ticket workspace ${ticket}`);
      return 1;
    }

    const huState = await boundary.getState!(hu);
    let huTransitionApplied = false;
    if (huState.state === "Desarrollo Terminado") {
      huTransitionApplied = true;
    } else if (await boundary.hasOpenDeliveryChildren!(hu)) {
      reportOperator(`lazy-workflow: la HU ${hu} todavía tiene hijos de entrega abiertos; transición de HU omitida`);
    } else {
      try {
        await boundary.setHuState!(hu, "Desarrollo Terminado", huState.state ?? "En Desarrollo", huState.revision ?? 0);
        const verified = await boundary.getState!(hu);
        if (verified.state !== "Desarrollo Terminado") {
          reportOperator(`lazy-workflow: no se pudo verificar la transición de la HU ${hu}; el ticket ${ticket} se conservó en Done`);
        } else {
          huTransitionApplied = true;
        }
      } catch (error) {
        reportOperator(`lazy-workflow: no se pudo transicionar la HU ${hu} (${errorMessage(error)}); el ticket ${ticket} se conservó en Done`);
      }
    }

    checkpoint = { ...checkpoint, phase: "cleaning" };
    await save();
    // Repositories that produced no changes still had a ticket branch created for them.
    const cleaned: string[] = [];
    const uncleaned: string[] = [];
    for (const unit of units.filter(({ changed }) => !changed)) {
      if (checkpoint.receipts[`cleanup:${unit.path}`]) {
        cleaned.push(unit.path);
        continue;
      }
      try {
        await this.ticketBranchCleaner.deleteTicketBranch(ticketBranch, integrationBranch, unit.path);
        cleaned.push(unit.path);
        checkpoint = { ...checkpoint, receipts: { ...checkpoint.receipts, [`cleanup:${unit.path}`]: { verifiedAt: new Date(this.clock.now()).toISOString() } } };
        await save();
      } catch (error) {
        uncleaned.push(unit.path);
        reportOperator(`lazy-workflow: no se pudo limpiar la rama del ticket en ${unit.path} (${errorMessage(error)})`);
      }
    }

    const summary = {
      hu: hu,
      ticket: ticket,
      integrationBranch,
      ticketBranch,
      ticketBranchAnchor,
      delivered: delivered.map((entry) => ({ path: entry.path, pullRequest: entry.pullRequest, mergeCommit: entry.mergeCommit })),
      cleaned,
      uncleaned,
      ticketState: "Done",
      huState: huTransitionApplied ? "Desarrollo Terminado" : (huState.state ?? "En Desarrollo"),
      clean: uncleaned.length === 0,
    };
    console.log(JSON.stringify(summary, null, 2));
    // The aggregate manifest is the only proof left once the checkpoint goes: write it first, and
    // only when the delivery is clean, so a `clean: true` manifest never outlives an unclean run.
    if (uncleaned.length === 0) {
      try {
        await writeAzureWorkspaceManifest({
          hu,
          ticket,
          integrationBranch,
          ticketBranch,
          primaryRepository,
          repositories: checkpoint.units,
          summary: `${delivered.length} repositorios entregados`,
          clean: true,
        }, scope.stateDirectory);
      } catch (error) {
        // The delivery already landed: keep the checkpoint as the surviving evidence rather than
        // clearing it behind an unwritable manifest.
        reportOperator(`lazy-workflow: no se pudo escribir el manifest agregado del workspace (${errorMessage(error)}); el checkpoint se conservó.`);
        return 1;
      }
      await this.azureWorkspaceCheckpoint.clear(scope.stateDirectory);
    }
    return 0;
  }

  private async workspacePrompt(
    options: CliOptions,
    scope: WorkspaceScope,
    issue: SelectedManagedIssue | null,
    units: GitHubWorkspaceUnit[] = [],
  ): Promise<{ prompt: string; agent: AgentAuthority }> {
    return this.prompt({ kind: "github-workspace-delivery", scope, issue, units }, options);
  }

  private async runWorkspacePlan(options: CliOptions): Promise<number> {
    try {
      // The provider is resolved once here; every branch below consumes it
      // instead of reinspecting `--hu`.
      const provider = resolveWorkflowRun(options.hu);
      // Azure scope for an Azure HU run, GitHub scope for a GitHub repository run: the same single-provider rule as `code`.
      const scope = provider.kind === "azure-hu-run" ? await this.azureWorkspaceScope(options) : await this.workspaceScope(options);
      // The CSV list is not a path: SAG norms live in the anchor repository.
      const norms = await this.loadSagNorms({ ...options, workingDirectory: scope.repositories[0]!.path }, "planning");
      if (options.normasSag && norms === null) return 1;
      let huInfo: HuInfo | null = null;
      if (provider.kind === "azure-hu-run") {
        try {
          huInfo = await this.huInfoService.getHuInfo(provider.hu);
        } catch (error) {
          // Distinct from the outer catch: this is a tracker read failure, not a workspace one.
          reportOperator(`lazy-workflow: no se pudo leer la HU en Azure DevOps (${errorMessage(error)})`);
          return 1;
        }
      }
      const run = await this.prompt({ kind: "workspace-plan", scope, run: provider, huInfo }, options, norms);
      const execution = await this.codingAgent.run({ ...options, workingDirectory: scope.parentDirectory, ...run, session: null }, provider.kind === "azure-hu-run");
      const result = await this.continuePlanAfterAzureLogin(execution, provider, scope.parentDirectory, run.agent);
      reportOperator(JSON.stringify(result, null, 2));
      return execution.failed ? 1 : 0;
    } catch (error) {
      reportOperator(`lazy-workflow: no se pudo preparar el workspace (${errorMessage(error)})`);
      return 1;
    }
  }

  private async runWorkspaceCode(options: CliOptions): Promise<number> {
    let scope: WorkspaceScope;
    const releases: Array<() => Promise<void>> = [];
    try {
      scope = await this.workspaceScope(options);
      if (this.githubRepositoryLock) {
        for (const repository of scope.repositories) releases.push(await this.githubRepositoryLock.acquire(repository.path));
      }
      const existing = await this.githubWorkspaceCheckpoint.read(scope.stateDirectory);
      if (existing) {
        const adopted = this.adoptCheckpointCli(existing.cli, options);
        if (!adopted) return 1;
        options = adopted;
      }
      if (options.session !== null && (!existing || existing.sessionId !== options.session)) {
        reportOperator("lazy-workflow: la sesión no coincide con el checkpoint workspace fijado.");
        return 1;
      }
      if (existing) return await this.resumeWorkspaceCode(options, scope, existing);
      const anchor = scope.repositories[0];
      if (!anchor?.providerIdentity) throw new Error("el primer repositorio no tiene identidad GitHub");
      const selection = await this.githubManagedQueue.selectEligibleIssue?.(anchor.path);
      if (!selection || selection.kind !== "candidate") {
        reportOperator(selection?.kind === "blocked" ? "lazy-workflow: la cola workspace tiene issues no elegibles" : "lazy-workflow: no quedan issues GitHub elegibles");
        return selection?.kind === "blocked" ? 0 : 1;
      }
      if (selection.repository.nameWithOwner !== anchor.providerIdentity) {
        throw new Error("el Issue seleccionado no pertenece al primer repositorio del workspace");
      }
      if (!this.githubManagedQueue.claimSelectedIssue) throw new Error("el coordinador workspace no puede verificar el claim del Issue");
      const selectedCheckpoint = this.createWorkspaceCheckpoint(scope, selection.issue.number, options.cli);
      await this.githubWorkspaceCheckpoint.write(selectedCheckpoint, scope.stateDirectory);
      const issue = await this.githubManagedQueue.claimSelectedIssue(selection.issue.number, anchor.path);
      return await this.deliverWorkspaceCode(options, scope, issue, null);
    } catch (error) {
      reportOperator(`lazy-workflow: no se pudo coordinar la entrega workspace (${errorMessage(error)})`);
      return 1;
    } finally {
      for (const release of releases.reverse()) await release();
    }
  }

  private async resumeWorkspaceCode(options: CliOptions, scope: WorkspaceScope, checkpoint: GitHubWorkspaceCheckpoint): Promise<number> {
    const expected = scope.repositories.map(({ path, remote, providerIdentity }) => ({ path, remote, repository: providerIdentity }));
    if (JSON.stringify(expected) !== JSON.stringify(checkpoint.repositories)
      || checkpoint.units.some((unit, index) => unit.path !== expected[index]?.path || unit.repository !== expected[index]?.repository)) {
      reportOperator("lazy-workflow: el checkpoint workspace no coincide con el alcance declarado; ejecución detenida.");
      return 1;
    }
    if (checkpoint.phase === "conflict-resolving") {
      const reconciliation = checkpoint.reconciliation;
      const delivery = this.githubDelivery;
      const unit = reconciliation && checkpoint.units.find(({ path }) => path === reconciliation.path);
      if (!delivery
        || !reconciliation
        || !unit
        || unit.pullRequest !== reconciliation.pullRequest
        || !delivery.verifyPendingPullRequestReconciliation
        || !delivery.verifyPullRequestReconciliation) {
        reportOperator("lazy-workflow: el checkpoint workspace no contiene una reconciliación de PR completa.");
        return 1;
      }
      try {
        await delivery.verifyPendingPullRequestReconciliation(unit.branch, reconciliation.originalCommit, reconciliation.baseCommit, unit.path);
        const outcome = await this.runGitHubPullRequestReconciliation(options, {
          issue: checkpoint.issue,
          repository: unit.repository,
          pullRequest: reconciliation.pullRequest,
          branch: unit.branch,
          manifestPath: unit.manifestPath,
          originalCommit: reconciliation.originalCommit,
          baseCommit: reconciliation.baseCommit,
          workingDirectory: unit.path,
          issueWorkingDirectory: scope.repositories[0]!.path,
          requireEvidence: true,
        }, checkpoint.sessionId);
        if (outcome.kind === "pending") {
          await this.githubWorkspaceCheckpoint.write({ ...checkpoint, sessionId: outcome.sessionId }, scope.stateDirectory);
          return 1;
        }
        const { manifest } = outcome;
        const { push: _push, merge: _merge, ...unitReceipts } = unit.receipts;
        const reconciledUnit = { ...unit, commit: manifest.commit, phase: "implementation-ready" as const, receipts: { ...unitReceipts, manifest: { verifiedAt: new Date().toISOString() } } };
        const { [`push:${unit.path}`]: _workspacePush, [`merge:${unit.path}`]: _workspaceMerge, ...workspaceReceipts } = checkpoint.receipts;
        checkpoint = {
          ...checkpoint,
          phase: "integrating",
          sessionId: null,
          intent: null,
          reconciliation: null,
          receipts: workspaceReceipts,
          units: checkpoint.units.map((candidate) => candidate.path === unit.path ? reconciledUnit : candidate),
        };
        await this.githubWorkspaceCheckpoint.write(checkpoint, scope.stateDirectory);
      } catch (error) {
        reportOperator(`lazy-workflow: no se pudo reanudar la reconciliación workspace (${errorMessage(error)})`);
        return 1;
      }
    }
    if (checkpoint.sessionId) {
      try {
        const result = await this.codingAgent.resume(checkpoint.sessionId, "continue", scope.parentDirectory, IMPLEMENTATION_READY_MARKER, getResumeOverrides(options));
        reportOperator(JSON.stringify(result, null, 2));
        if (!containsMarker(result.text, IMPLEMENTATION_READY_MARKER)) return 1;
        checkpoint = { ...checkpoint, phase: "implementation-ready", sessionId: null };
        await this.githubWorkspaceCheckpoint.write(checkpoint, scope.stateDirectory);
      } catch (error) {
        reportOperator(`lazy-workflow: no se pudo reanudar el workspace (${errorMessage(error)})`);
        return 1;
      }
    }
    if (checkpoint.phase === "selected") {
      const reread = this.githubManagedQueue.reconcileClaimedIssue ?? this.githubManagedQueue.readIssueDetail;
      if (!reread) {
        reportOperator("lazy-workflow: no se puede verificar el Issue fijado del workspace; ejecución detenida.");
        return 1;
      }
      const issue = await reread.call(this.githubManagedQueue, checkpoint.issue, scope.repositories[0]!.path);
      return this.deliverWorkspaceCode(options, scope, issue, checkpoint);
    }
    return this.deliverWorkspaceCode(options, scope, null, checkpoint);
  }

  private createWorkspaceCheckpoint(scope: WorkspaceScope, issue: number, cli: AgentCli): GitHubWorkspaceCheckpoint {
    return {
      schemaVersion: 2,
      cli,
      workflow: "github-workspace-code",
      issue,
      phase: "selected",
      sessionId: null,
      branch: `refs/heads/issue/${issue}`,
      parentDirectory: scope.parentDirectory,
      repositories: scope.repositories.map(({ path, remote, providerIdentity }) => ({ path, remote, repository: providerIdentity! })),
      units: [],
      receipts: {},
      intent: null,
    };
  }

  private async deliverWorkspaceCode(
    options: CliOptions,
    scope: WorkspaceScope,
    issue: SelectedManagedIssue | null,
    existing: GitHubWorkspaceCheckpoint | null,
  ): Promise<number> {
    const anchor = scope.repositories[0];
    if (!anchor?.providerIdentity) throw new Error("el primer repositorio no tiene identidad GitHub");
    let checkpoint = existing;
    let units = checkpoint?.units ?? [];
    const issueNumber = issue?.number ?? checkpoint?.issue;
    if (!issueNumber) throw new Error("falta el Issue fijado para el workspace");
    if (!checkpoint) {
      checkpoint = this.createWorkspaceCheckpoint(scope, issueNumber, options.cli);
      await this.githubWorkspaceCheckpoint.write(checkpoint, scope.stateDirectory);
    }
    if (checkpoint.units.length < scope.repositories.length) {
      units = checkpoint.units;
      for (const repository of scope.repositories.slice(units.length)) {
        const prepared = await this.githubDelivery?.prepareBranch(issueNumber, repository.path);
        if (!prepared) throw new Error("el coordinador GitHub no expone preparación de ramas");
        units = [...units, { path: repository.path, remote: repository.remote, repository: repository.providerIdentity!, branch: prepared.branch, baseBranch: prepared.baseBranch, manifestPath: prepared.manifestPath, changed: null, startingCommit: (await this.git(["rev-parse", "HEAD^{commit}"], repository.path)).trim(), commit: null, evidence: [], pullRequest: null, mergeCommit: null, phase: "started", receipts: {} }];
        checkpoint = { ...checkpoint, phase: "started", units };
        await this.githubWorkspaceCheckpoint.write(checkpoint, scope.stateDirectory);
      }
      checkpoint = { ...checkpoint, phase: "started", branch: units[0]!.branch, units };
    }
    if (checkpoint.phase === "selected") {
      checkpoint = { ...checkpoint, phase: "started" };
      await this.githubWorkspaceCheckpoint.write(checkpoint, scope.stateDirectory);
    }
    const save = async (): Promise<void> => { await this.githubWorkspaceCheckpoint.write(checkpoint!, scope.stateDirectory); };
    if (checkpoint.phase === "implementing" && !checkpoint.sessionId) {
      throw new Error("el checkpoint workspace no conserva una sesión reanudable");
    }
    if (checkpoint.phase === "started" && !checkpoint.sessionId) {
      const execution = await this.codingAgent.run({ ...options, workingDirectory: scope.parentDirectory, ...(await this.workspacePrompt(options, scope, issue, units)), session: null, terminalMarker: IMPLEMENTATION_READY_MARKER }, false);
      reportOperator(JSON.stringify(execution.result, null, 2));
      const terminal = containsMarker(execution.result.text, IMPLEMENTATION_READY_MARKER);
      checkpoint = { ...checkpoint, phase: terminal ? "implementation-ready" : "implementing", sessionId: terminal ? null : execution.result.sessionId };
      await save();
      if (execution.failed || !terminal) return 1;
    }
    return this.integrateWorkspaceCode(options, scope, checkpoint);
  }

  private async integrateWorkspaceCode(
    options: CliOptions,
    scope: WorkspaceScope,
    initial: GitHubWorkspaceCheckpoint,
  ): Promise<number> {
    let checkpoint = initial;
    const save = async (): Promise<void> => { await this.githubWorkspaceCheckpoint.write(checkpoint, scope.stateDirectory); };
    const delivery = this.githubDelivery;
    if (!delivery) throw new Error("el coordinador GitHub no está habilitado");
    const changed: GitHubWorkspaceUnit[] = [];
    for (const unit of checkpoint.units) {
      if (checkpoint.receipts[`cleanup:${unit.path}`]) {
        changed.push({ ...unit, changed: unit.changed ?? unit.commit !== null, phase: "cleaning" });
      } else if (await Bun.file(unit.manifestPath).exists()) {
        const manifest = await delivery.readManifest(unit.manifestPath, unit.path);
        if (manifest.issue !== checkpoint.issue || manifest.branch !== unit.branch) throw new Error(`el manifest de ${unit.path} no coincide con el Issue o la rama fijados`);
        if (!manifest.evidence?.length) throw new Error(`el manifest de ${unit.path} no contiene evidencia verificable`);
        changed.push({ ...unit, changed: true, commit: manifest.commit, evidence: manifest.evidence, phase: "implementation-ready", receipts: { ...unit.receipts, manifest: { verifiedAt: new Date().toISOString() } } });
      } else {
        const status = await this.git(["status", "--porcelain", "--untracked-files=all"], unit.path);
        if (status.trim()) throw new Error(`OpenCode dejó cambios sin commitear en ${unit.path}`);
        const head = (await this.git(["rev-parse", "HEAD^{commit}"], unit.path)).trim();
        if (head !== unit.startingCommit) throw new Error(`el repositorio ${unit.path} cambió sin manifest verificable`);
        changed.push({ ...unit, changed: false, phase: "cleaning" });
      }
    }
    if (!changed.some(({ changed: hasChanges }) => hasChanges)) {
      for (const unit of changed) {
        if (!unit.baseBranch) throw new Error(`falta la rama base verificada para ${unit.path}`);
        if (!checkpoint.receipts[`cleanup:${unit.path}`]) await delivery.cleanupBranch(unit.branch, unit.baseBranch, unit.startingCommit, unit.path);
      }
      throw new Error("el workspace no contiene cambios entregables");
    }
    checkpoint = { ...checkpoint, phase: "integrating", units: changed };
    await save();
    const effect = async (name: string, target: string, action: () => Promise<void>): Promise<void> => {
      checkpoint = { ...checkpoint, intent: { effect: name, target } };
      await save();
      try {
        await action();
        checkpoint = { ...checkpoint, intent: null, receipts: { ...checkpoint.receipts, [name]: { verifiedAt: new Date().toISOString() } } };
        await save();
      } catch (error) {
        await save();
        throw error;
      }
    };
    const delivered: GitHubWorkspaceUnit[] = [];
    for (const unit of changed.filter(({ changed: hasChanges }) => hasChanges)) {
      let currentUnit = unit;
      const baseBranch = currentUnit.baseBranch;
      if (!baseBranch) throw new Error(`falta la rama base verificada para ${currentUnit.path}`);
      if (!currentUnit.receipts.push) {
        await effect(`push:${currentUnit.path}`, currentUnit.commit!, () => delivery.pushCommit(currentUnit.branch, currentUnit.commit!, currentUnit.path));
        currentUnit = { ...currentUnit, receipts: { ...currentUnit.receipts, push: { verifiedAt: new Date().toISOString() } } };
        checkpoint = { ...checkpoint, units: checkpoint.units.map((candidate) => candidate.path === currentUnit.path ? currentUnit : candidate) };
        await save();
      }
      let pullRequest = currentUnit.pullRequest;
      if (!pullRequest) {
        await effect(`pull-request:${currentUnit.path}`, currentUnit.branch, async () => { pullRequest = (await delivery.createOrReusePullRequest(checkpoint.issue, currentUnit.branch, currentUnit.baseBranch!, currentUnit.commit!, currentUnit.path, false, `${checkpoint.repositories[0]!.repository}#${checkpoint.issue}`)).number; });
        currentUnit = { ...currentUnit, pullRequest, receipts: { ...currentUnit.receipts, "pull-request": { verifiedAt: new Date().toISOString() } } };
        checkpoint = { ...checkpoint, units: checkpoint.units.map((candidate) => candidate.path === currentUnit.path ? currentUnit : candidate) };
        await save();
      }
      if (!pullRequest) throw new Error(`no se pudo resolver el PR de ${currentUnit.path}`);
      let mergeCommit = currentUnit.mergeCommit;
      if (!mergeCommit) {
        try {
          await effect(`merge:${currentUnit.path}`, `${pullRequest}`, async () => { mergeCommit = (await delivery.mergePullRequest(pullRequest!, checkpoint.issue, currentUnit.branch, currentUnit.baseBranch!, currentUnit.commit!, currentUnit.path)).mergeCommit; });
        } catch (error) {
          if (!(error instanceof GitHubPullRequestConflictError)
            || !delivery.preparePullRequestReconciliation
            || !delivery.verifyPullRequestReconciliation) throw error;
          const originalCommit = currentUnit.commit!;
          const { baseCommit } = await delivery.preparePullRequestReconciliation(currentUnit.branch, baseBranch, originalCommit, currentUnit.path);
          checkpoint = {
            ...checkpoint,
            phase: "conflict-resolving",
            sessionId: null,
            intent: { effect: "reconcile-merge", target: `${currentUnit.path}:${pullRequest}:${originalCommit}:${baseCommit}` },
            reconciliation: { path: currentUnit.path, pullRequest, originalCommit, baseCommit },
          };
          await save();
          const outcome = await this.runGitHubPullRequestReconciliation(options, {
            issue: checkpoint.issue,
            repository: currentUnit.repository,
            pullRequest,
            branch: currentUnit.branch,
            manifestPath: currentUnit.manifestPath,
            originalCommit,
            baseCommit,
            workingDirectory: currentUnit.path,
            issueWorkingDirectory: scope.repositories[0]!.path,
            requireEvidence: true,
          }, null);
          if (outcome.kind === "pending") {
            checkpoint = { ...checkpoint, sessionId: outcome.sessionId };
            await save();
            return 1;
          }
          const { manifest } = outcome;
          const { push: _push, merge: _merge, ...unitReceipts } = currentUnit.receipts;
          currentUnit = { ...currentUnit, commit: manifest.commit, phase: "implementation-ready", receipts: { ...unitReceipts, manifest: { verifiedAt: new Date().toISOString() } } };
          const reconciledCommit = manifest.commit;
          const { [`push:${currentUnit.path}`]: _workspacePush, [`merge:${currentUnit.path}`]: _workspaceMerge, ...workspaceReceipts } = checkpoint.receipts;
          checkpoint = { ...checkpoint, phase: "integrating", sessionId: null, intent: null, reconciliation: null, receipts: workspaceReceipts, units: checkpoint.units.map((candidate) => candidate.path === currentUnit.path ? currentUnit : candidate) };
          await save();
          await effect(`push:${currentUnit.path}`, reconciledCommit, () => delivery.pushCommit(currentUnit.branch, reconciledCommit, currentUnit.path));
          currentUnit = { ...currentUnit, receipts: { ...currentUnit.receipts, push: { verifiedAt: new Date().toISOString() } } };
          checkpoint = { ...checkpoint, units: checkpoint.units.map((candidate) => candidate.path === currentUnit.path ? currentUnit : candidate) };
          await save();
          await effect(`merge:${currentUnit.path}`, `${pullRequest}`, async () => { mergeCommit = (await delivery.mergePullRequest(pullRequest!, checkpoint.issue, currentUnit.branch, currentUnit.baseBranch!, currentUnit.commit!, currentUnit.path)).mergeCommit; });
        }
        currentUnit = { ...currentUnit, mergeCommit, receipts: { ...currentUnit.receipts, merge: { verifiedAt: new Date().toISOString() } } };
        checkpoint = { ...checkpoint, units: checkpoint.units.map((candidate) => candidate.path === currentUnit.path ? currentUnit : candidate) };
        await save();
      }
      if (!mergeCommit) throw new Error(`no se pudo resolver el merge de ${currentUnit.path}`);
      delivered.push({ ...currentUnit, pullRequest, mergeCommit, phase: "reconciling", receipts: { ...currentUnit.receipts, push: { verifiedAt: new Date().toISOString() }, merge: { verifiedAt: new Date().toISOString() } } });
      checkpoint = { ...checkpoint, units: checkpoint.units.map((candidate) => candidate.path === currentUnit.path ? delivered.at(-1)! : candidate) };
      await save();
    }
    const first = delivered[0]!;
    if (!checkpoint.receipts["issue-closure"]) await effect("issue-closure", `${checkpoint.issue}`, () => delivery.closeIssue(checkpoint.issue, first.pullRequest!, first.mergeCommit!, scope.repositories[0]!.path));
    for (const changedUnit of changed) {
      const unit = checkpoint.units.find(({ path }) => path === changedUnit.path) ?? changedUnit;
      if (!unit.baseBranch) throw new Error(`falta la rama base verificada para ${unit.path}`);
      const commit = unit.commit ?? (await this.git(["rev-parse", "HEAD^{commit}"], unit.path)).trim();
      if (!checkpoint.receipts[`cleanup:${unit.path}`]) await effect(`cleanup:${unit.path}`, unit.branch, () => delivery.cleanupBranch(unit.branch!, unit.baseBranch!, commit, unit.path));
    }
    checkpoint = { ...checkpoint, phase: "cleaning", units: checkpoint.units.map((unit) => ({ ...unit, phase: "cleaning", receipts: { ...unit.receipts, cleanup: { verifiedAt: new Date().toISOString() } } })) };
    await save();
    await writeGitHubWorkspaceManifest({ issue: checkpoint.issue, branch: checkpoint.branch, repositories: checkpoint.units, summary: `${delivered.length} repositorios entregados`, clean: true }, scope.stateDirectory);
    if (!checkpoint.receipts["parent-reconciliation"] && this.githubParentReconciliation) {
      await effect("parent-reconciliation", `${checkpoint.issue}`, () => this.githubParentReconciliation!.reconcileParents(checkpoint.issue, scope.repositories[0]!.path));
    }
    await this.githubWorkspaceCheckpoint.clear(scope.stateDirectory);
    return 0;
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
        const adopted = this.adoptCheckpointCli(checkpoint.cli, options, checkpoint.handoffFrom ?? null);
        if (!adopted) return 1;
        let code: number;
        if (checkpoint.sessionId) {
          code = await this.runGitHubRecovery({ ...adopted, session: checkpoint.sessionId }, checkpoint, true);
        } else if (this.githubDelivery && ["started", "implementation-ready", "integrating", "conflict-resolving", "reconciling", "cleaning"].includes(checkpoint.phase)) {
          code = await this.runGitHubRecovery(adopted, checkpoint, true);
        } else {
          this.reportGitHubReconciliationRequired(checkpoint);
          return 1;
        }
        return code === 0 ? this.continueQueueAfterRecovery(this.restoreDeclaredCli(options, adopted), true) : code;
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

  // After recovery delivers the pinned issue and clears the checkpoint, keep
  // draining the queue so one run delivers every eligible issue. lockHeld=true
  // when the caller already holds the repository lock (non-reentrant).
  private async continueQueueAfterRecovery(options: CliOptions, lockHeld: boolean): Promise<number> {
    const store = this.githubCheckpointStore;
    const lock = this.githubRepositoryLock;
    const drain = async (): Promise<number> => {
      await this.githubParentReconciliation?.reconcileOpenParents(options.workingDirectory);
      return this.runDefaultCodeWorkflowLoop(options, store ?? null);
    };
    if (lockHeld || !store || !lock) return drain();
    const release = await lock.acquire(options.workingDirectory);
    try {
      return await drain();
    } finally {
      await release();
    }
  }

  private async runDefaultCodeWorkflowLoop(
    options: CliOptions,
    store: GitHubCheckpointStore | null,
  ): Promise<number> {
    const norms = await this.loadSagNorms(options, "coding");
    if (options.normasSag && norms === null) return 1;
    const queue = this.githubManagedQueue;
    // Deliver every eligible issue in one run: on completion, re-select the next.
    // Empty/blocked queue or any failure returns and exits the loop.
    while (true) {
      let queueOutcome: ManagedQueueOutcome;
      let checkpointWasWritten = false;
      let receipts: GitHubDeliveryCheckpoint["receipts"] = { "issue-claim": { verifiedAt: new Date().toISOString() } };
      if (store && queue.selectEligibleIssue && queue.claimSelectedIssue) {
        const selection = await queue.selectEligibleIssue(options.workingDirectory);
        if (selection.kind === "candidate") {
          receipts = {};
          await store.write({
            schemaVersion: 2,
            cli: options.cli,
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
            const claimedIssue = await queue.claimSelectedIssue(selection.issue.number, options.workingDirectory);
            queueOutcome = { kind: "selected", issue: claimedIssue, repository: selection.repository };
          } catch (error) {
            console.log(JSON.stringify({ outcome: RECONCILIATION_REQUIRED_MARKER, issue: selection.issue.number, phase: "selected" }, null, 2));
            reportOperator(`lazy-workflow: no se pudo verificar el claim del Issue #${selection.issue.number} (${errorMessage(error)}); checkpoint conservado.`);
            return 1;
          }
          receipts = { "issue-claim": { verifiedAt: new Date().toISOString() } };
          await store.write({
            schemaVersion: 2,
            cli: options.cli,
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
        queueOutcome = await queue.selectAndClaimEligibleIssue(options.workingDirectory);
      }
      if (queueOutcome.kind === "empty") {
        console.log(JSON.stringify({ outcome: QUEUE_EMPTY_MARKER }, null, 2));
        console.log(QUEUE_EMPTY_MARKER);
        console.log(WORKFLOW_STEP_FINISHED_MARKER);
        reportOperator("lazy-workflow: no quedan issues GitHub elegibles.");
        return 0;
      }
      if (queueOutcome.kind === "blocked") {
        const summary = queueOutcome.reasons.map(({ number, title, reasons }) =>
          `- #${number} ${title}: ${reasons.join(", ")}`
        ).join("\n");
        console.log(JSON.stringify({ outcome: QUEUE_BLOCKED_MARKER, reasons: queueOutcome.reasons }, null, 2));
        console.log(QUEUE_BLOCKED_MARKER);
        console.log(WORKFLOW_STEP_FINISHED_MARKER);
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
      /** The rung in course, written only once a descent moves it, so a run on its primary keeps the historical checkpoint shape. */
      let activeRung: FallbackRung | null = null;
      /** The CLI that owns the session in course: the run's own until a handoff moves the work to another one. */
      let activeCli = options.cli;
      const saveCheckpoint = async (phase: GitHubDeliveryCheckpoint["phase"], sessionId: string | null = null): Promise<void> => {
        if (store) await store.write({
          schemaVersion: 2,
          cli: activeCli,
          // Escrito solo mientras un traspaso tiene la sesión en otro CLI: es lo
          // que deja al comando original reanudar su propio trabajo (issue #252).
          ...(activeCli !== options.cli ? { handoffFrom: options.cli } : {}),
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
          ...(activeRung ? { model: activeRung.model, variant: activeRung.variant } : {}),
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
      // ADR-0020 superseded the uncoordinated shape: without a coordinator-owned
      // delivery adapter, branch, and manifest there is no delivery contract to
      // state, so the run fails closed instead of starting a session that cannot
      // be completed deterministically.
      if (!this.githubDelivery || !branch || !manifestPath) {
        reportOperator(`lazy-workflow: falta el adaptador de entrega GitHub, la rama o el manifest del Issue #${issue.number}; no se inicia una sesion sin contrato de entrega.`);
        return 1;
      }
      const run = await this.buildGitHubDeliveryPrompt(options, issue, repository, branch, manifestPath, norms);
      /** The authority of the session in course, restated by a handoff in the new CLI's own format. */
      let activeAuthority = run.agent;
      /** The session `activeCli` owns once a handoff opened a new one, so the two are never checkpointed crossed. */
      let activeSessionId: string | null = null;
      let execution;
      try {
        execution = await this.codingAgent.run({
          ...options,
          ...run,
          session: null,
          terminalMarker: IMPLEMENTATION_READY_MARKER,
        }, false);
        execution = await this.descendFallbackChain(
          options,
          execution,
          (sessionId, overrides) => this.codingAgent.resume(
            sessionId,
            "continue",
            options.workingDirectory,
            IMPLEMENTATION_READY_MARKER,
            { ...overrides, agent: activeAuthority },
          ),
          async (rung, sessionId) => {
            activeRung = rung;
            await saveCheckpoint("implementing", sessionId);
          },
          async (rung) => {
            const handedOff = await this.handOffGitHubDelivery(options, rung, {
              issue,
              repository,
              branch: branch!,
              manifestPath: manifestPath!,
              norms,
            });
            activeRung = rung;
            activeCli = rung.cli;
            activeAuthority = handedOff.agent;
            activeSessionId = handedOff.execution.result.sessionId;
            // El CLI nuevo y la sesión nueva quedan en el checkpoint en una sola
            // escritura, en cuanto el CLI nuevo devuelve el identificador: antes
            // de correr la sesión todavía no existe ninguno que registrar.
            await saveCheckpoint("implementing", activeSessionId);
            return handedOff.execution;
          },
        );
      } catch (error) {
        // A descent that failed still leaves a live session behind, so the
        // checkpoint keeps it and recovery resumes that one; only a session the
        // CLI declares gone goes back sessionless, as recovery already does.
        await saveCheckpoint(
          "reconciling",
          error instanceof AgentSessionNotFoundError ? null : activeSessionId ?? execution?.result.sessionId ?? null,
        );
        reportOperator(`lazy-workflow: la sesion GitHub fallo (${errorMessage(error)}); checkpoint conservado.`);
        return 1;
      }
      // El descenso es sticky solo dentro de esta unidad: la siguiente vuelve a
      // arrancar en el escalón primario, también cuando un traspaso cambió de CLI.
      if (activeCli !== options.cli) this.resolveAgent(options.cli);
      const result = execution.result;
      console.log(JSON.stringify(result, null, 2));
      const terminal = containsMarker(result.text, IMPLEMENTATION_READY_MARKER);
      await saveCheckpoint(execution.failed ? "reconciling" : (terminal ? "implementation-ready" : "implementing"), terminal ? null : result.sessionId);
      if (execution.failed) {
        this.reportGitHubReconciliationRequired({
          schemaVersion: 2,
          cli: activeCli,
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
            schemaVersion: 2,
            cli: activeCli,
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
          console.log(TICKET_COMPLETED_MARKER);
          console.log(WORKFLOW_STEP_FINISHED_MARKER);
          continue;
        } catch (error) {
          reportOperator(`lazy-workflow: no se pudo completar determinísticamente el Issue #${issue.number} (${errorMessage(error)}); checkpoint conservado.`);
          return 1;
        }
      }
      if (!terminal) {
        reportOperator(`lazy-workflow: la sesión GitHub terminó sin ${IMPLEMENTATION_READY_MARKER}.`);
        return 1;
      }
      if (store) await store.clear(options.workingDirectory);
      console.log(TICKET_COMPLETED_MARKER);
      console.log(WORKFLOW_STEP_FINISHED_MARKER);
    }
  }

  private async buildGitHubDeliveryPrompt(
    options: CliOptions,
    issue: SelectedManagedIssue,
    repository: GitHubRepositoryContext,
    branch: string,
    manifestPath: string,
    norms: SagContext | null,
  ): Promise<{ prompt: string; agent: AgentAuthority }> {
    return this.prompt({ kind: "github-delivery", issue, repository, branch, manifestPath }, options, norms);
  }

  /**
   * The cross-CLI handoff: a fresh session in the rung's CLI continuing the same
   * fixed unit of work. It receives the coordinator's own delivery prompt —
   * same issue, branch, manifest path and marker contract — plus the progress
   * already verified on disk, and the authority profile in the format the new CLI
   * enforces. Nothing the exhausted session said travels with it (ADR-0025).
   */
  private async handOffGitHubDelivery(
    options: CliOptions,
    rung: FallbackRung,
    work: {
      issue: SelectedManagedIssue;
      repository: GitHubRepositoryContext;
      branch: string;
      manifestPath: string;
      norms: SagContext | null;
    },
  ): Promise<{ execution: AgentExecution; agent: AgentAuthority }> {
    const handoffOptions: CliOptions = { ...options, cli: rung.cli, model: rung.model, variant: rung.variant };
    const run = await this.prompt(
      { kind: "github-delivery", issue: work.issue, repository: work.repository, branch: work.branch, manifestPath: work.manifestPath },
      handoffOptions,
      work.norms,
      await this.verifiedProgress(options.workingDirectory, "implementing", work.branch, work.manifestPath),
    );
    this.resolveAgent(rung.cli);
    return {
      execution: await this.codingAgent.run({
        ...handoffOptions,
        ...run,
        session: null,
        terminalMarker: IMPLEMENTATION_READY_MARKER,
      }, false),
      agent: run.agent,
    };
  }

  /**
   * What a handoff can state about the work already done: the checkpoint phase
   * and what the repository itself answers. A commit that does not exist yet, an
   * unreadable worktree, or a manifest never written are all absences the section
   * names rather than failures that stop the handoff.
   */
  private async verifiedProgress(
    workingDirectory: string,
    phase: GitHubDeliveryPhase,
    branch: string,
    manifestPath: string,
  ): Promise<HandoffProgress> {
    const readGit = async (args: string[]): Promise<string | null> => {
      try {
        return (await this.git(args, workingDirectory)).trim() || null;
      } catch {
        return null;
      }
    };
    return {
      phase,
      branch,
      // `log -1` fails on a branch with no commits yet, which is the absence the
      // section states; `rev-parse HEAD` would answer the base tip instead.
      commit: await readGit(["log", "-1", "--format=%H %s"]),
      uncommitted: await readGit(["status", "--porcelain", "--untracked-files=all"]) ?? "",
      manifest: await Bun.file(manifestPath).text().catch(() => null),
    };
  }

  private async buildGitHubReconciliationPrompt(
    options: CliOptions,
    issue: SelectedManagedIssue,
    repository: string,
    pullRequest: number,
    branch: string,
    manifestPath: string,
    originalCommit: string,
    baseCommit: string,
  ): Promise<{ prompt: string; agent: AgentAuthority }> {
    return this.prompt(
      {
        kind: "github-reconciliation",
        issue,
        repository: { nameWithOwner: repository },
        branch,
        manifestPath,
        pullRequest,
        originalCommit,
        baseCommit,
      },
      options,
    );
  }

  private async runGitHubPullRequestReconciliation(
    options: CliOptions,
    context: {
      issue: number;
      repository: string;
      pullRequest: number;
      branch: string;
      manifestPath: string;
      originalCommit: string;
      baseCommit: string;
      workingDirectory: string;
      issueWorkingDirectory: string;
      requireEvidence: boolean;
    },
    sessionId: string | null,
  ): Promise<GitHubReconciliationOutcome> {
    const delivery = this.githubDelivery;
    const readIssue = (this.githubManagedQueue.reconcileClaimedIssue ?? this.githubManagedQueue.readIssueDetail)?.bind(this.githubManagedQueue);
    if (!delivery?.verifyPullRequestReconciliation || !readIssue) {
      throw new Error("No se puede reconstruir el Issue fijado para reconciliar el PR");
    }
    const issue = await readIssue(context.issue, context.issueWorkingDirectory);
    const run = await this.buildGitHubReconciliationPrompt(
      { ...options, workingDirectory: context.workingDirectory },
      issue,
      context.repository,
      context.pullRequest,
      context.branch,
      context.manifestPath,
      context.originalCommit,
      context.baseCommit,
    );
    let failed = false;
    const result = sessionId
      ? await this.codingAgent.resume(sessionId, run.prompt, context.workingDirectory, IMPLEMENTATION_READY_MARKER, { ...getResumeOverrides(options), agent: run.agent })
      : await this.codingAgent.run({ ...options, workingDirectory: context.workingDirectory, ...run, session: null, terminalMarker: IMPLEMENTATION_READY_MARKER }, false)
        .then((execution) => {
          failed = execution.failed === true;
          return execution.result;
        });
    reportOperator(JSON.stringify(result, null, 2));
    if (failed || !containsMarker(result.text, IMPLEMENTATION_READY_MARKER)) {
      return { kind: "pending", sessionId: result.sessionId };
    }
    const manifest = await delivery.readManifest(context.manifestPath, context.workingDirectory);
    if (manifest.issue !== context.issue
      || manifest.branch !== context.branch
      || (context.requireEvidence && !manifest.evidence?.length)) {
      throw new Error(`El manifest reconciliado de ${context.workingDirectory} no es verificable`);
    }
    await delivery.verifyPullRequestReconciliation(
      context.branch,
      context.originalCommit,
      context.baseCommit,
      manifest.commit,
      context.workingDirectory,
    );
    return { kind: "ready", manifest };
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

    let manifest = await delivery.readManifest(fixedManifestPath, options.workingDirectory);
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
      try {
        await effect("merge", `${pullRequest}`, async () => {
          const merged = await delivery.mergePullRequest!(pullRequest!, checkpoint.issue, checkpoint.branch!, checkpoint.baseBranch!, manifest.commit, options.workingDirectory);
          mergeCommit = merged.mergeCommit;
          checkpoint = { ...checkpoint, pullRequest, mergeCommit };
        });
      } catch (error) {
        if (!(error instanceof GitHubPullRequestConflictError)
          || !delivery.preparePullRequestReconciliation
          || !delivery.verifyPullRequestReconciliation) throw error;
        const originalCommit = manifest.commit;
        const { baseCommit } = await delivery.preparePullRequestReconciliation(fixedBranch, fixedBaseBranch, originalCommit, options.workingDirectory);
        checkpoint = {
          ...checkpoint,
          phase: "conflict-resolving",
          intent: { effect: "reconcile-merge", target: `${pullRequest}:${originalCommit}:${baseCommit}` },
          reconciliation: { pullRequest, originalCommit, baseCommit },
        };
        await save();
        const outcome = await this.runGitHubPullRequestReconciliation(options, {
          issue: checkpoint.issue,
          repository: checkpoint.repository,
          pullRequest,
          branch: fixedBranch,
          manifestPath: fixedManifestPath,
          originalCommit,
          baseCommit,
          workingDirectory: options.workingDirectory,
          issueWorkingDirectory: options.workingDirectory,
          requireEvidence: false,
        }, null);
        if (outcome.kind === "pending") {
          checkpoint = { ...checkpoint, phase: "conflict-resolving", sessionId: outcome.sessionId };
          await save();
          throw new Error("La reconciliación del PR no terminó con IMPLEMENTATION_READY");
        }
        manifest = outcome.manifest;
        const { push: _push, merge: _merge, manifest: _manifest, ...receipts } = checkpoint.receipts;
        checkpoint = {
          ...checkpoint,
          commit: manifest.commit,
          phase: "implementation-ready",
          sessionId: null,
          intent: null,
          reconciliation: null,
          receipts: { ...receipts, manifest: { verifiedAt: new Date().toISOString() } },
        };
        await save();
        await effect("push", manifest.commit, () => delivery.pushCommit(fixedBranch, manifest.commit, options.workingDirectory));
        await effect("merge", `${pullRequest}`, async () => {
          const merged = await delivery.mergePullRequest!(pullRequest!, checkpoint.issue, fixedBranch, fixedBaseBranch, manifest.commit, options.workingDirectory);
          mergeCommit = merged.mergeCommit;
          checkpoint = { ...checkpoint, pullRequest, mergeCommit };
        });
      }
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
    await unlink(fixedManifestPath).catch(() => undefined);
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
    const queue = this.githubManagedQueue;
    if (!store || !lock) {
      this.reportGitHubReconciliationRequired(checkpoint);
      return 1;
    }
    if (!lockAlreadyHeld) {
      const release = await lock.acquire(options.workingDirectory);
      try {
        return await this.runGitHubRecovery(options, checkpoint, true);
      } finally {
        await release();
      }
    }
    try {
      const recoveryCheckpoint = await store.read(options.workingDirectory);
      if (!recoveryCheckpoint || recoveryCheckpoint.issue !== checkpoint.issue) {
        this.reportGitHubReconciliationRequired(checkpoint);
        return 1;
      }
      if (this.githubDelivery && recoveryCheckpoint.phase !== "conflict-resolving") {
        if (!recoveryCheckpoint.branch || !recoveryCheckpoint.baseBranch) {
          throw new Error("el checkpoint GitHub no contiene la rama fijada");
        }
        await this.githubDelivery.verifyRepository?.(recoveryCheckpoint.repository, options.workingDirectory);
        await this.githubDelivery.checkoutBranch?.(recoveryCheckpoint.branch, recoveryCheckpoint.baseBranch, options.workingDirectory);
        await this.githubDelivery.verifyBranch?.(recoveryCheckpoint.branch, recoveryCheckpoint.baseBranch, options.workingDirectory);
      }
    } catch (error) {
      const preserved = await store.read(options.workingDirectory).catch(() => checkpoint) ?? checkpoint;
      this.reportGitHubReconciliationRequired(preserved);
      reportOperator(`lazy-workflow: no se pudo preparar la rama fijada del Issue #${checkpoint.issue} (${errorMessage(error)}); checkpoint conservado.`);
      return 1;
    }
    if (this.githubDelivery && checkpoint.sessionId === null && checkpoint.phase === "started") {
      try {
        const liveCheckpoint = await store.read(options.workingDirectory);
        const readIssue = (queue.reconcileClaimedIssue ?? queue.readIssueDetail)?.bind(queue);
        if (!liveCheckpoint || liveCheckpoint.issue !== checkpoint.issue || !readIssue) {
          this.reportGitHubReconciliationRequired(checkpoint);
          return 1;
        }
        const branch = liveCheckpoint.branch;
        const manifestPath = liveCheckpoint.manifestPath;
        const baseBranch = liveCheckpoint.baseBranch;
        if (!branch || !manifestPath || !baseBranch) {
          throw new Error("el checkpoint GitHub no contiene la rama y el manifest fijados");
        }
        const issue = await readIssue(liveCheckpoint.issue, options.workingDirectory);
        const repository: GitHubRepositoryContext = { nameWithOwner: liveCheckpoint.repository };
        if (await manifestBelongsToDelivery(manifestPath, liveCheckpoint.issue, branch)) {
          await this.completeGitHubDelivery(options, { ...liveCheckpoint, branch, manifestPath, baseBranch, phase: "implementation-ready", sessionId: null });
          console.log(TICKET_COMPLETED_MARKER);
          console.log(WORKFLOW_STEP_FINISHED_MARKER);
          return 0;
        }
        const norms = await this.loadSagNorms(options, "coding");
        if (options.normasSag && norms === null) return 1;
        const run = await this.buildGitHubDeliveryPrompt(options, issue, repository, branch, manifestPath, norms);
        const execution = await this.codingAgent.run({ ...options, ...run, session: null, terminalMarker: IMPLEMENTATION_READY_MARKER }, false);
        const terminal = containsMarker(execution.result.text, IMPLEMENTATION_READY_MARKER);
        await store.write({ ...liveCheckpoint, phase: terminal ? "implementation-ready" : "implementing", sessionId: terminal ? null : execution.result.sessionId }, options.workingDirectory);
        if (execution.failed || !terminal) {
          this.reportGitHubReconciliationRequired({ ...liveCheckpoint, phase: "implementing", sessionId: execution.result.sessionId });
          return 1;
        }
        await this.completeGitHubDelivery(options, { ...liveCheckpoint, phase: "implementation-ready", sessionId: null });
        console.log(TICKET_COMPLETED_MARKER);
        console.log(WORKFLOW_STEP_FINISHED_MARKER);
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
    if (this.githubDelivery && checkpoint.phase === "conflict-resolving") {
      let release: (() => Promise<void>) | null = null;
      try {
        if (!lockAlreadyHeld) release = await lock.acquire(options.workingDirectory);
        const liveCheckpoint = await store.read(options.workingDirectory);
        const reconciliation = liveCheckpoint?.reconciliation;
        if (!liveCheckpoint
          || liveCheckpoint.issue !== checkpoint.issue
          || !liveCheckpoint.branch
          || !liveCheckpoint.manifestPath
          || !liveCheckpoint.pullRequest
          || !reconciliation
          || reconciliation.pullRequest !== liveCheckpoint.pullRequest
          || !this.githubDelivery.verifyPendingPullRequestReconciliation
          || !this.githubDelivery.verifyPullRequestReconciliation) {
          throw new Error("el checkpoint no contiene una reconciliación de PR completa");
        }
        await this.githubDelivery.verifyRepository?.(liveCheckpoint.repository, options.workingDirectory);
        await this.githubDelivery.verifyPendingPullRequestReconciliation(
          liveCheckpoint.branch,
          reconciliation.originalCommit,
          reconciliation.baseCommit,
          options.workingDirectory,
        );
        const outcome = await this.runGitHubPullRequestReconciliation(options, {
          issue: liveCheckpoint.issue,
          repository: liveCheckpoint.repository,
          pullRequest: reconciliation.pullRequest,
          branch: liveCheckpoint.branch,
          manifestPath: liveCheckpoint.manifestPath,
          originalCommit: reconciliation.originalCommit,
          baseCommit: reconciliation.baseCommit,
          workingDirectory: options.workingDirectory,
          issueWorkingDirectory: options.workingDirectory,
          requireEvidence: false,
        }, liveCheckpoint.sessionId);
        if (outcome.kind === "pending") {
          await store.write({ ...liveCheckpoint, sessionId: outcome.sessionId }, options.workingDirectory);
          this.reportGitHubReconciliationRequired({ ...liveCheckpoint, sessionId: outcome.sessionId });
          return 1;
        }
        const { manifest } = outcome;
        const { push: _push, merge: _merge, manifest: _manifest, ...receipts } = liveCheckpoint.receipts;
        const readyCheckpoint: GitHubDeliveryCheckpoint = {
          ...liveCheckpoint,
          phase: "implementation-ready",
          sessionId: null,
          commit: manifest.commit,
          reconciliation: null,
          intent: null,
          receipts: { ...receipts, manifest: { verifiedAt: new Date().toISOString() } },
        };
        await store.write(readyCheckpoint, options.workingDirectory);
        await this.completeGitHubDelivery(options, readyCheckpoint);
        console.log(TICKET_COMPLETED_MARKER);
        console.log(WORKFLOW_STEP_FINISHED_MARKER);
        return 0;
      } catch (error) {
        const current = await store.read(options.workingDirectory).catch(() => checkpoint) ?? checkpoint;
        await store.write({ ...current, phase: "conflict-resolving" }, options.workingDirectory);
        this.reportGitHubReconciliationRequired({ ...current, phase: "conflict-resolving" });
        reportOperator(`lazy-workflow: no se pudo reconciliar el conflicto del Issue #${checkpoint.issue} (${errorMessage(error)}); checkpoint conservado.`);
        return 1;
      } finally {
        if (release) await release();
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
        console.log(TICKET_COMPLETED_MARKER);
        console.log(WORKFLOW_STEP_FINISHED_MARKER);
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
    const reconcileClaimedIssue = queue.reconcileClaimedIssue?.bind(queue);
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
      const result = await this.codingAgent.resume(
        liveCheckpoint.sessionId,
        "continue",
        options.workingDirectory,
        IMPLEMENTATION_READY_MARKER,
        getRecoveryOverrides(options, liveCheckpoint),
      );
      console.log(JSON.stringify(result, null, 2));
      const terminal = containsMarker(result.text, IMPLEMENTATION_READY_MARKER);
      await store.write({ ...liveCheckpoint, phase: terminal ? "implementation-ready" : "implementing", sessionId: terminal ? null : result.sessionId }, options.workingDirectory);
      if (this.githubDelivery) {
        if (!liveCheckpoint.branch || !liveCheckpoint.baseBranch) throw new Error("el checkpoint GitHub no contiene la rama fijada");
        await this.githubDelivery.verifyBranch?.(liveCheckpoint.branch, liveCheckpoint.baseBranch, options.workingDirectory);
        if (!terminal) {
          this.reportGitHubReconciliationRequired({ ...liveCheckpoint, phase: "implementing", sessionId: result.sessionId });
          return 1;
        }
        await this.completeGitHubDelivery(options, { ...liveCheckpoint, phase: "implementation-ready", sessionId: null });
        console.log(TICKET_COMPLETED_MARKER);
        console.log(WORKFLOW_STEP_FINISHED_MARKER);
        return 0;
      }
      if (!terminal) {
        reportOperator(`lazy-workflow: la sesión GitHub terminó sin ${IMPLEMENTATION_READY_MARKER}.`);
        this.reportGitHubReconciliationRequired({ ...liveCheckpoint, phase: "implementing", sessionId: terminal ? null : result.sessionId });
        return 1;
      }
      await store.clear(options.workingDirectory);
      console.log(TICKET_COMPLETED_MARKER);
      console.log(WORKFLOW_STEP_FINISHED_MARKER);
      return 0;
    } catch (error) {
      const reread = await store.read(options.workingDirectory).catch(() => null);
      const currentCheckpoint = reread ?? checkpoint;
      const sessionId = error instanceof AgentSessionNotFoundError ? null : currentCheckpoint.sessionId;
      const reconciledCheckpoint = { ...currentCheckpoint, phase: "reconciling" as const, sessionId };
      await store.write(reconciledCheckpoint, options.workingDirectory);
      this.reportGitHubReconciliationRequired(reconciledCheckpoint);
      reportOperator(`lazy-workflow: no se pudo reanudar el Issue #${currentCheckpoint.issue} (${errorMessage(error)}); checkpoint conservado.`);
      return 1;
    } finally {
      if (release) await release();
    }
  }

  /**
   * Azure login continuation for the Azure HU planning run: preserve the
   * session, wait for Azure access, and resume it exactly once with `continue`
   * and the same authority profile it started with. Both CLIs report the
   * handshake, so the continuation is the same in either. The
   * mono-repository and workspace planning modes share this one owner; the
   * working directory the resumed session runs from is the only fact that
   * differs by mode.
   */
  private async continuePlanAfterAzureLogin(
    execution: Pick<AgentExecution, "result" | "azureLoginRequired">,
    run: WorkflowRun,
    workingDirectory: string,
    agent: AgentAuthority,
  ): Promise<AgentExecution["result"]> {
    if (!execution.azureLoginRequired || run.kind !== "azure-hu-run") return execution.result;
    reportOperator(`Sesion detenida a la espera de az login: ${execution.result.sessionId}`);
    await this.huInfoService.waitForAccess(run.hu);
    return this.codingAgent.resume(execution.result.sessionId, "continue", workingDirectory, undefined, { agent });
  }

  private async loadSagNorms(options: CliOptions, phase: "planning" | "coding"): Promise<SagContext | null> {
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
      const run = await this.prompt({ kind: "architecture-review-sag", scope, context }, options);
      const execution = await this.codingAgent.run({ ...options, ...run, session: null }, options.hu !== null);
      let result = execution.result;
      if (execution.azureLoginRequired && options.hu !== null) {
        reportOperator(`Sesion detenida a la espera de az login: ${result.sessionId}`);
        await this.huInfoService.waitForAccess(options.hu);
        result = await this.codingAgent.resume(result.sessionId, "continue", options.workingDirectory, undefined, { agent: run.agent });
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

  /** The authority of a run: its profile, in the format the run's own CLI enforces. */
  private authority(spec: WorkflowPromptSpec, cli: AgentCli): AgentAuthority {
    const profile = authorityProfile(spec);
    return { profile, configPath: authorityConfigPath(cli, profile) };
  }

  /**
   * Prepare one run: what the coding agent is told, and what it is allowed to do.
   * Both come from the same spec and travel together, so a run can never carry the
   * delivery prompt without the matching authority profile.
   *
   * Every coordinator-fixed fact travels through `spec`; the operator request
   * stays supplemental.
   */
  private async prompt(
    spec: WorkflowPromptSpec,
    options: CliOptions,
    norms: SagContext | null = null,
    /** Set only by a cross-CLI handoff, so the same spec also states where the work stands. */
    progress: HandoffProgress | null = null,
  ): Promise<{ prompt: string; agent: AgentAuthority }> {
    return {
      prompt: await buildWorkflowPrompt(spec, {
        operatorRequest: options.prompt,
        workingDirectory: options.workingDirectory,
        norms,
        questions: options.numberOfQuestions,
        progress,
      }),
      agent: this.authority(spec, options.cli),
    };
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
    if (migrated) {
      const adopted = this.adoptCheckpointCli(migrated.cli, options);
      if (!adopted) return 1;
      options = adopted;
    }
    let checkpoint: VersionedAutocodeCheckpoint = migrated ?? {
      schemaVersion: 3,
      cli: options.cli,
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
          const activeHours = activeEffortHours(checkpoint.activeDurationMs);
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
        const authoritativeResumePrompt = buildResumePrompt(resumePrompt, norms);
        const run = await this.prompt({
          kind: "azure-delivery",
          context,
          ticketBranch,
          evidenceDirectory: manifestPath ? dirname(manifestPath) : null,
          manifestPath,
          workflowPhase: checkpoint.phase,
          completionGates: Object.values(COMPLETION_GATE),
        }, options, norms);
        const execution = await track(null, async () => sessionId
          ? { result: await this.codingAgent.resume(sessionId, authoritativeResumePrompt, options.workingDirectory, IMPLEMENTATION_READY_MARKER, { ...getResumeOverrides(options), agent: run.agent }), azureLoginRequired: false, failed: false }
          : this.codingAgent.run({
            ...options,
            ...run,
            session: null,
            terminalMarker: IMPLEMENTATION_READY_MARKER,
          }, true));
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
              const activeHours = activeEffortHours(checkpoint.activeDurationMs);
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
        if (execution.failed) throw new Error(`la sesión ${options.cli} termino con error`);
        await this.retryTimer.wait(10_000);
        resumePrompt = options.prompt;
      } catch (error) {
        if (error instanceof AgentSessionNotFoundError || error instanceof AgentSessionCloseError) {
          checkpoint = { ...checkpoint, phase: "reconciling", sessionId: null, activeSince: null, intent: null };
          await save();
          reportOperator(`lazy-workflow: la sesión ${error.sessionId} no está disponible; checkpoint sessionless conservado para reconciliación.`);
          return 1;
        }
        reportOperator(`lazy-workflow: la sesión ${options.cli} falló (${errorMessage(error)}); conservaré el checkpoint y reintentaré en 10s.`);
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
