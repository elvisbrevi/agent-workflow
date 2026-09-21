/**
 * The chezmoi side of the credential store.
 *
 * Storing a value writes `~/.config/secrets/<service>.env`; the encrypted source
 * state and the private dotfiles repository only change when chezmoi re-adds the
 * file and its source is committed and pushed. The whole publication is
 * best-effort and answers how far it got, so a host without chezmoi — or a
 * source repository without a remote or a network — still stores the value.
 */

/** How far the publication of the encrypted source got. */
export type ChezmoiPublication =
  | "published" // re-added, committed and pushed
  | "committed" // the source holds the change, but the push failed
  | "unmanaged" // no chezmoi, or the file does not live in its source state
  | "failed"; // chezmoi or git refused

export async function publishChezmoiSource(target: string, credential: string): Promise<ChezmoiPublication> {
  const chezmoi = Bun.which("chezmoi");
  if (chezmoi === null) return "unmanaged";
  const sourceFile = await capture(chezmoi, ["source-path", target]);
  if (sourceFile === null) return "unmanaged";
  if ((await run(chezmoi, ["re-add", target])) !== 0) return "failed";
  const sourceDirectory = await capture(chezmoi, ["source-path"]);
  if (sourceDirectory === null) return "failed";

  const git = Bun.which("git");
  if (git === null) return "failed";
  // Only the file this command re-added is staged: another uncommitted change in
  // the dotfiles repository is the operator's, not this command's to publish.
  if ((await run(git, ["-C", sourceDirectory, "add", "--", sourceFile])) !== 0) return "failed";
  // A re-add of an unchanged value stages nothing, and that is not a failure:
  // there is simply no new commit to write.
  if ((await run(git, ["-C", sourceDirectory, "diff", "--cached", "--quiet"])) !== 0) {
    if ((await run(git, ["-C", sourceDirectory, "commit", "-m", `Update ${credential} credential`])) !== 0) {
      return "failed";
    }
  }
  return (await run(git, ["-C", sourceDirectory, "push"])) === 0 ? "published" : "committed";
}

/** Runs `command` and answers its trimmed stdout, or null when it fails. */
async function capture(command: string, args: string[]): Promise<string | null> {
  const child = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const text = await new Response(child.stdout).text();
  return (await child.exited) === 0 ? text.trim() : null;
}

/** Runs `command` and answers only its exit code. */
async function run(command: string, args: string[]): Promise<number> {
  const child = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return await child.exited;
}
