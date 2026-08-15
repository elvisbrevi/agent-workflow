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
import {
  IMPLEMENTATION_READY_MARKER,
  MANIFEST_VALIDATION_SHAPE,
  QUEUE_BLOCKED_MARKER,
  QUEUE_EMPTY_MARKER,
  TICKET_COMPLETED_MARKER,
  WORKFLOW_STEP_FINISHED_MARKER,
  renderContract,
} from "./workflow-contract.ts";

type PromptAsset =
  | "github-scope"
  | "github-plan"
  | "github-code"
  | "autoplan"
  | "autocode"
  | "architecture-review-sag";

export type SagContext = SagNormsContext | SagCodingContext;

export type WorkflowPromptSpec =
  | { kind: "github-plan" }
  | { kind: "azure-plan"; huInfo: HuInfo }
  | { kind: "workspace-plan"; scope: WorkspaceScope; huInfo: HuInfo | null }
  | {
      kind: "github-delivery";
      issue: SelectedManagedIssue;
      repository: GitHubRepositoryContext;
      branch: string;
      manifestPath: string;
    }
  /**
   * The pre-ADR-0020 shape: a fixed issue with no coordinator-owned branch or
   * manifest, so there is no delivery contract to state. Kept explicit — rather
   * than as a silent fallback off the delivery prompt — so the missing contract
   * is a visible decision instead of an accident.
   */
  | { kind: "github-code-uncoordinated"; issue: SelectedManagedIssue; repository: GitHubRepositoryContext }
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
      topology: AzureWorkspaceBranchTopology;
      ticketTopology: AzureWorkspaceBranchTopology;
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
  const { operatorRequest, workingDirectory, norms = null, questions } = context;
  const sag = norms ? [formatSagContext(norms)] : [];

  switch (spec.kind) {
    case "github-plan":
      return [
        ...(await githubWorkflow("plan")),
        ...sag,
        `The number of questions must be ${questions}`,
        `The working directory is ${workingDirectory}`,
        "Operator request:",
        operatorRequest,
      ];

    case "azure-plan":
      return [
        JSON.stringify(spec.huInfo),
        await readPromptAsset("autoplan"),
        ...sag,
        `The number of questions must be ${questions}`,
        operatorRequest,
        `The working directory is ${workingDirectory}`,
      ];

    case "workspace-plan":
      // An Azure workspace plan is the Azure planning run with a repository roster,
      // so it must not carry the GitHub scope that forbids `az` and mandates `gh`.
      return [
        ...(spec.huInfo
          ? [JSON.stringify(spec.huInfo), await readPromptAsset("autoplan"), `The number of questions must be ${questions}`]
          : await githubWorkflow("plan")),
        ...sag,
        `Workspace parent directory: ${spec.scope.parentDirectory}`,
        ...repositoryRoster(spec.scope),
        "OpenCode may only read or modify the listed repositories. Do not create, switch, push, delete, or associate delivery branches or pull requests through provider commands.",
        `The working directory is ${spec.scope.parentDirectory}`,
        "Operator request:",
        operatorRequest,
      ];

    case "github-code-uncoordinated":
      return [
        ...(await githubWorkflow("code")),
        `Coordinator-fixed repository: ${spec.repository.nameWithOwner}`,
        "Coordinator-fixed issue context:",
        issueContext(spec.issue),
        ...sag,
        `The working directory is ${workingDirectory}`,
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
        `The manifest JSON must contain issue ${issue.number}, branch ${branch}, the exact HEAD commit, a non-empty validation array, clean=true, and a non-empty summary.`,
        MANIFEST_VALIDATION_SHAPE,
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
        `Run relevant validation, create the merge commit, replace the manifest with the exact new HEAD, then emit ${IMPLEMENTATION_READY_MARKER}.`,
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
        "Each changed repository must write a manifest with at least one in-repository evidence path and its SHA-256 digest.",
        MANIFEST_VALIDATION_SHAPE,
        `The working directory is ${spec.scope.parentDirectory}`,
        "Operator request:",
        operatorRequest,
      ];

    case "azure-workspace-delivery":
      // The workspace variant of the Azure ticket delivery run: same authority
      // boundary as the single-repository run, widened to a repository roster.
      return [
        await readPromptAsset("autocode"),
        "Selected workflow: code",
        `Coordinator-fixed HU: ${spec.hu}`,
        `Coordinator-fixed ticket: ${spec.ticket}`,
        `Coordinator-fixed integration branch: ${spec.topology.integrationBranch}`,
        `Coordinator-fixed ticket branch: ${spec.ticketTopology.ticketBranch ?? null}`,
        `Workspace parent directory: ${spec.scope.parentDirectory}`,
        ...repositoryRoster(spec.scope),
        "Each participant repository must end with a manifest at the per-repo completion-manifest path including at least one evidence entry; unchanged repositories must end clean.",
        MANIFEST_VALIDATION_SHAPE,
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

/** Compose the prompt for one coordinator-fixed run. */
export async function buildWorkflowPrompt(
  spec: WorkflowPromptSpec,
  context: WorkflowPromptContext,
): Promise<string> {
  const lines = await fragments(spec, context);
  return lines.filter((line): line is string => line !== null).join("\n");
}

/** Append SAG norms to a resume prompt, which carries no coordinator facts of its own. */
export function buildResumePrompt(prompt: string, norms: SagContext | null): string {
  return norms ? [prompt, formatSagContext(norms)].join("\n") : prompt;
}
