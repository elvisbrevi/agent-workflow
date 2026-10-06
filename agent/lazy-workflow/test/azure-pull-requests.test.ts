import { describe, expect, test } from "bun:test";
import {
  AZURE_DESCRIPTION_LIMIT,
  AzurePullRequests,
  azureRepositoryFromRemote,
} from "../src/azure/azure-pull-requests.ts";
import type { AzRunner } from "../src/azure/ticket-info-service.ts";

const ORIGIN = "https://org@dev.azure.com/org/Equipo%20Uno/_git/repo";
const BASE = "https://dev.azure.com/org/Equipo%20Uno/_apis/git/repositories/repo";
const PR_URL = "https://dev.azure.com/org/Equipo%20Uno/_git/repo/pullrequest";

/** An `az` that answers every call with `answer` and records the method, uri and body. */
function fakeAz(answer: unknown): { az: AzRunner; calls: Array<{ method: string; uri: string; body: unknown }> } {
  const calls: Array<{ method: string; uri: string; body: unknown }> = [];
  const az: AzRunner = async (args) => {
    const flag = (name: string) => args[args.indexOf(name) + 1] ?? "";
    calls.push({
      method: flag("--method"),
      uri: flag("--uri"),
      body: args.includes("--body") ? JSON.parse(flag("--body")) : undefined,
    });
    return JSON.stringify(answer);
  };
  return { az, calls };
}

const PR = {
  pullRequestId: 7,
  title: "feat: x",
  description: "## Resumen",
  status: "completed",
  isDraft: false,
  creationDate: "2026-10-06T10:00:00Z",
  sourceRefName: "refs/heads/feature/x",
  targetRefName: "refs/heads/main",
  createdBy: { displayName: "Elvis Brevi" },
};

describe("azureRepositoryFromRemote", () => {
  test("lee organización, proyecto y repositorio de las tres formas de remote", () => {
    const expected = { organization: "org", project: "Equipo Uno", repository: "repo" };

    expect(azureRepositoryFromRemote(ORIGIN)).toEqual(expected);
    expect(azureRepositoryFromRemote("git@ssh.dev.azure.com:v3/org/Equipo%20Uno/repo")).toEqual(expected);
    expect(azureRepositoryFromRemote("https://org.visualstudio.com/DefaultCollection/Equipo%20Uno/_git/repo")).toEqual(expected);
    expect(azureRepositoryFromRemote("https://org.visualstudio.com/Equipo%20Uno/_git/repo/")).toEqual(expected);
  });

  test("un remote que no es Azure DevOps se rechaza", () => {
    expect(() => azureRepositoryFromRemote("https://github.com/owner/repo.git")).toThrow("no nombra un repositorio Azure DevOps");
  });
});

