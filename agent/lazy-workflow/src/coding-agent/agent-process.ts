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

/** Windows package managers commonly expose coding CLIs as .cmd launchers. */
export function resolveAgentBinary(binary: string): string | null {
  return Bun.which(binary)
    ?? (process.platform === "win32" ? Bun.which(`${binary}.cmd`) ?? Bun.which(`${binary}.bat`) : null);
}

export const spawnAgentProcess: AgentSpawner = (command, options) => {
  const { env, ...rest } = options ?? {};
  const binary = resolveAgentBinary(command[0]!) ?? command[0]!;
  const isWindowsScript = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(binary);
  // PowerShell receives the argument vector through stdin. Prompts and paths are
  // never interpolated into a shell command, and long prompts avoid cmd.exe's
  // command-line length limit.
  const launch = isWindowsScript
    ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $a=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); $rest=@($a | Select-Object -Skip 1); & $a[0] @rest; exit $LASTEXITCODE"]
    : command;
  const child = Bun.spawn(launch, {
    stdin: isWindowsScript ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...rest,
    ...(env ? { env: { ...Bun.env, ...env } } : {}),
  });
  if (isWindowsScript && child.stdin) {
    child.stdin.write(JSON.stringify([binary, ...command.slice(1)]));
    void child.stdin.end();
  }
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    kill: (signal) => {
      if (isWindowsScript) {
        const tree = Bun.spawn(["taskkill.exe", "/PID", String(child.pid), "/T", "/F"], {
          stdout: "ignore", stderr: "ignore",
        });
        void tree.exited;
      } else child.kill(signal);
    },
  };
};
