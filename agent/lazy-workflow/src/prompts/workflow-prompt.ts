/**
 * Workflow prompt: the single place that decides what OpenCode is told.
 *
 * The coordinator hands this module the facts it has already fixed (workflow
 * kind, HU, ticket, issue, branches, manifest paths, repository order) and gets
 * back the prompt. Fragment order, contract text, and marker vocabulary live
 * here and in `prompts/`; they are no longer restated at each call site.
 */

import type { HuInfo } from "../azure/hu-info.ts";
import type { AutocodeContext, AzureWorkspaceBranchTopology, CompletionGate } from "../azure/autocode-service.ts";
import type { GitHubRepositoryContext, SelectedManagedIssue } from "../github/managed-queue-service.ts";
import type { GitHubWorkspaceUnit } from "../github/github-workspace-checkpoint.ts";
import type { SagArchitectureReviewContext, SagCodingContext, SagNormsContext } from "../sag/sag-norms-service.ts";
import type { WorkspaceScope } from "../workspace/repository-scope.ts";
import type { QuestionAnswers } from "../interaction/question-round.ts";
import {
  IMPLEMENTATION_READY_MARKER,
  QUESTIONS_ANSWERED_MARKER,
  QUEUE_BLOCKED_MARKER,
  QUEUE_EMPTY_MARKER,
  TICKET_COMPLETED_MARKER,
  WORKFLOW_STEP_FINISHED_MARKER,
  azureManifestCommandLine,
  githubManifestCommandLine,
  renderContract,
} from "./workflow-contract.ts";

type PromptAsset =
  | "github-scope"
  | "github-plan"
  | "github-code"
  | "autoplan"
  | "autocode"
  | "architecture-review-sag"
  | "plan-interview-auto"
  | "plan-interview-interactive"
  | "plan-interview-answers";

export type SagContext = SagNormsContext | SagCodingContext;

/**
 * The provider an invocation resolves exactly once, in the vocabulary
 * `CONTEXT.md` already defines: an Azure HU run or a GitHub repository run.
 * Every branch that used to reinspect `--hu` reads this instead.
 */
export type WorkflowRun =
  | { readonly kind: "github-repository-run" }
  | { readonly kind: "azure-hu-run"; readonly hu: number };

/** Resolve the invocation's provider once, from the raw `--hu` CLI value. */
export function resolveWorkflowRun(hu: number | null): WorkflowRun {
  return hu === null ? { kind: "github-repository-run" } : { kind: "azure-hu-run", hu };
}

export type WorkflowPromptSpec =
  | { kind: "github-plan" }
  | { kind: "azure-plan"; huInfo: HuInfo }
  | { kind: "workspace-plan"; scope: WorkspaceScope; run: WorkflowRun; huInfo: HuInfo | null }
  | {
      kind: "github-delivery";
      issue: SelectedManagedIssue;
      repository: GitHubRepositoryContext;
      branch: string;
      manifestPath: string;
    }
  | {
      kind: "github-reconciliation";
      issue: SelectedManagedIssue;
      repository: GitHubRepositoryContext;
      branch: string;
      manifestPath: string;
      pullRequest: number;
      originalCommit: string;
      baseCommit: string;
    }
  | { kind: "github-workspace-delivery"; scope: WorkspaceScope; issue: SelectedManagedIssue | null; units: GitHubWorkspaceUnit[] }
  | {
      kind: "azure-workspace-delivery";
      scope: WorkspaceScope;
      hu: number | null;
      ticket: number | null;
      /** What the ticket asks for. The coordinator reads it before opening the session, because the
       * session is forbidden from selecting or inferring its own work. */
      context: AutocodeContext;
      description: string | null;
      topology: AzureWorkspaceBranchTopology;
      ticketTopology: AzureWorkspaceBranchTopology;
      /** Where each participant must write its manifest. The coordinator resolves these, never the session. */
      manifestPaths: Array<{ path: string; manifestPath: string }>;
    }
  | {
      kind: "azure-delivery";
      context: AutocodeContext;
      ticketBranch: string | null;
      evidenceDirectory: string | null;
      manifestPath: string | null;
      workflowPhase: string;
      completionGates: CompletionGate[];
    }
  | { kind: "architecture-review-sag"; scope: unknown; context: SagArchitectureReviewContext };

