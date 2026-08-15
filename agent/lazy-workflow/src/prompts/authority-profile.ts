/**
 * Agent authority profile: the mechanical half of the coordinator/agent boundary.
 *
 * The prompt states what the coding agent should decide; this states what it is
 * able to do, in the format each CLI's own provider validates and enforces, so a
 * prohibition no longer depends on the model reading and obeying prose (ADR-0021,
 * ADR-0023). Every profile exists in both formats and neither file is generated
 * from the other: a rule lost in translation is a rule that stops enforcing.
 *
 * OpenCode carries all five profiles in `opencode/authority.json`, injected
 * through `OPENCODE_CONFIG`, which merges with — rather than replaces — whatever
 * configuration the target repository already has. Claude Code validates one
 * settings file at a time, so each profile is its own file under `claudecode/`,
 * injected by path with `--settings`.
 *
 * Both CLIs run in their auto-approve mode (`--auto`, `bypassPermissions`), so
 * the deny rules are the whole enforcement surface: they are evaluated before any
 * permission, and everything not denied is approved without a prompt.
 */

import type { AgentCli } from "../cli/parse-cli-options.ts";
import type { WorkflowPromptSpec } from "./workflow-prompt.ts";

export const AUTHORITY_PROFILES = [
  "lazy-github-plan",
  "lazy-github-code",
  "lazy-azure-plan",
  "lazy-azure-code",
  "lazy-review",
] as const;

export type AuthorityProfile = typeof AUTHORITY_PROFILES[number];

/** Absolute path to the authority config lazy-workflow injects into the given CLI. */
export function authorityConfigPath(cli: AgentCli, profile: AuthorityProfile): string {
  const relative = cli === "claudecode" ? `../../claudecode/${profile}.json` : "../../opencode/authority.json";
  return Bun.fileURLToPath(new URL(relative, import.meta.url));
}

/** The authority a run may exercise, derived from what the coordinator already fixed. */
export function authorityProfile(spec: WorkflowPromptSpec): AuthorityProfile {
  switch (spec.kind) {
    case "github-plan":
      return "lazy-github-plan";
    case "azure-plan":
      return "lazy-azure-plan";
    // A workspace plan follows its already-resolved provider, not a fresh `--hu` check.
    case "workspace-plan":
      return spec.run.kind === "azure-hu-run" ? "lazy-azure-plan" : "lazy-github-plan";
    case "github-delivery":
    case "github-reconciliation":
    case "github-workspace-delivery":
      return "lazy-github-code";
    case "azure-delivery":
    case "azure-workspace-delivery":
      return "lazy-azure-code";
    case "architecture-review-sag":
      return "lazy-review";
  }
}
