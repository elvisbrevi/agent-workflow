import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { parseWorkingDirectoryList, normalizeWorkspaceScope } from "../src/workspace/repository-scope.ts";
import type { GitRunner } from "../src/git/git-ticket-branch-cleaner.ts";

test("parsea rutas CSV ordenadas y recorta espacios", () => {
  expect(parseWorkingDirectoryList(" /repo-a, /repo-b ")).toEqual(["/repo-a", "/repo-b"]);
  expect(parseWorkingDirectoryList("/repo")).toEqual(["/repo"]);
});

test("rechaza entradas vacías y repositorios repetidos", async () => {
  expect(() => parseWorkingDirectoryList("/repo-a,,/repo-b")).toThrow("vacías");
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-scope-"));
  const git: GitRunner = async (args, directory) => {
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "remote") return "git@github.com:owner/repo.git";
    return "";
  };
  try {
    await expect(normalizeWorkspaceScope(`${root},${root}`, git)).rejects.toThrow("repetido");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valida limpieza, remote y orden antes de devolver el alcance", async () => {
  const calls: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-scope-"));
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  await Bun.$`mkdir -p ${repoA} ${repoB}`;
  const git: GitRunner = async (args, directory) => {
    calls.push(`${directory}:${args.join(" ")}`);
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "remote") return `git@github.com:owner/${basename(directory)}.git`;
    return "";
  };
  try {
    const scope = await normalizeWorkspaceScope(`${repoA}, ${repoB}`, git);
    expect(scope.repositories.map(({ path }) => path)).toEqual([await realpath(repoA), await realpath(repoB)]);
    expect(scope.repositories.map(({ providerIdentity }) => providerIdentity)).toEqual([null, null]);
    expect(calls.filter((call) => call.includes("status")).map((call) => call.split(":", 1)[0])).toEqual([await realpath(repoA), await realpath(repoB)]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rechaza un worktree sucio antes de continuar con el siguiente", async () => {
  const visited: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-scope-"));
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  await Bun.$`mkdir -p ${repoA} ${repoB}`;
  const git: GitRunner = async (args, directory) => {
    visited.push(directory);
    if (args[0] === "rev-parse") return directory;
    if (args[0] === "remote") return "git@github.com:owner/repo.git";
    if (args[0] === "status") return " M file.ts";
    return "";
  };
  try {
    await expect(normalizeWorkspaceScope(`${repoA},${repoB}`, git)).rejects.toThrow("cambios");
    expect(visited.some((path) => path === repoB)).toBeFalse();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rechaza una subruta aunque pertenezca a un repositorio Git", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-workflow-scope-"));
  const child = join(root, "src");
  await Bun.$`mkdir -p ${child}`;
  const git: GitRunner = async (args, directory) => {
    if (args[0] === "rev-parse") return root;
    if (args[0] === "remote") return "git@github.com:owner/repo.git";
    return "";
  };
  try {
    await expect(normalizeWorkspaceScope(child, git)).rejects.toThrow("raíz");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
