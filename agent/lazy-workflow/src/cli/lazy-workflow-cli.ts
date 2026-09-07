import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, unlink } from "node:fs/promises";
import { HuInfoService } from "../azure/hu-info-service.ts";
import type { HuInfo } from "../azure/hu-info.ts";
import {
  AzureAutocodeService,
  COMPLETION_GATE,
  type AutocodeContext,
  type AutocodeState,
  type AutocodeAzureService,
  type CompletionGate,
  type IncompleteTicketCompletion,
  type TicketCompletionVerification,
  type VerifiedTicketCompletion,
} from "../azure/autocode-service.ts";
import type { TicketInfo } from "../azure/ticket-info-service.ts";
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
import { AgentExhaustionError, AgentSessionCloseError, AgentSessionNotFoundError, describeExhaustion, type AgentAuthority, type AgentExecution, type AgentResumeOverrides, type AgentRunOptions, type CodingAgent, type ProviderExhaustion } from "../coding-agent/coding-agent.ts";
import type { AgentResult } from "../coding-agent/agent-result.ts";
import { createCodingAgent, type CodingAgentFactory } from "../coding-agent/create-coding-agent.ts";
import { AGENT_CLI_PROFILES, DEFAULT_CLI, type AgentCli } from "../coding-agent/agent-cli.ts";
import { getDefaultReporter, reportOperator, reportOperatorHeading, setDefaultReporter } from "../output/operator-output.ts";
import { createReporter, type ReporterRunLogSink } from "../output/reporter.ts";
import { reportFailure, type FailureKind } from "../output/failure-kind.ts";
import { reportSessionEvent } from "../output/session-event.ts";
import { createRunLogSink, resolveRunLogPath, type RunLogRecordInput } from "../output/run-log.ts";
import { registerInterruptionHandlers, type InterruptionCheckpointProbe, type InterruptionProcess } from "../output/run-interruption.ts";
import { GitTicketBranchCleaner, runGit, type GitRunner } from "../git/git-ticket-branch-cleaner.ts";
import { SagNormsService } from "../sag/sag-norms-service.ts";
import {
  GitHubManagedQueueService,
  assigneeLogins,
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
import { SessionNotVerifiedError } from "../git/session-verification.ts";
import {
  GitHubDeliveryService,
  GitHubPullRequestConflictError,
  githubRepositoryFromRemote,
  type GitHubDeliveryAdapter,
} from "../github/github-delivery-service.ts";
import {
  GitHubParentReconciliationService,
  type GitHubParentReconciliationAdapter,
} from "../github/github-parent-reconciliation-service.ts";
import { GitHubRepositoryLockService, type GitHubRepositoryLockBoundary } from "../github/github-repository-lock.ts";
import {
  GitHubWorkspaceCheckpointStore,
  type GitHubWorkspaceCheckpoint,
  type GitHubWorkspaceUnit,
} from "../github/github-workspace-checkpoint.ts";
import { normalizeWorkspaceScope, type WorkspaceScope } from "../workspace/repository-scope.ts";
import { SudoSystemShutdown, type SystemShutdown } from "../system/shutdown-service.ts";
import {
  QUEUE_BLOCKED_MARKER,
  QUEUE_EMPTY_MARKER,
  RECONCILIATION_REQUIRED_MARKER,
  TICKET_COMPLETED_MARKER,
  WORKFLOW_STEP_FINISHED_MARKER,
} from "../prompts/workflow-contract.ts";
import {
  buildInterviewAnswersPrompt,
  buildResumePrompt,
  buildRoundRepairPrompt,
  buildWorkflowPrompt,
  resolveWorkflowRun,
  type HandoffProgress,
  type SagContext,
  type WorkflowPromptSpec,
  type WorkflowRun,
} from "../prompts/workflow-prompt.ts";
import { createQuestionChannel, type QuestionChannelFactory } from "../interaction/create-question-channel.ts";
import type { QuestionChannel } from "../interaction/question-channel.ts";
import { readPlanTurn, recommendedAnswers, type PlanTurn, type QuestionAnswers } from "../interaction/question-round.ts";
import { authorityConfigPath, authorityProfile } from "../prompts/authority-profile.ts";
import { AzurePlanPublicationService } from "../azure/plan-publication-service.ts";
import { parsePlan } from "../prompts/plan-contract.ts";
import { publishPlanIssues } from "../github/plan-publication-service.ts";
import {
  buildCli,
  variantRejection,
  type CliOptions as ParsedCliOptions,
  type CliParseResult,
  type CliParser,
  type FallbackRung,
} from "./parse-cli-options.ts";
import {
  createDeterministicToolServices,
  isDeterministicToolCommand,
  runDeterministicTool,
  type DeterministicToolServices,
} from "./deterministic-tools.ts";

type CliOptions = AgentRunOptions & ParsedCliOptions;

type GitHubReconciliationOutcome =
  | { kind: "pending"; sessionId: string }
  | { kind: "ready"; commit: string };

export type AzureBoundary = Pick<HuInfoService, "getHuInfo" | "waitForAccess">
  & Pick<AutocodeAzureService, "createTicket" | "linkParent" | "linkPredecessor">
  & Partial<{
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
  createOrReusePullRequest?(hu: number, ticket: number, participant?: AzurePullRequestTarget): Promise<{ pullRequest: number; mergeCommit: string }>;
  validateDirectTicketContext?(hu: number, ticket: number): Promise<void>;
  getCompletionInfo?(hu: number, ticket: number): Promise<{ hu: number; ticket: number; gates: TicketInfo["gates"] }>;
  prepareWorkspaceBranches?(options: { hu: number; repositories: readonly AzureWorkspaceRepositoryInput[]; baseBranch?: string | null; integrationBranch?: string }): Promise<AzureWorkspaceBranchTopology>;
  prepareWorkspaceTicketBranches?(options: { hu: number; ticket: number; integrationBranch: string; repositories: readonly AzureWorkspaceRepositoryInput[]; ticketBranch?: string; ticketBranchAnchor?: string | null }): Promise<AzureWorkspaceBranchTopology>;
  linkTicketBranch?(hu: number, ticket: number, ticketBranch: string, candidates: readonly string[]): Promise<unknown>;
  getBranch?(hu: number, ticket: number): Promise<{ hu: number; ticket: number; branch: string | null; integrationBranch: string | null }>;
  getTicket?(ticket: number): Promise<{ id: number; type: "Task" | "Bug" }>;
  getDescription?(ticket: number): Promise<{ ticket: number; description: string | null }>;
  getState?(ticket: number): Promise<{ ticket: number; state: string | null; revision: number | null }>;
  getHuState?(hu: number): Promise<{ hu: number; state: string | null; revision: number | null }>;
  getEffort?(ticket: number): Promise<{ ticket: number; effort: { estimated?: number; real?: number; realHours?: number } }>;
  setDescription?(ticket: number, filePath: string): Promise<unknown>;
  setState?(ticket: number, desiredState: string, expectedState: string, allowCompletion?: boolean, expectedRevision?: number): Promise<unknown>;
  setEffort?(ticket: number, realEffort: number, realEffortHours: number, expectedRevision: number): Promise<unknown>;
  setHuState?(hu: number, desiredState: string, expectedState: string, expectedRevision: number): Promise<{ hu: number; state: string; revision: number }>;
  getHuChildren?(hu: number): Promise<Array<{ id: number; type: string; state: string; title?: string }>>;
  hasOpenDeliveryChildren?(hu: number): Promise<boolean>;
  linkPullRequest?(hu: number, ticket: number, pullRequest: number, participant?: AzurePullRequestTarget): Promise<unknown>;
  linkCommit?(ticket: number, pullRequest: number, participant?: AzurePullRequestTarget): Promise<unknown>;
  validateSummary?(ticket: number, summary: string): Promise<void>;
  setSummary?(ticket: number, summary: string): Promise<unknown>;
  verifySession?(ticketBranch: string, integrationBranch: string, workingDirectory: string): Promise<{ commit: string }>;
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

function reportAzureFailure(
  kind: FailureKind,
  phase: string,
  options: Pick<CliOptions, "hu" | "ticket" | "workingDirectory" | "session" | "branch">,
  message: string,
  context: Partial<RunLogRecordInput["context"]> = {},
  checkpoint?: "preserved",
): void {
  reportFailure(kind, phase, {
    hu: options.hu,
    ticket: options.ticket,
    repository: options.workingDirectory,
    sessionId: options.session,
    branch: options.branch,
    ...context,
  }, message, undefined, checkpoint);
}

/**
 * Una validación de argumentos rechaza el run: publica el fallo y devuelve el
 * código de salida en la misma llamada, para que un sitio no pueda publicar sin
 * rechazar ni rechazar sin publicar. El contexto es el de un comando que abre
 * sesión, que identifica el trabajo por su Issue.
 */
function argumentError(
  options: Pick<CliOptions, "hu" | "issue" | "workingDirectory">,
  message: string,
): number {
  reportFailure("argument-error", "validating", {
    hu: options.hu,
    issue: options.issue,
    repository: options.workingDirectory,
  }, message);
  return 1;
}

/**
 * La misma decisión en un comando de tool de Azure, que identifica el trabajo
 * por su ticket y su rama en vez de por un Issue.
 */
function azureArgumentError(
  options: Pick<CliOptions, "hu" | "ticket" | "workingDirectory" | "session" | "branch">,
  message: string,
): number {
  reportAzureFailure("argument-error", "validating", options, message);
  return 1;
}

/** `completeGitHubDelivery` uses one explicit error type for manifest verification failures. */
class GitHubCoordinatedFailureError extends Error {
  constructor(readonly failureKind: FailureKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHubCoordinatedFailureError";
  }
}

class AzureCoordinatedFailureError extends Error {
  constructor(readonly failureKind: FailureKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AzureCoordinatedFailureError";
  }
}

function azureFailureKind(error: unknown, fallback: FailureKind): FailureKind {
  if (error instanceof SessionNotVerifiedError) return "session-not-verified";
  return error instanceof AzureCoordinatedFailureError ? error.failureKind : fallback;
}

function githubCompletionFailureKind(error: unknown): FailureKind {
  if (error instanceof SessionNotVerifiedError) return "session-not-verified";
  if (error instanceof GitHubCoordinatedFailureError) return error.failureKind;
  if (error instanceof GitHubPullRequestConflictError) return "pull-request-failure";
  return "deterministic-completion-failure";
}

function githubRecoveryFailureKind(error: unknown): FailureKind {
  return error instanceof GitHubCoordinatedFailureError || error instanceof GitHubPullRequestConflictError
    ? githubCompletionFailureKind(error)
    : "session-failure";
}

/** The run-log `workflow` label: the coarse family a command belongs to, not the command itself (ADR-0029). */
function runLogWorkflow(command: string): string {
  if (command === "plan" || command === "code") return command;
  return "tool";
}

/** The run-log `provider` label: which tracker this invocation targets. */
function runLogProvider(options: Pick<CliOptions, "command" | "hu" | "ticket">): "azure" | "github" {
  return options.hu !== null
    || options.ticket !== null
    || options.command.startsWith("hu-")
    || options.command.startsWith("ticket-")
    ? "azure"
    : "github";
}

type RunLogBase = Pick<RunLogRecordInput, "command" | "workflow" | "provider" | "cli" | "model" | "variant" | "context">;

function runLogBase(options: CliOptions, provider = runLogProvider(options)): RunLogBase {
  return {
    command: options.command,
    workflow: runLogWorkflow(options.command),
    provider,
    cli: options.cli,
    model: options.model,
    variant: options.variant,
    context: {
      issue: options.issue,
      ticket: options.ticket,
      hu: options.hu,
      repository: options.workingDirectory,
      sessionId: options.session,
      branch: options.branch,
    },
  };
}

/**
 * Whether a turn opened another question round, for the one caller that only
 * needs the yes or no: with the round bound already spent, a malformed round
 * and no round at all end the interview the same way.
 */
function asksAgain(text: string): boolean {
  try {
    return readPlanTurn(text).kind === "questions";
  } catch {
    return false;
  }
}

/** ADR 0009: active duration in hours, rounded upward to a quarter, never below one quarter. */
function activeEffortHours(activeDurationMs: number): number {
  return Math.max(0.25, Math.ceil(activeDurationMs / 900_000) / 4);
}

/**
 * Una reanudación agotada no es un fallo del coordinador: viaja como ejecución agotada para que
 * la cadena de fallback la reciba igual que a una corrida nueva.
 */
async function resumedExecution(resume: () => Promise<AgentResult>): Promise<AgentExecution> {
  try {
    return { result: await resume(), azureLoginRequired: false, failed: false };
  } catch (error) {
    if (!(error instanceof AgentExhaustionError)) throw error;
    return { result: error.result, azureLoginRequired: false, failed: true, exhaustion: error.exhaustion };
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
 *
 * "Explicit" is decided at adoption, not here: a `--model` declared beside a
 * `--cli` the run's own handoff moved off is no longer explicit about the CLI
 * that will run, and `adoptCheckpointCli` clears it before these options ever
 * reach this function.
 */
/**
 * Los overrides con los que Azure reanuda desde su checkpoint.
 *
 * El checkpoint Azure sí conserva el escalón al que un descenso movió el ticket, así que una
 * recuperación vuelve con ese modelo y no con el primario que ya se agotó. El de GitHub dejó de
 * conservarlo: allá ninguna sesión se reanuda (ADR-0038, ADR-0039).
 */
function getRecoveryOverrides(options: CliOptions, checkpoint: { model?: string | null; variant?: string | null }): AgentResumeOverrides {
  const overrides = getResumeOverrides(options);
  if (!checkpoint.model || options.hasModel) return overrides;
  return { model: checkpoint.model, ...(checkpoint.variant ? { variant: checkpoint.variant } : {}), ...overrides };
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

function isAuthenticationError(error: unknown): boolean {
  return /(?:authentication|authorization|unauthorized|forbidden|access token|login|\b401\b|\b403\b)/i.test(errorMessage(error));
}

const COMPLETION_GATE_MESSAGES: Record<CompletionGate, string> = {
  "pinned-ticket-context": "no se pudo reconstruir el ticket fijado como hijo directo de la HU",
  "ticket-state": "el estado del ticket no es Done",
  "completion-evidence": "falta la evidencia de completion",
  "real-effort": "falta el valor requerido de Real Effort",
  "real-effort-hours": "falta el valor requerido de Real Effort HH",
  "commit-url": "falta la URL del commit",
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

function reportUnmetCompletion(ticket: number, verification: IncompleteTicketCompletion, options?: CliOptions): void {
  const message = [
    `lazy-workflow: el ticket ${ticket} no cumple los gates de cierre; checkpoint sessionless conservado.`,
    ...verification.unmetGates.map((gate) => `- ${gate}: ${COMPLETION_GATE_MESSAGES[gate]}`),
  ].join("\n");
  if (options) reportAzureFailure("deterministic-completion-failure", "completing", options, message, { ticket }, "preserved");
  else reportOperator(message);
}

function requireVerifiedCompletion(
  ticket: number,
  verification: TicketCompletionVerification | null,
  fallbackMessage: string,
  options?: CliOptions,
): verification is VerifiedTicketCompletion {
  if (isIncompleteCompletion(verification)) {
    reportUnmetCompletion(ticket, verification, options);
  } else if (!verification) {
    if (options) reportAzureFailure("deterministic-completion-failure", "completing", options, fallbackMessage, { ticket }, "preserved");
    else reportOperator(fallbackMessage);
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
  "ticket-completion-info",
]);

/** Un identificador que el tracker puede aceptar: un HU, un ticket o un PR. */
function isPositiveId(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value > 0;
}

function isAzureRemote(origin: string): boolean {
  const trimmed = origin.trim();
  return /^https:\/\/(?:[^@\/]+@)?dev\.azure\.com\/|^git@ssh\.dev\.azure\.com:|^https?:\/\/[^\/]*\.visualstudio\.com\//.test(trimmed);
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
    private readonly sagNormsService: Pick<SagNormsService, "loadPlanning"> & Partial<Pick<SagNormsService, "loadCoding">> = new SagNormsService(),
    private readonly git: GitRunner = runGit,
    private readonly cliParser: CliParser = buildCli(),
    private readonly createReporterFn: typeof createReporter = createReporter,
    private readonly githubManagedQueue: GitHubManagedQueueAdapter = new GitHubManagedQueueService(),
    githubCheckpointStore?: GitHubCheckpointStore,
    githubRepositoryLock?: GitHubRepositoryLockBoundary,
    githubDelivery?: GitHubDeliveryAdapter,
    githubParentReconciliation?: GitHubParentReconciliationAdapter,
    private readonly azureWorkspaceCheckpoint: AzureWorkspaceCheckpointStore = new AzureWorkspaceCheckpointStore(),
    /**
     * The boundaries the standalone deterministic tools run against. They are
     * built on demand rather than here, because a workflow run never uses them
     * and must not pay for adapters it will not call (ADR-0026).
     */
    private readonly deterministicToolServices?: DeterministicToolServices,
    /**
     * How a planning run reaches the operator with its questions. Injected like
     * the coding agent seam, so a test drives an interview without opening a
     * socket or a terminal (ADR-0027).
     */
    private readonly createQuestionChannelFn: QuestionChannelFactory = createQuestionChannel,
    /**
     * The process a run installs its interruption handlers on. Injected like
     * every other boundary, so a test drives a signal or an unhandled
     * rejection without touching the real process running the suite.
     */
    private readonly processSignals: InterruptionProcess = process as unknown as InterruptionProcess,
    /**
     * How the machine is powered off when a run declares `--off`. Injected like
     * every other boundary, so a test verifies the decision without shutting
     * down the machine running the suite.
     */
    private readonly systemShutdown: SystemShutdown = new SudoSystemShutdown(),
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

  /**
   * El silencio que las sesiones de esta corrida pueden pasar, en milisegundos.
   *
   * Se fija al parsear y lo lee cada adaptador que se resuelva después: el watchdog vive en el
   * adaptador porque el silencio se mide sobre el stream que cada CLI emite (ADR-0039).
   */
  private idleTimeoutMs: number | undefined;

  private resolveAgent(cli: AgentCli): CodingAgent {
    this.activeAgent = typeof this.agentSource === "function"
      ? this.agentSource(cli, this.idleTimeoutMs)
      : this.agentSource;
    return this.activeAgent;
  }

  /**
   * A checkpoint pinned to an issue that was resolved outside this run's own
   * completion path (closed by hand, by another automation, or by a run whose
   * own checkpoint was lost) has nothing left to recover: `reconcileClaimedIssue`
   * throws once the issue is no longer eligible, and the recovery catch below
   * only knows how to preserve the checkpoint and ask to retry — so the same
   * failure repeats on every future invocation instead of ever converging.
   *
   * Scoped to checkpoints with no live session and no PR of their own, so an
   * in-flight completion that is closing the issue itself (still finishing
   * branch cleanup or parent reconciliation) is never short-circuited here.
   */
  private async githubCheckpointResolvedExternally(
    checkpoint: GitHubDeliveryCheckpoint,
    workingDirectory: string,
  ): Promise<SelectedManagedIssue | null> {
    if (checkpoint.commit) return null;
    const readIssue = this.githubManagedQueue.readIssueDetail?.bind(this.githubManagedQueue);
    if (!readIssue) return null;
    let issue: SelectedManagedIssue;
    try {
      issue = await readIssue(checkpoint.issue, workingDirectory);
    } catch (error) {
      throw new GitHubCoordinatedFailureError("claim-verification-failure", errorMessage(error), { cause: error });
    }
    if (issue.state === "OPEN") return null;
    if (issue.state === "CLOSED") return issue;
    throw new GitHubCoordinatedFailureError(
      "claim-verification-failure",
      `el Issue #${checkpoint.issue} devolvio un estado no verificable (${issue.state || "vacio"})`,
    );
  }

  /**
   * The claim on an orphaned checkpoint's issue is released the same way
   * `github-issue-release` does (ADR-0026: tools and workflows share one
   * path), and only when it still names the authenticated identity — an
   * assignment left by another identity (a different run, a human) is never
   * touched (issue #269).
   */
  private async releaseOrphanedCheckpointClaim(issue: SelectedManagedIssue, workingDirectory: string): Promise<void> {
    const verifyAuthentication = this.githubManagedQueue.verifyAuthentication?.bind(this.githubManagedQueue);
    const releaseOwnClaim = this.githubManagedQueue.releaseOwnClaim?.bind(this.githubManagedQueue);
    if (!verifyAuthentication || !releaseOwnClaim) {
      throw new GitHubCoordinatedFailureError("claim-verification-failure", "el adaptador GitHub no puede liberar el claim propio");
    }
    try {
      const identity = await verifyAuthentication(workingDirectory);
      if (!assigneeLogins(issue).includes(identity.login)) return;
      await releaseOwnClaim(issue.number, identity.login, workingDirectory);
    } catch (error) {
      throw new GitHubCoordinatedFailureError("claim-verification-failure", errorMessage(error), { cause: error });
    }
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
  private adoptCheckpointCli(cli: AgentCli, options: CliOptions, handoffFrom?: AgentCli): CliOptions | null {
    if (options.hasCli && options.cli !== cli && options.cli !== handoffFrom) {
      reportFailure(
        "argument-error",
        "reconciling",
        { repository: options.workingDirectory, sessionId: options.session },
        `lazy-workflow: el checkpoint pertenece al CLI ${cli}, no a ${options.cli}; checkpoint conservado. `
        + `Reanuda con --cli ${cli}, o sin --cli, para continuar el trabajo donde quedó.`,
      );
      return null;
    }
    // Parsing validated an explicit --variant against the command's own --cli,
    // which is not the CLI adopted here. An override the adopted one cannot
    // execute is an argument error like any other, caught with the checkpoint
    // intact rather than spent on a session that opens to die (issue #253).
    const rejection = options.hasVariant ? variantRejection(cli, options.variant) : null;
    if (rejection) {
      reportFailure(
        "argument-error",
        "reconciling",
        { repository: options.workingDirectory, sessionId: options.session },
        `lazy-workflow: la recuperación adopta el CLI ${cli} y ${rejection}; checkpoint conservado.`,
      );
      return null;
    }
    this.resolveAgent(cli);
    if (options.cli === cli) return options;
    // The declared `--cli` and `--model` are one pairing: the model is written in
    // the vocabulary of the CLI beside it. Reaching here with an explicit `--cli`
    // means the guard above let it through as `handoffFrom` — the run's own
    // handoff moved the session to another CLI — so that model names the CLI that
    // no longer holds the work, and applying it would resume OpenCode with
    // `claude-sonnet-5`. The checkpoint's own rung stands instead.
    //
    // Without an explicit `--cli` nothing was paired: `--model` has always named
    // whatever CLI holds the work, and it keeps doing so. The variant survives
    // either way, because the check above just validated it against this CLI.
    if (options.hasCli && options.hasModel) {
      reportOperator(
        `lazy-workflow: --model ${options.model} quedó declarado para ${options.cli} y el trabajo vive en ${cli}; `
        + "se reanuda con el escalón que el checkpoint conserva.",
      );
      return { ...options, cli, hasModel: false, model: AGENT_CLI_PROFILES[cli].defaultModel };
    }
    // No explicit override survives adoption here (the branch above is what clears
    // one), so `options.model` may still be the default resolved for the CLI this
    // run started with — or with none declared — rather than the one it adopts.
    // A brand-new session opened straight off `adopted` (never through
    // `getResumeOverrides`, which only gates a *resume*) would otherwise carry that
    // stale default into the adopted CLI's binary (ADR-0034, issue #298).
    return { ...options, cli, ...(options.hasModel ? {} : { model: AGENT_CLI_PROFILES[cli].defaultModel }) };
  }

  /**
   * The CLI a run goes back to once the checkpointed unit is done. Adopting a
   * handoff is scoped to that unit, exactly as a descent is: the next one starts
   * on the rung the operator declared. Without an explicit `--cli` there is
   * nothing declared to go back to, so the adopted CLI stays the run's own.
   *
   * Both branches re-resolve unconditionally, even when the CLI they land on already equals
   * `this.activeAgent`: a fallback descent that happens mid-unit, inside this same invocation,
   * moves `this.activeAgent` to the handed-off CLI without ever touching `options.cli` (only a
   * checkpoint adopted from an *earlier* invocation does that), so comparing options objects
   * alone cannot detect that drift, declared or not. Skipping the resolve on the `!hasCli`
   * branch reasoned that "nothing declared" meant nothing to reconcile — but the run's own CLI
   * (`adopted.cli`) is exactly as declared as an explicit `--cli` is, and leaving it unresolved
   * let a mid-unit handoff poison the next unit: `this.activeAgent` stayed on the handed-off
   * CLI while every checkpoint and report kept naming `adopted.cli`.
   */
  private restoreDeclaredCli(declared: CliOptions, adopted: CliOptions): CliOptions {
    if (!declared.hasCli) {
      this.resolveAgent(adopted.cli);
      return adopted;
    }
    this.resolveAgent(declared.cli);
    return declared;
  }

  private async resolveRunLogProvider(options: CliOptions): Promise<"azure" | "github"> {
    const declared = runLogProvider(options);
    if (declared === "azure" || options.command !== "code" || options.session === null) return declared;
    // A session without --hu is Azure only when no GitHub delivery checkpoint owns it.
    // The dispatch path makes the same distinction before it opens the session.
    try {
      if (this.githubCheckpointStore && await this.githubCheckpointStore.read(options.workingDirectory)) return "github";
    } catch {
      // A later recovery path reports an unreadable checkpoint; log setup must remain best effort.
    }
    return "azure";
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

    return this.runParsed(parsed.options, args);
  }

  /**
   * The run log's own lifecycle around one invocation: a `run.started` record
   * before anything runs, a `run.finished` one carrying the outcome, exit code
   * and duration however the invocation ends, and — in between — every
   * `warn`/`error` the Reporter emits, forwarded through `applyReporter`'s sink
   * (ADR-0029). It wraps `dispatchParsed` rather than threading through its many
   * return paths, so the record contract stays correct without touching them.
   */
  /**
   * A best-effort read of whatever checkpoint this run's own scope already
   * writes to disk, so an interruption record names what needs reconciling
   * instead of just saying a checkpoint might exist. Every store it reads is
   * one this class already owns for its normal work; nothing new is written
   * here, and a store that has nothing for this run, or fails to read, is
   * silently `null` rather than a reason to fail the interruption record.
   */
  private describeInterruptionCheckpoint(options: CliOptions): InterruptionCheckpointProbe {
    const workingDirectory = options.workingDirectory.split(",")[0]!.trim();
    const isWorkspace = options.workingDirectory.includes(",");
    return async () => {
      try {
        if (isWorkspace) {
          if (options.hu !== null) {
            const checkpoint = await this.azureWorkspaceCheckpoint.read(workingDirectory);
            return checkpoint ? `azure-workspace hu ${checkpoint.hu} ticket ${checkpoint.ticket} (phase ${checkpoint.phase})` : null;
          }
          const checkpoint = await this.githubWorkspaceCheckpoint.read(workingDirectory);
          return checkpoint ? `github-workspace issue ${checkpoint.issue}` : null;
        }
        if (this.githubCheckpointStore) {
          const checkpoint = await this.githubCheckpointStore.read(workingDirectory);
          if (checkpoint) return `github issue ${checkpoint.issue}`;
        }
        const azureCheckpoint = await this.checkpointStore.read(workingDirectory);
        if (azureCheckpoint) {
          return "phase" in azureCheckpoint
            ? `azure hu ${azureCheckpoint.hu} ticket ${azureCheckpoint.ticket} (phase ${azureCheckpoint.phase})`
            : `azure hu ${azureCheckpoint.hu} ticket ${azureCheckpoint.ticket}`;
        }
        return null;
      } catch {
        return null;
      }
    };
  }

  private async runParsed(options: CliOptions, args: string[]): Promise<number> {
    this.idleTimeoutMs = options.idleTimeoutMinutes * 60_000;
    const runLogPath = resolveRunLogPath({ logFile: options.logFile, noLogFile: options.noLogFile });
    // Minted here rather than inside the sink, because the operator is told
    // which run to look for and the sink stamps that same id on every record.
    const runId = crypto.randomUUID();
    let runLogWritable = runLogPath !== null;
    const runLog = createRunLogSink({
      path: runLogPath,
      runId,
      onWriteFailure: (error) => {
        runLogWritable = false;
        getDefaultReporter().warn(
          `lazy-workflow: no se pudo escribir el run log (${errorMessage(error)}); se deshabilita para el resto del run.`,
        );
      },
    });

    // `--off` never shuts down a run that died on an invalid argument, and the
    // one place every failure already passes through — without threading the
    // dozens of returns of `dispatchParsed` — is the sink the Reporter feeds.
    // The same flag keeps the pointer below quiet on a typo.
    let argumentError = false;

    /**
     * Where a failed run's own detail is, told once and only when there is
     * something to read: a run whose log is off (`--no-log-file`) or whose sink
     * died was already told so, and pointing at a file that holds nothing would
     * be worse than saying nothing. An argument error is the other silence —
     * the operator is at the keyboard with the message on screen, the same
     * reason `--off` never powers a machine down for a typo.
     *
     * It goes to the operator channel and not through `Reporter.warn`/`.error`,
     * which would write a run-log record whose whole content is an instruction
     * to read the run log.
     */
    const reportRunLogPointer = (): void => {
      if (!runLogPath || !runLogWritable || argumentError) return;
      reportOperator(`lazy-workflow: revisa el run log para el detalle del fallo: grep ${runId} ${runLogPath}`);
    };
    const base = runLogBase(options, await this.resolveRunLogProvider(options));
    const reporterRunLog: ReporterRunLogSink = {
      event(severity, message, detail) {
        if (detail?.failureKind === "argument-error") argumentError = true;
        runLog.write({
          ...base,
          event: "event",
          severity,
          message,
          failureKind: detail?.failureKind,
          phase: detail?.phase,
          checkpoint: detail?.checkpoint,
          sessionEvent: detail?.sessionEvent,
          reason: detail?.reason,
          fromCli: detail?.fromCli,
          // A session record names the rung it actually ran on; every other
          // record keeps the run's own declared one.
          cli: detail?.cli ?? base.cli,
          model: detail?.model ?? base.model,
          variant: detail?.variant ?? base.variant,
          durationMs: detail?.durationMs,
          outcome: detail?.outcome,
          context: detail?.context ? { ...base.context, ...detail.context } : base.context,
        });
      },
    };
    this.applyReporter(options, reporterRunLog);

    // Its own wall clock, deliberately not `this.clock`: that one is rigged by
    // several tests to a fixed call-order sequence that measures a ticket's
    // active work duration, and reading it here would consume one of those
    // calls and shift every business measurement built on it.
    const startedAt = Date.now();
    runLog.write({ ...base, event: "run.started", severity: "info", message: `lazy-workflow ${options.command} iniciado` });

    const teardownInterruptionHandlers = registerInterruptionHandlers({
      runLog,
      base,
      startedAt,
      describeCheckpoint: this.describeInterruptionCheckpoint(options),
      errorMessage,
      process: this.processSignals,
      // A crash needs the pointer as much as an ordinary failure does; a signal
      // is the operator's own doing and gets nothing.
      onFailure: reportRunLogPointer,
    });

    const finish = (exitCode: number, message: string): number => {
      teardownInterruptionHandlers();
      runLog.write({
        ...base,
        event: "run.finished",
        severity: exitCode === 0 ? "info" : "error",
        outcome: exitCode === 0 ? "success" : "failure",
        exitCode,
        durationMs: Date.now() - startedAt,
        message,
      });
      // After the record it points at, so the run is already whole in the file
      // by the time the operator is sent to read it.
      if (exitCode !== 0) reportRunLogPointer();
      return exitCode;
    };

    try {
      const exitCode = await this.dispatchParsed(options, args);
      // Before `finish`, so the shutdown and whatever happens to it stay inside
      // the run that asked for it: `run.finished` is still the last record.
      await this.shutDownSystem(options, argumentError);
      return finish(exitCode, `lazy-workflow ${options.command} finalizado (${exitCode === 0 ? "success" : "failure"})`);
    } catch (error) {
      reportFailure(
        "delivery-failure",
        "dispatching",
        base.context,
        `lazy-workflow ${options.command} termino con excepcion (${errorMessage(error)})`,
      );
      await this.shutDownSystem(options, argumentError);
      finish(1, `lazy-workflow ${options.command} finalizado con excepcion (${errorMessage(error)})`);
      throw error;
    }
  }

  private async dispatchParsed(options: CliOptions, args: string[]): Promise<number> {
    this.resolveAgent(options.cli);

    const command = options.command;

    if (options.verbose && options.quiet) {
      return argumentError(options, "--verbose y --quiet son mutuamente excluyentes");
    }

    if (options.interview.channel !== "off") {
      if (command !== "plan") {
        return argumentError(options, "--interview solo se permite con plan");
      }
      // Every channel announces itself through the Reporter — the URL, the tty
      // prompt, the exchange directory — and `--quiet` silences info. A silent
      // interactive run is a run the operator cannot answer.
      if (options.quiet) {
        return argumentError(options, "--interview y --quiet son mutuamente excluyentes: el canal no podría anunciarse");
      }
    }

    this.reportRunHeading(options);
    this.reportFallbackChain(options);

    if (options.workingDirectory.includes(",")) {
      if (command !== "plan" && command !== "code") {
        return argumentError(options, "--working-directory CSV solo se permite con plan o code");
      }
      // `plan` never mutates branches or tracker state, in either provider.
      if (command === "plan") return this.runWorkspacePlan(options);
      if (options.hu !== null) return this.runAzureWorkspaceCode(options);
      return this.runWorkspaceCode(options);
    }

    if (options.normasSag && command !== "plan" && command !== "code") {
      return argumentError(options, "--normas-sag solo se permite con plan o code");
    }

    // A deterministic tool is the workflow's own step run on its own, so it is
    // dispatched before any rule that only governs a session-opening command
    // (ADR-0026).
    if (isDeterministicToolCommand(command)) {
      return runDeterministicTool(
        command,
        options,
        this.deterministicToolServices ?? createDeterministicToolServices(this.huInfoService),
      );
    }

    if (TICKET_READ_COMMANDS.has(command)) return this.runTicketRead(command, options);

    if (command === "ticket-completion-apply") {
      if (!isPositiveId(options.hu)) {
        return azureArgumentError(options, "ticket-completion-apply requiere --hu <id>");
      }
      if (!isPositiveId(options.ticket)) {
        return azureArgumentError(options, "ticket-completion-apply requiere --ticket <id> con un entero positivo");
      }
      if (!isPositiveId(options.pullRequest)) {
        return azureArgumentError(options, "ticket-completion-apply requiere --pr <id> con un entero positivo");
      }
      if (!options.summary?.trim()) {
        return azureArgumentError(options, "ticket-completion-apply requiere --summary <texto>");
      }
      try {
        console.log(JSON.stringify(await this.applyTicketCompletion(options), null, 2));
        return 0;
      } catch (error) {
        reportAzureFailure(azureFailureKind(error, "deterministic-completion-failure"), "completing", options, `lazy-workflow: no se pudo ejecutar ticket-completion-apply (${errorMessage(error)})`);
        return 1;
      }
    }

    if (command === "ticket-create") {
      if (!isPositiveId(options.hu)) {
        return azureArgumentError(options, "ticket-create requiere --hu <id>");
      }
      if (options.type !== "Task" && options.type !== "Bug") {
        return azureArgumentError(options, "ticket-create requiere --type Task o --type Bug");
      }
      if (!options.title?.trim()) {
        return azureArgumentError(options, "ticket-create requiere --title <titulo>");
      }
      if (!options.descriptionFile?.trim()) {
        return azureArgumentError(options, "ticket-create requiere --description-file <path>");
      }
      try {
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
        reportAzureFailure("delivery-failure", "publishing", options, `lazy-workflow: no se pudo ejecutar ${command} (${errorMessage(error)})`);
        return 1;
      }
    }

    if (command === "ticket-link-parent" || command === "ticket-link-predecessor") {
      const [first, second] = command === "ticket-link-parent"
        ? [options.parent, options.child]
        : [options.blocker, options.blocked];
      const flags = command === "ticket-link-parent" ? "--parent <id> y --child <id>" : "--blocker <id> y --blocked <id>";
      if (first === null || second === null) {
        return azureArgumentError(options, `${command} requiere ${flags} con enteros positivos`);
      }
      try {
        const service = this.huInfoService;
        const link = command === "ticket-link-parent"
          ? service.linkParent.bind(service)
          : service.linkPredecessor.bind(service);
        console.log(JSON.stringify(await link(first, second), null, 2));
        return 0;
      } catch (error) {
        reportAzureFailure("delivery-failure", "publishing", options, `lazy-workflow: no se pudo ejecutar ${command} (${errorMessage(error)})`);
        return 1;
      }
    }

    if (command === "ticket-description-set" || command === "ticket-state-set" || command === "ticket-effort-set") {
      if (!isPositiveId(options.ticket)) {
        return azureArgumentError(options, `${command} requiere --ticket <id> con un entero positivo`);
      }
      if (command === "ticket-description-set" && !options.descriptionFile?.trim()) {
        return azureArgumentError(options, "ticket-description-set requiere --description-file <path>");
      }
      if (command === "ticket-state-set" && (!options.state?.trim() || !options.expectedState?.trim())) {
        return azureArgumentError(options, "ticket-state-set requiere --state <state> y --expected-state <state>");
      }
      if (command === "ticket-effort-set" && (
        !options.hasRealEffort || !options.hasRealEffortHours || !options.hasExpectedRevision
        ||
        !Number.isFinite(options.realEffort) || options.realEffort < 0
        || !Number.isFinite(options.realEffortHours) || options.realEffortHours < 0
        || !Number.isInteger(options.expectedRevision) || options.expectedRevision <= 0
      )) {
        return azureArgumentError(options, "ticket-effort-set requiere --real-effort <hours>, --real-effort-hh <hours> y --expected-rev <rev> válidos");
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
        reportAzureFailure("delivery-failure", "evidencing", options, `lazy-workflow: no se pudo ejecutar ${command} (${errorMessage(error)})`);
        return 1;
      }
    }

    if (command === "ticket-pr-link" || command === "ticket-commit-link") {
      if (command === "ticket-pr-link" && !isPositiveId(options.hu)) {
        return azureArgumentError(options, "ticket-pr-link requiere --hu <id>");
      }
      if (!isPositiveId(options.ticket)) {
        return azureArgumentError(options, `${command} requiere --ticket <id> con un entero positivo`);
      }
      if (!isPositiveId(options.pullRequest)) {
        return azureArgumentError(options, `${command} requiere --pr <id> con un entero positivo`);
      }
      try {
        let result: unknown;
        if (command === "ticket-pr-link") {
          if (!this.huInfoService.linkPullRequest) throw new Error("El servicio Azure no soporta ticket-pr-link");
          result = await this.huInfoService.linkPullRequest(options.hu!, options.ticket, options.pullRequest!);
        } else {
          if (!this.huInfoService.linkCommit) throw new Error("El servicio Azure no soporta ticket-commit-link");
          result = await this.huInfoService.linkCommit(options.ticket, options.pullRequest!);
        }
        console.log(JSON.stringify(result, null, 2));
        return 0;
      } catch (error) {
        reportAzureFailure("delivery-failure", "executing", options, `lazy-workflow: no se pudo ejecutar ${command} (${errorMessage(error)})`);
        return 1;
      }
    }

    if (command === "ticket-branch-set") {
      if (!isPositiveId(options.hu)) {
        return azureArgumentError(options, "ticket-branch-set requiere --hu <id>");
      }
      if (!isPositiveId(options.ticket)) {
        return azureArgumentError(options, "ticket-branch-set requiere --ticket <id> con un entero positivo");
      }
      if (!options.branch?.trim()) {
        return azureArgumentError(options, "ticket-branch-set requiere --branch <name>");
      }
      if (options.workingDirectory === process.cwd() && !args.some((arg) => arg === "--working-directory" || arg.startsWith("--working-directory="))) {
        return azureArgumentError(options, "ticket-branch-set requiere --working-directory <path>");
      }
      const workingDirectory = options.workingDirectory;
      if (!workingDirectory?.trim() || workingDirectory.startsWith("--")) {
        return azureArgumentError(options, "ticket-branch-set requiere --working-directory <path>");
      }
      if (!this.huInfoService.setTicketBranch) {
        reportAzureFailure("branch-preparation-failure", "preparing", options, "El servicio Azure no soporta ticket-branch-set");
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
        reportAzureFailure("branch-preparation-failure", "started", options, `lazy-workflow: no se pudo vincular la rama del ticket ${options.ticket} (${errorMessage(error)})`);
        return 1;
      }
    }

    if (command === "hu-info") {
      if (!isPositiveId(options.hu)) {
        return azureArgumentError(options, "hu-info requiere --hu <id>");
      }
     let huInfo: HuInfo;
     try {
       huInfo = await this.huInfoService.getHuInfo(options.hu);
     } catch (error) {
       reportAzureFailure("tracker-read-failure", "planning", options, `lazy-workflow: no se pudo leer la HU en Azure DevOps (${errorMessage(error)})`);
       return 1;
     }
      console.log(JSON.stringify(huInfo, null, 2));
      return 0;
    }

    if (command === "hu-branch-info") {
      if (!isPositiveId(options.hu)) {
        return azureArgumentError(options, "hu-branch-info requiere --hu <id>");
      }
      if (!this.huInfoService.getIntegrationBranchInfo) {
        reportAzureFailure("tracker-read-failure", "reading", options, "El servicio Azure no soporta hu-branch-info");
        return 1;
      }
      try {
        console.log(JSON.stringify(await this.huInfoService.getIntegrationBranchInfo(options.hu), null, 2));
        return 0;
      } catch (error) {
        reportAzureFailure("tracker-read-failure", "preparing", options, `lazy-workflow: no se pudo consultar la rama de la HU ${options.hu} (${errorMessage(error)})`);
        return 1;
      }
    }

    if (command === "hu-branch-set") {
      if (!isPositiveId(options.hu)) {
        return azureArgumentError(options, "hu-branch-set requiere --hu <id>");
      }
      if (!options.branch?.trim()) {
        return azureArgumentError(options, "hu-branch-set requiere --branch <name>");
      }
      if (!this.huInfoService.setIntegrationBranch) {
        reportAzureFailure("branch-preparation-failure", "preparing", options, "El servicio Azure no soporta hu-branch-set");
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
        reportAzureFailure("branch-preparation-failure", "preparing", options, `lazy-workflow: no se pudo vincular la rama de la HU ${options.hu} (${errorMessage(error)})`);
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
          reportFailure(
            "checkpoint-unreadable",
            "recovery-checkpoint-read",
            { repository: options.workingDirectory },
            `lazy-workflow: no se pudo leer el checkpoint GitHub (${errorMessage(error)}); ejecucion detenida.`,
          );
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
      return argumentError(options, "--branch y --base-branch solo se permiten en flujos Azure");
    }

    if (command === "code") {
      if (githubRecovery) return this.runGitHubRecovery(options, githubRecovery);
      if (isAzureHuRun) return this.runAzureCode(options);
      return this.runDefaultWorkflow(command, options);
    }

    if (options.hu === null) return this.runDefaultWorkflow("plan", options);

    let huInfo: HuInfo;
    try {
      huInfo = await this.huInfoService.getHuInfo(options.hu);
    } catch (error) {
      reportAzureFailure("tracker-read-failure", "planning", options, `lazy-workflow: no se pudo leer la HU en Azure DevOps (${errorMessage(error)})`);
      return 1;
    }
    const norms = await this.loadSagNorms(options, "planning");
    if (options.normasSag && norms === null) return 1;

    const { result, failed } = await this.runPlanningSession(
      { kind: "azure-plan", huInfo },
      options,
      norms,
      resolveWorkflowRun(options.hu),
      options.workingDirectory,
    );
    console.log(JSON.stringify(result, null, 2));
    if (failed) return 1;
    if (!await this.commitPlanningEdits(options.workingDirectory)) return 1;
    return this.publishAzurePlan(options.hu, result.text, options);
  }

  /**
   * Publish the plan the session returned. OpenCode decided the slices; creating
   * the work items and their blocking relations is the coordinator's mechanical
   * work, verified through the same ticket-* primitives.
   */
  private async publishAzurePlan(hu: number, text: string, options: CliOptions): Promise<number> {
    try {
      const tickets = parsePlan(text);
      if (tickets.length === 0) {
        reportOperator(`lazy-workflow: el plan de la HU ${hu} no requiere tickets de entrega.`);
        return 0;
      }
      // Only a plan with work to publish needs the publication primitives.
      const service = new AzurePlanPublicationService(
        {
          createTicket: this.huInfoService.createTicket.bind(this.huInfoService),
          linkPredecessor: this.huInfoService.linkPredecessor.bind(this.huInfoService),
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
      reportAzureFailure("deterministic-completion-failure", "publishing", options, `lazy-workflow: no se pudo publicar el plan de la HU ${hu} (${errorMessage(error)}); no se creó trabajo parcial sin verificar.`);
      return 1;
    }
  }

  /**
   * The shutdown `--off` declares: the last action of an unattended run,
   * whatever its outcome, because whoever asked for it is no longer at the
   * machine (ADR-0030).
   *
   * A run that died on an invalid argument is the exception: there the operator
   * is at the keyboard, and powering their machine off for a typo is never what
   * was asked. The grace period is the second way out — the interruption
   * handlers are still installed while it runs, so Ctrl-C cancels the shutdown
   * and leaves the run recorded as interrupted.
   *
   * None of this changes the run's own result: a shutdown that fails is reported
   * like any other failure and the run ends exactly as it was going to.
   */
  private async shutDownSystem(options: CliOptions, argumentError: boolean): Promise<void> {
    const request = options.shutdown;
    if (!request || argumentError) return;
    const context = { hu: options.hu, issue: options.issue, repository: options.workingDirectory };
    getDefaultReporter().warn(
      request.delaySeconds > 0
        ? `lazy-workflow: --off apagará el equipo en ${request.delaySeconds}s (Ctrl-C cancela)`
        : "lazy-workflow: --off apaga el equipo ahora",
      { phase: "shutting-down", context },
    );
    if (request.delaySeconds > 0) await this.retryTimer.wait(request.delaySeconds * 1000);
    try {
      await this.systemShutdown.shutdown(request.password);
    } catch (error) {
      reportFailure(
        "shutdown-failure",
        "shutting-down",
        context,
        `lazy-workflow: no se pudo apagar el equipo (${errorMessage(error)})`,
      );
    }
  }

  private applyReporter(options: ParsedCliOptions, runLog?: ReporterRunLogSink): void {
    const reporter = this.createReporterFn({
      verbose: options.verbose,
      verboseOutput: options.verboseOutput,
      quiet: options.quiet,
      noColor: options.noColor,
      runLog,
    });
    setDefaultReporter(reporter);
  }

  /**
   * The panel that opens a run: what it is doing, against which tracker and
   * repository, and how loudly it will report. It is the first thing the
   * operator reads, so everything that decides the run's shape is in it.
   */
  private reportRunHeading(options: ParsedCliOptions): void {
    const scope = options.hu !== null
      ? `HU ${options.hu}`
      : options.issue !== null
        ? `Issue ${options.issue}`
        : "GitHub";
    const verbosity = options.quiet
      ? "quiet"
      : options.verboseOutput
        ? "verbose-output"
        : options.verbose
          ? "verbose"
          : "parseada";
    reportOperatorHeading(`lazy-workflow · ${options.command}`, [
      `alcance    ${scope}`,
      // A deterministic tool opens no session, so naming an agent it will never
      // run would be the one false line in the panel.
      ...(isDeterministicToolCommand(options.command)
        ? []
        : [`agente     ${options.cli} · ${options.model} · ${options.variant}`]),
      // Silent without `--interview`, so the historical panel is unchanged; the
      // channel's own address is announced when it opens, since an ephemeral
      // port does not exist yet while the panel is being drawn.
      ...(options.interview.channel === "off" ? [] : [`entrevista ${options.interview.channel}`]),
      // A run that will power the machine off says so in the panel, not only
      // once there is nothing left to do.
      ...(options.shutdown ? [`apagado    al terminar${options.shutdown.delaySeconds > 0 ? ` (+${options.shutdown.delaySeconds}s)` : ""}`] : []),
      `directorio ${options.workingDirectory}`,
      `salida     ${verbosity}`,
    ]);
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

  private async descendFallbackChain(
    options: CliOptions,
    execution: AgentExecution,
    handOff: (rung: FallbackRung, reasoning: string[]) => Promise<AgentExecution>,
  ): Promise<AgentExecution> {
    let current = execution;
    let active: FallbackRung = { cli: options.cli, model: options.model, variant: options.variant };
    let index = 0;
    /** When the bounded wait ends, set on the first exhausted chain rather than at the start of the run. */
    let waitDeadline: number | null = null;
    // Dos causas de descenso, no una: la cuota agotada y el silencio más allá del timeout. Para el
    // bucle dicen lo mismo —este escalón no está produciendo— y solo se distinguen cuando la
    // cadena entera se gastó (ADR-0039).
    while (current.exhaustion || current.idleTimedOut) {
      let next = nextRung(options, index);
      if (!next) {
        // Una cadena gastada por silencio no espera: la cuota vuelve sola, un prompt que colgó a
        // tres CLIs va a colgar al cuarto intento.
        if (!current.exhaustion) return current;
        waitDeadline ??= this.clock.now() + options.fallbackWaitMaxSeconds * 1000;
        if (!await this.waitForPrimaryRetry(options, active, current.exhaustion, waitDeadline)) return current;
        // The retry starts over at the head of the chain, so whichever rung
        // recovers its quota first is the one the unit continues on.
        index = -1;
        next = nextRung(options, index)!;
      }
      const sessionId = current.result.sessionId;
      const handedOff = next.rung.cli !== active.cli;
      const cause = current.exhaustion?.cause ?? "idle_timeout";
      const spent = current.exhaustion ? "agotado" : "sin actividad";
      reportOperator(
        `lazy-workflow: escalón ${describeRung(active)} ${spent} (${cause}); desciendo a ${describeRung(next.rung)} traspasando el trabajo a una sesión nueva.`,
      );
      const descentContext = { hu: options.hu, issue: options.issue, repository: options.workingDirectory, sessionId };
      reportSessionEvent(
        "fallback_descent",
        `lazy-workflow: escalón ${describeRung(active)} ${spent} (${cause}); desciendo a ${describeRung(next.rung)}.`,
        next.rung,
        descentContext,
        { reason: cause, fromCli: active.cli },
      );
      if (handedOff) {
        reportSessionEvent(
          "cross_cli_handoff",
          `lazy-workflow: el trabajo pasa de ${active.cli} a ${next.rung.cli}.`,
          next.rung,
          descentContext,
          { fromCli: active.cli },
        );
      }
      active = next.rung;
      index = next.index;
      try {
        current = await handOff(next.rung, current.result.reasoning ?? []);
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
    const retryContext = { hu: options.hu, issue: options.issue, repository: options.workingDirectory, sessionId: null };
    if (remaining < options.fallbackWaitSeconds * 1000) {
      reportFailure(
        "session-failure",
        "reconciling",
        retryContext,
        `lazy-workflow: la cadena de fallback sigue agotada al alcanzar el tope de ${options.fallbackWaitMaxSeconds}s de espera; último ${exhausted}; checkpoint conservado.`,
        undefined,
        "preserved",
      );
      reportSessionEvent(
        "chain_exhausted",
        `lazy-workflow: cadena de fallback agotada, último ${exhausted}, tope de ${options.fallbackWaitMaxSeconds}s alcanzado.`,
        active,
        retryContext,
        { reason: exhaustion.cause, checkpoint: "preserved" },
      );
      return false;
    }
    reportOperator(
      `lazy-workflow: cadena de fallback agotada, último ${exhausted}; espero ${options.fallbackWaitSeconds}s y reintento el escalón primario; quedan ${Math.round(remaining / 1000)}s hasta el tope.`,
    );
    reportSessionEvent(
      "chain_retry",
      `lazy-workflow: cadena de fallback agotada, último ${exhausted}; reintento el escalón primario en ${options.fallbackWaitSeconds}s.`,
      active,
      retryContext,
      { reason: exhaustion.cause },
    );
    await this.retryTimer.wait(options.fallbackWaitSeconds * 1000);
    return true;
  }

  private async runDefaultWorkflow(command: "plan" | "code", options: CliOptions): Promise<number> {
    if (command === "plan") {
      const norms = await this.loadSagNorms(options, "planning");
      if (options.normasSag && norms === null) return 1;
      const { result, failed } = await this.runPlanningSession(
        { kind: "github-plan" },
        // A GitHub planning run has never resumed a session of its own; the
        // interview resumes the one it just opened, not one named on the CLI.
        { ...options, session: null },
        norms,
        { kind: "github-repository-run" },
        options.workingDirectory,
      );
      console.log(JSON.stringify(result, null, 2));
      if (failed) return 1;
      if (!await this.commitPlanningEdits(options.workingDirectory)) return 1;
      return this.publishGitHubPlan(result.text, options.workingDirectory, options);
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
      reportAzureFailure("topology-preparation-failure", "preparing", options, "El servicio Azure no expone la preparación workspace de ramas");
      return 1;
    }
    if (!isPositiveId(options.hu)) {
      reportAzureFailure("argument-error", "preparing", options, "runAzureWorkspaceCode requiere --hu");
      return 1;
    }
    if (options.ticket !== null && (!Number.isInteger(options.ticket) || options.ticket <= 0)) {
      reportAzureFailure("argument-error", "preparing", options, "runAzureWorkspaceCode requiere que --ticket <id> sea un entero positivo");
      return 1;
    }
    if (!this.huInfoService.createOrReusePullRequest || !this.huInfoService.checkoutTicketBranch
      || !this.huInfoService.pushTicketBranch || !this.huInfoService.linkPullRequest
      || !this.huInfoService.linkCommit || !this.huInfoService.getTicketInfo
      || !this.huInfoService.setEffort || !this.huInfoService.setState
      || !this.huInfoService.verifySession || !this.huInfoService.getBranch
      || !this.huInfoService.validateSummary || !this.huInfoService.setSummary
      || !this.huInfoService.getState || !this.huInfoService.getEffort
      || !this.huInfoService.setHuState || !this.huInfoService.hasOpenDeliveryChildren
      || !this.huInfoService.getHuState
      || !this.huInfoService.getAutocodeContextForTicket || !this.huInfoService.getTicket
      || !this.huInfoService.getDescription || !this.huInfoService.validateDirectTicketContext
      || !this.huInfoService.linkTicketBranch) {
      reportAzureFailure("delivery-failure", "preparing", options, "El servicio Azure no expone todas las primitivas de entrega workspace");
      return 1;
    }
    const hu = options.hu;
    const boundary = this.huInfoService;
    const startedAt = this.clock.now();
    // Captured before any checkpoint adoption below can overwrite `options.cli`: a fallback
    // handoff scopes its adopted CLI to the checkpointed ticket only (`restoreDeclaredCli`), and
    // the drain below has to hand the next ticket this pristine value, never the adopted one.
    const declaredOptions = options;
    let scope: WorkspaceScope;
    let checkpoint: AzureWorkspaceCheckpoint | null;
    try {
      scope = await this.azureWorkspaceScope(options);
      checkpoint = await this.azureWorkspaceCheckpoint.read(scope.stateDirectory);
    } catch (error) {
      reportAzureFailure("workspace-scope-failure", "preparing", options, `lazy-workflow: no se pudo leer el alcance workspace Azure (${errorMessage(error)}); ejecución detenida.`);
      return 1;
    }
    // El mismo persistir que usan los demás caminos, para que este no escriba a mano.
    const save = async (): Promise<void> => { await this.azureWorkspaceCheckpoint.write(checkpoint!, scope.stateDirectory); };
    if (checkpoint) {
      const adopted = this.adoptCheckpointCli(checkpoint.cli, options, checkpoint.handoffFrom);
      if (!adopted) return 1;
      options = adopted;
    }
    if (options.session !== null && (!checkpoint || checkpoint.sessionId !== options.session)) {
      reportAzureFailure("argument-error", "reconciling", options, "lazy-workflow: la sesión no coincide con el checkpoint workspace Azure fijado.", {}, "preserved");
      return 1;
    }
    const pinned = this.pinnedAzureWorkspaceTicket(options, checkpoint);
    if (pinned && "exit" in pinned) return pinned.exit;
    // Fail closed before any external effect: the recovered scope must be the same repositories,
    // in the same order, with the same remotes, for the same HU and ticket. A pinned unit is the
    // only one a checkpoint can carry, so this still precedes every effect below.
    if (checkpoint && pinned) {
      const mismatch = this.azureWorkspaceScopeMismatch(checkpoint, scope, hu, pinned.ticket);
      if (mismatch) {
        reportAzureFailure("workspace-scope-failure", "reconciling", options, `lazy-workflow: ${mismatch}; ejecución detenida.`, {}, "preserved");
        return 1;
      }
    }
    try {
      // Only the branch preparation here is a topology failure. The outer catch used to claim
      // every later failure was one too, which sent the operator looking at branches when what
      // had actually stopped the run was an evidence file at the far end of the delivery.
      let topology: AzureWorkspaceBranchTopology;
      try {
        // The HU branch is prepared before an unpinned selection reads it, at the same point the
        // single-repository run prepares its own: selection resolves the ticket against the HU's
        // native Branch link, so a first delivery has nothing to select until this provisions it.
        topology = await this.huInfoService.prepareWorkspaceBranches({
          hu,
          repositories: scope.repositories.map(({ path, remote }) => ({ path, remote })),
          baseBranch: options.baseBranch,
        });
      } catch (error) {
        reportAzureFailure("topology-preparation-failure", "preparing", options, `lazy-workflow: no se pudo preparar la topología multi-repositorio Azure (${errorMessage(error)}); ejecución detenida.`, {}, checkpoint ? "preserved" : undefined);
        return 1;
      }
      const resolved = pinned ?? await this.selectAzureWorkspaceTicket(hu, options, topology.integrationBranch);
      if ("exit" in resolved) return resolved.exit;
      const ticket = resolved.ticket;
      await boundary.validateDirectTicketContext!(hu, ticket);
      let ticketTopology: AzureWorkspaceBranchTopology;
      try {
        ticketTopology = await this.huInfoService.prepareWorkspaceTicketBranches({
          hu,
          ticket,
          integrationBranch: topology.integrationBranch,
          repositories: scope.repositories.map(({ path, remote }) => ({ path, remote })),
        });
      } catch (error) {
        reportAzureFailure("topology-preparation-failure", "preparing", options, `lazy-workflow: no se pudo preparar la topología multi-repositorio Azure (${errorMessage(error)}); ejecución detenida.`, {}, checkpoint ? "preserved" : undefined);
        return 1;
      }
      if (checkpoint) {
        const drift = this.azureWorkspaceTopologyMismatch(checkpoint, topology, ticketTopology);
        if (drift) {
          reportAzureFailure("topology-preparation-failure", "reconciling", options, `lazy-workflow: ${drift}; ejecución detenida.`, {}, "preserved");
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
        await save();
      }
      if (checkpoint.phase === "started" || checkpoint.phase === "implementing") {
        const state = await boundary.getState!(ticket);
        const started = await this.ensureAzureTicketInProgress(ticket, state, !!checkpoint.receipts["ticket-state"], async (receipt) => {
          if (receipt) {
            const verified = checkpoint!.receipts["ticket-state"] ?? { verifiedAt: new Date(this.clock.now()).toISOString() };
            checkpoint = { ...checkpoint!, intent: null, receipts: { ...checkpoint!.receipts, "ticket-state": verified } };
          } else {
            checkpoint = { ...checkpoint!, intent: { effect: "ticket-state", target: "En progreso" } };
          }
          await save();
        }, async (expectedState, expectedRevision) => {
          await boundary.setState!(ticket, "En progreso", expectedState, false, expectedRevision);
        }, options);
        if (!started) return 1;
        // Branch effects belong to the coordinator, so the session has to find every participant
        // already sitting on the ticket branch: manifest validation requires it and the session is
        // not allowed to switch branches itself. The single-repository path does this at the same
        // point in its own run.
        const sessionTicketBranch = ticketTopology.ticketBranch ?? `refs/heads/ticket/${ticket}`;
        try {
          for (const repository of scope.repositories) {
            await this.huInfoService.checkoutTicketBranch!(sessionTicketBranch, repository.path);
          }
        } catch (error) {
          reportAzureFailure("branch-preparation-failure", "started", options, `lazy-workflow: no se pudo situar el workspace en la rama del ticket (${errorMessage(error)}); ejecución detenida.`, {}, "preserved");
          return 1;
        }
        const resuming = checkpoint.sessionId;
        let activeCli = checkpoint.cli;
        let activeAuthority: AgentAuthority = {
          profile: "lazy-azure-code",
          configPath: authorityConfigPath(activeCli, "lazy-azure-code"),
        };
        let execution: AgentExecution;
        // Reanudar la sesión que el checkpoint fija sigue existiendo —es la relanzada del
        // operador sobre una corrida cortada—; lo que ya no existe es reanudar al descender
        // (ADR-0039), así que la cadena solo recibe el traspaso.
        const resumeFn = (sessionId: string, overrides: AgentResumeOverrides) =>
          this.codingAgent.resume(sessionId, undefined, scope.parentDirectory, undefined, { ...overrides, agent: activeAuthority });
        const handOff = async (rung: FallbackRung) => {
          const handoffOptions: CliOptions = { ...options, cli: rung.cli, model: rung.model, variant: rung.variant };
           const handoffRun = await this.azureWorkspacePrompt(handoffOptions, hu, ticket, scope, topology, ticketTopology, true);
          // The descent has no exit code of its own; an unbuildable prompt is a hard stop for the
          // whole delivery, so it travels as an error rather than as a session spawned blind.
          if (!handoffRun) throw new Error(`El ticket ${ticket} no tiene contexto de entrega verificable`);
          this.resolveAgent(rung.cli);
          // A workspace's `--working-directory` is the comma-separated repository list, not a
          // real path: the handed-off session has to spawn in the common parent exactly like the
          // primary run does below, or the child process fails to spawn at all.
          const handedOff = await this.codingAgent.run({
            ...handoffOptions,
            workingDirectory: scope.parentDirectory,
            ...handoffRun,
            session: null,
          }, false);
          activeCli = rung.cli;
          activeAuthority = handoffRun.agent;
          checkpoint = {
            ...checkpoint!,
            cli: rung.cli,
            handoffFrom: checkpoint!.handoffFrom ?? options.cli,
            model: rung.model,
            variant: rung.variant,
            sessionId: handedOff.result.sessionId,
          };
          await save();
          return handedOff;
        };
        if (resuming) {
          execution = await resumedExecution(() => resumeFn(resuming, getRecoveryOverrides(options, checkpoint!)));
        } else {
           const run = await this.azureWorkspacePrompt(options, hu, ticket, scope, topology, ticketTopology, true);
          if (!run) return 1;
          activeAuthority = run.agent;
          execution = await this.codingAgent.run({
            ...options,
            workingDirectory: scope.parentDirectory,
            ...run,
            session: null,
          }, true);
        }
        execution = await this.descendFallbackChain(options, execution, handOff);
        // Que la sesión terminara lo dice su proceso; que cada repositorio entregara lo dice git,
        // y eso lo pregunta la integración de abajo antes de tocar Azure (ADR-0035).
        const processSucceeded = !execution.failed;
        checkpoint = {
          ...checkpoint,
          cli: activeCli,
          phase: processSucceeded ? "implementation-ready" : "implementing",
          sessionId: processSucceeded ? null : execution.result.sessionId,
          summary: execution.result.text.trim() || null,
          // The idle watchdog's silent intervals are nudged waits, not active
          // effort, so they come back out of the accrued window (issue #292).
          activeDurationMs: checkpoint.activeDurationMs + Math.max(0, accrue() - (execution.idleMs ?? 0)),
        };
        await save();
        if (!processSucceeded) {
          reportAzureFailure("session-failure", "reconciling", options, `lazy-workflow: ${activeCli} falló durante la entrega workspace Azure (${errorMessage(execution.result.text)}); ejecución detenida.`, { sessionId: execution.result.sessionId }, "preserved");
          return 1;
        }
      }
      return await this.integrateAzureWorkspaceCode(options, declaredOptions, hu, ticket, scope, topology, ticketTopology, checkpoint, accrue);
    } catch (error) {
      reportAzureFailure("delivery-failure", "reconciling", options, `lazy-workflow: falló la entrega workspace Azure (${errorMessage(error)}); ejecución detenida.`, {}, "preserved");
      return 1;
    }
  }

  /**
   * The delivery unit an Azure workspace run already knows before touching anything: a surviving
   * checkpoint pins it and an explicit `--ticket` fixes it. `null` means the run has to select,
   * which needs the HU branch and therefore happens after branch preparation.
   */
  private pinnedAzureWorkspaceTicket(
    options: CliOptions,
    checkpoint: AzureWorkspaceCheckpoint | null,
  ): { ticket: number } | { exit: number } | null {
    if (checkpoint) {
      // The checkpointed unit is immutable: a contradicting --ticket is an operator error, not a
      // reason to abandon the delivery already in flight.
      if (options.ticket !== null && options.ticket !== checkpoint.ticket) {
        reportAzureFailure("workspace-scope-failure", "reconciling", options, `lazy-workflow: el checkpoint workspace Azure pertenece al ticket ${checkpoint.ticket}, no al ticket ${options.ticket}; ejecución detenida.`, {}, "preserved");
        return { exit: 1 };
      }
      return { ticket: checkpoint.ticket };
    }
    if (options.ticket !== null) return { ticket: options.ticket };
    return null;
  }

  /**
   * The next unit of an unpinned workspace run: the HU's eligible children drained with the same
   * selection single-repository `code --hu` applies (ADR-0028), against the integration branch
   * branch preparation has already resolved.
   */
  private async selectAzureWorkspaceTicket(
    hu: number,
    options: CliOptions,
    integrationBranch: string,
  ): Promise<{ ticket: number } | { exit: number }> {
    if (!this.huInfoService.getAutocodeState) {
      reportAzureFailure("tracker-read-failure", "selecting", options, "El servicio Azure no expone la selección de tickets pendientes de la HU");
      return { exit: 1 };
    }
    let state: AutocodeState;
    try {
      state = await this.huInfoService.getAutocodeState(hu, integrationBranch);
    } catch (error) {
      reportAzureFailure("tracker-read-failure", "selecting", options, `lazy-workflow: no se pudo seleccionar el siguiente ticket de la HU ${hu} (${errorMessage(error)}); ejecución detenida.`);
      return { exit: 1 };
    }
    if (!state.context) {
      // Blocked and empty are different outcomes: pending work with no eligible unit is a
      // dependency wait the operator must resolve, an empty queue is a finished HU.
      if (state.pending) {
        reportAzureFailure("tracker-read-failure", "selecting", options, `lazy-workflow: no hay un ticket elegible todavía para la HU ${hu}.`);
        return { exit: 1 };
      }
      reportOperator(`lazy-workflow: no hay tickets pendientes para la HU ${hu}.`);
      return { exit: 0 };
    }
    return { ticket: state.context.ticket.id };
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

  /**
   * The ticket is the drain's, not the operator's: `options.ticket` is null on every `--hu` run
   * that lets the coordinator pick, so reading it here handed the session `Coordinator-fixed
   * ticket: null`. It takes the resolved ticket, and reads what that ticket asks for before the
   * session opens -- the session is told never to infer or select its own work, so a prompt
   * without the ticket's content leaves it nothing it is allowed to do.
   */
  private async azureWorkspacePrompt(
    options: CliOptions,
    hu: number,
    ticket: number,
    scope: WorkspaceScope,
    topology: AzureWorkspaceBranchTopology,
    ticketTopology: AzureWorkspaceBranchTopology,
    checkpointPreserved = false,
  ): Promise<{ prompt: string; agent: AgentAuthority } | null> {
    const [context, description] = await Promise.all([
      this.huInfoService.getAutocodeContextForTicket!(hu, ticket, topology.integrationBranch),
      this.huInfoService.getDescription!(ticket),
    ]);
    // Fail closed rather than open a session with an empty context: an unimplementable prompt is
    // exactly what stalled this run before, and it costs a whole session to find out.
    if (!context) {
      reportAzureFailure("claim-verification-failure", "prompting", options, `lazy-workflow: el ticket ${ticket} no tiene contexto de entrega verificable; ejecución detenida.`, { ticket }, checkpointPreserved ? "preserved" : undefined);
      return null;
    }
    return this.prompt(
      {
        kind: "azure-workspace-delivery",
        scope,
        hu,
        ticket,
        context,
        description: description.description,
        topology,
        ticketTopology,
      },
      options,
    );
  }

  private async integrateAzureWorkspaceCode(
    options: CliOptions,
    declaredOptions: CliOptions,
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
    const units: Array<{ path: string; commit?: string; pullRequest?: number; mergeCommit?: string; changed: boolean }> = [];
    for (const repository of scope.repositories) {
      // Un repositorio cambió si su rama de ticket lleva commits sobre la de integración y su
      // árbol quedó limpio; uno que no cambió tiene que estar exactamente donde empezó (ADR-0035).
      let verified: { commit: string } | null = null;
      try {
        verified = await boundary.verifySession!(ticketBranch, integrationBranch, repository.path);
      } catch {
        verified = null;
      }
      if (!verified) {
        const status = await this.git(["status", "--porcelain", "--untracked-files=no"], repository.path);
        if (status.trim()) {
          reportAzureFailure("workspace-scope-failure", "evidencing", options, `lazy-workflow: el repositorio ${repository.path} quedó con cambios sin commitear; ejecución detenida.`, { repository: repository.path }, "preserved");
          return 1;
        }
        // Sin manifest el repositorio se entrega como "sin cambios", y la limpieza
        // le borra la rama del ticket local y remota. Un commit que solo existe
        // aquí desaparecería con ella sin que nadie lo hubiera declarado, así que
        // un HEAD que el remoto no contiene detiene la corrida -- la misma postura
        // que la ruta GitHub toma con su startingCommit. Un ref remoto ausente no
        // acusa nada: es la rama ya retirada por una entrega anterior.
        const ticketBranchName = ticketBranch.replace(/^refs\/heads\//, "");
        const unpublished = await this.git(
          ["rev-list", "--count", `refs/remotes/origin/${ticketBranchName}..HEAD`],
          repository.path,
        ).catch(() => "0");
        if (unpublished.trim() !== "0") {
          reportAzureFailure("session-not-verified", "evidencing", options, `lazy-workflow: el repositorio ${repository.path} tiene commits que su rama remota no lleva; ejecución detenida.`, { repository: repository.path }, "preserved");
          return 1;
        }
        units.push({ path: repository.path, changed: false });
        continue;
      }
      units.push({ path: repository.path, commit: verified.commit, changed: true });
    }

    const changedUnits = units.filter((unit) => unit.changed);
    if (changedUnits.length === 0) {
      reportAzureFailure("delivery-failure", "evidencing", options, "lazy-workflow: el workspace no contiene cambios entregables; ejecución detenida.", {}, "preserved");
      return 1;
    }

    // Azure allows the ticket exactly one native Branch ArtifactLink and it must name the primary
    // implementation repository: the first declared repository that actually changed. An existing
    // link stays authoritative, so the boundary reports which repository the ticket ended up on.
    // Una entrega ya recibida no vuelve a fijarla: completar el PR borra la rama del ticket y
    // Azure retira su Branch ArtifactLink con ella (ADR-0010), así que volver a escribirlo al
    // reanudar nombraría una rama que ya no existe. El primario que el checkpoint recibió sigue
    // siendo el mismo, y los PR ya entregados nombran la rama que integraron.
    const checkpointUnit = (path: string): AzureWorkspaceCheckpointUnit | undefined =>
      checkpoint.units.find((candidate) => candidate.path === path);
    let primaryRepository: string;
    if (checkpoint.primaryRepository && changedUnits.every(({ path }) => checkpointUnit(path)?.receipts.delivery)) {
      primaryRepository = checkpoint.primaryRepository;
    } else {
      try {
        const candidates = checkpoint.primaryRepository
          ? [checkpoint.primaryRepository, ...changedUnits.map(({ path }) => path)]
          : changedUnits.map(({ path }) => path);
        const linked = await boundary.linkTicketBranch!(hu, ticket, ticketBranch, candidates);
        primaryRepository = (linked as { workingDirectory?: string }).workingDirectory ?? candidates[0]!;
      } catch (error) {
        reportAzureFailure("branch-preparation-failure", "integrating", options, `lazy-workflow: no se pudo fijar la rama primaria del ticket (${errorMessage(error)}); ejecución detenida.`, {}, "preserved");
        return 1;
      }
    }
    checkpoint = { ...checkpoint, primaryRepository };
    await save();

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
        reportAzureFailure("topology-preparation-failure", "integrating", options, `lazy-workflow: el repositorio ${unit.path} no tiene identidad Azure en la topología; ejecución detenida.`, { repository: unit.path }, "preserved");
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
        reportAzureFailure("delivery-failure", "integrating", options, `lazy-workflow: no se pudo entregar el repositorio ${unit.path} (${errorMessage(error)}); ejecución detenida.`, { repository: unit.path }, "preserved");
        return 1;
      }
    }

    // Lo que cierra el ticket es lo último que dijo la sesión, una sola para todo el workspace
    // (ADR-0037). Antes se publicaba un documento armado con la evidencia de cada repositorio.
    const completionInfo = await boundary.getTicketInfo!(hu, ticket);
    const summary = checkpoint.summary?.trim();
    if (!summary && !completionInfo.completionEvidence) {
      reportAzureFailure("session-not-verified", "evidencing", options, "lazy-workflow: la sesión workspace no dejó resumen para completion-evidence; ejecución detenida.", {}, "preserved");
      return 1;
    }
    const ticketEffortBefore = await boundary.getEffort!(ticket);
    const baselineReal = ticketEffortBefore.effort.real ?? 0;
    const baselineRealHours = ticketEffortBefore.effort.realHours ?? 0;
    const ticketStateBefore = await boundary.getState!(ticket);

    if (summary) {
      try {
        await boundary.validateSummary!(ticket, summary);
      } catch (error) {
        reportAzureFailure("session-not-verified", "evidencing", options, `lazy-workflow: el resumen de la sesión no es publicable (${errorMessage(error)}); ejecución detenida.`, {}, "preserved");
        return 1;
      }
      const refreshedInfo = await boundary.getTicketInfo!(hu, ticket);
      if (!refreshedInfo.completionEvidence) await boundary.setSummary!(ticket, summary);
    }

    // Effort has to be reconciled before the completion gates are judged, not after: real-effort and
    // real-effort-hours only clear once this write lands, so checking gates first meant they could
    // never be satisfied on a first run — the single-repository path and ticket-completion-apply both
    // require effort to already be settled before they judge completion, for the same reason.
    if (!checkpoint.receipts.effort) {
      const effortInfo = await boundary.getTicketInfo!(hu, ticket);
      const activeHours = activeEffortHours(checkpoint.activeDurationMs + accrue());
      await boundary.setEffort!(
        ticket,
        baselineReal + activeHours,
        baselineRealHours + activeHours,
        effortInfo.ticket.revision ?? ticketStateBefore.revision ?? 0,
      );
      checkpoint = { ...checkpoint, receipts: { ...checkpoint.receipts, effort: { verifiedAt: new Date(this.clock.now()).toISOString() } } };
      await save();
    }

    const finalInfo = await boundary.getTicketInfo!(hu, ticket);
    const unmetBeforeDone = finalInfo.gates.unmet.filter((gate) => gate !== COMPLETION_GATE.ticketState);
    if (unmetBeforeDone.length > 0) {
      reportAzureFailure("deterministic-completion-failure", "completing", options, `lazy-workflow: gates incumplidos en el ticket workspace ${ticket}: ${unmetBeforeDone.join(", ")}`, {}, "preserved");
      return 1;
    }

    // The ticket and the HU only move once every changed repository carries a verified receipt.
    const pending = checkpoint.units.filter((unit) => unit.changed && !unit.receipts.delivery);
    if (pending.length > 0) {
      reportAzureFailure("delivery-failure", "completing", options, `lazy-workflow: quedan repositorios sin entregar (${pending.map(({ path }) => path).join(", ")}); ejecución detenida.`, {}, "preserved");
      return 1;
    }
    checkpoint = { ...checkpoint, phase: "completing" };
    await save();

    if (finalInfo.ticket.state !== "Done") {
      const currentState = await boundary.getState!(ticket);
      await boundary.setState!(ticket, "Done", currentState.state ?? ticketStateBefore.state ?? "Active", true, currentState.revision ?? ticketStateBefore.revision ?? 0);
    }

    const verifyAfter = await boundary.getTicketInfo!(hu, ticket);
    if (verifyAfter.ticket.state !== "Done") {
      reportAzureFailure("deterministic-completion-failure", "completing", options, `lazy-workflow: no se pudo verificar la finalización del ticket workspace ${ticket}`, {}, "preserved");
      return 1;
    }

    const huState = await boundary.getHuState!(hu);
    let huTransitionApplied = false;
    if (huState.state === "Desarrollo Terminado") {
      huTransitionApplied = true;
    } else if (await boundary.hasOpenDeliveryChildren!(hu)) {
      reportOperator(`lazy-workflow: la HU ${hu} todavía tiene hijos de entrega abiertos; transición de HU omitida`);
    } else {
      try {
        await boundary.setHuState!(hu, "Desarrollo Terminado", huState.state ?? "En Desarrollo", huState.revision ?? 0);
        const verified = await boundary.getHuState!(hu);
        if (verified.state !== "Desarrollo Terminado") {
          reportAzureFailure("hu-transition-failure", "completing", options, `lazy-workflow: no se pudo verificar la transición de la HU ${hu}; el ticket ${ticket} se conservó en Done`, { ticket }, "preserved");
        } else {
          huTransitionApplied = true;
        }
      } catch (error) {
        reportAzureFailure("hu-transition-failure", "completing", options, `lazy-workflow: no se pudo transicionar la HU ${hu} (${errorMessage(error)}); el ticket ${ticket} se conservó en Done`, {}, "preserved");
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
        reportAzureFailure("ticket-branch-cleanup-failure", "cleaning", options, `lazy-workflow: no se pudo limpiar la rama del ticket en ${unit.path} (${errorMessage(error)})`, { repository: unit.path }, "preserved");
      }
    }

    const deliveryReport = {
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
        reportAzureFailure("manifest-not-verifiable", "cleaning", options, `lazy-workflow: no se pudo escribir el manifest agregado del workspace (${errorMessage(error)}); el checkpoint se conservó.`, {}, "preserved");
        return 1;
      }
      await this.azureWorkspaceCheckpoint.clear(scope.stateDirectory);
      // Without a fixed --ticket the run is a drain: select the next eligible child of the HU, as
      // single-repository `code --hu` does. Only a clean delivery continues; an unclean one stops
      // with its checkpoint intact so the operator reconciles before more work is claimed.
      // The next unit starts on the CLI the operator declared, not on whatever this unit adopted
      // from its own checkpoint or fallback handoff (issue: a mid-drain descent otherwise poisoned
      // every ticket after it with a CLI/model pairing nobody asked for).
      if (options.ticket === null) {
        return this.runAzureWorkspaceCode({ ...this.restoreDeclaredCli(declaredOptions, options), session: null });
      }
    }
    return 0;
  }

  private async workspacePrompt(
    options: CliOptions,
    scope: WorkspaceScope,
    issue: SelectedManagedIssue,
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
          reportAzureFailure("tracker-read-failure", "planning", options, `lazy-workflow: no se pudo leer la HU en Azure DevOps (${errorMessage(error)})`);
          return 1;
        }
      }
      const { result, failed } = await this.runPlanningSession(
        { kind: "workspace-plan", scope, run: provider, huInfo },
        { ...options, session: null },
        norms,
        provider,
        scope.parentDirectory,
      );
      reportOperator(JSON.stringify(result, null, 2));
      if (failed) return 1;
      for (const repository of scope.repositories) {
        if (!await this.commitPlanningEdits(repository.path)) return 1;
      }
      // A workspace plan publishes exactly like a single-repository one: the
      // session decides the slices, the coordinator creates the work items. The
      // repository count is the session's scope, never a reason to leave a plan
      // stranded in stdout.
      if (provider.kind === "azure-hu-run") return this.publishAzurePlan(provider.hu, result.text, options);
      // Un plan workspace GitHub publica en el repositorio ancla, que es el unico
      // donde `code` busca la cola gestionada.
      return this.publishGitHubPlan(result.text, scope.repositories[0]!.path, options);
    } catch (error) {
      reportFailure(
        resolveWorkflowRun(options.hu).kind === "azure-hu-run" ? "workspace-scope-failure" : "delivery-failure",
        "preparing",
        { hu: options.hu, issue: options.issue, repository: options.workingDirectory },
        `lazy-workflow: no se pudo preparar el workspace (${errorMessage(error)})`,
      );
      return 1;
    }
  }

  /** El alcance del checkpoint workspace debe seguir siendo el mismo declarado, repositorio por repositorio. */
  private workspaceScopeMismatch(checkpoint: GitHubWorkspaceCheckpoint, scope: WorkspaceScope): string | null {
    if (checkpoint.parentDirectory !== scope.parentDirectory) {
      return "el checkpoint workspace GitHub pertenece a otro directorio de estado";
    }
    if (checkpoint.repositories.length !== scope.repositories.length) {
      return "el checkpoint workspace GitHub declara otra cantidad de repositorios";
    }
    const drifted = scope.repositories.find((repository, index) =>
      repository.path !== checkpoint.repositories[index]?.path
      || repository.remote !== checkpoint.repositories[index]?.remote
      || repository.providerIdentity !== checkpoint.repositories[index]?.repository
    );
    return drifted ? `el repositorio ${drifted.path} no coincide con la identidad remota del checkpoint workspace GitHub` : null;
  }

  /**
   * Coordina una entrega GitHub transversal con el mismo bucle que un repositorio: seleccionar y
   * fijar ramas, correr una sesión, y dejar que git diga qué repositorio entregó (ADR-0035). Un
   * checkpoint que sobrevive de una corrida anterior nunca reanuda esa sesión (ADR-0039); va
   * directo a la integración, que vuelve a preguntarle a git.
   */
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
        const mismatch = this.workspaceScopeMismatch(existing, scope);
        if (mismatch) {
          reportFailure("workspace-scope-failure", "reconciling", { issue: existing.issue, repository: options.workingDirectory }, `lazy-workflow: ${mismatch}; ejecución detenida.`);
          return 1;
        }
        return await this.integrateWorkspaceCode(options, scope, existing);
      }
      const anchor = scope.repositories[0];
      if (!anchor?.providerIdentity) throw new Error("el primer repositorio no tiene identidad GitHub");
      if (!this.githubDelivery) throw new Error("el coordinador GitHub no está habilitado");
      const selection = await this.githubManagedQueue.selectEligibleIssue?.(anchor.path);
      if (!selection || selection.kind !== "candidate") {
        reportOperator(selection?.kind === "blocked" ? "lazy-workflow: la cola workspace tiene issues no elegibles" : "lazy-workflow: no quedan issues GitHub elegibles");
        return selection?.kind === "blocked" ? 0 : 1;
      }
      if (selection.repository.nameWithOwner !== anchor.providerIdentity) {
        throw new Error("el Issue seleccionado no pertenece al primer repositorio del workspace");
      }
      if (!this.githubManagedQueue.claimSelectedIssue) throw new Error("el coordinador workspace no puede verificar el claim del Issue");
      const issue = await this.githubManagedQueue.claimSelectedIssue(selection.issue.number, anchor.path);
      const units: GitHubWorkspaceUnit[] = [];
      for (const repository of scope.repositories) {
        const prepared = await this.githubDelivery.prepareBranch(issue.number, repository.path);
        units.push({
          path: repository.path,
          remote: repository.remote,
          repository: repository.providerIdentity!,
          branch: prepared.branch,
          baseBranch: prepared.baseBranch,
          changed: null,
          commit: null,
          pullRequest: null,
          mergeCommit: null,
        });
      }
      let checkpoint: GitHubWorkspaceCheckpoint = {
        schemaVersion: 3,
        workflow: "github-workspace-code",
        issue: issue.number,
        parentDirectory: scope.parentDirectory,
        repositories: scope.repositories.map(({ path, remote, providerIdentity }) => ({ path, remote, repository: providerIdentity! })),
        units,
        summary: null,
      };
      await this.githubWorkspaceCheckpoint.write(checkpoint, scope.stateDirectory);
      const run = await this.workspacePrompt(options, scope, issue, units);
      const execution = await this.codingAgent.run(
        { ...options, workingDirectory: scope.parentDirectory, ...run, session: null },
        false,
      );
      reportOperator(JSON.stringify(execution.result, null, 2));
      // Igual que la entrega de un solo repositorio: el proceso que sale es la señal, y lo que
      // cada repositorio entregó lo dice git más abajo, en la integración (ADR-0035).
      checkpoint = { ...checkpoint, summary: execution.result.text.trim() || null };
      await this.githubWorkspaceCheckpoint.write(checkpoint, scope.stateDirectory);
      if (execution.failed) {
        await this.githubWorkspaceCheckpoint.clear(scope.stateDirectory);
        reportFailure("session-failure", "reconciling", { issue: issue.number, repository: options.workingDirectory }, `lazy-workflow: la sesión workspace GitHub falló (${errorMessage(execution.result.text)}); el Issue #${issue.number} queda reclamado.`);
        return 1;
      }
      return await this.integrateWorkspaceCode(options, scope, checkpoint);
    } catch (error) {
      reportFailure("delivery-failure", "coordinating", { issue: undefined, repository: options.workingDirectory }, `lazy-workflow: no se pudo coordinar la entrega workspace (${errorMessage(error)})`);
      return 1;
    } finally {
      for (const release of releases.reverse()) await release();
    }
  }

  /**
   * Los efectos deterministas de un workspace ya verificado con git: push, pull request y merge
   * por repositorio que cambió, cierre único del Issue, limpieza de cada rama y reconciliación de
   * padres. Ninguno lleva recibo propio — cada uno verifica su estado antes de actuar, igual que la
   * entrega de un repositorio — y un repositorio sin cambios es una entrega válida que nunca ve un
   * pull request (ADR-0035).
   */
  private async integrateWorkspaceCode(
    options: CliOptions,
    scope: WorkspaceScope,
    initial: GitHubWorkspaceCheckpoint,
  ): Promise<number> {
    let checkpoint = initial;
    const save = async (): Promise<void> => { await this.githubWorkspaceCheckpoint.write(checkpoint, scope.stateDirectory); };
    const delivery = this.githubDelivery;
    if (!delivery) throw new Error("el coordinador GitHub no está habilitado");
    const anchor = checkpoint.repositories[0]!;

    // Un repositorio de la entrega transversal cambió si su rama lleva commits sobre la base y su
    // árbol quedó limpio; uno que no cambió tiene que estar exactamente donde empezó, sin nada sin
    // publicar que la limpieza pudiera perder (ADR-0035).
    const units: GitHubWorkspaceUnit[] = [];
    for (const unit of checkpoint.units) {
      if (unit.changed !== null) { units.push(unit); continue; }
      if (!unit.baseBranch) throw new Error(`falta la rama base fijada para ${unit.path}`);
      let verified: { commit: string } | null;
      try {
        verified = await delivery.verifySession(unit.branch, unit.baseBranch, unit.path);
      } catch {
        verified = null;
      }
      if (!verified) {
        const status = await this.git(["status", "--porcelain", "--untracked-files=no"], unit.path);
        if (status.trim()) {
          reportFailure("workspace-scope-failure", "reconciling", { issue: checkpoint.issue, repository: unit.repository, branch: unit.branch }, `lazy-workflow: el repositorio ${unit.path} quedó con cambios sin commitear; ejecución detenida.`);
          return 1;
        }
        const branchName = unit.branch.replace(/^refs\/heads\//, "");
        const unpublishedRaw = await this.git(["rev-list", "--count", `refs/remotes/origin/${branchName}..HEAD`], unit.path).catch(() => "0");
        const unpublished = Number(unpublishedRaw.trim() || "0");
        if (!Number.isFinite(unpublished) || unpublished > 0) {
          reportFailure("session-not-verified", "reconciling", { issue: checkpoint.issue, repository: unit.repository, branch: unit.branch }, `lazy-workflow: el repositorio ${unit.path} tiene commits que su rama remota no lleva; ejecución detenida.`);
          return 1;
        }
        const head = (await this.git(["rev-parse", "HEAD^{commit}"], unit.path)).trim();
        units.push({ ...unit, changed: false, commit: head });
        continue;
      }
      units.push({ ...unit, changed: true, commit: verified.commit });
    }
    checkpoint = { ...checkpoint, units };
    await save();

    const changedUnits = units.filter((unit) => unit.changed);
    if (changedUnits.length === 0) {
      for (const unit of units) {
        if (!unit.baseBranch) continue;
        await delivery.cleanupBranch(unit.branch, unit.baseBranch, unit.commit!, unit.path);
      }
      await this.githubWorkspaceCheckpoint.clear(scope.stateDirectory);
      reportFailure("delivery-failure", "reconciling", { issue: checkpoint.issue, repository: options.workingDirectory }, "lazy-workflow: el workspace no contiene cambios entregables; ejecución detenida.");
      return 1;
    }

    const delivered: GitHubWorkspaceUnit[] = [];
    for (const changedUnit of changedUnits) {
      let unit = changedUnit;
      const baseBranch = unit.baseBranch;
      if (!baseBranch) throw new Error(`falta la rama base fijada para ${unit.path}`);
      if (unit.pullRequest && unit.mergeCommit) { delivered.push(unit); continue; }
      try {
        if (!unit.pullRequest) {
          await delivery.pushCommit(unit.branch, unit.commit!, unit.path);
          const created = await delivery.createOrReusePullRequest(
            checkpoint.issue, unit.branch, baseBranch, unit.commit!, unit.path,
            false, `${anchor.repository}#${checkpoint.issue}`, checkpoint.summary ?? undefined,
          );
          unit = { ...unit, pullRequest: created.number };
          checkpoint = { ...checkpoint, units: checkpoint.units.map((candidate) => candidate.path === unit.path ? unit : candidate) };
          await save();
        }
        const pullRequest = unit.pullRequest!;
        let mergeCommit: string;
        try {
          mergeCommit = (await delivery.mergePullRequest(pullRequest, checkpoint.issue, unit.branch, baseBranch, unit.commit!, unit.path)).mergeCommit!;
        } catch (error) {
          if (!(error instanceof GitHubPullRequestConflictError)
            || !delivery.preparePullRequestReconciliation
            || !delivery.verifyPullRequestReconciliation) throw error;
          const originalCommit = unit.commit!;
          const { baseCommit } = await delivery.preparePullRequestReconciliation(unit.branch, baseBranch, originalCommit, unit.path);
          const outcome = await this.runGitHubPullRequestReconciliation(options, {
            issue: checkpoint.issue,
            repository: unit.repository,
            pullRequest,
            branch: unit.branch,
            baseBranch,
            originalCommit,
            baseCommit,
            workingDirectory: unit.path,
            issueWorkingDirectory: anchor.path,
          });
          if (outcome.kind === "pending") throw new Error(`la sesión de reconciliación no resolvió el conflicto en ${unit.path}`);
          unit = { ...unit, commit: outcome.commit };
          checkpoint = { ...checkpoint, units: checkpoint.units.map((candidate) => candidate.path === unit.path ? unit : candidate) };
          await save();
          await delivery.pushCommit(unit.branch, outcome.commit, unit.path);
          mergeCommit = (await delivery.mergePullRequest(pullRequest, checkpoint.issue, unit.branch, baseBranch, unit.commit!, unit.path)).mergeCommit!;
        }
        unit = { ...unit, mergeCommit };
        checkpoint = { ...checkpoint, units: checkpoint.units.map((candidate) => candidate.path === unit.path ? unit : candidate) };
        await save();
        delivered.push(unit);
      } catch (error) {
        reportFailure(githubCompletionFailureKind(error), "reconciling", { issue: checkpoint.issue, repository: unit.repository, branch: unit.branch }, `lazy-workflow: no se pudo entregar el repositorio ${unit.path} (${errorMessage(error)}); checkpoint conservado.`);
        return 1;
      }
    }

    const first = delivered[0]!;
    try {
      await delivery.closeIssue(checkpoint.issue, first.pullRequest!, first.mergeCommit!, anchor.path);
    } catch (error) {
      reportFailure(githubCompletionFailureKind(error), "reconciling", { issue: checkpoint.issue, repository: anchor.repository }, `lazy-workflow: no se pudo cerrar el Issue #${checkpoint.issue} (${errorMessage(error)}); checkpoint conservado.`);
      return 1;
    }

    for (const unit of checkpoint.units) {
      if (!unit.baseBranch) continue;
      try {
        await delivery.cleanupBranch(unit.branch, unit.baseBranch, unit.commit!, unit.path);
      } catch (error) {
        reportFailure(githubCompletionFailureKind(error), "cleaning", { issue: checkpoint.issue, repository: unit.repository, branch: unit.branch }, `lazy-workflow: no se pudo limpiar la rama de ${unit.path} (${errorMessage(error)}); checkpoint conservado.`);
        return 1;
      }
    }

    if (this.githubParentReconciliation) {
      try {
        await this.githubParentReconciliation.reconcileParents(checkpoint.issue, anchor.path);
      } catch (error) {
        reportFailure("parent-reconciliation-failure", "cleaning", { issue: checkpoint.issue, repository: anchor.repository }, `lazy-workflow: no se pudo reconciliar los padres del Issue #${checkpoint.issue} (${errorMessage(error)}); checkpoint conservado.`);
        return 1;
      }
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
      try {
        release = await lock.acquire(options.workingDirectory);
      } catch (error) {
        throw new GitHubCoordinatedFailureError("lock-unavailable", errorMessage(error), { cause: error });
      }
      let checkpoint: GitHubDeliveryCheckpoint | null;
      try {
        checkpoint = await store.read(options.workingDirectory);
      } catch (error) {
        throw new GitHubCoordinatedFailureError("checkpoint-unreadable", errorMessage(error), { cause: error });
      }
      const resolvedIssue = checkpoint ? await this.githubCheckpointResolvedExternally(checkpoint, options.workingDirectory) : null;
      if (checkpoint && resolvedIssue) {
        await this.releaseOrphanedCheckpointClaim(resolvedIssue, options.workingDirectory);
        reportOperator(
          `lazy-workflow: el Issue #${checkpoint.issue} del checkpoint ya está cerrado sin PR asociado; `
          + "checkpoint descartado, continuando con la cola.",
        );
        await store.clear(options.workingDirectory);
        try {
          await this.githubParentReconciliation?.reconcileOpenParents(options.workingDirectory);
        } catch (error) {
          throw new GitHubCoordinatedFailureError("parent-reconciliation-failure", errorMessage(error), { cause: error });
        }
        return this.runDefaultCodeWorkflowLoop(options, store);
      }
      // Un checkpoint es una entrega a retomar, y `runGitHubRecovery` decide con la única
      // pregunta que importa: si la unidad llegó a verificarse (ADR-0038).
      if (checkpoint) return this.runGitHubRecovery(options, checkpoint, true);
      try {
        await this.githubParentReconciliation?.reconcileOpenParents(options.workingDirectory);
      } catch (error) {
        throw new GitHubCoordinatedFailureError("parent-reconciliation-failure", errorMessage(error), { cause: error });
      }
      return this.runDefaultCodeWorkflowLoop(options, store);
    } catch (error) {
      console.log(JSON.stringify({ outcome: RECONCILIATION_REQUIRED_MARKER }, null, 2));
      const failureKind = error instanceof GitHubCoordinatedFailureError ? error.failureKind : "delivery-failure";
      reportFailure(
        failureKind,
        "coordinating",
        { repository: options.workingDirectory },
        `lazy-workflow: no se pudo coordinar la entrega GitHub (${errorMessage(error)}); ejecucion detenida.`,
      );
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
      try {
        await this.githubParentReconciliation?.reconcileOpenParents(options.workingDirectory);
      } catch (error) {
        throw new GitHubCoordinatedFailureError("parent-reconciliation-failure", errorMessage(error), { cause: error });
      }
      return this.runDefaultCodeWorkflowLoop(options, store ?? null);
    };
    if (lockHeld || !store || !lock) return drain();
    let release: (() => Promise<void>);
    try {
      release = await lock.acquire(options.workingDirectory);
    } catch (error) {
      throw new GitHubCoordinatedFailureError("lock-unavailable", errorMessage(error), { cause: error });
    }
    try {
      return await drain();
    } finally {
      await release();
    }
  }

  private async runDefaultCodeWorkflowLoop(
    options: CliOptions,
    store: GitHubCheckpointStore | null,
    /** Unidades que ya fallaron antes de entrar al bucle, como la que una recuperación descartó. */
    alreadyFailed = 0,
  ): Promise<number> {
    const norms = await this.loadSagNorms(options, "coding");
    if (options.normasSag && norms === null) return 1;
    const queue = this.githubManagedQueue;
    /**
     * Cuántas unidades fallaron sin detener el drenaje (ADR-0038).
     *
     * Una unidad que falla conserva su claim, que es lo que la saca de la frontera, así que la
     * vuelta siguiente elige otra y el drenaje termina igual. Lo que el conteo cambia es el código
     * de salida: una corrida que dejó issues rotas detrás no puede reportarse como limpia.
     */
    let failedUnits = alreadyFailed;
    /**
     * Dejar la unidad en curso y seguir con la siguiente.
     *
     * Lo que la saca de la frontera es su propio claim, que no se libera; el checkpoint se limpia
     * porque la unidad no llegó a tocar el remoto y no hay nada a medias que reconciliar. El
     * llamador hace `continue` — un cierre no puede hacerlo por él.
     */
    const skipFailedUnit = async (
      kind: FailureKind,
      phase: string,
      context: { issue: number; repository: string; branch: string | null; sessionId?: string | null },
      message: string,
    ): Promise<void> => {
      reportFailure(kind, phase, context, message);
      failedUnits += 1;
      if (store) await store.clear(options.workingDirectory);
    };
    // Deliver every eligible issue in one run: on completion, re-select the next.
    while (true) {
      let queueOutcome: ManagedQueueOutcome;
      let checkpointWasWritten = false;
      if (store && queue.selectEligibleIssue && queue.claimSelectedIssue) {
        let selection: Awaited<ReturnType<NonNullable<GitHubManagedQueueAdapter["selectEligibleIssue"]>>>;
        try {
          selection = await queue.selectEligibleIssue(options.workingDirectory);
        } catch (error) {
          reportFailure(
            "tracker-read-failure",
            "selecting",
            { repository: options.workingDirectory },
            `lazy-workflow: no se pudo leer la cola GitHub (${errorMessage(error)}); ejecucion detenida.`,
          );
          return 1;
        }
        if (selection.kind === "candidate") {
          await store.write({
            schemaVersion: 3,
            workflow: "github-code",
            repository: selection.repository.nameWithOwner,
            issue: selection.issue.number,
            branch: null,
            commit: null,
          }, options.workingDirectory);
          checkpointWasWritten = true;
          try {
            const claimedIssue = await queue.claimSelectedIssue(selection.issue.number, options.workingDirectory);
            queueOutcome = { kind: "selected", issue: claimedIssue, repository: selection.repository };
          } catch (error) {
            console.log(JSON.stringify({ outcome: RECONCILIATION_REQUIRED_MARKER, issue: selection.issue.number, phase: "selected" }, null, 2));
            reportFailure(
              "claim-verification-failure",
              "selected",
              { issue: selection.issue.number, repository: selection.repository.nameWithOwner },
              `lazy-workflow: no se pudo verificar el claim del Issue #${selection.issue.number} (${errorMessage(error)}); checkpoint conservado.`,
            );
            return 1;
          }

        } else {
          queueOutcome = selection;
        }
      } else {
        try {
          queueOutcome = await queue.selectAndClaimEligibleIssue(options.workingDirectory);
        } catch (error) {
          console.log(JSON.stringify({ outcome: RECONCILIATION_REQUIRED_MARKER }, null, 2));
          reportFailure(
            "tracker-read-failure",
            "selecting",
            { repository: options.workingDirectory },
            `lazy-workflow: no se pudo leer la cola GitHub (${errorMessage(error)}); ejecucion detenida.`,
          );
          return 1;
        }
      }
      if (queueOutcome.kind === "empty") {
        console.log(JSON.stringify({ outcome: QUEUE_EMPTY_MARKER }, null, 2));
        console.log(QUEUE_EMPTY_MARKER);
        console.log(WORKFLOW_STEP_FINISHED_MARKER);
        reportOperator(failedUnits === 0
          ? "lazy-workflow: no quedan issues GitHub elegibles."
          : `lazy-workflow: no quedan issues GitHub elegibles; ${failedUnits} quedaron reclamadas sin entregar.`);
        return failedUnits === 0 ? 0 : 1;
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
      /** The session's own closing words, which become the pull-request body (ADR-0037). */
      let summary: string | null = null;
      let commit: string | null = null;
      /** El escalón en curso, para que el traspaso siguiente sepa de dónde viene. */
      let activeRung: FallbackRung | null = null;
      /** El CLI que corre la sesión en curso: el del run hasta que un traspaso la mueva. */
      let activeCli = options.cli;
      /** El checkpoint de la unidad: lo que git no puede contar, y nada más (ADR-0038). */
      const saveCheckpoint = async (): Promise<void> => {
        if (store) await store.write({
          schemaVersion: 3,
          workflow: "github-code",
          repository: repository.nameWithOwner,
          issue: issue.number,
          branch,
          baseBranch,
          commit,
          summary,
        }, options.workingDirectory);
      };
      if (!checkpointWasWritten) await saveCheckpoint();
      if (this.githubDelivery) {
        try {
          const prepared = await this.githubDelivery.prepareBranch(issue.number, options.workingDirectory);
          branch = prepared.branch;
          baseBranch = prepared.baseBranch;
          await saveCheckpoint();
        } catch (error) {
          await saveCheckpoint();
          reportFailure(
            "branch-preparation-failure",
            "started",
            { issue: issue.number, repository: repository.nameWithOwner },
            `lazy-workflow: no se pudo preparar la rama del Issue #${issue.number} (${errorMessage(error)}); checkpoint conservado.`,
          );
          return 1;
        }
      }
      // ADR-0020 superseded the uncoordinated shape: without a coordinator-owned delivery adapter
      // and a fixed branch there is nothing to verify, so the run fails closed instead of opening a
      // session nobody will be able to complete.
      if (!this.githubDelivery || !branch || !baseBranch) {
        reportFailure(
          "delivery-failure",
          "started",
          { issue: issue.number, repository: repository.nameWithOwner, branch },
          `lazy-workflow: falta el adaptador de entrega GitHub o la rama del Issue #${issue.number}; no se inicia una sesion sin contrato de entrega.`,
        );
        return 1;
      }
      const run = await this.buildGitHubDeliveryPrompt(options, issue, repository, branch, norms);
      /** The authority of the session in course, restated by a handoff in the new CLI's own format. */
      let activeAuthority = run.agent;
      /** The session `activeCli` owns once a handoff opened a new one, so the two are never checkpointed crossed. */
      let activeSessionId: string | null = null;
      const handOff = async (rung: FallbackRung, reasoning: string[]): Promise<AgentExecution> => {
        const handedOff = await this.handOffGitHubDelivery(options, rung, {
          issue,
          repository,
          branch: branch!,
          baseBranch: baseBranch!,
          norms,
          reasoning,
        });
        activeRung = rung;
        activeCli = rung.cli;
        activeAuthority = handedOff.agent;
        activeSessionId = handedOff.execution.result.sessionId;
        // El CLI nuevo y la sesión nueva quedan en el checkpoint en una sola
        // escritura, en cuanto el CLI nuevo devuelve el identificador: antes
        // de correr la sesión todavía no existe ninguno que registrar.
        await saveCheckpoint();
        return handedOff.execution;
      };
      const descend = (attempted: AgentExecution): Promise<AgentExecution> =>
        this.descendFallbackChain(options, attempted, handOff);
      let execution;
      try {
        // En dos pasos: el catch de abajo nombra la sesión que quedó viva, y un descenso que
        // explota tiene que encontrarla ya asignada.
        execution = await this.codingAgent.run({
          ...options,
          ...run,
          session: null,
        }, false);
        execution = await descend(execution);
      } catch (error) {
        // A descent that failed still leaves a live session behind, so the
        // checkpoint keeps it and recovery resumes that one; only a session the
        // CLI declares gone goes back sessionless, as recovery already does.
        const reconcilingSessionId = error instanceof AgentSessionNotFoundError ? null : activeSessionId ?? execution?.result.sessionId ?? null;
        await skipFailedUnit(
          "session-failure",
          "reconciling",
          { issue: issue.number, repository: repository.nameWithOwner, branch, sessionId: reconcilingSessionId },
          `lazy-workflow: la sesion GitHub fallo (${errorMessage(error)}); el Issue #${issue.number} queda reclamado.`,
        );
        continue;
      }
      // El descenso es sticky solo dentro de esta unidad: la siguiente vuelve a
      // arrancar en el escalón primario, también cuando un traspaso cambió de CLI.
      if (activeCli !== options.cli) this.resolveAgent(options.cli);
      const result = execution.result;
      console.log(JSON.stringify(result, null, 2));
      summary = result.text.trim() || null;
      // Que el proceso saliera bien es lo único que dice esto; que la unidad se entregara lo dice
      // git, y eso se pregunta abajo antes de tocar el remoto (ADR-0035).
      const processSucceeded = !execution.failed;
      await saveCheckpoint();
      if (!processSucceeded) {
        await skipFailedUnit(
          "session-failure",
          "reconciling",
          { issue: issue.number, repository: repository.nameWithOwner, branch, sessionId: result.sessionId },
          `lazy-workflow: la sesión GitHub falló (${errorMessage(result.text)}); el Issue #${issue.number} queda reclamado.`,
        );
        continue;
      }

      if (this.githubDelivery) {
        // La compuerta de la unidad, antes de tocar el remoto: git dice si esto es una entrega
        // (ADR-0035). Lo que no pasa por acá no vuelve a intentarse en esta corrida — queda
        // reclamado, con su rama, y el drenaje sigue con la siguiente (ADR-0038).
        try {
          if (!branch || !baseBranch) throw new Error("la unidad no tiene rama fijada");
          commit = (await this.githubDelivery.verifySession(branch, baseBranch, options.workingDirectory)).commit;
        } catch (error) {
          await skipFailedUnit(
            githubCompletionFailureKind(error),
            "implementation-ready",
            { issue: issue.number, repository: repository.nameWithOwner, branch },
            `lazy-workflow: el Issue #${issue.number} no quedó verificado (${errorMessage(error)}); queda reclamado y su rama se conserva.`,
          );
          continue;
        }
        try {
          await this.completeGitHubDelivery(options, {
            schemaVersion: 3,
            workflow: "github-code",
            repository: repository.nameWithOwner,
            issue: issue.number,
            branch,
            baseBranch,
            commit,
            summary,
          });
          console.log(TICKET_COMPLETED_MARKER);
          console.log(WORKFLOW_STEP_FINISHED_MARKER);
          continue;
        } catch (error) {
          reportFailure(
            githubCompletionFailureKind(error),
            "implementation-ready",
            { issue: issue.number, repository: repository.nameWithOwner, branch },
            `lazy-workflow: no se pudo completar determinísticamente el Issue #${issue.number} (${errorMessage(error)}); checkpoint conservado.`,
          );
          // Una unidad verificada que ya empujó, abrió PR o mergeó está a medias: tomar la
          // siguiente enterraría el estado que hay que reconciliar bajo una segunda entrega.
          return 1;
        }
      }
      if (!processSucceeded) {
        reportFailure(
          "session-failure",
          "implementation-ready",
          { issue: issue.number, repository: repository.nameWithOwner, branch },
          "lazy-workflow: la sesión GitHub falló.",
        );
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
    norms: SagContext | null,
  ): Promise<{ prompt: string; agent: AgentAuthority }> {
    return this.prompt({ kind: "github-delivery", issue, repository, branch }, options, norms);
  }

  /**
   * El traspaso: una sesión fresca en el escalón siguiente continuando la misma
   * unidad fijada, cambie o no de CLI. Recibe el mismo prompt de entrega del
   * coordinador, la sección de avance —rama, commits y las últimas cadenas de
   * pensamiento del agente saliente— y el perfil de autoridad en el formato que
   * el CLI nuevo impone. Nunca se reanuda una sesión: reanudar replayaba una
   * transcripción entera para cambiar de modelo (ADR-0039).
   */
  private async handOffGitHubDelivery(
    options: CliOptions,
    rung: FallbackRung,
    work: {
      issue: SelectedManagedIssue;
      repository: GitHubRepositoryContext;
      /** `null` cuando el checkpoint todavía no fijó rama: hay traspaso, pero no hay avance que declarar. */
      branch: string | null;
      baseBranch: string | null;
      norms: SagContext | null;
      /** Lo último que pensó el escalón que se agotó, tal cual lo emitió. */
      reasoning: string[];
    },
  ): Promise<{ execution: AgentExecution; agent: AgentAuthority }> {
    const handoffOptions: CliOptions = { ...options, cli: rung.cli, model: rung.model, variant: rung.variant };
    const run = await this.prompt(
      { kind: "github-delivery", issue: work.issue, repository: work.repository, branch: work.branch ?? "" },
      handoffOptions,
      work.norms,
      work.branch && work.baseBranch
        ? await this.verifiedProgress(options.workingDirectory, work.branch, work.baseBranch, work.reasoning)
        : null,
    );
    this.resolveAgent(rung.cli);
    return {
      execution: await this.codingAgent.run({
        ...handoffOptions,
        ...run,
        session: null,
      }, false),
      agent: run.agent,
    };
  }

  /**
   * What a handoff can state about the work already done: the checkpoint phase
   * and what the repository itself answers about this unit — never what belongs
   * to another delivery. A commit that does not exist yet, an unreadable
   * worktree, or a manifest never written (or written by another delivery) are
   * all absences the section names rather than failures that stop the handoff.
   */
  private async verifiedProgress(
    workingDirectory: string,
    branch: string,
    baseBranch: string,
    reasoning: string[],
  ): Promise<HandoffProgress> {
    const readGit = async (args: string[]): Promise<string | null> => {
      try {
        return (await this.git(args, workingDirectory)).trim() || null;
      } catch {
        return null;
      }
    };
    // The base is read through its remote branch: the ref `prepareBranch` creates
    // the unit's branch from, and the one it has just fetched.
    const base = `refs/remotes/origin/${baseBranch.replace(/^refs\/heads\//, "")}`;
    return {
      branch,
      // Solo lo que la rama lleva sobre esa base es avance de esta entrega; un `log` pelado
      // respondería la punta de la base. Un rango vacío — o una rama sin commits, que hace fallar
      // a `log` — es la ausencia que la sección dice.
      commits: await readGit(["log", "--format=%h %s", `${base}..${branch}`]) ?? "",
      reasoning,
    };
  }

  private async buildGitHubReconciliationPrompt(
    options: CliOptions,
    issue: SelectedManagedIssue,
    repository: string,
    pullRequest: number,
    branch: string,
    originalCommit: string,
    baseCommit: string,
  ): Promise<{ prompt: string; agent: AgentAuthority }> {
    return this.prompt(
      {
        kind: "github-reconciliation",
        issue,
        repository: { nameWithOwner: repository },
        branch,
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
      baseBranch: string;
      originalCommit: string;
      baseCommit: string;
      workingDirectory: string;
      issueWorkingDirectory: string;
    },
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
      context.originalCommit,
      context.baseCommit,
    );
    // Sesión fresca, siempre: la reconciliación es su propio trabajo y no continúa la sesión de
    // entrega que dejó el conflicto (ADR-0039).
    const execution = await this.codingAgent.run(
      { ...options, workingDirectory: context.workingDirectory, ...run, session: null },
      false,
    );
    const result = execution.result;
    reportOperator(JSON.stringify(result, null, 2));
    if (execution.failed) return { kind: "pending", sessionId: result.sessionId };
    const { commit } = await delivery.verifySession(context.branch, context.baseBranch, context.workingDirectory);
    await delivery.verifyPullRequestReconciliation(
      context.branch,
      context.originalCommit,
      context.baseCommit,
      commit,
      context.workingDirectory,
    );
    return { kind: "ready", commit };
  }

  /**
   * Los efectos deterministas de una unidad ya verificada: push, pull request, merge, cierre,
   * limpieza y reconciliación de padres.
   *
   * No lleva recibos. Los llevaba para no repetir un efecto que ya había ocurrido, y cada uno de
   * ellos verifica su propio estado antes de actuar: `pushCommit` compara la rama remota con el
   * commit, `createOrReusePullRequest` reusa el PR canónico, `mergePullRequest` devuelve el merge
   * si el PR ya está mergeado, `closeIssue` sale si la issue ya está cerrada, `cleanupBranch`
   * comprueba las dos refs antes de borrarlas. Un recibo solo ahorraba la llamada que responde
   * eso, al precio de una máquina de estado que podía desincronizarse del remoto (ADR-0038).
   */
  private async completeGitHubDelivery(options: CliOptions, initial: GitHubDeliveryCheckpoint): Promise<void> {
    const delivery = this.githubDelivery;
    const store = this.githubCheckpointStore;
    if (!delivery || !store || !initial.branch || !initial.baseBranch) {
      throw new Error("faltan primitivas o contexto para completar la entrega GitHub");
    }
    const fixedBranch = initial.branch;
    const fixedBaseBranch = initial.baseBranch;
    await delivery.verifyRepository?.(initial.repository, options.workingDirectory);
    let checkpoint = initial;
    const save = async (): Promise<void> => store.write(checkpoint, options.workingDirectory);
    const effect = async (name: string, action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        if (error instanceof GitHubPullRequestConflictError) throw error;
        const failureKind: FailureKind = name === "parent-reconciliation"
          ? "parent-reconciliation-failure"
          : name === "pull-request" || name === "merge"
            ? "pull-request-failure"
            : "deterministic-completion-failure";
        throw new GitHubCoordinatedFailureError(failureKind, errorMessage(error), { cause: error });
      }
    };

    // El commit lo tiene git, no un archivo que la sesión pidió que le escribieran (ADR-0035).
    // Una unidad que el bucle ya verificó llega con su commit fijado; una que se retoma desde el
    // checkpoint no, y se verifica acá.
    let verifiedCommit = checkpoint.commit
      ?? (await delivery.verifySession(fixedBranch, fixedBaseBranch, options.workingDirectory)).commit;
    checkpoint = { ...checkpoint, commit: verifiedCommit };
    await save();

    await effect("push", () => delivery.pushCommit(fixedBranch, verifiedCommit, options.workingDirectory));
    let pullRequest = 0;
    await effect("pull-request", async () => {
      pullRequest = (await delivery.createOrReusePullRequest!(
        checkpoint.issue, fixedBranch, fixedBaseBranch, verifiedCommit, options.workingDirectory,
        true, `#${checkpoint.issue}`, checkpoint.summary ?? undefined,
      )).number;
    });
    if (!pullRequest) throw new Error("No se pudo resolver el PR GitHub");

    let mergeCommit = "";
    const merge = async (): Promise<void> => {
      await effect("merge", async () => {
        mergeCommit = (await delivery.mergePullRequest!(
          pullRequest, checkpoint.issue, fixedBranch, fixedBaseBranch, verifiedCommit, options.workingDirectory,
        )).mergeCommit;
      });
    };
    try {
      await merge();
    } catch (error) {
      if (!(error instanceof GitHubPullRequestConflictError)
        || !delivery.preparePullRequestReconciliation
        || !delivery.verifyPullRequestReconciliation) throw error;
      const originalCommit = verifiedCommit;
      const { baseCommit } = await delivery.preparePullRequestReconciliation(fixedBranch, fixedBaseBranch, originalCommit, options.workingDirectory);
      const outcome = await this.runGitHubPullRequestReconciliation(options, {
        issue: checkpoint.issue,
        repository: checkpoint.repository,
        pullRequest,
        branch: fixedBranch,
        baseBranch: fixedBaseBranch,
        originalCommit,
        baseCommit,
        workingDirectory: options.workingDirectory,
        issueWorkingDirectory: options.workingDirectory,
      });
      if (outcome.kind === "pending") throw new Error("La sesión de reconciliación no resolvió el conflicto");
      verifiedCommit = outcome.commit;
      checkpoint = { ...checkpoint, commit: verifiedCommit };
      await save();
      await effect("push", () => delivery.pushCommit(fixedBranch, verifiedCommit, options.workingDirectory));
      await merge();
    }
    if (!mergeCommit) throw new Error("No se pudo verificar el commit de merge GitHub");

    await effect("issue-closure", () => delivery.closeIssue(checkpoint.issue, pullRequest, mergeCommit, options.workingDirectory));
    await effect("cleanup", () => delivery.cleanupBranch(fixedBranch, fixedBaseBranch, verifiedCommit, options.workingDirectory));
    if (this.githubParentReconciliation) {
      await effect("parent-reconciliation", () => this.githubParentReconciliation!.reconcileParents(checkpoint.issue, options.workingDirectory));
    }
    await store.clear(options.workingDirectory);
  }

  private reportGitHubReconciliationRequired(checkpoint: GitHubDeliveryCheckpoint, emitFailure = true): void {
    console.log(JSON.stringify({
      outcome: RECONCILIATION_REQUIRED_MARKER,
      issue: checkpoint.issue,
    }, null, 2));
    if (emitFailure) {
      reportFailure(
        "reconciliation-required",
        "reconciling",
        { issue: checkpoint.issue, repository: checkpoint.repository, branch: checkpoint.branch },
        `lazy-workflow: el Issue #${checkpoint.issue} conserva un checkpoint GitHub; requiere reconciliacion.`,
      );
    }
  }

  /**
   * Retomar una entrega GitHub que quedó a medias, que es una sola pregunta.
   *
   * El checkpoint guarda el único bit que git no puede contar por sí solo: si la unidad pasó su
   * verificación (ADR-0038). Con commit fijado, la entrega ya está hecha del lado del repositorio
   * y lo que falta son efectos deterministas e idempotentes —push, PR, merge, cierre, limpieza—
   * que `completeGitHubDelivery` vuelve a intentar sin abrir sesión. Sin commit, la unidad nunca
   * llegó a tocar el remoto: no hay nada que reconciliar, la issue conserva su claim, y la corrida
   * sigue drenando.
   *
   * Lo que había acá era una máquina de ocho fases con recibos e intenciones por efecto, y toda
   * ella respondía a que el coordinador no sabía si la sesión había entregado. Ahora lo sabe.
   */
  private async runGitHubRecovery(options: CliOptions, checkpoint: GitHubDeliveryCheckpoint, lockAlreadyHeld = false): Promise<number> {
    const store = this.githubCheckpointStore;
    const lock = this.githubRepositoryLock;
    if (!store || !lock) {
      this.reportGitHubReconciliationRequired(checkpoint);
      return 1;
    }
    if (!lockAlreadyHeld) {
      let release: () => Promise<void>;
      try {
        release = await lock.acquire(options.workingDirectory);
      } catch (error) {
        reportFailure(
          "lock-unavailable",
          "reconciling",
          { issue: checkpoint.issue, repository: checkpoint.repository, branch: checkpoint.branch },
          `lazy-workflow: no se pudo adquirir el lock GitHub (${errorMessage(error)}); checkpoint conservado.`,
        );
        return 1;
      }
      try {
        return await this.runGitHubRecovery(options, checkpoint, true);
      } finally {
        await release();
      }
    }

    let live: GitHubDeliveryCheckpoint | null;
    try {
      live = await store.read(options.workingDirectory);
    } catch (error) {
      this.reportGitHubReconciliationRequired(checkpoint, false);
      reportFailure(
        "checkpoint-unreadable",
        "reconciling",
        { issue: checkpoint.issue, repository: checkpoint.repository },
        `lazy-workflow: no se pudo leer el checkpoint GitHub (${errorMessage(error)}); checkpoint conservado.`,
      );
      return 1;
    }
    if (!live || live.issue !== checkpoint.issue) {
      this.reportGitHubReconciliationRequired(checkpoint);
      return 1;
    }

    // Una unidad que nunca se verificó no dejó nada en el remoto: se la deja reclamada, con su
    // rama, y el drenaje sigue con la siguiente.
    if (!live.commit || !live.branch || !live.baseBranch) {
      await store.clear(options.workingDirectory);
      reportFailure(
        "session-failure",
        "reconciling",
        { issue: live.issue, repository: live.repository, branch: live.branch },
        `lazy-workflow: el Issue #${live.issue} quedó sin verificar en una corrida anterior; queda reclamado y su rama se conserva.`,
      );
      return this.runDefaultCodeWorkflowLoop(options, store, 1);
    }

    try {
      await this.completeGitHubDelivery(options, live);
      console.log(TICKET_COMPLETED_MARKER);
      console.log(WORKFLOW_STEP_FINISHED_MARKER);
    } catch (error) {
      const preserved = await store.read(options.workingDirectory).catch(() => live) ?? live;
      this.reportGitHubReconciliationRequired(preserved, false);
      reportFailure(
        githubCompletionFailureKind(error),
        "implementation-ready",
        { issue: live.issue, repository: live.repository, branch: live.branch },
        `lazy-workflow: no se pudo completar determinísticamente el Issue #${live.issue} (${errorMessage(error)}); checkpoint conservado.`,
      );
      return 1;
    }
    return this.runDefaultCodeWorkflowLoop(options, store);
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

  /**
   * One planning session, from its prompt to its last word — shared by the
   * GitHub, Azure and workspace planning runs, which differ only in the spec
   * they build and the directory they run from.
   *
   * Without `--interview` this is exactly the historical path: build, run,
   * continue after an Azure login, answer with the result. With one, the
   * session's paused turns are carried to the operator and back until the plan
   * is final (ADR-0027).
   */
  /**
   * A planning session may create or update documentation as its own
   * deliverable (ADR-0021: committing stays allowed in planning profiles for
   * exactly this). The coordinator commits it mechanically once the session
   * ends, rather than trusting the prompt asking the session to do it itself —
   * ADR-0020 already rejected provider text as a control plane, and a session
   * that forgot would surface the failure later, on an unrelated `code` run,
   * far from its cause. `prepareBranch` and `repositoryScope` both require a
   * clean tracked tree before they act, so this closes exactly that gap.
   */
  private async commitPlanningEdits(workingDirectory: string): Promise<boolean> {
    try {
      const status = await this.git(["status", "--porcelain", "--untracked-files=no"], workingDirectory);
      if (!status.trim()) return true;
      // Solo lo que git ya rastrea: un `-A` barre lo que estaba suelto en el directorio —un
      // `.env`, un dump— y el commit siguiente lo publica. Un archivo sin rastrear casi siempre
      // no está versionado porque no debe estarlo, y no bloquea el checkout de una rama nueva.
      await this.git(["add", "-u"], workingDirectory);
      await this.git(["commit", "-m", "lazy-workflow: commit documentation from planning session"], workingDirectory);
      return true;
    } catch (error) {
      reportFailure(
        "delivery-failure",
        "planning",
        { repository: workingDirectory },
        `lazy-workflow: no se pudieron commitear los cambios de documentación de la sesión de planificación (${errorMessage(error)}); ejecución detenida.`,
      );
      return false;
    }
  }

  /**
   * Publica el plan que la sesion devolvio: un Issue por rebanada, con su rol de
   * triage puesto en la misma llamada que lo crea, y despues las aristas de
   * bloqueo declaradas.
   *
   * Es el gemelo GitHub de `publishAzurePlan` (ADR-0040): el coordinador crea el
   * trabajo porque es el unico que sabe cual es suyo. Antes lo deducia leyendo
   * la numeracion mas alta previa a la sesion, y esa deduccion etiquetaba como
   * del plan cualquier Issue que alguien abriera a mano mientras corria.
   */
  private async publishGitHubPlan(text: string, workingDirectory: string, options: CliOptions): Promise<number> {
    try {
      const tickets = parsePlan(text);
      if (tickets.length === 0) {
        reportOperator("lazy-workflow: el plan no requiere Issues de entrega.");
        return 0;
      }
      const { createReadyIssue, linkBlockedBy } = this.githubManagedQueue;
      if (!createReadyIssue || !linkBlockedBy) {
        throw new Error("la frontera de cola GitHub no expone las primitivas de publicacion");
      }
      const publication = await publishPlanIssues(
        {
          createReadyIssue: createReadyIssue.bind(this.githubManagedQueue),
          linkBlockedBy: linkBlockedBy.bind(this.githubManagedQueue),
        },
        tickets,
        workingDirectory,
      );
      console.log(JSON.stringify(publication, null, 2));
      return 0;
    } catch (error) {
      reportFailure(
        "deterministic-completion-failure",
        "publishing",
        { issue: options.issue, repository: workingDirectory },
        `lazy-workflow: no se pudo publicar el plan en GitHub (${errorMessage(error)}); ejecucion detenida.`,
      );
      return 1;
    }
  }

  private async runPlanningSession(
    spec: WorkflowPromptSpec,
    options: CliOptions,
    norms: SagContext | null,
    run: WorkflowRun,
    workingDirectory: string,
  ): Promise<{ result: AgentResult; failed: boolean }> {
    const prompted = await this.prompt(spec, options, norms);

    // Built before the session opens: an unusable port is then an
    // argument-shaped failure that costs no model usage, and the channel's
    // address is already printed while the agent thinks.
    let channel: QuestionChannel | null;
    try {
      channel = this.createQuestionChannelFn(options.interview, getDefaultReporter());
    } catch (error) {
      reportFailure("argument-error", "planning", { hu: options.hu, issue: options.issue, repository: workingDirectory }, `lazy-workflow: no se pudo abrir el canal de preguntas (${errorMessage(error)}); ejecución detenida.`);
      throw error;
    }

    try {
      const execution = await this.codingAgent.run(
        { ...options, ...prompted, workingDirectory, session: options.session },
        run.kind === "azure-hu-run",
      );
      // Login first: a session parked on `az login` never got to ask anything.
      const result = await this.continuePlanAfterAzureLogin(execution, run, workingDirectory, prompted.agent);
      if (!channel) return { result, failed: execution.failed === true };
      return await this.interview(channel, result, options, norms, workingDirectory, prompted.agent, execution.failed === true);
    } finally {
      await channel?.close();
    }
  }

  /**
   * Read the finished turn, giving a session that closed its round with broken
   * JSON exactly one chance to restate it.
   *
   * The round is the session's own work — the questions were written, the
   * repository was explored, the turn was paid for — and an unbalanced bracket
   * is the one failure that throws all of it away while nothing is actually
   * wrong with what was asked. So the coordinator asks for the payload again
   * instead of discarding the turn. It still decides nothing it cannot verify:
   * the restated round goes through the same fail-closed reader, and a second
   * unreadable answer stops the run. A session that already failed is not
   * resumed at all — its text is cut short by the failure, not by a slip.
   */
  private async readTurn(
    result: AgentResult,
    options: CliOptions,
    norms: SagContext | null,
    workingDirectory: string,
    agent: AgentAuthority,
    failed: boolean,
  ): Promise<{ turn: PlanTurn | null; result: AgentResult }> {
    let reason: string;
    try {
      return { turn: readPlanTurn(result.text), result };
    } catch (error) {
      reason = errorMessage(error);
    }
    const scope = { hu: options.hu, issue: options.issue, repository: workingDirectory };
    if (failed) {
      reportFailure("session-failure", "planning", { ...scope, sessionId: result.sessionId }, `lazy-workflow: la ronda de preguntas no se pudo leer (${reason}); ejecución detenida.`);
      return { turn: null, result };
    }

    reportOperator(`lazy-workflow: la ronda de preguntas no se pudo leer (${reason}); pido a la sesión ${result.sessionId} que la vuelva a emitir.`);
    let restated: AgentResult;
    try {
      restated = await this.codingAgent.resume(
        result.sessionId,
        buildResumePrompt(await buildRoundRepairPrompt(reason), norms),
        workingDirectory,
        undefined,
        { agent },
      );
    } catch (error) {
      if (error instanceof AgentExhaustionError) {
        reportFailure("session-failure", "planning", { ...scope, sessionId: error.result.sessionId }, `lazy-workflow: ${describeExhaustion(error.exhaustion)}; entrevista detenida.`);
        return { turn: null, result: error.result };
      }
      reportFailure("session-failure", "planning", { ...scope, sessionId: result.sessionId }, `lazy-workflow: no se pudo pedir de nuevo la ronda de preguntas (${errorMessage(error)}); ejecución detenida.`);
      return { turn: null, result };
    }

    try {
      return { turn: readPlanTurn(restated.text), result: restated };
    } catch (error) {
      reportFailure("session-failure", "planning", { ...scope, sessionId: restated.sessionId }, `lazy-workflow: la ronda de preguntas siguió sin poder leerse tras pedirla de nuevo (${errorMessage(error)}); ejecución detenida.`);
      return { turn: null, result: restated };
    }
  }

  /**
   * Carry the session's paused turns to the operator until the plan is final.
   *
   * The pause is read from the finished turn's own text rather than signalled
   * through `terminalMarker`: a terminal marker cuts the stream short and closes
   * the session with it, and the session that must answer the next round is the
   * very one that would be deleted.
   */
  private async interview(
    channel: QuestionChannel,
    first: AgentResult,
    options: CliOptions,
    norms: SagContext | null,
    workingDirectory: string,
    agent: AgentAuthority,
    failedBefore: boolean,
  ): Promise<{ result: AgentResult; failed: boolean }> {
    let result = first;
    let failed = failedBefore;

    for (let round = 1; ; round += 1) {
      const read = await this.readTurn(result, options, norms, workingDirectory, agent, failed);
      result = read.result;
      if (!read.turn) return { result, failed: true };
      const turn = read.turn;
      if (turn.kind === "final") return { result, failed };
      if (failed) {
        reportFailure("session-failure", "planning", { hu: options.hu, issue: options.issue, repository: workingDirectory, sessionId: result.sessionId }, "lazy-workflow: la sesión pidió responder preguntas pero terminó con error; ejecución detenida.");
        return { result, failed: true };
      }

      const last = round >= options.interview.rounds;
      reportOperator(
        `Ronda ${turn.round.round}: ${turn.round.questions.length} pregunta(s) del plan [sesión ${result.sessionId}]`,
      );

      let answers: QuestionAnswers;
      try {
        answers = await channel.ask(turn.round);
      } catch (error) {
        // An expired deadline or a channel that went away resolves to what the
        // session itself recommended, which is what a run without `--interview`
        // would have done anyway. Interactivity is a chance to intervene, not a
        // new way for a planning run to die.
        reportOperator(`lazy-workflow: ${errorMessage(error)}; se aceptan las respuestas recomendadas por la sesión.`);
        answers = recommendedAnswers(turn.round);
      }
      reportOperator(`Ronda ${turn.round.round} respondida (${answers.source}); reanudo la sesión ${result.sessionId}`);

      try {
        result = await this.codingAgent.resume(
          result.sessionId,
          buildResumePrompt(await buildInterviewAnswersPrompt(answers, last ? 0 : options.interview.rounds - round), norms),
          workingDirectory,
          undefined,
          { agent },
        );
      } catch (error) {
        if (error instanceof AgentExhaustionError) {
          reportFailure("session-failure", "planning", { hu: options.hu, issue: options.issue, repository: workingDirectory, sessionId: error.result.sessionId }, `lazy-workflow: ${describeExhaustion(error.exhaustion)}; entrevista detenida.`);
          return { result: error.result, failed: true };
        }
        reportFailure("session-failure", "planning", { hu: options.hu, issue: options.issue, repository: workingDirectory, sessionId: result.sessionId }, `lazy-workflow: no se pudo reanudar la sesión de planificación (${errorMessage(error)}); ejecución detenida.`);
        return { result, failed: true };
      }

      if (last) {
        // The bound was declared and stated to the session. One that asks again
        // anyway is not one to keep resuming. A round that no longer parses is
        // moot here: the interview is over either way.
        if (asksAgain(result.text)) {
          reportOperator(
            `lazy-workflow: la sesión abrió otra ronda con el tope de ${options.interview.rounds} agotado; ejecución detenida.`,
          );
          return { result, failed: true };
        }
        return { result, failed };
      }
    }
  }

  /** The authority of a run: its profile, in the format the run's own CLI enforces. */
  private authority(spec: WorkflowPromptSpec, cli: AgentCli): AgentAuthority {
    const profile = authorityProfile(spec);
    return { profile, configPath: authorityConfigPath(cli, profile) };
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
      reportFailure("delivery-failure", phase, { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, `lazy-workflow: no se pudo cargar el contexto SAG (${errorMessage(error)}); ejecucion detenida.`);
      return null;
    }
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
        // El default de `--prompt` no viaja: no es una petición del operador, es relleno.
        operatorRequest: options.hasPrompt ? options.prompt : "",
        workingDirectory: options.workingDirectory,
        norms,
        questions: options.numberOfQuestions,
        interview: options.interview.channel !== "off",
        progress,
      }),
      agent: this.authority(spec, options.cli),
    };
  }

  private async runTicketRead(command: string, options: CliOptions): Promise<number> {
    if (!isPositiveId(options.ticket)) {
      return azureArgumentError(options, `${command} requiere --ticket <id> con un entero positivo`);
    }
    const ticket = options.ticket;
    const needsHu = command === "ticket-info" || command === "ticket-branch-info"
      || command === "ticket-pr-info" || command === "ticket-completion-info";
    if (needsHu && !isPositiveId(options.hu)) {
      return azureArgumentError(options, `${command} requiere --hu <id>`);
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
      reportAzureFailure("tracker-read-failure", "reading", options, `lazy-workflow: no se pudo consultar ${command} (${errorMessage(error)})`);
      return 1;
    }
  }

  /**
   * El cierre determinista de un ticket, con el resumen de la sesión como su completion-evidence
   * (ADR-0037). Lo que llegaba acá como un manifest —el commit, los digests, los adjuntos y el
   * documento renderizado— o lo responde git antes de llamar (ADR-0035), o dejó de existir.
   */
  private async applyTicketCompletion(options: CliOptions, runEffect: CompletionEffectRunner = async (_effect, _target, action) => action()): Promise<unknown> {
    if (!this.huInfoService.getTicketInfo || !this.huInfoService.validateDirectTicketContext) {
      throw new Error("El servicio Azure no soporta ticket-completion-apply");
    }
    if (!this.huInfoService.linkPullRequest || !this.huInfoService.linkCommit
      || !this.huInfoService.setSummary || !this.huInfoService.setState || !this.huInfoService.validateSummary) {
      throw new Error("El servicio Azure no expone todas las primitivas de completion");
    }

    const summary = options.summary?.trim() ?? "";
    await this.huInfoService.validateDirectTicketContext(options.hu!, options.ticket!);
    let info = await this.huInfoService.getTicketInfo(options.hu!, options.ticket!);

    const unreconcilableGates = info.gates.unmet.filter((gate) =>
      gate === COMPLETION_GATE.realEffort
      || gate === COMPLETION_GATE.realEffortHours
    );
    if (unreconcilableGates.length > 0) {
      throw new Error(`No se puede completar el ticket ${options.ticket}; faltan datos previos: ${unreconcilableGates.join(", ")}`);
    }

    // Un ticket que ya carga completion-evidence no necesita otra, así que una entrega retomada
    // sin el resumen de su sesión todavía cierra; una que no la carga y no lo tiene, no.
    const completionEvidenceMissing = !info.completionEvidence;
    if (!summary && completionEvidenceMissing) {
      throw new Error("La sesión no dejó un resumen para la completion-evidence del ticket");
    }
    if (summary) {
      try {
        await this.huInfoService.validateSummary(options.ticket!, summary);
      } catch (error) {
        throw new AzureCoordinatedFailureError("evidence-not-verifiable", errorMessage(error), { cause: error });
      }
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

    if (summary && completionEvidenceMissing) {
      await runEffect("evidence", "resumen de la sesión", () => this.huInfoService!.setSummary!(options.ticket!, summary).then(() => undefined));
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
    return { hu: options.hu, ticket: options.ticket, pullRequest: options.pullRequest, state: "Done", gates: info.gates };
  }

  private async runAzureCode(options: CliOptions): Promise<number> {
    let checkpoint: StoredAutocodeCheckpoint | null;
    try {
      checkpoint = await this.checkpointStore.read(options.workingDirectory);
    } catch (error) {
      reportAzureFailure("checkpoint-unreadable", "recovery-checkpoint-read", options, `lazy-workflow: no se pudo leer el checkpoint Azure (${errorMessage(error)}); ejecución detenida.`);
      return 1;
    }
    if (options.session !== null && checkpoint === null) {
      reportAzureFailure("checkpoint-unreadable", "reconciling", options, "lazy-workflow: no existe un checkpoint para la sesión solicitada.");
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
      const adopted = this.adoptCheckpointCli(migrated.cli, options, migrated.handoffFrom);
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
      reportAzureFailure("argument-error", "reconciling", options, `lazy-workflow: la HU ${options.hu} no coincide con la HU fijada ${checkpoint.hu}.`, {}, "preserved");
      return 1;
    }
    if (options.session !== null && checkpoint.sessionId !== options.session) {
      reportAzureFailure("argument-error", "reconciling", options, "lazy-workflow: la sesión no coincide con el checkpoint fijado.", {}, "preserved");
      return 1;
    }
    if (options.session === null && checkpoint.sessionId !== null) {
      reportAzureFailure("argument-error", "reconciling", options, `lazy-workflow: el ticket ${checkpoint.ticket ?? "fijado"} conserva una sesión activa; reanúdala con --session.`, { ticket: checkpoint.ticket }, "preserved");
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
          reportAzureFailure("branch-preparation-failure", "preflight-hu", options, `lazy-workflow: no se encontró la rama de integración para la HU ${hu}; ejecución detenida.`, {}, "preserved");
          return 1;
        }
      }
      checkpoint = { ...checkpoint, integrationBranch };
      if (checkpoint.phase === "preflight-hu") await markPhase("selected", { integrationBranch });
    } catch (error) {
      reportAzureFailure("branch-preparation-failure", "preflight-hu", options, `lazy-workflow: no se pudo preparar la rama de integración de la HU ${hu} (${errorMessage(error)}); ejecución detenida.`, {}, "preserved");
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
          if (!checkpoint.localCommit) {
            reportAzureFailure("session-not-verified", "reconciling", options, `lazy-workflow: el ticket ${checkpoint.ticket} tiene un PR canónico, pero su sesión nunca quedó verificada; checkpoint sessionless conservado.`, { ticket: checkpoint.ticket }, "preserved");
            return 1;
          }
        }
      } catch (error) {
        reportAzureFailure("pull-request-failure", "reconciling", options, `lazy-workflow: no se pudo reconciliar el PR canónico del ticket ${checkpoint.ticket} (${errorMessage(error)}); ejecución detenida.`, { ticket: checkpoint.ticket }, "preserved");
        return 1;
      }
    }

    if ((checkpoint.phase === "implementing" || checkpoint.phase === "reconciling") && checkpoint.ticket !== null && checkpoint.sessionId === null && !checkpoint.localCommit) {
      if (!this.huInfoService.getAutocodeContextForTicket) {
        reportAzureFailure("claim-verification-failure", "reconciling", options, `lazy-workflow: no se puede reconstruir el ticket ${checkpoint.ticket} fijado; ejecución detenida.`, { ticket: checkpoint.ticket }, "preserved");
        return 1;
      }
      let context: AutocodeContext | null;
      try {
        context = await this.huInfoService.getAutocodeContextForTicket(hu, checkpoint.ticket, integrationBranch);
      } catch (error) {
        reportAzureFailure("claim-verification-failure", "reconciling", options, `lazy-workflow: no se pudo reconstruir el ticket ${checkpoint.ticket} (${errorMessage(error)}); ejecución detenida.`, { ticket: checkpoint.ticket }, "preserved");
        return 1;
      }
      if (!context || !this.huInfoService.verifyTicketCompletion) {
        reportUnmetCompletion(checkpoint.ticket, { ticketId: checkpoint.ticket, unmetGates: [COMPLETION_GATE.pinnedTicketContext] }, options);
        return 1;
      }
      let verification: TicketCompletionVerification | null;
      try {
        verification = await this.huInfoService.verifyTicketCompletion(context);
      } catch (error) {
        reportAzureFailure("deterministic-completion-failure", "completing", options, `lazy-workflow: no se pudo verificar el cierre del ticket ${checkpoint.ticket} (${errorMessage(error)}); checkpoint conservado.`, { ticket: checkpoint.ticket }, "preserved");
        return 1;
      }
      if (!requireVerifiedCompletion(checkpoint.ticket, verification, `lazy-workflow: el ticket ${checkpoint.ticket} todavía no cumple el cierre verificable.`, options)) return 1;
      try {
        await this.cleanupCompletedTicketBranch(context, options.workingDirectory, verification.ticketBranch);
        await this.checkpointStore.clear(options.workingDirectory);
      } catch (error) {
        reportAzureFailure(azureFailureKind(error, "ticket-branch-cleanup-failure"), "cleaning", options, `lazy-workflow: no se pudo limpiar el ticket ${checkpoint.ticket} (${errorMessage(error)}); checkpoint conservado.`, { ticket: checkpoint.ticket }, "preserved");
        return 1;
      }
      return 0;
    }

    if (checkpoint.ticket !== null && checkpoint.sessionId === null && checkpoint.localCommit
      && this.huInfoService.checkoutTicketBranch && this.huInfoService.pushTicketBranch && this.huInfoService.createOrReusePullRequest && this.huInfoService.getTicketInfo && this.huInfoService.setEffort
      && this.huInfoService.getAutocodeContextForTicket && checkpoint.ticketBranch) {
      const context = await this.huInfoService.getAutocodeContextForTicket(hu, checkpoint.ticket, integrationBranch);
      if (!context) {
        reportUnmetCompletion(checkpoint.ticket, { ticketId: checkpoint.ticket, unmetGates: [COMPLETION_GATE.pinnedTicketContext] }, options);
        return 1;
      }
      try {
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
          await this.applyTicketCompletion({ ...options, pullRequest: pullRequest.pullRequest, summary: checkpoint.summary ?? null }, runEffect);
          checkpoint = { ...checkpoint, phase: "cleaning", receipts: { ...checkpoint.receipts, "ticket-completion": { verifiedAt: new Date(now()).toISOString() } } };
          await save();
        }
        await this.cleanupCompletedTicketBranch(context, options.workingDirectory, checkpoint.ticketBranch!);
        await this.checkpointStore.clear(options.workingDirectory);
        return this.runVersionedAzureCode({ ...options, session: null }, null);
      } catch (error) {
        reportAzureFailure(azureFailureKind(error, "deterministic-completion-failure"), "reconciling", options, `lazy-workflow: no se pudo reconciliar determinísticamente el ticket ${checkpoint.ticket} (${errorMessage(error)}); checkpoint conservado.`, { ticket: checkpoint.ticket }, "preserved");
        return 1;
      }
    }

    let context: AutocodeContext | null = null;
    if (checkpoint.ticket !== null) {
      if (!this.huInfoService.getAutocodeContextForTicket) {
        reportAzureFailure("claim-verification-failure", "reconciling", options, `lazy-workflow: no se puede reconstruir el ticket ${checkpoint.ticket} fijado; ejecución detenida.`, { ticket: checkpoint.ticket }, "preserved");
        return 1;
      }
      context = await this.huInfoService.getAutocodeContextForTicket(hu, checkpoint.ticket, integrationBranch);
    } else if (this.huInfoService.getAutocodeState) {
      await markPhase("selected", { integrationBranch });
      const state = await this.huInfoService.getAutocodeState(hu, integrationBranch);
      if (!state.context) {
        if (state.pending) {
          reportAzureFailure("tracker-read-failure", "selecting", options, `lazy-workflow: no hay un ticket elegible todavía para la HU ${hu}.`);
          return 1;
        }
        reportOperator(`lazy-workflow: no hay tickets pendientes para la HU ${hu}.`);
        await this.checkpointStore.clear(options.workingDirectory);
        return 0;
      }
      context = state.context;
    }
    if (!context || context.hu.id !== hu || context.integrationBranch !== integrationBranch || !integrationBranch) {
      reportAzureFailure("claim-verification-failure", "selecting", options, `lazy-workflow: no se pudo reconstruir el ticket fijado de la HU ${hu}.`, {}, "preserved");
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
      reportAzureFailure("branch-preparation-failure", "started", options, `lazy-workflow: la rama de integración del ticket ${ticket} no coincide con la HU fijada; ejecución detenida.`, { ticket }, "preserved");
      return 1;
    }
    if (checkpoint.receipts["ticket-branch"] && existingBranch?.branch !== ticketBranch) {
      reportAzureFailure("manifest-mismatch", "reconciling", options, `lazy-workflow: el recibo de rama del ticket ${ticket} no coincide con Azure; ejecución detenida.`, { ticket }, "preserved");
      return 1;
    }
    await markPhase("started", { ticketBranch });
    const started = await this.ensureAzureTicketInProgress(ticket, stateInfo, !!checkpoint.receipts["ticket-state"], async (receipt) => {
      if (receipt) {
        const verified = checkpoint.receipts["ticket-state"] ?? { verifiedAt: new Date(now()).toISOString() };
        checkpoint = { ...checkpoint, intent: null, receipts: { ...checkpoint.receipts, "ticket-state": verified } };
        await save();
      } else {
        checkpoint = { ...checkpoint, intent: { effect: "ticket-state", target: "En progreso" } };
        await save();
      }
    }, async (expectedState, expectedRevision) => {
      await track("ticket-state", () => this.huInfoService.setState!(
        ticket,
        "En progreso",
        expectedState,
        false,
        expectedRevision,
      ).then(() => undefined), "En progreso");
    }, options);
    if (!started) return 1;
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

    const norms = await this.loadSagNorms(options, "coding");
    if (options.normasSag && norms === null) return 1;
    let sessionId = options.session ?? checkpoint.sessionId;
    let activeCli = checkpoint.cli;
    let resumePrompt = options.prompt;
    while (true) {
      try {
        const authoritativeResumePrompt = buildResumePrompt(resumePrompt, norms);
        const run = await this.prompt({ kind: "azure-delivery", context, ticketBranch }, options, norms);
        let activeAuthority = run.agent;
        const execution = await track(null, async () => {
          // Both a fresh session and a resume of a checkpointed one descend the same declared
          // chain on provider exhaustion (ADR-0024): crossing an invocation or a turn is not an
          // exemption, so the callbacks are shared and every attempt routes through one descent.
          const resumeFn = (descentSessionId: string, overrides: AgentResumeOverrides) =>
            this.codingAgent.resume(
              descentSessionId,
              authoritativeResumePrompt,
              options.workingDirectory,
              undefined,
              { ...overrides, agent: activeAuthority },
            );
          const onDescent = async (rung: FallbackRung, descentSessionId: string) => {
            activeCli = rung.cli;
            checkpoint = { ...checkpoint, model: rung.model, variant: rung.variant, sessionId: descentSessionId };
            await save();
          };
          const handOff = async (rung: FallbackRung) => {
            const handoffOptions: CliOptions = { ...options, cli: rung.cli, model: rung.model, variant: rung.variant };
            const handoffRun = await this.prompt({ kind: "azure-delivery", context, ticketBranch }, handoffOptions, norms);
            this.resolveAgent(rung.cli);
            const handedOff = await this.codingAgent.run({
              ...handoffOptions,
              ...handoffRun,
              session: null,
            }, false);
            activeCli = rung.cli;
            activeAuthority = handoffRun.agent;
            checkpoint = {
              ...checkpoint,
              cli: rung.cli,
              handoffFrom: checkpoint.handoffFrom ?? options.cli,
              model: rung.model,
              variant: rung.variant,
              sessionId: handedOff.result.sessionId,
            };
            await save();
            return handedOff;
          };
          let started: AgentExecution;
          if (sessionId) {
            try {
              started = {
                result: await this.codingAgent.resume(sessionId, authoritativeResumePrompt, options.workingDirectory, undefined, { ...getResumeOverrides(options), agent: run.agent }),
                azureLoginRequired: false,
                failed: false,
              };
            } catch (error) {
              if (!(error instanceof AgentExhaustionError)) throw error;
              started = { result: error.result, azureLoginRequired: false, failed: true, exhaustion: error.exhaustion };
            }
          } else {
            started = await this.codingAgent.run({
              ...options,
              ...run,
              session: null,
            }, true);
          }
          return await this.descendFallbackChain(options, started, handOff);
        });
        // Same exclusion as the workspace path: the idle watchdog's silent
        // intervals never count as active effort (issue #292).
        if (execution.idleMs) {
          checkpoint = { ...checkpoint, activeDurationMs: Math.max(0, checkpoint.activeDurationMs - execution.idleMs) };
          await save();
        }
        sessionId = execution.result.sessionId;
        // Una sesión que espera el login Azure sigue viva y se reanuda; cualquier otra ya terminó,
        // y lo que decide si entregó es git, no ella.
        checkpoint = { ...checkpoint, cli: activeCli, sessionId: execution.azureLoginRequired ? sessionId : null };
        await save();
        if (execution.azureLoginRequired) {
          await this.huInfoService.waitForAccess(hu);
          resumePrompt = "continue";
          continue;
        }
        if (execution.failed) {
          reportAzureFailure("session-failure", "implementing", options, `lazy-workflow: la sesión ${activeCli} del ticket ${ticket} terminó con error; checkpoint conservado.`, { ticket, sessionId }, "preserved");
          return 1;
        }
        if (!this.huInfoService.verifySession || !this.huInfoService.checkoutTicketBranch || !this.huInfoService.pushTicketBranch
          || !this.huInfoService.createOrReusePullRequest || !this.huInfoService.getTicketInfo || !this.huInfoService.setEffort) {
          reportAzureFailure("deterministic-completion-failure", "completing", options, `lazy-workflow: el coordinador no expone todas las primitivas de completion para el ticket ${ticket}; ejecución detenida.`, { ticket }, "preserved");
          return 1;
        }
        // La compuerta de la unidad, antes de tocar el remoto: la rama activa es la fijada, el
        // árbol está limpio y lleva commits sobre la de integración (ADR-0035). Lo que no pasa
        // por acá deja el ticket en `En progreso` con su rama en pie, para que alguien mire.
        const summary = execution.result.text.trim() || null;
        let verifiedCommit: string;
        try {
          verifiedCommit = (await this.huInfoService.verifySession(ticketBranch!, integrationBranch, options.workingDirectory)).commit;
        } catch (error) {
          reportAzureFailure(azureFailureKind(error, "deterministic-completion-failure"), "implementation-ready", options, `lazy-workflow: el ticket ${ticket} no quedó verificado (${errorMessage(error)}); checkpoint conservado y su rama se conserva.`, { ticket }, "preserved");
          return 1;
        }
        try {
          // El commit y el resumen son lo único que git y Azure no responden por sí solos: que
          // la sesión llegó a verificarse, y lo último que dijo (ADR-0037, ADR-0038).
          checkpoint = { ...checkpoint, localCommit: verifiedCommit, summary };
          await save();
          await markPhase("implementation-ready", { sessionId: null });
          await markPhase("integrating", { sessionId: null });
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
            { ...options, pullRequest: pullRequest.pullRequest, summary },
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
          reportAzureFailure(azureFailureKind(error, "deterministic-completion-failure"), "reconciling", options, `lazy-workflow: no se pudo completar determinísticamente el ticket ${ticket} ya verificado (${errorMessage(error)}); checkpoint conservado.`, { ticket }, "preserved");
          return 1;
        }
      } catch (error) {
        if (error instanceof AgentSessionNotFoundError || error instanceof AgentSessionCloseError) {
          checkpoint = { ...checkpoint, phase: "reconciling", sessionId: null, activeSince: null, intent: null };
          await save();
          reportAzureFailure("session-failure", "reconciling", options, `lazy-workflow: la sesión ${error.sessionId} no está disponible; checkpoint sessionless conservado para reconciliación.`, { ticket, sessionId: error.sessionId }, "preserved");
          return 1;
        }
        // Sin marcador que esperar no queda nada que reintentar: la sesión salió, y lo que dejó en
        // la rama ya no va a cambiar por relanzarla. El ticket queda `En progreso` con su rama.
        reportAzureFailure("session-failure", "implementing", options, `lazy-workflow: la sesión ${options.cli} falló (${errorMessage(error)}); checkpoint conservado.`, { ticket }, "preserved");
        return 1;
      }
    }
  }

  private async ensureAzureTicketInProgress(
    ticket: number,
    state: { state: string | null; revision: number | null },
    hasReceipt: boolean,
    persist: (receipt: boolean) => Promise<void>,
    transition: (expectedState: string, expectedRevision: number) => Promise<void>,
    options: CliOptions,
  ): Promise<boolean> {
    if (hasReceipt && state.state !== "En progreso") {
      reportAzureFailure("manifest-mismatch", "reconciling", options, `lazy-workflow: el recibo de estado del ticket ${ticket} no coincide con Azure; ejecución detenida.`, { ticket }, "preserved");
      return false;
    }
    if (!hasReceipt && state.state !== "En progreso") {
      if (state.state === null || state.revision === null) {
        reportAzureFailure("claim-verification-failure", "started", options, `lazy-workflow: Azure no expone el estado y la revisión necesarios para mover el ticket ${ticket} a En progreso; ejecución detenida.`, { ticket }, "preserved");
        return false;
      }
      if (!this.huInfoService.setState) {
        reportAzureFailure("deterministic-completion-failure", "started", options, `lazy-workflow: el coordinador no expone la transición de estado del ticket ${ticket}; ejecución detenida.`, { ticket }, "preserved");
        return false;
      }
      await persist(false);
      await transition(state.state, state.revision);
    }
    if (!hasReceipt) await persist(true);
    return true;
  }

  private async cleanupCompletedTicketBranch(
    context: AutocodeContext,
    workingDirectory: string,
    verifiedTicketBranch: string,
  ): Promise<void> {
    try {
      await this.ticketBranchCleaner.deleteTicketBranch(verifiedTicketBranch, context.integrationBranch, workingDirectory);
    } catch (error) {
      throw new AzureCoordinatedFailureError("ticket-branch-cleanup-failure", errorMessage(error), { cause: error });
    }
    reportOperator(`lazy-workflow: rama completada ${verifiedTicketBranch} eliminada local y remotamente.`);
  }
}
