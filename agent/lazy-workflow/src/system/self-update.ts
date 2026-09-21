/**
 * `lazy-workflow update`: reinstalling the tool from its own repository.
 *
 * What a reinstall means — which destinations, which cache, which ref — belongs
 * to the installer that put this binary on the PATH, so this command does not
 * reimplement it: it runs the repository's `install.sh` and forwards the
 * arguments the operator declared after `update`. With none, the CLI declares
 * `--all-global`, the shared install this tool is normally reached through. It
 * opens no session, writes no run log and takes no workflow option.
 */
import { fileURLToPath } from "node:url";

/** The injected boundary: it answers the installer's exit code. */
export type InstallerRunner = (args: string[]) => Promise<number>;

/** The installer that ships beside the CLI, in the checkout or in its cache. */
export function installerPath(): string {
  return fileURLToPath(new URL("../../../../install.sh", import.meta.url));
}

export async function runSelfUpdate(args: string[]): Promise<number> {
  const child = Bun.spawn(["bash", installerPath(), ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}
