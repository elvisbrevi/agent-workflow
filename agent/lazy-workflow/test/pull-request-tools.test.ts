import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeterministicToolServices } from "../src/cli/deterministic-tools.ts";
import { runGit } from "../src/git/git-ticket-branch-cleaner.ts";
import { isAzureRemote, isGitHubRemote } from "../src/pull-request/pull-request-tools.ts";

let repository: string;

beforeEach(async () => {
  repository = mkdtempSync(join(tmpdir(), "lazy-workflow-pr-tracker-"));
  await runGit(["init", "-q"], repository);
});

afterEach(() => {
  rmSync(repository, { recursive: true, force: true });
});

const resolve = createDeterministicToolServices({}).pullRequests!;

test("cada forma de remote se reconoce por su tracker y por ningún otro", () => {
  for (const github of ["https://github.com/owner/repo.git", "git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo"]) {
    expect({ github, azure: isAzureRemote(github), isGitHub: isGitHubRemote(github) }).toEqual({ github, azure: false, isGitHub: true });
  }
  for (const azure of [
    "https://org@dev.azure.com/org/Team/_git/repo",
    "git@ssh.dev.azure.com:v3/org/Team/repo",
    "https://org.visualstudio.com/Team/_git/repo",
  ]) {
    expect({ azure, isAzure: isAzureRemote(azure), github: isGitHubRemote(azure) }).toEqual({ azure, isAzure: true, github: false });
  }
});

test("el tracker de los pr-* es el que nombra origin", async () => {
  await runGit(["remote", "add", "origin", "git@github.com:owner/repo.git"], repository);
  expect((await resolve(repository)).tracker).toBe("github");

  await runGit(["remote", "set-url", "origin", "https://dev.azure.com/org/Team/_git/repo"], repository);
  expect((await resolve(repository)).tracker).toBe("azure");
});

test("un origin que no es GitHub ni Azure DevOps se rechaza", async () => {
  await runGit(["remote", "add", "origin", "https://gitlab.com/owner/repo.git"], repository);

  await expect(resolve(repository)).rejects.toThrow("no es GitHub ni Azure DevOps");
});
