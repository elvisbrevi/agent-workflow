/**
 * The machine shutdown a run declares with `--off`: the last action of an
 * unattended invocation, once there is nothing left to drain or close
 * (ADR-0030).
 *
 * It is a boundary like every other external-system adapter — the CLI decides
 * *when* to shut down and this module knows *how* — so a test verifies the
 * decision without powering off the machine running the suite.
 *
 * The password never travels as an argument: `sudo -S` reads it from stdin, and
 * whatever the command writes back is redacted before it is reported, so a
 * failed shutdown never becomes the thing that publishes the credential.
 */

/** What `--off` declares: the credential sudo shuts down with, and the grace period before it. */
export interface ShutdownRequest {
  /** The password `sudo -S` reads from stdin; null asks for a sudo that does not need one (`sudo -n`). */
  password: string | null;
  /** Seconds of grace before the shutdown runs; 0 shuts down immediately. */
  delaySeconds: number;
}

export interface SystemShutdown {
  /** Powers the machine off; fails closed with the redacted reason when the command could not run. */
  shutdown(password: string | null): Promise<void>;
}

/** No raw sudo text is ever reported: a password appearing in it is replaced. */
export function redactPassword(text: string, password: string | null): string {
  if (!password) return text;
  return text.split(password).join("***");
}

/**
 * `sudo -S shutdown -h now`, the same form an operator would type by hand. With
 * no declared password it uses `sudo -n`, which fails immediately instead of
 * blocking on a prompt nobody will answer in an unattended run.
 */
export class SudoSystemShutdown implements SystemShutdown {
  constructor(private readonly spawn: typeof Bun.spawn = Bun.spawn) {}

  async shutdown(password: string | null): Promise<void> {
    const command = password === null
      ? ["sudo", "-n", "shutdown", "-h", "now"]
      : ["sudo", "-S", "-p", "", "shutdown", "-h", "now"];
    const child = this.spawn(command, {
      stdin: password === null ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (password !== null && child.stdin) {
      child.stdin.write(`${password}\n`);
      await child.stdin.end();
    }
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr as ReadableStream).text(),
    ]);
    if (exitCode !== 0) {
      const detail = redactPassword(stderr, password).trim();
      throw new Error(`${command.join(" ")} falló: ${detail || `exit ${exitCode}`}`);
    }
  }
}
