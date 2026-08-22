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
import { findTextEvidence } from "../azure/ticket-info-service.ts";
import type { CompletionManifest, CompletionManifestEvidence, CompletionManifestInput, TicketInfo, TicketAttachment, EvidenceKind } from "../azure/ticket-info-service.ts";
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
import { DEFAULT_CLI, type AgentCli } from "../coding-agent/agent-cli.ts";
import { getDefaultReporter, reportOperator, reportOperatorHeading, setDefaultReporter } from "../output/operator-output.ts";
import { createReporter, type Reporter, type ReporterRunLogSink } from "../output/reporter.ts";
import { reportFailure, type FailureKind } from "../output/failure-kind.ts";
import { reportSessionEvent } from "../output/session-event.ts";
import { createRunLogSink, resolveRunLogPath, type RunLogRecordInput } from "../output/run-log.ts";
import { registerInterruptionHandlers, type InterruptionCheckpointProbe, type InterruptionProcess } from "../output/run-interruption.ts";
import { GitTicketBranchCleaner, runGit, type GitRunner } from "../git/git-ticket-branch-cleaner.ts";
import { SagNormsService } from "../sag/sag-norms-service.ts";
import { DeploymentAuthenticationRequiredError, SagDeploymentService, sanitizeDeploymentText, type DeploymentEnvironment, type DeploymentScope } from "../sag/deployment-service.ts";
import { InfrastructureAuthenticationRequiredError, SagInfrastructureService, type InfrastructureScope } from "../sag/infrastructure-service.ts";
import { GitHubArchitectureReviewService, type ArchitectureReviewPublication, type ArchitectureReviewTicket, type ArchitectureReviewTracker } from "../github/architecture-review-service.ts";
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
  type GitHubDeliveryPhase,
} from "../github/github-delivery-checkpoint.ts";
import {
  GitHubDeliveryService,
  GitHubManifestNotVerifiableError,
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
import { SudoSystemShutdown, type SystemShutdown } from "../system/shutdown-service.ts";
import {
  IMPLEMENTATION_READY_MARKER,
  markerResumePrompt,
  QUEUE_BLOCKED_MARKER,
  QUEUE_EMPTY_MARKER,
  RECONCILIATION_REQUIRED_MARKER,
  TICKET_COMPLETED_MARKER,
  WORKFLOW_STEP_FINISHED_MARKER,
} from "../prompts/workflow-contract.ts";
import {
  buildInterviewAnswersPrompt,
  buildResumePrompt,
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
import { AzurePlanPublicationService, parsePlan } from "../azure/plan-publication-service.ts";
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
  writeCompletionManifest?(path: string, input: CompletionManifestInput, workingDirectory: string): Promise<CompletionManifest>;
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
  getHuState?(hu: number): Promise<{ hu: number; state: string | null; revision: number | null }>;
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

function oldestReceiptTimestamp(receipts: GitHubDeliveryCheckpoint["receipts"]): string | null {
  const timestamps = Object.values(receipts)
    .filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== undefined)
    .map((receipt) => receipt.verifiedAt);
  return timestamps.length === 0
    ? null
    : timestamps.reduce((oldest, current) => (Date.parse(current) < Date.parse(oldest) ? current : oldest));
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
  return error instanceof AzureCoordinatedFailureError ? error.failureKind : fallback;
}

function githubCompletionFailureKind(error: unknown): FailureKind {
  if (error instanceof GitHubManifestNotVerifiableError) return "manifest-not-verifiable";
  if (error instanceof GitHubCoordinatedFailureError) return error.failureKind;
  if (error instanceof GitHubPullRequestConflictError) return "pull-request-failure";
  return "deterministic-completion-failure";
}

function githubRecoveryFailureKind(error: unknown): FailureKind {
  return error instanceof GitHubManifestNotVerifiableError
    || error instanceof GitHubCoordinatedFailureError
    || error instanceof GitHubPullRequestConflictError
    ? githubCompletionFailureKind(error)
    : "session-failure";
}

/** The run-log `workflow` label: the coarse family a command belongs to, not the command itself (ADR-0029). */
function runLogWorkflow(command: string): string {
  if (command === "plan" || command === "code") return command;
  if (command === "architecture-review-sag" || command === "infra-sag" || command === "deploy-sag") return "sag";
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
 *
 * "Explicit" is decided at adoption, not here: a `--model` declared beside a
 * `--cli` the run's own handoff moved off is no longer explicit about the CLI
 * that will run, and `adoptCheckpointCli` clears it before these options ever
 * reach this function.
 */
function getRecoveryOverrides(options: CliOptions, checkpoint: Pick<GitHubDeliveryCheckpoint, "model" | "variant">): AgentResumeOverrides {
  const overrides = getResumeOverrides(options);
  if (!checkpoint.model || options.hasModel) return overrides;
  // The declared overrides land last because an explicit one always wins, and an
  // explicit `--variant` is the value adoption validated against the CLI the
  // checkpoint imposes — rejecting it there and then ignoring it here would name
  // two different variants for one session (issue #253).
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

  private resolveAgent(cli: AgentCli): CodingAgent {
    this.activeAgent = typeof this.agentSource === "function" ? this.agentSource(cli) : this.agentSource;
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
    if (checkpoint.sessionId !== null || checkpoint.pullRequest) return null;
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
      return { ...options, cli, hasModel: false };
    }
    return { ...options, cli };
  }

  /**
   * The CLI a run goes back to once the checkpointed unit is done. Adopting a
   * handoff is scoped to that unit, exactly as a descent is: the next one starts
   * on the rung the operator declared. Without an explicit `--cli` there is
   * nothing declared to go back to, so the adopted CLI stays the run's own.
   *
   * Re-resolves unconditionally once there is something declared to restore, even when
   * `declared.cli` already equals `adopted.cli`: a fallback descent that happens mid-unit,
   * inside this same invocation, moves `this.activeAgent` to the handed-off CLI without ever
   * touching `options.cli` (only a checkpoint adopted from an *earlier* invocation does that),
   * so comparing the two options objects alone cannot detect that drift.
   */
  private restoreDeclaredCli(declared: CliOptions, adopted: CliOptions): CliOptions {
    if (!declared.hasCli) return adopted;
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
          return checkpoint ? `github-workspace issue ${checkpoint.issue} (phase ${checkpoint.phase})` : null;
        }
        if (this.githubCheckpointStore) {
          const checkpoint = await this.githubCheckpointStore.read(workingDirectory);
          if (checkpoint) return `github issue ${checkpoint.issue} (phase ${checkpoint.phase})`;
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
    const runLog = createRunLogSink({
      path: resolveRunLogPath({ logFile: options.logFile, noLogFile: options.noLogFile }),
      onWriteFailure: (error) => {
        getDefaultReporter().warn(
          `lazy-workflow: no se pudo escribir el run log (${errorMessage(error)}); se deshabilita para el resto del run.`,
        );
      },
    });
    const base = runLogBase(options, await this.resolveRunLogProvider(options));
    // `--off` never shuts down a run that died on an invalid argument, and the
    // one place every failure already passes through — without threading the
    // dozens of returns of `dispatchParsed` — is the sink the Reporter feeds.
    let argumentError = false;
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
      reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "--verbose y --quiet son mutuamente excluyentes");
      return 1;
    }

    if (options.interview.channel !== "off") {
      if (command !== "plan") {
        reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "--interview solo se permite con plan");
        return 1;
      }
      // Every channel announces itself through the Reporter — the URL, the tty
      // prompt, the exchange directory — and `--quiet` silences info. A silent
      // interactive run is a run the operator cannot answer.
      if (options.quiet) {
        reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "--interview y --quiet son mutuamente excluyentes: el canal no podría anunciarse");
        return 1;
      }
    }

    this.reportRunHeading(options);
    this.reportFallbackChain(options);

    if (options.workingDirectory.includes(",")) {
      if (command !== "plan" && command !== "code") {
      reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "--working-directory CSV solo se permite con plan o code");
        return 1;
      }
      // `plan` never mutates branches or tracker state, in either provider.
      if (command === "plan") return this.runWorkspacePlan(options);
      if (options.hu !== null) return this.runAzureWorkspaceCode(options);
      return this.runWorkspaceCode(options);
    }

    if (options.normasSag && command !== "plan" && command !== "code") {
      reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "--normas-sag solo se permite con plan o code");
      return 1;
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

    if (options.issue !== null && command !== "architecture-review-sag" && command !== "deploy-sag" && command !== "infra-sag") {
      reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "--issue solo se permite con infra-sag, architecture-review-sag o deploy-sag");
      return 1;
    }

    if (options.environment !== null && command !== "deploy-sag") {
      reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "--environment solo se permite con deploy-sag");
      return 1;
    }

    if (command === "deploy-sag" && options.environment !== null && !options.environment?.trim()) {
       reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "deploy-sag requiere --environment <dev|test|qa> cuando se proporciona --environment");
      return 1;
    }

    if (command === "architecture-review-sag") {
      if (options.hu !== null && options.issue !== null) {
        reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "architecture-review-sag no permite combinar --hu y --issue");
        return 1;
      }
      if (options.hu === null && options.issue === null) {
        reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "architecture-review-sag requiere --hu <id> o --issue <id>");
        return 1;
      }
      if (options.session !== null || options.branch !== null || options.baseBranch !== null) {
        reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "architecture-review-sag no permite --session, --branch ni --base-branch");
        return 1;
      }
      return this.runArchitectureReview(options);
    }

    if (command === "infra-sag") {
      const unsupportedFlag = args.slice(1)
        .map((arg) => arg?.split("=", 1)[0])
        .find((arg): arg is string => typeof arg === "string" && arg.startsWith("--") && !INFRASTRUCTURE_FLAGS.has(arg));
      if (unsupportedFlag) {
        reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, `infra-sag no permite ${unsupportedFlag}`);
        return 1;
      }
      if (options.hu !== null && options.issue !== null) {
        reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "infra-sag no permite combinar --hu y --issue");
        return 1;
      }
      if (options.hu === null && options.issue === null) {
        reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "infra-sag requiere --hu <id> o --issue <id>");
        return 1;
      }
      if (options.session !== null || options.branch !== null || options.baseBranch !== null) {
        reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "infra-sag no permite --session, --branch ni --base-branch");
        return 1;
      }
      return this.runInfrastructure(options);
    }

    if (command === "deploy-sag") {
      if (options.environment !== null && args.filter((arg) => arg === "--environment" || arg.startsWith("--environment=")).length > 1) {
        reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "deploy-sag no permite repetir --environment");
        return 1;
      }
      if (options.hu !== null && options.issue !== null) {
        reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "deploy-sag no permite combinar --hu y --issue");
        return 1;
      }
      if (options.hu === null && options.issue === null) {
        reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "deploy-sag requiere --hu <id> o --issue <id>");
        return 1;
      }
      const environment = options.environment?.trim().toLowerCase() ?? "dev";
      if (environment !== "dev" && environment !== "test" && environment !== "qa") {
        reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "deploy-sag solo permite DEV, TEST o QA; PROD y sus aliases estan prohibidos");
        return 1;
      }
      if (options.session !== null || options.branch !== null || options.baseBranch !== null) {
        reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "deploy-sag no permite --session, --branch ni --base-branch");
        return 1;
      }
      return this.runDeployment(options, environment);
    }

    if (TICKET_READ_COMMANDS.has(command)) return this.runTicketRead(command, options);

    if (command === "ticket-completion-apply") {
      if (!isValidHu(options.hu)) {
        reportAzureFailure("argument-error", "validating", options, "ticket-completion-apply requiere --hu <id>");
        return 1;
      }
      if (options.ticket === null || !Number.isInteger(options.ticket) || options.ticket <= 0) {
        reportAzureFailure("argument-error", "validating", options, "ticket-completion-apply requiere --ticket <id> con un entero positivo");
        return 1;
      }
      if (options.pullRequest === null || !Number.isInteger(options.pullRequest) || options.pullRequest <= 0) {
        reportAzureFailure("argument-error", "validating", options, "ticket-completion-apply requiere --pr <id> con un entero positivo");
        return 1;
      }
      if (!options.manifest?.trim()) {
        reportAzureFailure("argument-error", "validating", options, "ticket-completion-apply requiere --manifest <path>");
        return 1;
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
      if (!isValidHu(options.hu)) {
        reportAzureFailure("argument-error", "validating", options, "ticket-create requiere --hu <id>");
        return 1;
      }
      if (options.type !== "Task" && options.type !== "Bug") {
        reportAzureFailure("argument-error", "validating", options, "ticket-create requiere --type Task o --type Bug");
        return 1;
      }
      if (!options.title?.trim()) {
        reportAzureFailure("argument-error", "validating", options, "ticket-create requiere --title <titulo>");
        return 1;
      }
      if (!options.descriptionFile?.trim()) {
        reportAzureFailure("argument-error", "validating", options, "ticket-create requiere --description-file <path>");
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
        reportAzureFailure("argument-error", "validating", options, `${command} requiere ${flags} con enteros positivos`);
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
        reportAzureFailure("delivery-failure", "publishing", options, `lazy-workflow: no se pudo ejecutar ${command} (${errorMessage(error)})`);
        return 1;
      }
    }

    if (command === "ticket-description-set" || command === "ticket-state-set" || command === "ticket-effort-set") {
      if (options.ticket === null || !Number.isInteger(options.ticket) || options.ticket <= 0) {
        reportAzureFailure("argument-error", "validating", options, `${command} requiere --ticket <id> con un entero positivo`);
        return 1;
      }
      if (command === "ticket-description-set" && !options.descriptionFile?.trim()) {
        reportAzureFailure("argument-error", "validating", options, "ticket-description-set requiere --description-file <path>");
        return 1;
      }
      if (command === "ticket-state-set" && (!options.state?.trim() || !options.expectedState?.trim())) {
        reportAzureFailure("argument-error", "validating", options, "ticket-state-set requiere --state <state> y --expected-state <state>");
        return 1;
      }
      if (command === "ticket-effort-set" && (
        !options.hasRealEffort || !options.hasRealEffortHours || !options.hasExpectedRevision
        ||
        !Number.isFinite(options.realEffort) || options.realEffort < 0
        || !Number.isFinite(options.realEffortHours) || options.realEffortHours < 0
        || !Number.isInteger(options.expectedRevision) || options.expectedRevision <= 0
      )) {
        reportAzureFailure("argument-error", "validating", options, "ticket-effort-set requiere --real-effort <hours>, --real-effort-hh <hours> y --expected-rev <rev> válidos");
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
        reportAzureFailure("delivery-failure", "evidencing", options, `lazy-workflow: no se pudo ejecutar ${command} (${errorMessage(error)})`);
        return 1;
      }
    }

    if (command === "ticket-pr-link" || command === "ticket-commit-link" || command === "ticket-attachment-add" || command === "ticket-evidence-set") {
      if (command === "ticket-pr-link" && !isValidHu(options.hu)) {
        reportAzureFailure("argument-error", "validating", options, "ticket-pr-link requiere --hu <id>");
        return 1;
      }
      if (options.ticket === null || !Number.isInteger(options.ticket) || options.ticket <= 0) {
        reportAzureFailure("argument-error", "validating", options, `${command} requiere --ticket <id> con un entero positivo`);
        return 1;
      }
      if ((command === "ticket-pr-link" || command === "ticket-commit-link")
        && (options.pullRequest === null || !Number.isInteger(options.pullRequest) || options.pullRequest <= 0)) {
        reportAzureFailure("argument-error", "validating", options, `${command} requiere --pr <id> con un entero positivo`);
        return 1;
      }
      if ((command === "ticket-attachment-add" || command === "ticket-evidence-set") && !options.file?.trim()) {
        reportAzureFailure("argument-error", "validating", options, `${command} requiere --file <path>`);
        return 1;
      }
      if (command === "ticket-attachment-add" && !options.evidenceKind) {
        reportAzureFailure("argument-error", "validating", options, "ticket-attachment-add requiere --kind <http-json|screen|command-output>");
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
        reportAzureFailure("delivery-failure", "executing", options, `lazy-workflow: no se pudo ejecutar ${command} (${errorMessage(error)})`);
        return 1;
      }
    }

    if (command === "ticket-branch-set") {
      if (!isValidHu(options.hu)) {
        reportAzureFailure("argument-error", "validating", options, "ticket-branch-set requiere --hu <id>");
        return 1;
      }
      if (options.ticket === null || !Number.isInteger(options.ticket) || options.ticket <= 0) {
        reportAzureFailure("argument-error", "validating", options, "ticket-branch-set requiere --ticket <id> con un entero positivo");
        return 1;
      }
      if (!options.branch?.trim()) {
        reportAzureFailure("argument-error", "validating", options, "ticket-branch-set requiere --branch <name>");
        return 1;
      }
      if (options.workingDirectory === process.cwd() && !args.some((arg) => arg === "--working-directory" || arg.startsWith("--working-directory="))) {
        reportAzureFailure("argument-error", "validating", options, "ticket-branch-set requiere --working-directory <path>");
        return 1;
      }
      const workingDirectory = options.workingDirectory;
      if (!workingDirectory?.trim() || workingDirectory.startsWith("--")) {
        reportAzureFailure("argument-error", "validating", options, "ticket-branch-set requiere --working-directory <path>");
        return 1;
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
      if (!isValidHu(options.hu)) {
        reportAzureFailure("argument-error", "validating", options, "hu-info requiere --hu <id>");
        return 1;
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
      if (!isValidHu(options.hu)) {
        reportAzureFailure("argument-error", "validating", options, "hu-branch-info requiere --hu <id>");
        return 1;
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
      if (!isValidHu(options.hu)) {
        reportAzureFailure("argument-error", "validating", options, "hu-branch-set requiere --hu <id>");
        return 1;
      }
      if (!options.branch?.trim()) {
        reportAzureFailure("argument-error", "validating", options, "hu-branch-set requiere --branch <name>");
        return 1;
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
      reportFailure("argument-error", "validating", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "--branch y --base-branch solo se permiten en flujos Azure");
      return 1;
    }

    if (command === "code") {
      if (githubRecovery) {
        const adopted = this.adoptCheckpointCli(githubRecovery.cli, options, githubRecovery.handoffFrom);
        if (!adopted) return 1;
        const code = await this.runGitHubRecovery(adopted, githubRecovery);
        return code === 0 ? this.continueQueueAfterRecovery(this.restoreDeclaredCli(options, adopted), false) : code;
      }
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
      const { createTicket, linkPredecessor } = this.huInfoService;
      if (!createTicket || !linkPredecessor) {
        reportAzureFailure("deterministic-completion-failure", "publishing", options, "lazy-workflow: el coordinador no expone las primitivas de publicación de plan; ejecución detenida.");
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
      const descentContext = { hu: options.hu, issue: options.issue, repository: options.workingDirectory, sessionId };
      reportSessionEvent(
        "fallback_descent",
        `lazy-workflow: escalón ${describeRung(active)} agotado (${current.exhaustion.cause}); desciendo a ${describeRung(next.rung)}.`,
        next.rung,
        descentContext,
        { reason: current.exhaustion.cause, fromCli: active.cli },
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
      return failed ? 1 : 0;
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
    if (!isValidHu(options.hu)) {
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
      || !this.huInfoService.getCompletionManifestPath || !this.huInfoService.readCompletionManifest
      || !this.huInfoService.validateCompletionManifest || !this.huInfoService.getBranch
      || !this.huInfoService.validateEvidenceFile || !this.huInfoService.addAttachment
      || !this.huInfoService.setEvidence || !this.huInfoService.getState
      || !this.huInfoService.getEffort || !this.huInfoService.validateEvidence
      || !this.huInfoService.setHuState || !this.huInfoService.hasOpenDeliveryChildren
      || !this.huInfoService.getHuState
      || !this.huInfoService.getAutocodeContextForTicket || !this.huInfoService.getTicket
      || !this.huInfoService.getDescription || !this.huInfoService.getAttachments
      || !this.huInfoService.getEvidence || !this.huInfoService.validateDirectTicketContext
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
    if (checkpoint) {
      const adopted = this.adoptCheckpointCli(checkpoint.cli, options, checkpoint.handoffFrom);
      if (!adopted) return 1;
      options = adopted;
    }
    if (options.session !== null && (!checkpoint || checkpoint.sessionId !== options.session)) {
      reportAzureFailure("argument-error", "reconciling", options, "lazy-workflow: la sesión no coincide con el checkpoint workspace Azure fijado.", {}, "preserved");
      return 1;
    }
    const resolved = await this.resolveAzureWorkspaceTicket(hu, options, checkpoint);
    if ("exit" in resolved) return resolved.exit;
    const ticket = resolved.ticket;
    // Fail closed before any external effect: the recovered scope must be the same repositories,
    // in the same order, with the same remotes, for the same HU and ticket.
    if (checkpoint) {
      const mismatch = this.azureWorkspaceScopeMismatch(checkpoint, scope, hu, ticket);
      if (mismatch) {
        reportAzureFailure("workspace-scope-failure", "reconciling", options, `lazy-workflow: ${mismatch}; ejecución detenida.`, {}, "preserved");
        return 1;
      }
    }
    try {
      await boundary.validateDirectTicketContext!(hu, ticket);
      // Only the branch preparation below is a topology failure. The outer catch used to claim
      // every later failure was one too, which sent the operator looking at branches when what
      // had actually stopped the run was an evidence file at the far end of the delivery.
      let topology: AzureWorkspaceBranchTopology;
      let ticketTopology: AzureWorkspaceBranchTopology;
      try {
        topology = await this.huInfoService.prepareWorkspaceBranches({
          hu,
          repositories: scope.repositories.map(({ path, remote }) => ({ path, remote })),
          baseBranch: options.baseBranch,
        });
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
        await this.azureWorkspaceCheckpoint.write(checkpoint, scope.stateDirectory);
      }
      if (checkpoint.phase === "started" || checkpoint.phase === "implementing") {
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
        let execution: AgentExecution;
        // Both branches descend the same declared chain on provider exhaustion (ADR-0024):
        // a resume of a checkpointed session is not exempt just because it crosses an
        // invocation, so the callbacks are shared and every attempt is routed through the
        // same descent.
        const resumeFn = (sessionId: string, overrides: AgentResumeOverrides) =>
          this.codingAgent.resume(sessionId, markerResumePrompt(IMPLEMENTATION_READY_MARKER), scope.parentDirectory, IMPLEMENTATION_READY_MARKER, overrides);
        const onDescent = async (rung: FallbackRung, sessionId: string) => {
          activeCli = rung.cli;
          checkpoint = { ...checkpoint!, model: rung.model, variant: rung.variant, sessionId };
          await this.azureWorkspaceCheckpoint.write(checkpoint, scope.stateDirectory);
        };
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
            terminalMarker: IMPLEMENTATION_READY_MARKER,
          }, false);
          activeCli = rung.cli;
          checkpoint = {
            ...checkpoint!,
            cli: rung.cli,
            handoffFrom: checkpoint!.handoffFrom ?? options.cli,
            model: rung.model,
            variant: rung.variant,
            sessionId: handedOff.result.sessionId,
          };
          await this.azureWorkspaceCheckpoint.write(checkpoint, scope.stateDirectory);
          return handedOff;
        };
        if (resuming) {
          try {
            execution = {
              result: await this.codingAgent.resume(resuming, markerResumePrompt(IMPLEMENTATION_READY_MARKER), scope.parentDirectory, IMPLEMENTATION_READY_MARKER, getRecoveryOverrides(options, checkpoint)),
              azureLoginRequired: false,
              failed: false,
            };
          } catch (error) {
            if (!(error instanceof AgentExhaustionError)) throw error;
            execution = { result: error.result, azureLoginRequired: false, failed: true, exhaustion: error.exhaustion };
          }
        } else {
           const run = await this.azureWorkspacePrompt(options, hu, ticket, scope, topology, ticketTopology, true);
          if (!run) return 1;
          execution = await this.codingAgent.run({
            ...options,
            workingDirectory: scope.parentDirectory,
            ...run,
            session: null,
            terminalMarker: IMPLEMENTATION_READY_MARKER,
          }, true);
        }
        execution = await this.descendFallbackChain(options, execution, resumeFn, onDescent, handOff);
        const terminal = !execution.failed && containsMarker(execution.result.text, IMPLEMENTATION_READY_MARKER);
        checkpoint = {
          ...checkpoint,
          cli: activeCli,
          phase: terminal ? "implementation-ready" : "implementing",
          sessionId: terminal ? null : execution.result.sessionId,
          activeDurationMs: checkpoint.activeDurationMs + accrue(),
        };
        await this.azureWorkspaceCheckpoint.write(checkpoint, scope.stateDirectory);
        if (execution.failed) {
          reportAzureFailure("session-failure", "reconciling", options, `lazy-workflow: ${activeCli} falló durante la entrega workspace Azure (${errorMessage(execution.result.text)}); ejecución detenida.`, { sessionId: execution.result.sessionId }, "preserved");
          return 1;
        }
        if (!terminal) {
          reportAzureFailure("session-failure", "implementing", options, `lazy-workflow: la sesión ${activeCli} workspace Azure terminó sin ${IMPLEMENTATION_READY_MARKER}.`, { sessionId: execution.result.sessionId }, "preserved");
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
   * The delivery unit of an Azure workspace run. A surviving checkpoint pins it, an explicit
   * `--ticket` fixes it, and otherwise the run drains the HU's eligible children with the same
   * selection single-repository `code --hu` applies (ADR-0028).
   */
  private async resolveAzureWorkspaceTicket(
    hu: number,
    options: CliOptions,
    checkpoint: AzureWorkspaceCheckpoint | null,
  ): Promise<{ ticket: number } | { exit: number }> {
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
    if (!this.huInfoService.getAutocodeState) {
      reportAzureFailure("tracker-read-failure", "selecting", options, "El servicio Azure no expone la selección de tickets pendientes de la HU");
      return { exit: 1 };
    }
    let state: AutocodeState;
    try {
      state = await this.huInfoService.getAutocodeState(hu);
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
    // The session is told where every manifest goes instead of inferring it: the integration phase
    // only ever looks at these paths, so a guessed location reads as a repository with no changes.
    const [manifestPaths, context, description] = await Promise.all([
      Promise.all(scope.repositories.map(async ({ path }) => ({
        path,
        manifestPath: await this.huInfoService.getCompletionManifestPath!(path),
      }))),
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
        manifestPaths,
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
    const units: Array<{ path: string; manifestPath: string; manifest?: CompletionManifest; commit?: string; pullRequest?: number; mergeCommit?: string; changed: boolean }> = [];
    for (const repository of scope.repositories) {
      const manifestPath = await boundary.getCompletionManifestPath!(repository.path);
      const exists = await Bun.file(manifestPath).exists();
      if (!exists) {
        const status = await this.git(["status", "--porcelain", "--untracked-files=no"], repository.path);
        if (status.trim()) {
          reportAzureFailure("workspace-scope-failure", "evidencing", options, `lazy-workflow: el repositorio ${repository.path} quedó sucio sin manifest; ejecución detenida.`, { repository: repository.path }, "preserved");
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
          reportAzureFailure("manifest-not-verifiable", "evidencing", options, `lazy-workflow: el repositorio ${repository.path} tiene commits sin manifest verificable; ejecución detenida.`, { repository: repository.path }, "preserved");
          return 1;
        }
        units.push({ path: repository.path, manifestPath, changed: false });
        continue;
      }
      units.push({ path: repository.path, manifestPath, changed: true });
    }

    const changedUnits = units.filter((unit) => unit.changed);
    if (changedUnits.length === 0) {
      reportAzureFailure("delivery-failure", "evidencing", options, "lazy-workflow: el workspace no contiene cambios entregables; ejecución detenida.", {}, "preserved");
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
        reportAzureFailure("manifest-not-verifiable", "evidencing", options, `lazy-workflow: el manifest de ${unit.path} no es verificable (${errorMessage(error)}); ejecución detenida.`, { repository: unit.path }, "preserved");
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
      reportAzureFailure("branch-preparation-failure", "integrating", options, `lazy-workflow: no se pudo fijar la rama primaria del ticket (${errorMessage(error)}); ejecución detenida.`, {}, "preserved");
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

    // La evidencia que cierra el ticket es la del workspace entero, no la del primer repositorio.
    // Mirar solo `changedUnits[0]` dejaba sin adjuntar todo lo que los demás repositorios habían
    // declarado, y detenía la entrega como si no existiera una evidencia textual que viviera en el
    // segundo. Los manifests ya vienen leídos y verificados del bucle de arriba; aquí se revalidan
    // contra el ticket ya entregado, porque los merges adelantaron la rama.
    const completionInfo = await boundary.getTicketInfo!(hu, ticket);
    const workspaceEvidence: CompletionManifestEvidence[] = [];
    for (const unit of changedUnits) {
      await boundary.validateCompletionManifest!(unit.manifest!, completionInfo, ticket, unit.path);
      for (const evidence of unit.manifest!.evidence) {
        // Dos repositorios pueden declarar el mismo archivo; el ticket lo adjunta una sola vez.
        if (!workspaceEvidence.some(({ sha256 }) => sha256.toLowerCase() === evidence.sha256.toLowerCase())) {
          workspaceEvidence.push(evidence);
        }
      }
    }

    const ticketEffortBefore = await boundary.getEffort!(ticket);
    const baselineReal = ticketEffortBefore.effort.real ?? 0;
    const baselineRealHours = ticketEffortBefore.effort.realHours ?? 0;
    const ticketStateBefore = await boundary.getState!(ticket);

    for (const evidence of workspaceEvidence) {
      try {
        await boundary.validateEvidenceFile!(evidence.path, evidence.kind);
      } catch (error) {
        reportAzureFailure("evidence-not-verifiable", "evidencing", options, `lazy-workflow: la evidencia ${evidence.path} no es verificable (${errorMessage(error)}); ejecución detenida.`, { repository: evidence.path }, "preserved");
        return 1;
      }
    }

    // Un manifest sin evidencia textual ya no pasa `parseCompletionManifest`, así que esto solo
    // alcanza a manifests escritos antes de esa regla. Un ticket que ya carga completion-evidence no
    // necesita otra, que es lo que `applyTicketCompletion` sostiene para la ruta de repo único.
    const textEvidence = findTextEvidence(workspaceEvidence);
    if (!textEvidence && !completionInfo.completionEvidence) {
      reportAzureFailure("evidence-not-verifiable", "evidencing", options, "lazy-workflow: el manifest workspace no contiene evidencia textual para completion-evidence; ejecución detenida.", {}, "preserved");
      return 1;
    }
    if (textEvidence) {
      try {
        await boundary.validateEvidence!(ticket, textEvidence.path);
      } catch (error) {
        reportAzureFailure("evidence-not-verifiable", "evidencing", options, `lazy-workflow: la evidencia ${textEvidence.path} no es verificable (${errorMessage(error)}); ejecución detenida.`, { repository: textEvidence.path }, "preserved");
        return 1;
      }
    }

    for (const evidence of workspaceEvidence) {
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
    if (textEvidence && !refreshedInfo.completionEvidence) {
      await boundary.setEvidence!(ticket, textEvidence.path);
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
        reportAzureFailure("manifest-not-verifiable", "cleaning", options, `lazy-workflow: no se pudo escribir el manifest agregado del workspace (${errorMessage(error)}); el checkpoint se conservó.`, {}, "preserved");
        return 1;
      }
      // El manifest por repositorio es la señal de "hay algo que entregar", y
      // sobrevivirlo a su propia entrega hacía que la fase siguiente leyera como
      // pendiente un commit ya mergeado, sobre una rama de ticket que ya cerró.
      // Se retira junto con el checkpoint, como hace la ruta GitHub.
      for (const unit of units) await unlink(unit.manifestPath).catch(() => undefined);
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
      return failed ? 1 : 0;
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
        reportFailure("argument-error", "reconciling", { issue: existing?.issue, repository: options.workingDirectory, sessionId: options.session }, "lazy-workflow: la sesión no coincide con el checkpoint workspace fijado.");
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
      reportFailure("delivery-failure", "coordinating", { issue: undefined, repository: options.workingDirectory }, `lazy-workflow: no se pudo coordinar la entrega workspace (${errorMessage(error)})`);
      return 1;
    } finally {
      for (const release of releases.reverse()) await release();
    }
  }

  private async resumeWorkspaceCode(options: CliOptions, scope: WorkspaceScope, checkpoint: GitHubWorkspaceCheckpoint): Promise<number> {
    const expected = scope.repositories.map(({ path, remote, providerIdentity }) => ({ path, remote, repository: providerIdentity }));
    if (JSON.stringify(expected) !== JSON.stringify(checkpoint.repositories)
      || checkpoint.units.some((unit, index) => unit.path !== expected[index]?.path || unit.repository !== expected[index]?.repository)) {
      reportFailure("workspace-scope-failure", "reconciling", { issue: checkpoint.issue, repository: options.workingDirectory }, "lazy-workflow: el checkpoint workspace no coincide con el alcance declarado; ejecución detenida.");
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
        reportFailure("delivery-failure", "reconciling", { issue: checkpoint.issue, repository: options.workingDirectory }, `lazy-workflow: no se pudo reanudar la reconciliación workspace (${errorMessage(error)})`);
        return 1;
      }
    }
    if (checkpoint.sessionId) {
      try {
        const result = await this.codingAgent.resume(checkpoint.sessionId, markerResumePrompt(IMPLEMENTATION_READY_MARKER), scope.parentDirectory, IMPLEMENTATION_READY_MARKER, getResumeOverrides(options));
        reportOperator(JSON.stringify(result, null, 2));
        if (!containsMarker(result.text, IMPLEMENTATION_READY_MARKER)) return 1;
        checkpoint = { ...checkpoint, phase: "implementation-ready", sessionId: null };
        await this.githubWorkspaceCheckpoint.write(checkpoint, scope.stateDirectory);
      } catch (error) {
        reportFailure("session-failure", "reconciling", { issue: checkpoint.issue, repository: options.workingDirectory, sessionId: checkpoint.sessionId }, `lazy-workflow: no se pudo reanudar el workspace (${errorMessage(error)})`);
        return 1;
      }
    }
    if (checkpoint.phase === "selected") {
      const reread = this.githubManagedQueue.reconcileClaimedIssue ?? this.githubManagedQueue.readIssueDetail;
      if (!reread) {
        reportFailure("claim-verification-failure", "reconciling", { issue: checkpoint.issue, repository: options.workingDirectory }, "lazy-workflow: no se puede verificar el Issue fijado del workspace; ejecución detenida.");
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
        const status = await this.git(["status", "--porcelain", "--untracked-files=no"], unit.path);
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
        const since = oldestReceiptTimestamp(checkpoint.receipts) ?? "fecha desconocida";
        reportOperator(
          `lazy-workflow: el Issue #${checkpoint.issue} del checkpoint ya está cerrado sin PR asociado `
          + `(fase "${checkpoint.phase}", reclamado desde ${since}); `
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
      if (checkpoint) {
        const adopted = this.adoptCheckpointCli(checkpoint.cli, options, checkpoint.handoffFrom);
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
            reportFailure(
              "claim-verification-failure",
              "selected",
              { issue: selection.issue.number, repository: selection.repository.nameWithOwner },
              `lazy-workflow: no se pudo verificar el claim del Issue #${selection.issue.number} (${errorMessage(error)}); checkpoint conservado.`,
            );
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
      /**
       * Escrito mientras un traspaso tiene el trabajo en otro CLI, y en cada
       * checkpoint que la unidad deje atrás hasta cerrarla: es lo que deja al
       * comando original reanudar su propio trabajo (issue #252).
       */
      const handoffOrigin = (): { handoffFrom?: AgentCli } => activeCli === options.cli ? {} : { handoffFrom: options.cli };
      const saveCheckpoint = async (phase: GitHubDeliveryCheckpoint["phase"], sessionId: string | null = null): Promise<void> => {
        if (store) await store.write({
          schemaVersion: 2,
          cli: activeCli,
          ...handoffOrigin(),
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
          reportFailure(
            "branch-preparation-failure",
            "started",
            { issue: issue.number, repository: repository.nameWithOwner },
            `lazy-workflow: no se pudo preparar la rama del Issue #${issue.number} (${errorMessage(error)}); checkpoint conservado.`,
          );
          return 1;
        }
      }
      // ADR-0020 superseded the uncoordinated shape: without a coordinator-owned
      // delivery adapter, branch, and manifest there is no delivery contract to
      // state, so the run fails closed instead of starting a session that cannot
      // be completed deterministically.
      if (!this.githubDelivery || !branch || !manifestPath) {
        reportFailure(
          "delivery-failure",
          "started",
          { issue: issue.number, repository: repository.nameWithOwner, branch },
          `lazy-workflow: falta el adaptador de entrega GitHub, la rama o el manifest del Issue #${issue.number}; no se inicia una sesion sin contrato de entrega.`,
        );
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
            markerResumePrompt(IMPLEMENTATION_READY_MARKER),
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
              baseBranch: baseBranch!,
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
        const reconcilingSessionId = error instanceof AgentSessionNotFoundError ? null : activeSessionId ?? execution?.result.sessionId ?? null;
        await saveCheckpoint("reconciling", reconcilingSessionId);
        reportFailure(
          "session-failure",
          "reconciling",
          { issue: issue.number, repository: repository.nameWithOwner, branch, sessionId: reconcilingSessionId },
          `lazy-workflow: la sesion GitHub fallo (${errorMessage(error)}); checkpoint conservado.`,
        );
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
        reportFailure(
          "session-failure",
          "reconciling",
          { issue: issue.number, repository: repository.nameWithOwner, branch, sessionId: result.sessionId },
          `lazy-workflow: la sesión GitHub falló (${errorMessage(result.text)}); checkpoint conservado.`,
        );
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
        }, false);
        return 1;
      }

      if (this.githubDelivery) {
        if (!terminal) {
          reportFailure(
            "session-failure",
            "implementation-ready",
            { issue: issue.number, repository: repository.nameWithOwner, branch },
            `lazy-workflow: la sesión GitHub terminó sin ${IMPLEMENTATION_READY_MARKER}.`,
          );
          return 1;
        }
        try {
          await this.completeGitHubDelivery(options, {
            schemaVersion: 2,
            cli: activeCli,
            ...handoffOrigin(),
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
          reportFailure(
            githubCompletionFailureKind(error),
            "implementation-ready",
            { issue: issue.number, repository: repository.nameWithOwner, branch },
            `lazy-workflow: no se pudo completar determinísticamente el Issue #${issue.number} (${errorMessage(error)}); checkpoint conservado.`,
          );
          return 1;
        }
      }
      if (!terminal) {
        reportFailure(
          "session-failure",
          "implementation-ready",
          { issue: issue.number, repository: repository.nameWithOwner, branch },
          `lazy-workflow: la sesión GitHub terminó sin ${IMPLEMENTATION_READY_MARKER}.`,
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
      baseBranch: string;
      manifestPath: string;
      norms: SagContext | null;
    },
  ): Promise<{ execution: AgentExecution; agent: AgentAuthority }> {
    const handoffOptions: CliOptions = { ...options, cli: rung.cli, model: rung.model, variant: rung.variant };
    const run = await this.prompt(
      { kind: "github-delivery", issue: work.issue, repository: work.repository, branch: work.branch, manifestPath: work.manifestPath },
      handoffOptions,
      work.norms,
      await this.verifiedProgress(options.workingDirectory, "implementing", work.issue.number, work.branch, work.baseBranch, work.manifestPath),
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
   * and what the repository itself answers about this unit — never what belongs
   * to another delivery. A commit that does not exist yet, an unreadable
   * worktree, or a manifest never written (or written by another delivery) are
   * all absences the section names rather than failures that stop the handoff.
   */
  private async verifiedProgress(
    workingDirectory: string,
    phase: GitHubDeliveryPhase,
    issue: number,
    branch: string,
    baseBranch: string,
    manifestPath: string,
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
      phase,
      branch,
      // Only what the unit's branch holds over that base is progress of this
      // delivery; a bare `log -1` would answer the base tip instead. An empty
      // range — or a branch with no commits yet, which makes `log` fail — is the
      // absence the section states.
      commit: await readGit(["log", "-1", "--format=%H %s", `${base}..${branch}`]),
      uncommitted: await readGit(["status", "--porcelain", "--untracked-files=no"]) ?? "",
      // The manifest path is fixed per repository, so one left by an earlier
      // delivery is only this unit's progress when it names this issue and branch.
      manifest: await manifestBelongsToDelivery(manifestPath, issue, branch)
        ? await Bun.file(manifestPath).text().catch(() => null)
        : null,
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
    const manifest = await this.readGitHubManifest(delivery, context.manifestPath, context.workingDirectory);
    if (manifest.issue !== context.issue
      || manifest.branch !== context.branch
      || (context.requireEvidence && !manifest.evidence?.length)) {
      throw new GitHubManifestNotVerifiableError(`El manifest reconciliado de ${context.workingDirectory} no es verificable`);
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
        if (error instanceof GitHubPullRequestConflictError) throw error;
        const failureKind: FailureKind = name === "parent-reconciliation"
          ? "parent-reconciliation-failure"
          : name === "pull-request" || name === "merge"
            ? "pull-request-failure"
            : "deterministic-completion-failure";
        throw new GitHubCoordinatedFailureError(failureKind, errorMessage(error), { cause: error });
      }
    };

    let manifest = await this.readGitHubManifest(delivery, fixedManifestPath, options.workingDirectory);
    if (manifest.issue !== checkpoint.issue || manifest.branch !== fixedBranch) {
      throw new GitHubManifestNotVerifiableError("El manifest no coincide con el Issue o la rama fijados");
    }
    if (checkpoint.commit !== null && checkpoint.commit !== manifest.commit) {
      throw new GitHubManifestNotVerifiableError("El commit del manifest cambió respecto al checkpoint fijado");
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

  private async readGitHubManifest(
    delivery: GitHubDeliveryAdapter,
    path: string,
    workingDirectory: string,
  ): Promise<GitHubReadyManifest> {
    try {
      return await delivery.readManifest(path, workingDirectory);
    } catch (error) {
      throw new GitHubManifestNotVerifiableError(errorMessage(error), { cause: error });
    }
  }

  private reportGitHubReconciliationRequired(checkpoint: GitHubDeliveryCheckpoint, emitFailure = true): void {
    console.log(JSON.stringify({
      outcome: RECONCILIATION_REQUIRED_MARKER,
      issue: checkpoint.issue,
      phase: checkpoint.phase,
    }, null, 2));
    if (emitFailure) {
      reportFailure(
        "reconciliation-required",
        checkpoint.phase,
        { issue: checkpoint.issue, repository: checkpoint.repository, sessionId: checkpoint.sessionId, branch: checkpoint.branch },
        `lazy-workflow: el Issue #${checkpoint.issue} conserva un checkpoint GitHub en fase ${checkpoint.phase}; requiere reconciliacion.`,
      );
    }
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
      let release: () => Promise<void>;
      try {
        release = await lock.acquire(options.workingDirectory);
      } catch (error) {
        reportFailure(
          "lock-unavailable",
          checkpoint.phase,
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
    try {
      let recoveryCheckpoint: GitHubDeliveryCheckpoint | null;
      try {
        recoveryCheckpoint = await store.read(options.workingDirectory);
      } catch (error) {
        throw new GitHubCoordinatedFailureError("checkpoint-unreadable", errorMessage(error), { cause: error });
      }
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
      this.reportGitHubReconciliationRequired(preserved, false);
      reportFailure(
        error instanceof GitHubCoordinatedFailureError ? error.failureKind : "branch-preparation-failure",
        "started",
        { issue: checkpoint.issue, repository: checkpoint.repository },
        `lazy-workflow: no se pudo preparar la rama fijada del Issue #${checkpoint.issue} (${errorMessage(error)}); checkpoint conservado.`,
      );
      return 1;
    }
    if (this.githubDelivery && checkpoint.sessionId === null && checkpoint.phase === "started") {
      try {
        let liveCheckpoint: GitHubDeliveryCheckpoint | null;
        try {
          liveCheckpoint = await store.read(options.workingDirectory);
        } catch (error) {
          throw new GitHubCoordinatedFailureError("checkpoint-unreadable", errorMessage(error), { cause: error });
        }
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
        let issue: SelectedManagedIssue;
        try {
          issue = await readIssue(liveCheckpoint.issue, options.workingDirectory);
        } catch (error) {
          throw new GitHubCoordinatedFailureError("claim-verification-failure", errorMessage(error), { cause: error });
        }
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
          reportFailure(
            "session-failure",
            "implementing",
            { issue: liveCheckpoint.issue, repository: liveCheckpoint.repository, branch, sessionId: execution.result.sessionId },
            `lazy-workflow: la sesión GitHub terminó sin ${IMPLEMENTATION_READY_MARKER}; checkpoint conservado.`,
          );
          this.reportGitHubReconciliationRequired({ ...liveCheckpoint, phase: "implementing", sessionId: execution.result.sessionId }, false);
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
          this.reportGitHubReconciliationRequired({ ...preserved, phase: "started", sessionId: null }, false);
        reportFailure(
          githubRecoveryFailureKind(error),
          "started",
          { issue: checkpoint.issue, repository: checkpoint.repository },
          `lazy-workflow: no se pudo reanudar el Issue #${checkpoint.issue} (${errorMessage(error)}); checkpoint conservado.`,
        );
        return 1;
      }
    }
    if (this.githubDelivery && checkpoint.phase === "conflict-resolving") {
      let release: (() => Promise<void>) | null = null;
      try {
        if (!lockAlreadyHeld) {
          try {
            release = await lock.acquire(options.workingDirectory);
          } catch (error) {
            throw new GitHubCoordinatedFailureError("lock-unavailable", errorMessage(error), { cause: error });
          }
        }
        let liveCheckpoint: GitHubDeliveryCheckpoint | null;
        try {
          liveCheckpoint = await store.read(options.workingDirectory);
        } catch (error) {
          throw new GitHubCoordinatedFailureError("checkpoint-unreadable", errorMessage(error), { cause: error });
        }
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
        this.reportGitHubReconciliationRequired({ ...current, phase: "conflict-resolving" }, false);
        reportFailure(
          error instanceof GitHubCoordinatedFailureError
            ? error.failureKind
            : error instanceof GitHubManifestNotVerifiableError || error instanceof GitHubPullRequestConflictError
              ? githubCompletionFailureKind(error)
              : "pull-request-failure",
          "conflict-resolving",
          { issue: checkpoint.issue, repository: checkpoint.repository },
          `lazy-workflow: no se pudo reconciliar el conflicto del Issue #${checkpoint.issue} (${errorMessage(error)}); checkpoint conservado.`,
        );
        return 1;
      } finally {
        if (release) await release();
      }
    }
    if (this.githubDelivery && checkpoint.sessionId === null && ["implementation-ready", "integrating", "reconciling", "cleaning"].includes(checkpoint.phase)) {
      try {
        let liveCheckpoint: GitHubDeliveryCheckpoint | null;
        try {
          liveCheckpoint = await store.read(options.workingDirectory);
        } catch (error) {
          throw new GitHubCoordinatedFailureError("checkpoint-unreadable", errorMessage(error), { cause: error });
        }
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
        this.reportGitHubReconciliationRequired({ ...preserved, phase: "reconciling", sessionId: null }, false);
        reportFailure(
          githubRecoveryFailureKind(error),
          "reconciling",
          { issue: checkpoint.issue, repository: checkpoint.repository },
          `lazy-workflow: no se pudo reconciliar el Issue #${checkpoint.issue} (${errorMessage(error)}); checkpoint conservado.`,
        );
        return 1;
      }
    }
    if (!checkpoint.sessionId || options.session !== checkpoint.sessionId) {
      if (checkpoint.sessionId !== options.session) {
        console.log(JSON.stringify({ outcome: RECONCILIATION_REQUIRED_MARKER, issue: checkpoint.issue, phase: checkpoint.phase }, null, 2));
        reportFailure(
          "argument-error",
          checkpoint.phase,
          { issue: checkpoint.issue, repository: checkpoint.repository, sessionId: options.session },
          "lazy-workflow: la sesión GitHub no coincide con el checkpoint fijado.",
        );
      }
      else this.reportGitHubReconciliationRequired(checkpoint);
      return 1;
    }
    const reconcileClaimedIssue = queue.reconcileClaimedIssue?.bind(queue);
    if (!reconcileClaimedIssue) {
      this.reportGitHubReconciliationRequired(checkpoint);
      reportFailure(
        "claim-verification-failure",
        checkpoint.phase,
        { issue: checkpoint.issue, repository: checkpoint.repository },
        "lazy-workflow: el coordinador no puede verificar el claim del Issue; checkpoint conservado.",
      );
      return 1;
    }

    let release: (() => Promise<void>) | null = null;
    try {
      if (!lockAlreadyHeld) {
        try {
          release = await lock.acquire(options.workingDirectory);
        } catch (error) {
          throw new GitHubCoordinatedFailureError("lock-unavailable", errorMessage(error), { cause: error });
        }
      }
      let liveCheckpoint: GitHubDeliveryCheckpoint | null;
      try {
        liveCheckpoint = await store.read(options.workingDirectory);
      } catch (error) {
        throw new GitHubCoordinatedFailureError("checkpoint-unreadable", errorMessage(error), { cause: error });
      }
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
      let issue: SelectedManagedIssue;
      try {
        issue = await reconcileClaimedIssue(liveCheckpoint.issue, options.workingDirectory);
      } catch (error) {
        throw new GitHubCoordinatedFailureError("claim-verification-failure", errorMessage(error), { cause: error });
      }
      if (issue.number !== liveCheckpoint.issue) throw new Error("el checkpoint GitHub no coincide con el issue recuperado");
      const norms = await this.loadSagNorms(options, "coding");
      if (options.normasSag && norms === null) return 1;
      const repository: GitHubRepositoryContext = { nameWithOwner: liveCheckpoint.repository };
      let activeCli = liveCheckpoint.cli;
      let execution: AgentExecution;
      try {
        execution = {
          result: await this.codingAgent.resume(
            liveCheckpoint.sessionId,
            "continue",
            options.workingDirectory,
            IMPLEMENTATION_READY_MARKER,
            getRecoveryOverrides(options, liveCheckpoint),
          ),
          azureLoginRequired: false,
          failed: false,
        };
      } catch (error) {
        if (!(error instanceof AgentExhaustionError)) throw error;
        execution = { result: error.result, azureLoginRequired: false, failed: true, exhaustion: error.exhaustion };
      }
      // Provider exhaustion descends the declared chain here too (ADR-0024): a resume across
      // invocations is not exempt from the descent a fresh session gets.
      execution = await this.descendFallbackChain(
        options,
        execution,
        (descentSessionId, overrides) => this.codingAgent.resume(descentSessionId, "continue", options.workingDirectory, IMPLEMENTATION_READY_MARKER, overrides),
        async (rung, descentSessionId) => {
          activeCli = rung.cli;
          await store.write({ ...liveCheckpoint, cli: rung.cli, model: rung.model, variant: rung.variant, sessionId: descentSessionId }, options.workingDirectory);
        },
        async (rung) => {
          if (!liveCheckpoint.branch || !liveCheckpoint.baseBranch || !liveCheckpoint.manifestPath) {
            throw new Error("el checkpoint GitHub no contiene la rama y el manifest fijados");
          }
          const handedOff = await this.handOffGitHubDelivery(options, rung, {
            issue,
            repository,
            branch: liveCheckpoint.branch,
            baseBranch: liveCheckpoint.baseBranch,
            manifestPath: liveCheckpoint.manifestPath,
            norms,
          });
          activeCli = rung.cli;
          await store.write({
            ...liveCheckpoint,
            cli: rung.cli,
            handoffFrom: liveCheckpoint.handoffFrom ?? options.cli,
            model: rung.model,
            variant: rung.variant,
            sessionId: handedOff.execution.result.sessionId,
          }, options.workingDirectory);
          return handedOff.execution;
        },
      );
      const result = execution.result;
      console.log(JSON.stringify(result, null, 2));
      const terminal = !execution.failed && containsMarker(result.text, IMPLEMENTATION_READY_MARKER);
      await store.write({ ...liveCheckpoint, cli: activeCli, phase: execution.failed ? "reconciling" : (terminal ? "implementation-ready" : "implementing"), sessionId: terminal ? null : result.sessionId }, options.workingDirectory);
      if (execution.failed) {
        this.reportGitHubReconciliationRequired({ ...liveCheckpoint, cli: activeCli, phase: "reconciling", sessionId: result.sessionId }, false);
        reportFailure(
          "session-failure",
          "reconciling",
          { issue: liveCheckpoint.issue, repository: liveCheckpoint.repository, sessionId: result.sessionId },
          `lazy-workflow: no se pudo reanudar el Issue #${liveCheckpoint.issue} (${errorMessage(result.text)}); checkpoint conservado.`,
        );
        return 1;
      }
      if (this.githubDelivery) {
        if (!liveCheckpoint.branch || !liveCheckpoint.baseBranch) throw new Error("el checkpoint GitHub no contiene la rama fijada");
        await this.githubDelivery.verifyBranch?.(liveCheckpoint.branch, liveCheckpoint.baseBranch, options.workingDirectory);
        if (!terminal) {
          reportFailure(
            "session-failure",
            "implementing",
            { issue: liveCheckpoint.issue, repository: liveCheckpoint.repository, sessionId: result.sessionId },
            `lazy-workflow: la sesión GitHub terminó sin ${IMPLEMENTATION_READY_MARKER}; checkpoint conservado.`,
          );
          this.reportGitHubReconciliationRequired({ ...liveCheckpoint, cli: activeCli, phase: "implementing", sessionId: result.sessionId }, false);
          return 1;
        }
        await this.completeGitHubDelivery(options, { ...liveCheckpoint, cli: activeCli, phase: "implementation-ready", sessionId: null });
        console.log(TICKET_COMPLETED_MARKER);
        console.log(WORKFLOW_STEP_FINISHED_MARKER);
        return 0;
      }
      if (!terminal) {
        reportFailure(
          "session-failure",
          "implementing",
          { issue: liveCheckpoint.issue, repository: liveCheckpoint.repository, sessionId: result.sessionId },
          `lazy-workflow: la sesión GitHub terminó sin ${IMPLEMENTATION_READY_MARKER}.`,
        );
        this.reportGitHubReconciliationRequired({ ...liveCheckpoint, cli: activeCli, phase: "implementing", sessionId: terminal ? null : result.sessionId }, false);
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
      this.reportGitHubReconciliationRequired(reconciledCheckpoint, false);
      reportFailure(
        githubRecoveryFailureKind(error),
        "reconciling",
        { issue: currentCheckpoint.issue, repository: currentCheckpoint.repository, sessionId },
        `lazy-workflow: no se pudo reanudar el Issue #${currentCheckpoint.issue} (${errorMessage(error)}); checkpoint conservado.`,
      );
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
  private async runPlanningSession(
    spec: WorkflowPromptSpec,
    options: CliOptions,
    norms: SagContext | null,
    run: WorkflowRun,
    workingDirectory: string,
  ): Promise<{ result: AgentResult; failed: boolean }> {
    const prompted = await this.prompt(spec, options, norms);

    // Built before the session opens: an unusable port, a missing terminal or an
    // unwritable directory is then an argument-shaped failure that costs no model
    // usage, and the channel's address is already printed while the agent thinks.
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
      let turn: PlanTurn;
      try {
        turn = readPlanTurn(result.text);
      } catch (error) {
        reportFailure("session-failure", "planning", { hu: options.hu, issue: options.issue, repository: workingDirectory, sessionId: result.sessionId }, `lazy-workflow: la ronda de preguntas no se pudo leer (${errorMessage(error)}); ejecución detenida.`);
        return { result, failed: true };
      }
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

  private async runDeployment(options: CliOptions, environment: DeploymentEnvironment, authenticationRetried = false): Promise<number> {
    if (!this.sagNormsService.loadDeployment) {
      reportFailure("delivery-failure", "deploying", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "lazy-workflow: el servicio SAG no soporta deploy-sag");
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
        reportAzureFailure("deployment-authentication-required", "authenticating", options, `Sesion de deployment detenida; autenticacion requerida para la HU ${options.hu}.`);
        await this.huInfoService.waitForAccess(options.hu);
        return this.runDeployment(options, environment, true);
      }
      reportFailure(
        options.hu !== null && (error instanceof DeploymentAuthenticationRequiredError || isAuthenticationError(error))
          ? "deployment-authentication-required"
          : "delivery-failure",
        "deploying",
        { hu: options.hu, issue: options.issue, repository: options.workingDirectory },
        `lazy-workflow: no se pudo ejecutar deploy-sag (${deploymentErrorMessage(error)}); ejecucion detenida.`,
      );
      return 1;
    }
  }

  private async runInfrastructure(options: CliOptions, authenticationRetried = false): Promise<number> {
    if (!this.sagNormsService.loadInfrastructure) {
      reportFailure("delivery-failure", "verifying", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "lazy-workflow: el servicio SAG no soporta infra-sag");
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
        reportAzureFailure("infrastructure-authentication-required", "authenticating", options, `Sesion de infraestructura detenida; autenticacion requerida para la HU ${options.hu}.`);
        await this.huInfoService.waitForAccess(options.hu);
        return this.runInfrastructure(options, true);
      }
      reportFailure(
        options.hu !== null && (error instanceof InfrastructureAuthenticationRequiredError || isAuthenticationError(error))
          ? "infrastructure-authentication-required"
          : "delivery-failure",
        "verifying",
        { hu: options.hu, issue: options.issue, repository: options.workingDirectory },
        `lazy-workflow: no se pudo ejecutar infra-sag (${deploymentErrorMessage(error)}); ejecucion detenida.`,
      );
      return 1;
    }
  }

  private async runArchitectureReview(options: CliOptions): Promise<number> {
    if (!this.sagNormsService.loadArchitectureReview) {
      reportFailure("delivery-failure", "reviewing", { hu: options.hu, issue: options.issue, repository: options.workingDirectory }, "lazy-workflow: el servicio SAG no soporta architecture-review-sag");
      return 1;
    }
    try {
      const initialStatus = await this.git(["status", "--porcelain", "--untracked-files=no"], options.workingDirectory);
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
      const finalStatus = await this.git(["status", "--porcelain", "--untracked-files=no"], options.workingDirectory);
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
      reportFailure(
        "delivery-failure",
        "reviewing",
        { hu: options.hu, issue: options.issue, repository: options.workingDirectory },
        `lazy-workflow: no se pudo ejecutar architecture-review-sag (${errorMessage(error)}); ejecucion detenida.`,
      );
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
        interview: options.interview.channel !== "off",
        progress,
      }),
      agent: this.authority(spec, options.cli),
    };
  }

  private async runTicketRead(command: string, options: CliOptions): Promise<number> {
    if (options.ticket === null || !Number.isInteger(options.ticket) || options.ticket <= 0) {
      reportAzureFailure("argument-error", "validating", options, `${command} requiere --ticket <id> con un entero positivo`);
      return 1;
    }
    const ticket = options.ticket;
    const needsHu = command === "ticket-info" || command === "ticket-branch-info"
      || command === "ticket-pr-info" || command === "ticket-completion-info";
    if (needsHu && !isValidHu(options.hu)) {
      reportAzureFailure("argument-error", "validating", options, `${command} requiere --hu <id>`);
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
      reportAzureFailure("tracker-read-failure", "reading", options, `lazy-workflow: no se pudo consultar ${command} (${errorMessage(error)})`);
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
    let manifest: CompletionManifest;
    try {
      manifest = await this.huInfoService.readCompletionManifest(options.manifest!, options.workingDirectory);
      await this.huInfoService.validateCompletionManifest(manifest, info, options.ticket!, options.workingDirectory);
    } catch (error) {
      throw new AzureCoordinatedFailureError("manifest-not-verifiable", errorMessage(error), { cause: error });
    }

    const unreconcilableGates = info.gates.unmet.filter((gate) =>
      gate === COMPLETION_GATE.realEffort
      || gate === COMPLETION_GATE.realEffortHours
    );
    if (unreconcilableGates.length > 0) {
      throw new Error(`No se puede completar el ticket ${options.ticket}; faltan datos previos: ${unreconcilableGates.join(", ")}`);
    }

    for (const evidence of manifest.evidence) {
      try {
        await this.huInfoService.validateEvidenceFile(evidence.path, evidence.kind);
      } catch (error) {
        throw new AzureCoordinatedFailureError("evidence-not-verifiable", errorMessage(error), { cause: error });
      }
    }
    const textEvidence = manifest.evidence.find(({ kind }) => kind !== "screen");
    const completionEvidenceMissing = !info.completionEvidence;
    if (!textEvidence && completionEvidenceMissing) {
      throw new Error("El manifest no contiene evidencia textual para completion-evidence");
    }
    if (textEvidence) {
      try {
        await this.huInfoService.validateEvidence(options.ticket!, textEvidence.path);
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
    try {
      const manifest = await this.huInfoService.readCompletionManifest(manifestPath, workingDirectory);
      await this.huInfoService.validateCompletionManifest(manifest, info, ticket, workingDirectory);
      return manifest;
    } catch (error) {
      throw new AzureCoordinatedFailureError("manifest-not-verifiable", errorMessage(error), { cause: error });
    }
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
          if (!checkpoint.manifestPath) {
            reportAzureFailure("manifest-not-verifiable", "reconciling", options, `lazy-workflow: el ticket ${checkpoint.ticket} tiene un PR canónico, pero falta su manifest; checkpoint sessionless conservado.`, { ticket: checkpoint.ticket }, "preserved");
            return 1;
          }
        }
      } catch (error) {
        reportAzureFailure("pull-request-failure", "reconciling", options, `lazy-workflow: no se pudo reconciliar el PR canónico del ticket ${checkpoint.ticket} (${errorMessage(error)}); ejecución detenida.`, { ticket: checkpoint.ticket }, "preserved");
        return 1;
      }
    }

    if ((checkpoint.phase === "implementing" || checkpoint.phase === "reconciling") && checkpoint.ticket !== null && checkpoint.sessionId === null && !checkpoint.manifestPath) {
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

    if (checkpoint.ticket !== null && checkpoint.sessionId === null && checkpoint.manifestPath
      && this.huInfoService.checkoutTicketBranch && this.huInfoService.pushTicketBranch && this.huInfoService.createOrReusePullRequest && this.huInfoService.getTicketInfo && this.huInfoService.setEffort
      && this.huInfoService.getAutocodeContextForTicket && checkpoint.ticketBranch) {
      const context = await this.huInfoService.getAutocodeContextForTicket(hu, checkpoint.ticket, integrationBranch);
      if (!context) {
        reportUnmetCompletion(checkpoint.ticket, { ticketId: checkpoint.ticket, unmetGates: [COMPLETION_GATE.pinnedTicketContext] }, options);
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
    if (checkpoint.receipts["ticket-state"] && stateInfo.state !== "En progreso" && stateInfo.state !== "In Progress") {
      reportAzureFailure("manifest-mismatch", "reconciling", options, `lazy-workflow: el recibo de estado del ticket ${ticket} no coincide con Azure; ejecución detenida.`, { ticket }, "preserved");
      return 1;
    }
    if (checkpoint.receipts["ticket-branch"] && existingBranch?.branch !== ticketBranch) {
      reportAzureFailure("manifest-mismatch", "reconciling", options, `lazy-workflow: el recibo de rama del ticket ${ticket} no coincide con Azure; ejecución detenida.`, { ticket }, "preserved");
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
    let activeCli = checkpoint.cli;
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
        const execution = await track(null, async () => {
          // Both a fresh session and a resume of a checkpointed one descend the same declared
          // chain on provider exhaustion (ADR-0024): crossing an invocation or a turn is not an
          // exemption, so the callbacks are shared and every attempt routes through one descent.
          const resumeFn = (descentSessionId: string, overrides: AgentResumeOverrides) =>
            this.codingAgent.resume(descentSessionId, authoritativeResumePrompt, options.workingDirectory, IMPLEMENTATION_READY_MARKER, overrides);
          const onDescent = async (rung: FallbackRung, descentSessionId: string) => {
            activeCli = rung.cli;
            checkpoint = { ...checkpoint, model: rung.model, variant: rung.variant, sessionId: descentSessionId };
            await save();
          };
          const handOff = async (rung: FallbackRung) => {
            const handoffOptions: CliOptions = { ...options, cli: rung.cli, model: rung.model, variant: rung.variant };
            const handoffRun = await this.prompt({
              kind: "azure-delivery",
              context,
              ticketBranch,
              evidenceDirectory: manifestPath ? dirname(manifestPath) : null,
              manifestPath,
              workflowPhase: checkpoint.phase,
              completionGates: Object.values(COMPLETION_GATE),
            }, handoffOptions, norms);
            this.resolveAgent(rung.cli);
            const handedOff = await this.codingAgent.run({
              ...handoffOptions,
              ...handoffRun,
              session: null,
              terminalMarker: IMPLEMENTATION_READY_MARKER,
            }, false);
            activeCli = rung.cli;
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
                result: await this.codingAgent.resume(sessionId, authoritativeResumePrompt, options.workingDirectory, IMPLEMENTATION_READY_MARKER, { ...getRecoveryOverrides(options, checkpoint), agent: run.agent }),
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
              terminalMarker: IMPLEMENTATION_READY_MARKER,
            }, true);
          }
          return await this.descendFallbackChain(options, started, resumeFn, onDescent, handOff);
        });
        sessionId = execution.result.sessionId;
        checkpoint = { ...checkpoint, cli: activeCli };
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
              reportAzureFailure(azureFailureKind(error, "deterministic-completion-failure"), "reconciling", options, `lazy-workflow: no se pudo completar determinísticamente el ticket ${ticket} después del marcador (${errorMessage(error)}); checkpoint conservado.`, { ticket }, "preserved");
              return 1;
            }
          }
          reportAzureFailure("deterministic-completion-failure", "completing", options, `lazy-workflow: el coordinador no expone todas las primitivas de completion para el ticket ${ticket}; ejecución detenida.`, { ticket }, "preserved");
          return 1;
        }
        if (execution.failed) throw new Error(`la sesión ${options.cli} termino con error`);
        await this.retryTimer.wait(10_000);
        resumePrompt = options.prompt;
      } catch (error) {
        if (error instanceof AgentSessionNotFoundError || error instanceof AgentSessionCloseError) {
          checkpoint = { ...checkpoint, phase: "reconciling", sessionId: null, activeSince: null, intent: null };
          await save();
          reportAzureFailure("session-failure", "reconciling", options, `lazy-workflow: la sesión ${error.sessionId} no está disponible; checkpoint sessionless conservado para reconciliación.`, { ticket, sessionId: error.sessionId }, "preserved");
          return 1;
        }
        reportAzureFailure("session-failure", "implementing", options, `lazy-workflow: la sesión ${options.cli} falló (${errorMessage(error)}); conservaré el checkpoint y reintentaré en 10s.`, { ticket }, "preserved");
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
    try {
      await this.ticketBranchCleaner.deleteTicketBranch(verifiedTicketBranch, context.integrationBranch, workingDirectory);
    } catch (error) {
      throw new AzureCoordinatedFailureError("ticket-branch-cleanup-failure", errorMessage(error), { cause: error });
    }
    reportOperator(`lazy-workflow: rama completada ${verifiedTicketBranch} eliminada local y remotamente.`);
  }
}
