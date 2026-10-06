/**
 * The deterministic tools a workflow uses, named as commands of their own.
 *
 * A workflow run reaches Azure Boards, GitHub and git through adapters that
 * never open a session: they read or mutate the tracker, the branch or the pull
 * request and answer. Those operations are the same whether a run drives them or
 * an operator does, so every one of them is reachable as its own command and the
 * workflow stays the only thing a run has to trust (ADR-0026).
 *
 * This module holds only the names, with no imports, so both the parser and the
 * dispatcher can read them without importing each other.
 */

/** Azure Boards operations the workflow performs through `az`. */
export const AZURE_TOOL_COMMANDS = [
  "hu-children-info",
  "hu-state-set",
  "hu-branch-ensure",
  "ticket-type-info",
  "ticket-pr-create",
  "ticket-branch-push",
  "ticket-branch-checkout",
  "ticket-session-verify",
] as const;

/** GitHub operations the workflow performs through `gh`. */
export const GITHUB_TOOL_COMMANDS = [
  "github-auth-info",
  "github-repo-info",
  "github-issue-list",
  "github-issue-select",
  "github-issue-info",
  "github-issue-claim",
  "github-issue-release",
  "github-issue-close",
  "github-branch-prepare",
  "github-branch-checkout",
  "github-branch-verify",
  "github-branch-cleanup",
  "github-session-verify",
  "github-commit-push",
  "github-pr-create",
  "github-pr-merge",
] as const;

/** Repository operations the workflow performs through `git`. */
export const GIT_TOOL_COMMANDS = ["git-branch-checkout", "git-branch-delete"] as const;

/**
 * The credential operations: inspect locations, read, store, copy from
 * Keychain, and pull the published encrypted source without opening a session.
 */
export const CREDENTIALS_TOOL_COMMANDS = [
  "credentials-audit",
  "credentials-list",
  "credentials-get",
  "credentials-set",
  "credentials-migrate",
  "credentials-update",
] as const;

export const DETERMINISTIC_TOOL_COMMANDS = [
  ...AZURE_TOOL_COMMANDS,
  ...GITHUB_TOOL_COMMANDS,
  ...GIT_TOOL_COMMANDS,
  ...CREDENTIALS_TOOL_COMMANDS,
] as const;

export type DeterministicToolCommand = typeof DETERMINISTIC_TOOL_COMMANDS[number];

const COMMAND_SET = new Set<string>(DETERMINISTIC_TOOL_COMMANDS);

export function isDeterministicToolCommand(command: string): command is DeterministicToolCommand {
  return COMMAND_SET.has(command);
}

/** The invocation forms shown in `--help`, in the order the families are listed. */
export const DETERMINISTIC_TOOL_FORMS = [
  "  lz hu-children-info --hu <id>",
  "  lz hu-state-set --hu <id> --state <state> --expected-state <state> --expected-rev <rev>",
  "  lz hu-branch-ensure --hu <id> [--base-branch <name>] --working-directory <path>",
  "  lz ticket-type-info --ticket <id>",
  "  lz ticket-pr-create --hu <id> --ticket <id>",
  "  lz ticket-branch-push --branch <name> --working-directory <path>",
  "  lz ticket-branch-checkout --branch <name> --working-directory <path>",
  "  lz ticket-session-verify --branch <name> --base-branch <name> --working-directory <path>",
  "  lz github-auth-info --working-directory <path>",
  "  lz github-repo-info --working-directory <path>",
  "  lz github-issue-list --working-directory <path>",
  "  lz github-issue-select --working-directory <path>",
  "  lz github-issue-info --issue <id> --working-directory <path>",
  "  lz github-issue-claim --issue <id> --working-directory <path>",
  "  lz github-issue-release --issue <id> --working-directory <path>",
  "  lz github-issue-close --issue <id> --pr <id> --commit <sha> --working-directory <path>",
  "  lz github-branch-prepare --issue <id> --working-directory <path>",
  "  lz github-branch-checkout --branch <name> --base-branch <name> --working-directory <path>",
  "  lz github-branch-verify --branch <name> --base-branch <name> --working-directory <path>",
  "  lz github-branch-cleanup --branch <name> --base-branch <name> --commit <sha> --working-directory <path>",
  "  lz github-session-verify --branch <name> --base-branch <name> --working-directory <path>",
  "  lz github-commit-push --branch <name> --commit <sha> --working-directory <path>",
  "  lz github-pr-create --issue <id> --branch <name> --base-branch <name> --commit <sha> --working-directory <path>",
  "  lz github-pr-merge --pr <id> --issue <id> --branch <name> --base-branch <name> --commit <sha> --working-directory <path>",
  "  lz git-branch-checkout --branch <name> --working-directory <path>",
  "  lz git-branch-delete --branch <name> --base-branch <name> [--commit <sha>] --working-directory <path>",
  "  lz credentials-audit [--name <NAME>]",
  "  lz credentials-list",
  "  lz credentials-get --name <NAME> [--force]",
  "  lz credentials-set --name <NAME> [--service <service>] [--stdin]",
  "  lz credentials-migrate --name <NAME> [--service <service>]",
  "  lz credentials-update",
];
