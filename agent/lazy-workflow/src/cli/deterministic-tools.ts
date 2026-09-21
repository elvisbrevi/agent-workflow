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

import { join } from "node:path";
import { GitTicketBranchCleaner } from "../git/git-ticket-branch-cleaner.ts";
import {
  GitHubDeliveryService,
  type GitHubBranchPreparation,
  type GitHubPullRequest,
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
import { reportFailure } from "../output/failure-kind.ts";
import type { AzurePullRequestTarget } from "../azure/autocode-service.ts";
import {
  defaultSecretsDirectory,
  listCredentials,
  readCredential,
  storeCredential,
  type CredentialEntry,
  type CredentialValue,
  type StoredCredential,
} from "../credentials/credential-store.ts";
import { refreshChezmoiSource } from "../credentials/chezmoi-source.ts";
import { readCredentialSecret } from "../credentials/secret-input.ts";
import { isDeterministicToolCommand, type DeterministicToolCommand } from "./tool-commands.ts";
import type { CliOptions } from "./parse-cli-options.ts";

export { isDeterministicToolCommand, type DeterministicToolCommand };

/** The credential operations, injectable so a test drives them without touching the host. */
export interface CredentialTools {
  list(directory: string): Promise<CredentialEntry[]>;
  read(directory: string, name: string): Promise<CredentialValue | null>;
  /** The value being stored: hidden at a terminal, or the first stdin line with `--stdin`. */
  readSecret(name: string, fromStdin: boolean): Promise<string>;
  /** Writes the value and answers where it landed and whether chezmoi re-added it. */
  store(directory: string, name: string, service: string | null, value: string): Promise<StoredCredential>;
}

/** The boundaries a run uses when its boundary does not declare one. */
const productionCredentialTools: CredentialTools = {
  list: listCredentials,
  read: readCredential,
  readSecret: readCredentialSecret,
  store: async (directory, name, service, value) => {
    const stored = await storeCredential(directory, name, service, value);
    return { ...stored, chezmoiSourceUpdated: await refreshChezmoiSource(join(directory, stored.file)) };
  },
};

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
  verifySession(branch: string, baseBranch: string, workingDirectory: string): Promise<{ commit: string }>;
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
  verifySession?(ticketBranch: string, integrationBranch: string, workingDirectory: string): Promise<{ commit: string }>;
}

export interface DeterministicToolServices {
  azure: AzureToolBoundary;
  queue: GitHubQueueTools;
  delivery: GitHubDeliveryTools;
  branches: GitBranchTools;
  /**
   * The credential operations. Optional because only the `credentials-*`
   * commands reach them: a test that drives another family declares none.
   */
  credentials?: CredentialTools;
}

