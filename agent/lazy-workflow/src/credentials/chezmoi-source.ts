/**
 * The chezmoi side of the credential store.
 *
 * Storing a value writes `~/.config/secrets/<service>.env`, but the encrypted
 * source state only changes when chezmoi re-adds that file. The refresh is
 * best-effort and answers whether it happened: a file chezmoi does not manage,
 * or a host without chezmoi, is a file the operator updates by other means.
 */

export async function refreshChezmoiSource(path: string): Promise<boolean> {
  const chezmoi = Bun.which("chezmoi");
  if (chezmoi === null) return false;
  if ((await run(chezmoi, ["source-path", path])) !== 0) return false;
  return (await run(chezmoi, ["re-add", path])) === 0;
}

async function run(chezmoi: string, args: string[]): Promise<number> {
  const child = Bun.spawn([chezmoi, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return await child.exited;
}
