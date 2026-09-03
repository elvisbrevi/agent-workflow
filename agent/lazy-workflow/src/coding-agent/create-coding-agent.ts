/**
 * The one place a `--cli` value becomes an adapter, so coordination resolves the
 * coding agent once per run instead of branching per call site (ADR-0023).
 */

import type { AgentCli } from "./agent-cli.ts";
import { ClaudeCodeService } from "../claude-code/claude-code-service.ts";
import { CodexService } from "../codex/codex-service.ts";
import { OpenCodeService } from "../opencode/open-code-service.ts";
import type { CodingAgent } from "./coding-agent.ts";

import { getDefaultReporter } from "../output/operator-output.ts";
import {
  assembleCodexAuthorityHome,
  codexAuthorityHomePath,
  resolveOperatorCodexHome,
} from "../prompts/codex-authority-home.ts";
import { spawnAgentProcess } from "./agent-process.ts";

/**
 * El segundo argumento es el timeout de inactividad en milisegundos, que el run declara con
 * `--idle-timeout`. Va por CLI porque el watchdog vive en cada adaptador: el silencio se mide sobre
 * el stream que cada uno lee (ADR-0039).
 */
export type CodingAgentFactory = (cli: AgentCli, idleTimeoutMs?: number) => CodingAgent;

export const createCodingAgent: CodingAgentFactory = (cli, idleTimeoutMs) => {
  if (cli === "claudecode") return new ClaudeCodeService(spawnAgentProcess, getDefaultReporter(), idleTimeoutMs);
  if (cli === "codex") {
    return new CodexService(
      spawnAgentProcess,
      getDefaultReporter(),
      assembleCodexAuthorityHome,
      resolveOperatorCodexHome,
      codexAuthorityHomePath,
      idleTimeoutMs,
    );
  }
  return new OpenCodeService(spawnAgentProcess, getDefaultReporter(), undefined, idleTimeoutMs);
};
