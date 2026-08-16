/**
 * The deterministic tools, run as commands of their own (ADR-0026).
 *
 * Every operation here already existed as a step some workflow performs: the
 * GitHub queue reads and claims, the delivery branch and pull request effects,
 * the git branch deletion, and the Azure reads and mutations the ticket commands
 * did not yet expose. None of them opens a session, so each one answers with the
 * JSON its adapter returned and an exit code, and an operator can run the same
 * step the workflow would have run.
 *
 * The boundaries stay injectable, exactly as the workflow's do, so a test drives
 * these commands without `gh`, `az` or `git` on the host.
 */

import { GitTicketBranchCleaner } from "../git/git-ticket-branch-cleaner.ts";
import {
  GitHubDeliveryService,
  type GitHubBranchPreparation,
  type GitHubPullRequest,
  type GitHubReadyManifest,
} from "../github/github-delivery-service.ts";
import {
  GitHubManagedQueueService,
  classifyQueueIssues,
  evaluateEligibility,
  orderEligibleManagedIssues,
  type GitHubAuthenticatedIdentity,
  type GitHubRepositoryContext,
  type ManagedIssue,
  type ManagedQueueSelection,
  type SelectedManagedIssue,
} from "../github/managed-queue-service.ts";
import { reportOperator } from "../output/operator-output.ts";
import type { AzurePullRequestTarget } from "../azure/autocode-service.ts";
import { isDeterministicToolCommand, type DeterministicToolCommand } from "./tool-commands.ts";
import type { CliOptions } from "./parse-cli-options.ts";

export { isDeterministicToolCommand, type DeterministicToolCommand };

/** The GitHub queue operations a tool command drives. */
export interface GitHubQueueTools {
  verifyAuthentication(workingDirectory: string): Promise<GitHubAuthenticatedIdentity>;
  verifyRepository(workingDirectory: string): Promise<GitHubRepositoryContext>;
  listManagedIssues(workingDirectory: string): Promise<ManagedIssue[]>;
  readIssueDetail(issue: number, workingDirectory: string): Promise<SelectedManagedIssue>;
  selectEligibleIssue(workingDirectory: string): Promise<ManagedQueueSelection>;
  claimSelectedIssue(issue: number, workingDirectory: string): Promise<SelectedManagedIssue>;
  releaseOwnClaim(issue: number, login: string, workingDirectory: string): Promise<void>;
}

/** The GitHub delivery operations a tool command drives. */
export interface GitHubDeliveryTools {
  prepareBranch(issue: number, workingDirectory: string): Promise<GitHubBranchPreparation>;
  checkoutBranch(branch: string, baseBranch: string, workingDirectory: string): Promise<void>;
  verifyBranch(branch: string, baseBranch: string, workingDirectory: string): Promise<void>;
  cleanupBranch(branch: string, baseBranch: string, commit: string, workingDirectory: string): Promise<void>;
  readManifest(path: string, workingDirectory: string): Promise<GitHubReadyManifest>;
  pushCommit(branch: string, commit: string, workingDirectory: string): Promise<void>;
  createOrReusePullRequest(issue: number, branch: string, baseBranch: string, commit: string, workingDirectory: string): Promise<GitHubPullRequest>;
  mergePullRequest(pullRequest: number, issue: number, branch: string, baseBranch: string, commit: string, workingDirectory: string): Promise<GitHubPullRequest & { mergeCommit: string }>;
  closeIssue(issue: number, pullRequest: number, mergeCommit: string, workingDirectory: string): Promise<void>;
}

export interface GitBranchTools {
  deleteTicketBranch(ticketBranch: string, integrationBranch: string, workingDirectory: string, expectedRemoteCommit?: string): Promise<void>;
}

/**
 * The Azure operations these commands expose. Every one is optional for the same
 * reason the workflow's boundary makes them optional: an injected boundary
 * implements what its test needs, and a command that finds its own operation
 * missing says so instead of failing obscurely.
 */
export interface AzureToolBoundary {
  getHuChildren?(hu: number): Promise<Array<{ id: number; type: string; state: string; title?: string }>>;
  setHuState?(hu: number, desiredState: string, expectedState: string, expectedRevision: number): Promise<{ hu: number; state: string; revision: number }>;
  ensureIntegrationBranch?(hu: number, workingDirectory: string, baseBranch?: string | null): Promise<string | null>;
  getTicket?(ticket: number): Promise<{ id: number; type: "Task" | "Bug" }>;
  createOrReusePullRequest?(hu: number, ticket: number, participant?: AzurePullRequestTarget): Promise<{ pullRequest: number; mergeCommit: string }>;
  pushTicketBranch?(branch: string, workingDirectory: string): Promise<void>;
  checkoutTicketBranch?(branch: string, workingDirectory: string): Promise<void>;
}

export interface DeterministicToolServices {
  azure: AzureToolBoundary;
  queue: GitHubQueueTools;
  delivery: GitHubDeliveryTools;
  branches: GitBranchTools;
}

