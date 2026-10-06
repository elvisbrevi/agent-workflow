import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutGitBranchByName } from "../src/git/git-branch-checkout.ts";
import type { GitRunner } from "../src/git/git-ticket-branch-cleaner.ts";

/** Real git, isolated from the operator's own configuration. */
const git: GitRunner = async (args, workingDirectory) => {
  const child = Bun.spawn(["git", ...args], {
    cwd: workingDirectory,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} falló: ${stderr.trim()}`);
  return stdout;
};

let root: string;
let seed: string;
let work: string;

async function commit(repository: string, file: string): Promise<string> {
  writeFileSync(join(repository, file), file);
  await git(["add", file], repository);
  await git(["commit", "-m", file], repository);
  return (await git(["rev-parse", "HEAD"], repository)).trim();
}

const head = async (repository: string) => (await git(["rev-parse", "HEAD"], repository)).trim();

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "lazy-workflow-branch-checkout-"));
  seed = join(root, "seed");
  work = join(root, "work");
  await git(["init", "--bare", "-b", "main", "origin.git"], root);
  await git(["clone", "origin.git", "seed"], root);
  await commit(seed, "main.txt");
  await git(["push", "origin", "main"], seed);
  await git(["switch", "--create", "feature-x"], seed);
  await commit(seed, "feature.txt");
  await git(["push", "origin", "feature-x"], seed);
  await git(["clone", "origin.git", "work"], root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("una rama remota nombrada como la lista yp queda rastreada con su nombre local", async () => {
  const result = await checkoutGitBranchByName(git, "origin/feature-x", work);

  expect(result).toEqual({ branch: "feature-x", fetched: true, pulled: true });
  expect((await git(["rev-parse", "--abbrev-ref", "feature-x@{upstream}"], work)).trim()).toBe("origin/feature-x");
});

test("un nombre corto sin rama local se resuelve contra el remoto", async () => {
  const result = await checkoutGitBranchByName(git, "feature-x", work);

  expect(result.branch).toBe("feature-x");
  expect(await head(work)).toBe(await head(seed));
});

test("una rama local atrasada cambia y alcanza a su remoto por avance rápido", async () => {
  await checkoutGitBranchByName(git, "feature-x", work);
  await git(["switch", "main"], work);
  const latest = await commit(seed, "later.txt");
  await git(["push", "origin", "feature-x"], seed);

  const result = await checkoutGitBranchByName(git, "origin/feature-x", work);

  expect(result).toEqual({ branch: "feature-x", fetched: true, pulled: true });
  expect(await head(work)).toBe(latest);
});

test("una rama divergente cambia sin fabricar un merge", async () => {
  await checkoutGitBranchByName(git, "feature-x", work);
  const local = await commit(work, "local.txt");
  await git(["switch", "main"], work);
  await commit(seed, "remote.txt");
  await git(["push", "origin", "feature-x"], seed);

  const result = await checkoutGitBranchByName(git, "feature-x", work);

  expect(result).toEqual({ branch: "feature-x", fetched: true, pulled: false });
  expect(await head(work)).toBe(local);
});

test("una rama que no existe falla sin tocar el árbol", async () => {
  await expect(checkoutGitBranchByName(git, "missing", work)).rejects.toThrow("git switch missing falló");
  expect((await git(["branch", "--show-current"], work)).trim()).toBe("main");
});

test("un nombre que git leería como opción se rechaza antes de llamar a git", async () => {
  const calls: string[][] = [];
  const recording: GitRunner = async (args) => { calls.push(args); return ""; };

  await expect(checkoutGitBranchByName(recording, "--orphan", work)).rejects.toThrow("Rama no válida");
  expect(calls).toEqual([]);
});
