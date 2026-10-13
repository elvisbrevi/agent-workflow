/**
 * `lz update`: reinstalling the tool from its own repository.
 *
 * What a reinstall means — which destinations, which cache, which ref — belongs
 * to the installer that put this binary on the PATH, so this command does not
 * reimplement it: it runs the repository's Bun installer and forwards the
 * arguments the operator declared after `update`. Without a mode, the CLI declares
 * `--all-global`, the shared install this tool is normally reached through. It
 * opens no session, writes no run log and takes no workflow option. The
 * installer also owns an existing web's backup, artifacts and verified restart.
 */
import { fileURLToPath } from "node:url";
import { MODES } from "../../../../installer/options.ts";

/** The injected boundary: it answers the installer's exit code. */
export type InstallerRunner = (args: string[]) => Promise<number>;

/** Skips and refs still update the usual global installation unless a mode was named. */
export function selfUpdateArgs(args: string[]): string[] {
  return args.some((arg) => arg.startsWith("--") && MODES.includes(arg.slice(2) as typeof MODES[number]))
    ? args : ["--all-global", ...args];
}

/** The installer that ships beside the CLI, in the checkout or in its cache. */
export function installerPath(): string {
  return fileURLToPath(new URL("../../../../installer/main.ts", import.meta.url));
}

export async function runSelfUpdate(args: string[]): Promise<number> {
  const command = [process.execPath, installerPath(), ...args];
  const child = Bun.spawn(command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}