/** The concrete adapters, built only when a tool command is actually run. */
export function createDeterministicToolServices(azure: AzureToolBoundary): DeterministicToolServices {
  return {
    azure,
    queue: new GitHubManagedQueueService(),
    delivery: new GitHubDeliveryService(),
    branches: new GitTicketBranchCleaner(),
  };
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * A ref the delivery and git adapters accept. They compare against
 * `refs/heads/<name>`, and an operator types the branch name, so the short form
 * is completed here rather than rejected there.
 */
export function toBranchRef(branch: string): string {
  return branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
}

class MissingArgument extends Error {}

function requirePositive(value: number | null, flag: string, command: string): number {
  if (value === null || !Number.isInteger(value) || value <= 0) {
    throw new MissingArgument(`${command} requiere ${flag} con un entero positivo`);
  }
  return value;
}

function requireText(value: string | null, flag: string, command: string): string {
  const text = value?.trim();
  if (!text) throw new MissingArgument(`${command} requiere ${flag}`);
  return text;
}

function requireBranchRef(value: string | null, flag: string, command: string): string {
  return toBranchRef(requireText(value, flag, command));
}

function requireOperation<T>(operation: T | undefined, command: string): NonNullable<T> {
  if (!operation) throw new MissingArgument(`El servicio no soporta ${command}`);
  return operation as NonNullable<T>;
}

/**
 * The eligibility of the managed queue, as the workflow itself computes it, so
 * `github-issue-list` answers the question the operator actually has: which
 * issues a `code` run would take, and why it would skip the rest.
 */
function describeQueue(issues: ManagedIssue[]): unknown {
  const { eligible, blocked } = classifyQueueIssues(issues);
  return {
    managed: issues.length,
    eligible: orderEligibleManagedIssues(eligible).map(({ number, title, createdAt }) => ({ number, title, createdAt })),
    blocked,
    issues: issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      reasons: evaluateEligibility(issue),
    })),
  };
}

async function runAzureTool(
  command: DeterministicToolCommand,
  options: CliOptions,
  azure: AzureToolBoundary,
): Promise<unknown> {
  if (command === "hu-children-info") {
    const hu = requirePositive(options.hu, "--hu <id>", command);
    const children = await requireOperation(azure.getHuChildren, command)(hu);
    return { hu, children };
  }
  if (command === "hu-state-set") {
    const hu = requirePositive(options.hu, "--hu <id>", command);
    const state = requireText(options.state, "--state <state>", command);
    const expectedState = requireText(options.expectedState, "--expected-state <state>", command);
    if (!options.hasExpectedRevision) throw new MissingArgument(`${command} requiere --expected-rev <rev>`);
    return requireOperation(azure.setHuState, command)(hu, state, expectedState, options.expectedRevision);
  }
  if (command === "hu-branch-ensure") {
    const hu = requirePositive(options.hu, "--hu <id>", command);
    const branch = await requireOperation(azure.ensureIntegrationBranch, command)(
      hu,
      options.workingDirectory,
      options.baseBranch,
    );
    return { hu, branch };
  }
  if (command === "ticket-type-info") {
    const ticket = requirePositive(options.ticket, "--ticket <id>", command);
    return requireOperation(azure.getTicket, command)(ticket);
  }
  if (command === "ticket-pr-create") {
    const hu = requirePositive(options.hu, "--hu <id>", command);
    const ticket = requirePositive(options.ticket, "--ticket <id>", command);
    const pullRequest = await requireOperation(azure.createOrReusePullRequest, command)(hu, ticket);
    return { hu, ticket, ...pullRequest };
  }
  if (command === "ticket-branch-push") {
    const branch = requireText(options.branch, "--branch <name>", command);
    await requireOperation(azure.pushTicketBranch, command)(branch, options.workingDirectory);
    return { branch, pushed: true };
  }
  // ticket-branch-checkout
  const branch = requireText(options.branch, "--branch <name>", command);
  await requireOperation(azure.checkoutTicketBranch, command)(branch, options.workingDirectory);
  return { branch, checkedOut: true };
}