export interface WorkflowPromptContext {
  /** The supplemental operator request. Never authoritative over coordinator facts. */
  operatorRequest: string;
  /** The directory the run was scoped to. Workspace runs override it with the parent directory. */
  workingDirectory: string;
  /** Phase-selected SAG norms, when the run loaded them. */
  norms?: SagContext | null;
  /** Question budget for the planning workflows. */
  questions?: number;
  /**
   * Whether an operator is reachable to answer this planning run's questions.
   * The two branches are separate assets rather than conditional prose, so the
   * session is never told both policies and left to pick one.
   */
  interview?: boolean;
  /** Set only when this prompt hands the same fixed work to a session in another CLI. */
  progress?: HandoffProgress | null;
}

/**
 * What a cross-CLI handoff can state about the work already done, and only that:
 * the checkpoint phase and everything readable from the repository itself. The
 * outgoing session's own account of what it did never enters here, because an
 * exhausted account cannot be asked and its prose is not verifiable (ADR-0025).
 */
export interface HandoffProgress {
  phase: string;
  branch: string;
  /** The HEAD commit of the fixed branch, or null when nothing was committed yet. */
  commit: string | null;
  /** `git status --porcelain` of the worktree, empty when it is clean. */
  uncommitted: string;
  /** The completion manifest already on disk, when the outgoing session wrote one. */
  manifest: string | null;
}

/** The progress section a handed-off session starts from, appended to its own workflow prompt. */
export function formatHandoffProgress(progress: HandoffProgress): string {
  const uncommitted = progress.uncommitted.trim();
  return [
    "Traspaso entre agentes: esta unidad de trabajo ya está en curso y el estado siguiente está verificado en el repositorio.",
    "Continúa desde este estado; no reimplementes lo que ya está hecho ni descartes lo que ya está commiteado.",
    `Fase del checkpoint: ${progress.phase}`,
    `Rama fijada: ${progress.branch}`,
    `Último commit: ${progress.commit ?? "todavía no hay commits en la rama"}`,
    uncommitted ? `Archivos sin commitear:\n${uncommitted}` : "El árbol de trabajo no tiene cambios sin commitear.",
    progress.manifest
      ? `Completion manifest ya escrito:\n${progress.manifest}`
      : "Todavía no hay completion manifest escrito.",
  ].join("\n");
}

function readAsset(name: PromptAsset): Promise<string> {
  return Bun.file(new URL(`../../prompts/${name}-prompt.md`, import.meta.url)).text();
}

/** Load a prompt asset and resolve its contract placeholders. */
export async function readPromptAsset(name: PromptAsset): Promise<string> {
  return renderContract(await readAsset(name));
}

/**
 * The GitHub scope paragraph plus exactly the selected workflow's instructions.
 * The coordinator has already chosen; OpenCode never receives the other branch.
 */
async function githubWorkflow(workflow: "plan" | "code"): Promise<string[]> {
  return [
    await readPromptAsset("github-scope"),
    `Selected workflow: ${workflow}`,
    await readPromptAsset(workflow === "plan" ? "github-plan" : "github-code"),
  ];
}

/**
 * How this planning run answers its own questions. Every planning branch —
 * GitHub, Azure, workspace — appends exactly one of the two, so the policy is
 * stated once per run and never twice.
 */
function planInterviewSection(interview: boolean | undefined): Promise<string> {
  return readPromptAsset(interview ? "plan-interview-interactive" : "plan-interview-auto");
}

/**
 * The resume prompt of an answered round: the static reading instructions, the
 * marker, and the payload. The marker is composed here from the contract rather
 * than written into the asset, exactly as the delivery prompts do.
 */
