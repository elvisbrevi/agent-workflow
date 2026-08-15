/**
 * How a coding agent CLI is launched. The shape is shared by every adapter so a
 * test can hand any of them a fake spawner and read back the command it built.
 */

export interface AgentProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface AgentSpawnOptions {
  cwd?: string;
  /** Extra environment for the child; merged over the inherited environment. */
  env?: Record<string, string>;
}

export type AgentSpawner = (command: string[], options?: AgentSpawnOptions) => AgentProcess;

export const spawnAgentProcess: AgentSpawner = (command, options) => {
  const { env, ...rest } = options ?? {};
  const process = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    ...rest,
    ...(env ? { env: { ...Bun.env, ...env } } : {}),
  });
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    exited: process.exited,
    kill: (signal) => process.kill(signal),
  };
};