async function runGitHubTool(
  command: DeterministicToolCommand,
  options: CliOptions,
  services: DeterministicToolServices,
): Promise<unknown> {
  const { queue, delivery } = services;
  const workingDirectory = options.workingDirectory;

  if (command === "github-auth-info") return queue.verifyAuthentication(workingDirectory);
  if (command === "github-repo-info") return queue.verifyRepository(workingDirectory);
  if (command === "github-issue-list") return describeQueue(await queue.listManagedIssues(workingDirectory));
  if (command === "github-issue-select") return queue.selectEligibleIssue(workingDirectory);
  if (command === "github-issue-info") {
    const issue = requirePositive(options.issue, "--issue <id>", command);
    const detail = await queue.readIssueDetail(issue, workingDirectory);
    return { ...detail, reasons: evaluateEligibility(detail) };
  }
  if (command === "github-issue-claim") {
    const issue = requirePositive(options.issue, "--issue <id>", command);
    return queue.claimSelectedIssue(issue, workingDirectory);
  }
  if (command === "github-issue-release") {
    const issue = requirePositive(options.issue, "--issue <id>", command);
    // Only the run's own claim may be released, so the identity comes from the
    // authenticated user rather than from a flag.
    const { login } = await queue.verifyAuthentication(workingDirectory);
    await queue.releaseOwnClaim(issue, login, workingDirectory);
    return { issue, released: true, login };
  }
  if (command === "github-issue-close") {
    const issue = requirePositive(options.issue, "--issue <id>", command);
    const pullRequest = requirePositive(options.pullRequest, "--pr <id>", command);
    const commit = requireText(options.commit, "--commit <sha>", command);
    await delivery.closeIssue(issue, pullRequest, commit, workingDirectory);
    return { issue, pullRequest, mergeCommit: commit, closed: true };
  }
  if (command === "github-branch-prepare") {
    const issue = requirePositive(options.issue, "--issue <id>", command);
    return delivery.prepareBranch(issue, workingDirectory);
  }
  if (command === "github-branch-checkout" || command === "github-branch-verify") {
    const branch = requireBranchRef(options.branch, "--branch <name>", command);
    const baseBranch = requireBranchRef(options.baseBranch, "--base-branch <name>", command);
    if (command === "github-branch-checkout") {
      await delivery.checkoutBranch(branch, baseBranch, workingDirectory);
      return { branch, baseBranch, checkedOut: true };
    }
    await delivery.verifyBranch(branch, baseBranch, workingDirectory);
    return { branch, baseBranch, verified: true };
  }
  if (command === "github-branch-cleanup") {
    const branch = requireBranchRef(options.branch, "--branch <name>", command);
    const baseBranch = requireBranchRef(options.baseBranch, "--base-branch <name>", command);
    const commit = requireText(options.commit, "--commit <sha>", command);
    await delivery.cleanupBranch(branch, baseBranch, commit, workingDirectory);
    return { branch, baseBranch, commit, removed: true };
  }
  if (command === "github-manifest-info") {
    const manifest = requireText(options.manifest, "--manifest <path>", command);
    return delivery.readManifest(manifest, workingDirectory);
  }
  if (command === "github-commit-push") {
    const branch = requireBranchRef(options.branch, "--branch <name>", command);
    const commit = requireText(options.commit, "--commit <sha>", command);
    await delivery.pushCommit(branch, commit, workingDirectory);
    return { branch, commit, pushed: true };
  }
  if (command === "github-pr-create") {
    const issue = requirePositive(options.issue, "--issue <id>", command);
    const branch = requireBranchRef(options.branch, "--branch <name>", command);
    const baseBranch = requireBranchRef(options.baseBranch, "--base-branch <name>", command);
    const commit = requireText(options.commit, "--commit <sha>", command);
    const pullRequest = await delivery.createOrReusePullRequest(issue, branch, baseBranch, commit, workingDirectory);
    return { issue, branch, baseBranch, commit, ...pullRequest };
  }
  // github-pr-merge
  const pullRequest = requirePositive(options.pullRequest, "--pr <id>", command);
  const issue = requirePositive(options.issue, "--issue <id>", command);
  const branch = requireBranchRef(options.branch, "--branch <name>", command);
  const baseBranch = requireBranchRef(options.baseBranch, "--base-branch <name>", command);
  const commit = requireText(options.commit, "--commit <sha>", command);
  return delivery.mergePullRequest(pullRequest, issue, branch, baseBranch, commit, workingDirectory);
}

async function runGitTool(
  command: DeterministicToolCommand,
  options: CliOptions,
  branches: GitBranchTools,
): Promise<unknown> {
  const branch = requireBranchRef(options.branch, "--branch <name>", command);
  const baseBranch = requireBranchRef(options.baseBranch, "--base-branch <name>", command);
  await branches.deleteTicketBranch(branch, baseBranch, options.workingDirectory, options.commit ?? undefined);
  return { branch, baseBranch, ...(options.commit ? { commit: options.commit } : {}), removed: true };
}

/**
 * Runs one deterministic tool and prints what its adapter answered. A missing
 * argument and a failed operation are both reported the way every other
 * sessionless command reports them, so the exit code is the whole contract.
 */
export async function runDeterministicTool(
  command: DeterministicToolCommand,
  options: CliOptions,
  services: DeterministicToolServices,
  print: (line: string) => void = console.log,
): Promise<number> {
  try {
    const result = command.startsWith("github-")
      ? await runGitHubTool(command, options, services)
      : command.startsWith("git-")
        ? await runGitTool(command, options, services.branches)
        : await runAzureTool(command, options, services.azure);
    print(JSON.stringify(result ?? null, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof MissingArgument) {
      reportOperator(error.message);
      return 1;
    }
    reportOperator(`lazy-workflow: no se pudo ejecutar ${command} (${errorMessage(error)})`);
    return 1;
  }
}
