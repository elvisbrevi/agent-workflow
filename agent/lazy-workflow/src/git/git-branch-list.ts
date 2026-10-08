import { type GitRunner } from "./git-ticket-branch-cleaner.ts";

/** One branch, as the `yp checkout` menu shows it. */
export interface GitBranchEntry {
  /** The short name: `feature-x` locally, `origin/feature-x` for a remote branch. */
  name: string;
  type: "local" | "remote";
  /** The date of the branch's last commit, ISO 8601 in UTC to the second: `2023-11-14T22:15:20Z`. */
  date: string;
}

export interface GitBranchList {
  /** The active branch, or null when HEAD is detached. */
  current: string | null;
  /** Whether `fetch --all --prune` refreshed the remotes; a failed fetch only means the known branches are listed. */
  fetched: boolean;
  /** Every other branch, newest commit first. */
  branches: GitBranchEntry[];
}

const succeeds = (attempt: Promise<unknown>): Promise<boolean> => attempt.then(() => true, () => false);

/**
 * Git's own ISO dates change with its version — `+00:00` on older ones, `Z`
 * on newer — so the epoch seconds it prints are formatted here instead.
 */
const utcDate = (epochSeconds: string): string =>
  new Date(Number(epochSeconds) * 1000).toISOString().replace(".000Z", "Z");

/**
 * The branches `yp checkout` offers, without its menu: the remotes are
 * refreshed first, the list runs newest commit first, the active branch is
 * named apart rather than offered, and a remote's `HEAD` pointer is no branch.
 * Every entry is a name `git-branch-checkout` accepts as it is.
 */
export async function listGitBranches(git: GitRunner, workingDirectory: string): Promise<GitBranchList> {
  await git(["rev-parse", "--is-inside-work-tree"], workingDirectory);
  const fetched = await succeeds(git(["fetch", "--all", "--prune"], workingDirectory));
  const current = (await git(["branch", "--show-current"], workingDirectory)).trim() || null;
  // Un tab no puede aparecer en un nombre de rama, así que separa sin ambigüedad.
  const output = await git([
    "branch",
    "--all",
    "--sort=-committerdate",
    "--format=%(refname)%09%(refname:short)%09%(committerdate:unix)",
  ], workingDirectory);

  const branches: GitBranchEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [ref = "", name, date = ""] = line.split("\t");
    const local = ref.startsWith("refs/heads/");
    // Un HEAD desacoplado y el HEAD de un remoto apuntan a una rama; no lo son.
    if (!name || (!local && !ref.startsWith("refs/remotes/")) || ref.endsWith("/HEAD")) continue;
    if (local && name === current) continue;
    branches.push({ name, type: local ? "local" : "remote", date: utcDate(date) });
  }
  return { current, fetched, branches };
}
