/**
 * Agent authority profile: the mechanical half of the coordinator/OpenCode boundary.
 *
 * The prompt states what OpenCode should decide; this states what it is able to do.
 * Each profile is an OpenCode agent definition in `opencode/authority.json` whose
 * `permission.bash` deny rules are enforced by the provider, so a prohibition no
 * longer depends on the model reading and obeying prose.
 *
 * OpenCode runs with `--auto`, which auto-approves everything *not explicitly
 * denied*, so the deny rules are the whole enforcement surface. The config is
 * injected through `OPENCODE_CONFIG`, which merges with — rather than replaces —
 * whatever configuration the target repository already has.
 */

import type { WorkflowPromptSpec } from "./workflow-prompt.ts";

export type AuthorityProfile =
  | "lazy-github-plan"
  | "lazy-github-code"
  | "lazy-azure-plan"
  | "lazy-azure-code"
  | "lazy-review";

/** Absolute path to the authority config lazy-workflow injects into OpenCode. */
export function authorityConfigPath(): string {
  return Bun.fileURLToPath(new URL("../../opencode/authority.json", import.meta.url));
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
