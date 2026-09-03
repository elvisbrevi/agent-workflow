/**
 * The coding agent CLI vocabulary, shared by argument parsing, the adapters, and
 * the checkpoints that record which CLI owns an in-flight session (ADR-0023).
 */

import { CLAUDE_CODE_EFFORTS } from "../claude-code/claude-code-service.ts";
import { CODEX_EFFORTS } from "../codex/codex-service.ts";

/** The coding agent CLI that executes the session of this run (ADR-0023). */
export type AgentCli = "opencode" | "claudecode" | "codex";

/**
 * The per-CLI facts a run needs, resolved once from `--cli` (ADR-0034): the
 * binary that names a missing install, the model `--model` defaults to when
 * the operator names none, and the efforts `--variant` accepts — `undefined`
 * leaves it free-form, as OpenCode's does.
 */
export interface AgentCliProfile {
  readonly binary: string;
  readonly defaultModel: string;
  readonly efforts?: readonly string[];
}

export const AGENT_CLI_PROFILES: Record<AgentCli, AgentCliProfile> = {
  opencode: { binary: "opencode", defaultModel: "opencode-go/deepseek-v4-pro" },
  claudecode: { binary: "claude", defaultModel: "claude-sonnet-5", efforts: CLAUDE_CODE_EFFORTS },
  codex: { binary: "codex", defaultModel: "gpt-5.6-sol", efforts: CODEX_EFFORTS },
};

/** The binary each CLI is invoked through, so a missing one is named as the operator installs it. */
export const AGENT_CLI_BINARIES: Record<AgentCli, string> = Object.fromEntries(
  (Object.entries(AGENT_CLI_PROFILES) as Array<[AgentCli, AgentCliProfile]>).map(([cli, profile]) => [cli, profile.binary]),
) as Record<AgentCli, string>;

export const DEFAULT_CLI: AgentCli = "opencode";

export function isAgentCli(value: unknown): value is AgentCli {
  return typeof value === "string" && Object.hasOwn(AGENT_CLI_PROFILES, value);
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