describe("AzurePullRequests", () => {
  test("un origin de otra organización falla antes de llamar a az", () => {
    const { az, calls } = fakeAz({});

    expect(() => new AzurePullRequests(az, "https://dev.azure.com/otra/Equipo/_git/repo"))
      .toThrow("pertenece a la organización otra");
    expect(calls).toEqual([]);
  });

  test("list pide las activas y deja las ramas en su forma corta", async () => {
    const { az, calls } = fakeAz({ value: [{ ...PR, status: "active" }] });

    const prs = await new AzurePullRequests(az, ORIGIN).list();

    expect(calls).toEqual([{
      method: "get",
      uri: `${BASE}/pullrequests?searchCriteria.status=active&$top=100&api-version=7.1`,
      body: undefined,
    }]);
    expect(prs).toEqual([{
      id: 7,
      title: "feat: x",
      author: "Elvis Brevi",
      source: "feature/x",
      target: "main",
      draft: false,
      createdAt: "2026-10-06T10:00:00Z",
      url: `${PR_URL}/7`,
    }]);
  });

  test("read traduce el estado y cada voto", async () => {
    const { az } = fakeAz({
      ...PR,
      reviewers: [
        { displayName: "Ana", vote: 10, isRequired: true },
        { displayName: "Luis", vote: 5 },
        { displayName: "Eva", vote: 0 },
        { displayName: "Juan", vote: -5 },
        { displayName: "Sara", vote: -10 },
      ],
    });

    const pr = await new AzurePullRequests(az, ORIGIN).read(7);

    expect(pr.status).toBe("merged");
    expect(pr.description).toBe("## Resumen");
    expect(pr.reviewers).toEqual([
      { name: "Ana", state: "approved", required: true },
      { name: "Luis", state: "approved-with-suggestions", required: false },
      { name: "Eva", state: "pending", required: false },
      { name: "Juan", state: "changes-requested", required: false },
      { name: "Sara", state: "rejected", required: false },
    ]);
  });

  test("threads deja solo lo que escribió una persona", async () => {
    const person = { displayName: "Ana" };
    const { az, calls } = fakeAz({ value: [
      {
        id: 12, status: "active", threadContext: { filePath: "/src/a.ts", rightFileStart: { line: 4 } },
        comments: [
          { id: 1, content: "Falta un caso", publishedDate: "2026-10-06T10:00:00Z", commentType: "text", author: person },
          { id: 2, content: "borrado", publishedDate: "2026-10-06T10:01:00Z", commentType: "text", isDeleted: true, author: person },
        ],
      },
      { id: 13, status: "fixed", threadContext: null, comments: [
        { id: 1, content: "¿Y la doc?", publishedDate: "2026-10-06T11:00:00Z", commentType: "text", author: person },
      ] },
      { id: 14, comments: [{ id: 1, content: "Ana voted 10", publishedDate: "2026-10-06T12:00:00Z", commentType: "system" }] },
      { id: 15, status: "active", isDeleted: true, comments: [{ id: 1, content: "x", publishedDate: "", commentType: "text" }] },
    ] });

    const threads = await new AzurePullRequests(az, ORIGIN).threads(7);

    expect(calls[0]?.uri).toBe(`${BASE}/pullRequests/7/threads?api-version=7.1`);
    expect(threads).toEqual([
      {
        id: "12", status: "active", path: "/src/a.ts", line: 4,
        comments: [{ id: "1", author: "Ana", body: "Falta un caso", createdAt: "2026-10-06T10:00:00Z" }],
      },
      {
        id: "13", status: "resolved", path: null, line: null,
        comments: [{ id: "1", author: "Ana", body: "¿Y la doc?", createdAt: "2026-10-06T11:00:00Z" }],
      },
    ]);
  });

  test("reply publica el comentario en el hilo y responde su id", async () => {
    const { az, calls } = fakeAz({ id: 3 });

    const reply = await new AzurePullRequests(az, ORIGIN).reply(7, "12", "Corregido en abc");

    expect(calls).toEqual([{
      method: "post",
      uri: `${BASE}/pullRequests/7/threads/12/comments?api-version=7.1`,
      body: { content: "Corregido en abc", commentType: 1 },
    }]);
    expect(reply).toEqual({ comment: "3" });
  });

  test("un hilo que no es un entero se rechaza sin llamar a az", async () => {
    const { az, calls } = fakeAz({});

    await expect(new AzurePullRequests(az, ORIGIN).reply(7, "conversation", "x")).rejects.toThrow("Un hilo de Azure DevOps es un entero");
    expect(calls).toEqual([]);
  });

  test("create publica las ramas como refs y responde el PR con su URL", async () => {
    const { az, calls } = fakeAz({ pullRequestId: 8 });

    const created = await new AzurePullRequests(az, ORIGIN).create({
      source: "feature/x", target: "main", title: "feat: x", description: "## Resumen",
    });

    expect(calls).toEqual([{
      method: "post",
      uri: `${BASE}/pullrequests?api-version=7.1`,
      body: { sourceRefName: "refs/heads/feature/x", targetRefName: "refs/heads/main", title: "feat: x", description: "## Resumen" },
    }]);
    expect(created).toEqual({ id: 8, url: `${PR_URL}/8` });
  });

  test("una descripción sobre el límite de Azure se rechaza sin llamar a az", async () => {
    const { az, calls } = fakeAz({});

    await expect(new AzurePullRequests(az, ORIGIN).create({
      source: "feature/x", target: "main", title: "feat: x", description: "x".repeat(AZURE_DESCRIPTION_LIMIT + 1),
    })).rejects.toThrow(`hasta ${AZURE_DESCRIPTION_LIMIT} caracteres`);
    expect(calls).toEqual([]);
  });
});