export async function buildInterviewAnswersPrompt(
  answers: QuestionAnswers,
  remainingRounds: number,
): Promise<string> {
  return [
    await readPromptAsset("plan-interview-answers"),
    remainingRounds > 0
      ? `Quedan ${remainingRounds} ronda(s) de preguntas si aún necesitas decidir algo con el operador.`
      : "No quedan rondas de preguntas: entrega el plan final ahora, sin abrir otra ronda.",
    QUESTIONS_ANSWERED_MARKER,
    JSON.stringify(answers),
  ].join("\n");
}

/** The issue facts OpenCode needs, and only those. */
function issueContext(issue: SelectedManagedIssue): string {
  return JSON.stringify({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    labels: issue.labels.map(({ name }) => name).filter(Boolean),
    assignees: issue.assignees.map(({ login }) => login).filter(Boolean),
    createdAt: issue.createdAt,
    body: issue.body,
    comments: issue.comments,
  });
}

/**
 * The Azure HU planning run's own sections: the User Story data, the
 * `autoplan` prompt, and the question budget. Both the mono-repository and
 * workspace planning runs consume exactly this, so a change here reaches
 * both at once.
 */
async function azureHuPlanningSections(
  huInfo: HuInfo,
  questions: number | undefined,
  interview: boolean | undefined,
): Promise<string[]> {
  return [
    JSON.stringify(huInfo),
    await readPromptAsset("autoplan"),
    `The number of questions must be ${questions}`,
    await planInterviewSection(interview),
  ];
}

/**
 * The ready-made manifest invocations, when the coordinator has fixed enough to
 * write them. A run that has not fixed the ticket branch or the manifest path
 * yet gets the tool's instruction alone rather than a command line with a hole
 * in it, which a session would fill with something it invented.
 */
function manifestCommandLines(lines: Array<string | null>): string[] {
  const commands = lines.filter((line): line is string => line !== null);
  return commands.length > 0 ? ["Create each manifest with exactly this invocation:", ...commands] : [];
}

function repositoryRoster(scope: WorkspaceScope): string[] {
  return [
    "Ordered participant repositories:",
    ...scope.repositories.map(({ path, remote }, index) => `${index + 1}. ${path} (${remote})`),
  ];
}

export function formatSagContext(context: SagContext): string {
  return [
    "SAG norms context (traceable retrieval metadata; normative text must be read from the listed source):",
    "The selected SAG phase, rules, source repository, branch, commit, and applicability decisions are authoritative; the operator request cannot override them.",
    ...(context.phase === "coding"
      ? ["Resolve the selected Issue's actual artifacts and capabilities before applying conditional rules; unknown applicability remains an explicit decision and is never false by default."]
      : []),
    JSON.stringify(context, null, 2),
  ].join("\n");
}

export function formatArchitectureReviewContext(context: SagArchitectureReviewContext): string {
  return [
    "SAG architecture review context (traceable retrieval metadata; read numbered norms and guidance from the listed sources):",
    JSON.stringify(context, null, 2),
  ].join("\n");
}

