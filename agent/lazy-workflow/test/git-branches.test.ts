import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutGitBranchByName } from "../src/git/git-branch-checkout.ts";
import { listGitBranches } from "../src/git/git-branch-list.ts";
import type { GitRunner } from "../src/git/git-ticket-branch-cleaner.ts";

/** Each commit one minute after the last, so ordering by date is deterministic. */
let clock = 0;

/** Real git, isolated from the operator's own configuration. */
const git: GitRunner = async (args, workingDirectory) => {
  const date = `${1_700_000_000 + clock * 60} +0000`;
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
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
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
  clock += 1;
  await git(["commit", "-m", file], repository);
  return (await git(["rev-parse", "HEAD"], repository)).trim();
}

const head = async (repository: string) => (await git(["rev-parse", "HEAD"], repository)).trim();

beforeEach(async () => {
  clock = 0;
  root = mkdtempSync(join(tmpdir(), "lazy-workflow-branches-"));
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

test("el listado nombra la rama activa aparte y ofrece las demás como yp, la más reciente primero", async () => {
  const list = await listGitBranches(git, work);

  expect(list.current).toBe("main");
  expect(list.fetched).toBeTrue();
  // El HEAD del remoto apunta a una rama y no se ofrece como una.
  expect(list.branches.map(({ name, type }) => ({ name, type }))).toEqual([
    { name: "origin/feature-x", type: "remote" },
    { name: "origin/main", type: "remote" },
  ]);
  expect(list.branches[0]?.date).toBe("2023-11-14T22:15:20Z");
});

test("una rama local se lista como local y la activa no se ofrece", async () => {
  await checkoutGitBranchByName(git, "origin/feature-x", work);

  const list = await listGitBranches(git, work);

  expect(list.current).toBe("feature-x");
  expect(list.branches).toContainEqual(expect.objectContaining({ name: "main", type: "local" }));
  expect(list.branches.some(({ name, type }) => name === "feature-x" && type === "local")).toBeFalse();
});

test("cada rama listada es un nombre que git-branch-checkout acepta tal cual", async () => {
  const [newest] = (await listGitBranches(git, work)).branches;

  const result = await checkoutGitBranchByName(git, newest!.name, work);

  expect(result.branch).toBe("feature-x");
});

test("sin alcanzar el remoto lista las ramas que ya conoce", async () => {
  await git(["remote", "set-url", "origin", join(root, "missing.git")], work);

  const list = await listGitBranches(git, work);

  expect(list.fetched).toBeFalse();
  expect(list.branches.map(({ name }) => name)).toEqual(["origin/feature-x", "origin/main"]);
});

test("un HEAD desacoplado no es una rama", async () => {
  await git(["switch", "--detach", "HEAD"], work);

  const list = await listGitBranches(git, work);

  expect(list.current).toBeNull();
  expect(list.branches.map(({ name }) => name)).toEqual(["origin/feature-x", "main", "origin/main"]);
});
