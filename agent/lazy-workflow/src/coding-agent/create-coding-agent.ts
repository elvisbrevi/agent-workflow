/**
 * The one place a `--cli` value becomes an adapter, so coordination resolves the
 * coding agent once per run instead of branching per call site (ADR-0023).
 */

import type { AgentCli } from "./agent-cli.ts";
import { ClaudeCodeService } from "../claude-code/claude-code-service.ts";
import { OpenCodeService } from "../opencode/open-code-service.ts";
import type { CodingAgent } from "./coding-agent.ts";

export type CodingAgentFactory = (cli: AgentCli) => CodingAgent;

export const createCodingAgent: CodingAgentFactory = (cli) =>
  cli === "claudecode" ? new ClaudeCodeService() : new OpenCodeService();