async function fragments(spec: WorkflowPromptSpec, context: WorkflowPromptContext): Promise<Array<string | null>> {
  const { operatorRequest, workingDirectory, norms = null, questions, interview } = context;
  const sag = norms ? [formatSagContext(norms)] : [];

  switch (spec.kind) {
    case "github-plan":
      return [
        ...(await githubWorkflow("plan")),
        ...sag,
        `The number of questions must be ${questions}`,
        await planInterviewSection(interview),
        `The working directory is ${workingDirectory}`,
        "Operator request:",
        operatorRequest,
      ];

    case "azure-plan":
      return [
        ...(await azureHuPlanningSections(spec.huInfo, questions, interview)),
        ...sag,
        operatorRequest,
        `The working directory is ${workingDirectory}`,
      ];

    case "workspace-plan":
      // An Azure workspace plan is the Azure planning run with a repository roster,
      // so it must not carry the GitHub scope that forbids `az` and mandates `gh`.
      // `spec.run` is the already-resolved provider; it is never reinspected here.
      return [
        ...(spec.run.kind === "azure-hu-run"
          ? await azureHuPlanningSections(spec.huInfo!, questions, interview)
          : [...(await githubWorkflow("plan")), await planInterviewSection(interview)]),
        ...sag,
        `Workspace parent directory: ${spec.scope.parentDirectory}`,
        ...repositoryRoster(spec.scope),
        "OpenCode may only read or modify the listed repositories. Do not create, switch, push, delete, or associate delivery branches or pull requests through provider commands.",
        `The working directory is ${spec.scope.parentDirectory}`,
        "Operator request:",
        operatorRequest,
      ];

    case "github-delivery": {
      const { issue, repository, branch, manifestPath } = spec;
      return [
        ...(await githubWorkflow("code")),
        `Coordinator-fixed repository: ${repository.nameWithOwner}`,
        "Coordinator-fixed issue context:",
        issueContext(issue),
        `The coordinator owns queue outcomes; do not print ${QUEUE_EMPTY_MARKER} or ${QUEUE_BLOCKED_MARKER}.`,
        `Coordinator-fixed issue branch: ${branch}`,
        `Write the ${IMPLEMENTATION_READY_MARKER} manifest to: ${manifestPath}`,
        // The instruction itself arrives with the `github-code` asset; what the
        // spec adds is the invocation with this unit's identities already in it.
        ...manifestCommandLines([githubManifestCommandLine({ issue: issue.number, branch, manifestPath, workingDirectory })]),
        `The only successful terminal marker is ${IMPLEMENTATION_READY_MARKER}; do not print ${TICKET_COMPLETED_MARKER} or ${WORKFLOW_STEP_FINISHED_MARKER}.`,
        ...sag,
        `The working directory is ${workingDirectory}`,
        "Operator request:",
        operatorRequest,
      ];
    }

    case "github-reconciliation": {
      const { issue, repository, branch, manifestPath, pullRequest, originalCommit, baseCommit } = spec;
      const delivery = await fragments(
        { kind: "github-delivery", issue, repository, branch, manifestPath },
        { ...context, norms: null },
      );
      return [
        delivery.filter((line): line is string => line !== null).join("\n"),
        "Reconcile the existing pull request conflict. This is not a new issue implementation.",
        `Coordinator-fixed pull request: #${pullRequest}`,
        `Original implementation commit: ${originalCommit}`,
        `Coordinator-fetched base commit: ${baseCommit}`,
        `Merge exactly ${baseCommit} into ${branch}; resolve every conflict while preserving both the fixed Issue requirements and already integrated base changes.`,
        "Do not rebase, reset, force-push, switch branches, select another issue, or mutate GitHub.",
        `Run relevant validation, create the merge commit, run the manifest tool again so the manifest names the new HEAD, then emit ${IMPLEMENTATION_READY_MARKER}.`,
      ];
    }

    case "github-workspace-delivery":
      return [
        ...(await githubWorkflow("code")),
        ...(spec.issue ? ["Coordinator-fixed issue context:", issueContext(spec.issue)] : []),
        `Workspace parent directory: ${spec.scope.parentDirectory}`,
        ...repositoryRoster(spec.scope),
        ...(spec.units.length > 0
          ? ["Immutable delivery paths:", ...spec.units.map(({ path, branch, manifestPath }) => `${path}: branch ${branch}, manifest ${manifestPath}`)]
          : []),
        "OpenCode may only read or modify the listed repositories. Do not create, switch, push, delete, or associate delivery branches or pull requests through provider commands.",
        "Work through repositories serially in the declared order, committing each changed repository independently.",
        "Each changed repository must end with a manifest carrying at least one in-repository evidence path.",
        ...manifestCommandLines(spec.issue
          ? spec.units.map(({ path, branch, manifestPath }) =>
              githubManifestCommandLine({ issue: spec.issue!.number, branch, manifestPath, workingDirectory: path }))
          : []),
        `The working directory is ${spec.scope.parentDirectory}`,
        "Operator request:",
        operatorRequest,
      ];

    case "azure-workspace-delivery":
      // The workspace variant of the Azure ticket delivery run: same authority
      // boundary as the single-repository run, widened to a repository roster.
      return [
        await readPromptAsset("autocode"),
        // The asset's last line opens with `HU and ticket context:`, and this is the fragment that
        // fills it -- the same slot `azure-delivery` fills below. Leaving it to the identity lines
        // told the session which ticket it was on and nothing about what the ticket asked for, and
        // a session forbidden from selecting its own work can only refuse.
        JSON.stringify(spec.context),
        ...(spec.description ? ["Ticket description:", spec.description] : []),
        "Selected workflow: code",
        `Coordinator-fixed HU: ${spec.hu}`,
        `Coordinator-fixed ticket: ${spec.ticket}`,
        `Coordinator-fixed integration branch: ${spec.topology.integrationBranch}`,
        `Coordinator-fixed ticket branch: ${spec.ticketTopology.ticketBranch ?? null}`,
        `Workspace parent directory: ${spec.scope.parentDirectory}`,
        ...repositoryRoster(spec.scope),
        // The contract promises the coordinator supplies the manifest path, so it has to name it:
        // a session left to infer one writes a manifest the integration phase never finds.
        ...(spec.manifestPaths.length > 0
          ? ["Immutable manifest paths:", ...spec.manifestPaths.map(({ path, manifestPath }) => `${path}: manifest ${manifestPath}`)]
          : []),
        "Each participant repository must end with a manifest at exactly its listed path including at least one evidence entry, and at least one of the workspace's evidence entries must be http-json or command-output; unchanged repositories must end clean.",
        ...manifestCommandLines(spec.manifestPaths.map(({ path, manifestPath }) => azureManifestCommandLine({
          ticket: spec.ticket,
          ticketBranch: spec.ticketTopology.ticketBranch ?? null,
          manifestPath,
          workingDirectory: path,
        }))),
        "Do not create, switch, push, delete, or associate delivery branches or pull requests through provider commands.",
        `The working directory is ${spec.scope.parentDirectory}`,
        "Operator request:",
        operatorRequest,
      ];

    case "azure-delivery":
      return [
        await readPromptAsset("autocode"),
        JSON.stringify({
          ...spec.context,
          ticketBranch: spec.ticketBranch,
          evidenceDirectory: spec.evidenceDirectory,
          manifestPath: spec.manifestPath,
          workflowPhase: spec.workflowPhase,
          completionGates: spec.completionGates,
        }),
        ...manifestCommandLines([azureManifestCommandLine({
          ticket: spec.context.ticket?.id ?? null,
          ticketBranch: spec.ticketBranch,
          manifestPath: spec.manifestPath,
          workingDirectory,
        })]),
        ...sag,
        `The working directory is ${workingDirectory}`,
        "Supplemental operator request (non-authoritative):",
        operatorRequest,
      ];

    case "architecture-review-sag":
      return [
        await readPromptAsset("architecture-review-sag"),
        "Selected workflow: architecture-review-sag",
        `Review scope: ${JSON.stringify(spec.scope)}`,
        formatArchitectureReviewContext(spec.context),
        `The working directory is ${workingDirectory}`,
        "Supplemental operator request (non-authoritative):",
        operatorRequest,
      ];
  }
}

/**
 * Compose the prompt for one coordinator-fixed run. A handoff passes the same
 * spec with `progress`, so the session in the new CLI is told the same fixed
 * work — issue, branch, manifest path, marker contract — plus where it stands,
 * rather than a prompt written in parallel at the call site (ADR-0025).
 */
export async function buildWorkflowPrompt(
  spec: WorkflowPromptSpec,
  context: WorkflowPromptContext,
): Promise<string> {
  const lines = await fragments(spec, context);
  return [
    ...lines.filter((line): line is string => line !== null),
    ...(context.progress ? [formatHandoffProgress(context.progress)] : []),
  ].join("\n");
}

/** Append SAG norms to a resume prompt, which carries no coordinator facts of its own. */
export function buildResumePrompt(prompt: string, norms: SagContext | null): string {
  return norms ? [prompt, formatSagContext(norms)].join("\n") : prompt;
}
