import { type GitRunner } from "./git-ticket-branch-cleaner.ts";

/** Where `checkoutGitBranchByName` left the repository. */
export interface GitBranchCheckout {
  /** The local branch HEAD points to afterwards. */
  branch: string;
  /** Whether `fetch --all --prune` refreshed the remotes; a failed fetch only means the known branches were used. */
  fetched: boolean;
  /** Whether the branch fast-forwarded to its upstream; one without upstream, or diverged from it, stays as it was. */
  pulled: boolean;
}

const succeeds = (attempt: Promise<unknown>): Promise<boolean> => attempt.then(() => true, () => false);

/**
 * The switch `yp checkout` performs, without its menu: the operator names the
 * branch instead of picking it. The remotes are refreshed first, a remote branch
 * is named the way that menu lists it (`origin/feature-x`) and lands on its local
 * name, and the branch then catches up with its upstream.
 *
 * Two things are stricter than `yp`: `git switch` never reads the name as a
 * path, so a missing branch cannot restore a file instead, and catching up is a
 * fast-forward, never a merge that fabricates history nobody reviewed.
 */
export async function checkoutGitBranchByName(
  git: GitRunner,
  requested: string,
  workingDirectory: string,
): Promise<GitBranchCheckout> {
  const name = requested.startsWith("refs/heads/") ? requested.slice("refs/heads/".length) : requested;
  if (
    !/^[A-Za-z0-9._/-]+$/.test(name)
    || name.startsWith("-")
    || name.startsWith("/")
    || name.endsWith("/")
    || name.includes("..")
    || name.includes("//")
  ) {
    throw new Error(`Rama no válida: ${requested}`);
  }

  await git(["rev-parse", "--is-inside-work-tree"], workingDirectory);
  const fetched = await succeeds(git(["fetch", "--all", "--prune"], workingDirectory));
  const exists = (ref: string) => succeeds(git(["show-ref", "--verify", "--quiet", ref], workingDirectory));

  if (!await exists(`refs/heads/${name}`) && await exists(`refs/remotes/${name}`)) {
    // Ya rastreada: la rama local existe y basta con cambiar a ella.
    const local = name.slice(name.indexOf("/") + 1);
    await git(await exists(`refs/heads/${local}`) ? ["switch", local] : ["switch", "--track", name], workingDirectory);
  } else {
    // Un nombre corto sin rama local lo resuelve git contra su único remoto.
    await git(["switch", name], workingDirectory);
  }

  const branch = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], workingDirectory)).trim();
  const pulled = await succeeds(git(["pull", "--ff-only"], workingDirectory));
  return { branch, fetched, pulled };
}
