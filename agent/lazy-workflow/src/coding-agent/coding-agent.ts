/**
 * The coding agent seam: the contract coordination depends on, so a second CLI
 * is one adapter rather than a branch at every call site (ADR-0023).
 *
 * The prompt states what the agent should decide; the authority states what it is
 * able to do, expressed in the format its own CLI enforces (ADR-0021).
 */

import type { AgentResult } from "./agent-result.ts";

export interface AgentRunOptions {
  model: string;
  variant: string;
  session: string | null;
  prompt: string;
  workingDirectory?: string;
  terminalMarker?: string;
  /** Agent authority profile whose permissions bound what this run may do. */
  agent?: AgentAuthority;
}

/** The agent authority profile and the config that defines it, injected per run. */
export interface AgentAuthority {
  profile: string;
  configPath: string;
}

export interface AgentExecution {
  result: AgentResult;
  azureLoginRequired: boolean;
  failed?: boolean;
}

export type AgentResumeOverrides = Partial<Pick<AgentRunOptions, "model" | "variant" | "agent">>;

export interface CodingAgent {
  run(options: AgentRunOptions, detectAzureLogin?: boolean): Promise<AgentExecution>;
  resume(
    sessionId: string,
    prompt?: string,
    workingDirectory?: string,
    terminalMarker?: string,
    overrides?: AgentResumeOverrides,
  ): Promise<AgentResult>;
}

/** The session ran but could not be released once its terminal marker arrived. */
export class AgentSessionCloseError extends Error {
  constructor(
    readonly sessionId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentSessionCloseError";
  }
}

/** The session a checkpoint points at is gone, so it can no longer be resumed. */
export class AgentSessionNotFoundError extends Error {
  constructor(
    readonly sessionId: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentSessionNotFoundError";
  }
}
