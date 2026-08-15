/**
 * The coding agent CLI vocabulary, shared by argument parsing, the adapters, and
 * the checkpoints that record which CLI owns an in-flight session (ADR-0023).
 */

/** The coding agent CLI that executes the session of this run (ADR-0023). */
export type AgentCli = "opencode" | "claudecode";

/** The binary each CLI is invoked through, so a missing one is named as the operator installs it. */
export const AGENT_CLI_BINARIES: Record<AgentCli, string> = {
  opencode: "opencode",
  claudecode: "claude",
};

export const DEFAULT_CLI: AgentCli = "opencode";

export function isAgentCli(value: unknown): value is AgentCli {
  return typeof value === "string" && Object.hasOwn(AGENT_CLI_BINARIES, value);
}

/**
 * The stored checkpoint with the owning CLI a run could not name before `--cli`
 * existed: OpenCode ran every session there was. Upgrading it on read is what
 * keeps an in-flight delivery recoverable across the update. The same value is
 * returned when there is nothing to upgrade, so a caller rewrites the file only
 * when it actually changed.
 */
export function withOwnerCli(value: unknown, previousVersion: number, schemaVersion: number): unknown {
  if (typeof value !== "object" || value === null) return value;
  if ((value as { schemaVersion?: unknown }).schemaVersion !== previousVersion) return value;
  return { ...value, schemaVersion, cli: DEFAULT_CLI };
}
