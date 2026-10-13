import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../src/git/git-ticket-branch-cleaner.ts";
import { SessionNotVerifiedError, verifySessionWithGit } from "../src/git/session-verification.ts";

const branch = "refs/heads/ticket/26297";
const baseBranch = "refs/heads/hu/24663";
let root: string;
let repository: string;
let commit: string;

async function configureIdentity(directory: string): Promise<void> {
  await runGit(["config", "user.email", "session-verification@example.invalid"], directory);
  await runGit(["config", "user.name", "Session verification test"], directory);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lazy-workflow-session-verification-"));
  const origin = join(root, "origin");
  repository = join(root, "clone");
  await runGit(["init", "--initial-branch=main", origin], root);
  await configureIdentity(origin);
  await writeFile(join(origin, "tracked.txt"), "base\n");
  await runGit(["add", "tracked.txt"], origin);
  await runGit(["commit", "-m", "base"], origin);
  await runGit(["branch", "hu/24663"], origin);
  await runGit(["clone", origin, repository], root);
  await configureIdentity(repository);
  await runGit(["switch", "--create", "ticket/26297", "origin/hu/24663"], repository);
  await writeFile(join(repository, "tracked.txt"), "entrega\n");
  await runGit(["commit", "-am", "entrega"], repository);
  commit = (await runGit(["rev-parse", "HEAD^{commit}"], repository)).trim();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("verifica un clon fresco cuya base solo existe en origin", async () => {
  expect((await runGit(["branch", "--list", "hu/24663"], repository)).trim()).toBe("");
  expect((await runGit(["rev-list", "--count", "origin/hu/24663..HEAD"], repository)).trim()).toBe("1");
  expect(await verifySessionWithGit(runGit, branch, baseBranch, repository)).toEqual({ commit });
});

test("prefiere la base local cuando también existe en origin", async () => {
  await runGit(["branch", "hu/24663", commit], repository);
  await expect(verifySessionWithGit(runGit, branch, baseBranch, repository)).rejects.toThrow(
    new SessionNotVerifiedError(`la rama ${branch} no tiene commits sobre ${baseBranch}`),
  );
});

test("verifica contra la base local aunque no exista en origin", async () => {
  await runGit(["branch", "hu/24663", "origin/hu/24663"], repository);
  await runGit(["update-ref", "-d", "refs/remotes/origin/hu/24663"], repository);
  expect(await verifySessionWithGit(runGit, branch, baseBranch, repository)).toEqual({ commit });
});

test("rechaza una base inexistente en local y en origin nombrando la base", async () => {
  await runGit(["update-ref", "-d", "refs/remotes/origin/hu/24663"], repository);
  const verification = verifySessionWithGit(runGit, branch, baseBranch, repository);
  await expect(verification).rejects.toBeInstanceOf(SessionNotVerifiedError);
  await expect(verification).rejects.toThrow(baseBranch);
});

test("rechaza un árbol sucio", async () => {
  await writeFile(join(repository, "tracked.txt"), "sin commitear\n");
  await expect(verifySessionWithGit(runGit, branch, baseBranch, repository)).rejects.toThrow(
    new SessionNotVerifiedError("la sesión dejó cambios sin commitear"),
  );
});

test("rechaza una rama activa distinta", async () => {
  await runGit(["switch", "main"], repository);
  await expect(verifySessionWithGit(runGit, branch, baseBranch, repository)).rejects.toThrow(
    new SessionNotVerifiedError(`la rama activa main no coincide con ${branch}`),
  );
});

test("clasifica HEAD detached como una sesión no verificada", async () => {
  await runGit(["switch", "--detach", commit], repository);
  await expect(verifySessionWithGit(runGit, branch, baseBranch, repository)).rejects.toBeInstanceOf(SessionNotVerifiedError);
});

for (const args of [
  ["status", "--porcelain", "--untracked-files=no"],
  ["rev-list", "--count", `refs/remotes/origin/hu/24663..${branch}`],
  ["rev-parse", "HEAD^{commit}"],
]) {
  test(`clasifica un fallo de git ${args[0]} como una sesión no verificada`, async () => {
    const failure = new Error(`fallo de git ${args.join(" ")}`);
    const verification = verifySessionWithGit(async (command, directory) => {
      if (command.join(" ") === args.join(" ")) throw failure;
      return runGit(command, directory);
    }, branch, baseBranch, repository);
    await expect(verification).rejects.toBeInstanceOf(SessionNotVerifiedError);
    await expect(verification).rejects.toThrow(failure.message);
  });
}