/** The concrete adapters, built only when a tool command is actually run. */
export function createDeterministicToolServices(azure: AzureToolBoundary): DeterministicToolServices {
  return {
    azure,
    queue: new GitHubManagedQueueService(),
    delivery: new GitHubDeliveryService(),
    branches: new GitTicketBranchCleaner(),
    credentials: productionCredentialTools,
  };
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function deterministicFailureKind(command: DeterministicToolCommand) {
  if (command.endsWith("-info") || command === "github-issue-list" || command === "github-issue-select" || command === "github-auth-info" || command === "github-repo-info") return "tracker-read-failure" as const;
  if (command.endsWith("session-verify")) return "session-not-verified" as const;
  if (command === "git-branch-delete") return "ticket-branch-cleanup-failure" as const;
  if (command.includes("branch-prepare") || command.includes("branch-checkout") || command.includes("branch-verify") || command === "hu-branch-ensure") return "branch-preparation-failure" as const;
  if (command === "github-issue-claim") return "claim-verification-failure" as const;
  if (command.includes("pr-") || command === "github-pr-merge") return "pull-request-failure" as const;
  return "deterministic-completion-failure" as const;
}

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

/**
 * The boundary operation `command` needs, bound to the boundary that owns it.
 * Taking the owner and the key rather than the function keeps the receiver
 * attached: in production the boundary is a class whose methods delegate through
 * `this`, so a detached method reads `this` as undefined and fails where an
 * injected object of arrow functions never could.
 */
function requireOperation<T extends object, K extends keyof T>(owner: T, key: K, command: string): NonNullable<T[K]> {
  const operation = owner[key];
  if (typeof operation !== "function") throw new MissingArgument(`El servicio no soporta ${command}`);
  return operation.bind(owner) as NonNullable<T[K]>;
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
    const children = await requireOperation(azure, "getHuChildren", command)(hu);
    return { hu, children };
  }
  if (command === "hu-state-set") {
    const hu = requirePositive(options.hu, "--hu <id>", command);
    const state = requireText(options.state, "--state <state>", command);
    const expectedState = requireText(options.expectedState, "--expected-state <state>", command);
    if (!options.hasExpectedRevision) throw new MissingArgument(`${command} requiere --expected-rev <rev>`);
    return requireOperation(azure, "setHuState", command)(hu, state, expectedState, options.expectedRevision);
  }
  if (command === "hu-branch-ensure") {
    const hu = requirePositive(options.hu, "--hu <id>", command);
    const branch = await requireOperation(azure, "ensureIntegrationBranch", command)(
      hu,
      options.workingDirectory,
      options.baseBranch,
    );
    return { hu, branch };
  }
  if (command === "ticket-type-info") {
    const ticket = requirePositive(options.ticket, "--ticket <id>", command);
    return requireOperation(azure, "getTicket", command)(ticket);
  }
  if (command === "ticket-pr-create") {
    const hu = requirePositive(options.hu, "--hu <id>", command);
    const ticket = requirePositive(options.ticket, "--ticket <id>", command);
    const pullRequest = await requireOperation(azure, "createOrReusePullRequest", command)(hu, ticket);
    return { hu, ticket, ...pullRequest };
  }
  if (command === "ticket-branch-push") {
    const branch = requireText(options.branch, "--branch <name>", command);
    await requireOperation(azure, "pushTicketBranch", command)(branch, options.workingDirectory);
    return { branch, pushed: true };
  }
  if (command === "ticket-session-verify") {
    const branch = requireBranchRef(options.branch, "--branch <name>", command);
    const baseBranch = requireBranchRef(options.baseBranch, "--base-branch <name>", command);
    const { commit } = await requireOperation(azure, "verifySession", command)(branch, baseBranch, options.workingDirectory);
    return { branch, baseBranch, commit };
  }
  // ticket-branch-checkout
  const branch = requireText(options.branch, "--branch <name>", command);
  await requireOperation(azure, "checkoutTicketBranch", command)(branch, options.workingDirectory);
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
  if (command === "github-session-verify") {
    const branch = requireBranchRef(options.branch, "--branch <name>", command);
    const baseBranch = requireBranchRef(options.baseBranch, "--base-branch <name>", command);
    return { branch, baseBranch, ...await delivery.verifySession(branch, baseBranch, workingDirectory) };
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
/**
 * The credential commands answer with the operator's own files instead of the
 * JSON its siblings print: `credentials-list` writes one name per line and
 * `credentials-get` writes the decoded value, because both feed the shell
 * directly. The value only reaches a terminal — a pipe requires `--force`, so an
 * agent capturing output never gets it by accident.
 *
 * `credentials-set` is the write of the family. It takes the value from a hidden
 * prompt — from stdin only when `--stdin` declares it — stores it in its env
 * file, and answers with where it landed. The value is never printed, so it can
 * appear in neither a pipe nor a log.
 */
async function runCredentialsTool(
  command: DeterministicToolCommand,
  options: CliOptions,
  credentials: CredentialTools,
  print: (line: string) => void,
  isTerminal: boolean,
): Promise<number> {
  const directory = defaultSecretsDirectory();
  if (command === "credentials-list") {
    for (const entry of await credentials.list(directory)) print(entry.name);
    return 0;
  }
  const name = requireText(options.name, "--name <NAME>", command);
  if (command === "credentials-get") {
    if (!isTerminal && !options.force) {
      throw new MissingArgument("credentials-get requiere una terminal o --force para imprimir el valor");
    }
    const found = await credentials.read(directory, name);
    if (!found) throw new Error(`${name} no esta en ${directory}`);
    print(found.value);
    return 0;
  }
  const value = await credentials.readSecret(name, options.stdin);
  print(JSON.stringify(await credentials.store(directory, name, options.service, value), null, 2));
  return 0;
}

export async function runDeterministicTool(
  command: DeterministicToolCommand,
  options: CliOptions,
  services: DeterministicToolServices,
  print: (line: string) => void = console.log,
  isTerminal: boolean = process.stdout.isTTY === true,
): Promise<number> {
  try {
    if (command.startsWith("credentials-")) {
      return await runCredentialsTool(command, options, services.credentials ?? productionCredentialTools, print, isTerminal);
    }
    const result = command.startsWith("github-")
      ? await runGitHubTool(command, options, services)
      : command.startsWith("git-")
        ? await runGitTool(command, options, services.branches)
        : await runAzureTool(command, options, services.azure);
    print(JSON.stringify(result ?? null, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof MissingArgument) {
      reportFailure("argument-error", "validating", {
        issue: options.issue,
        ticket: options.ticket,
        hu: options.hu,
        repository: options.workingDirectory,
        branch: options.branch,
      }, error.message);
      return 1;
    }
    reportFailure(
      deterministicFailureKind(command),
      "executing",
      {
        issue: options.issue,
        ticket: options.ticket,
        hu: options.hu,
        repository: options.workingDirectory,
        branch: options.branch,
      },
      `lazy-workflow: no se pudo ejecutar ${command} (${errorMessage(error)})`,
    );
    return 1;
  }
}
