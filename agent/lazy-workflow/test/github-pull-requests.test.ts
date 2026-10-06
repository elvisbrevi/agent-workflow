import { describe, expect, test } from "bun:test";
import { CONVERSATION_THREAD, GitHubPullRequests } from "../src/github/github-pull-requests.ts";
import type { GhRunner } from "../src/github/managed-queue-service.ts";

/** A `gh` that answers by the first argument it recognizes and records every call. */
function fakeGh(answer: (args: string[]) => unknown): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = async (args, workingDirectory) => {
    expect(workingDirectory).toBe("/repo");
    calls.push(args);
    const result = answer(args);
    return typeof result === "string" ? result : JSON.stringify(result);
  };
  return { gh, calls };
}

const PR = {
  number: 31,
  title: "feat: registrar trabajo",
  author: { login: "elvisbrevi" },
  headRefName: "feature/x",
  baseRefName: "main",
  isDraft: false,
  createdAt: "2026-10-05T22:01:35Z",
  url: "https://github.com/owner/repo/pull/31",
};

const comment = (id: string, body: string) => ({ id, author: { login: "reviewer" }, body, createdAt: "2026-10-06T10:00:00Z" });

describe("GitHubPullRequests", () => {
  test("list lee las abiertas y las traduce al contrato común", async () => {
    const { gh, calls } = fakeGh(() => [PR]);

    const prs = await new GitHubPullRequests(gh, "/repo").list();

    expect(calls[0]?.slice(0, 4)).toEqual(["pr", "list", "--state", "open"]);
    expect(prs).toEqual([{
      id: 31,
      title: "feat: registrar trabajo",
      author: "elvisbrevi",
      source: "feature/x",
      target: "main",
      draft: false,
      createdAt: "2026-10-05T22:01:35Z",
      url: "https://github.com/owner/repo/pull/31",
    }]);
  });

  test("read traduce el estado y las revisiones; un pedido de revisión la deja pendiente", async () => {
    const { gh } = fakeGh(() => ({
      ...PR,
      state: "MERGED",
      body: "## Resumen",
      latestReviews: [
        { author: { login: "ana" }, state: "APPROVED" },
        { author: { login: "luis" }, state: "CHANGES_REQUESTED" },
        { author: { login: "eva" }, state: "COMMENTED" },
      ],
      reviewRequests: [{ login: "luis" }, { slug: "plataforma" }],
    }));

    const pr = await new GitHubPullRequests(gh, "/repo").read(31);

    expect(pr.status).toBe("merged");
    expect(pr.description).toBe("## Resumen");
    expect(pr.reviewers).toEqual([
      { name: "ana", state: "approved", required: false },
      { name: "luis", state: "pending", required: false },
      { name: "eva", state: "commented", required: false },
      { name: "plataforma", state: "pending", required: false },
    ]);
  });

  test("threads ofrece la conversación como un hilo más, antes de los de revisión", async () => {
    const { gh, calls } = fakeGh(() => ({
      data: { repository: { pullRequest: {
        comments: { totalCount: 1, nodes: [comment("IC_1", "¿Y los tests?")] },
        reviewThreads: { totalCount: 1, nodes: [{
          id: "PRRT_1", isResolved: true, path: "src/a.ts", line: 12,
          comments: { totalCount: 1, nodes: [comment("PRRC_1", "Falta un caso")] },
        }] },
      } } },
    }));

    const threads = await new GitHubPullRequests(gh, "/repo").threads(31);

    expect(calls[0]).toContain("number=31");
    expect(threads).toEqual([
      {
        id: CONVERSATION_THREAD, status: "active", path: null, line: null,
        comments: [{ id: "IC_1", author: "reviewer", body: "¿Y los tests?", createdAt: "2026-10-06T10:00:00Z" }],
      },
      {
        id: "PRRT_1", status: "resolved", path: "src/a.ts", line: 12,
        comments: [{ id: "PRRC_1", author: "reviewer", body: "Falta un caso", createdAt: "2026-10-06T10:00:00Z" }],
      },
    ]);
  });

  test("sin conversación no se ofrece su hilo, y un PR inexistente falla", async () => {
    const empty = fakeGh(() => ({ data: { repository: { pullRequest: {
      comments: { totalCount: 0, nodes: [] },
      reviewThreads: { totalCount: 0, nodes: [] },
    } } } }));
    const missing = fakeGh(() => ({ data: { repository: { pullRequest: null } } }));

    expect(await new GitHubPullRequests(empty.gh, "/repo").threads(31)).toEqual([]);
    await expect(new GitHubPullRequests(missing.gh, "/repo").threads(99)).rejects.toThrow("El PR #99 no existe");
  });

  test("una página de hilos o comentarios cortada falla en vez de esconder lo que falta", async () => {
    const truncated = fakeGh(() => ({ data: { repository: { pullRequest: {
      comments: { totalCount: 101, nodes: [comment("IC_1", "uno")] },
      reviewThreads: { totalCount: 0, nodes: [] },
    } } } }));

    await expect(new GitHubPullRequests(truncated.gh, "/repo").threads(31)).rejects.toThrow("más de 1 comentarios");
  });

  test("responder a la conversación es un comentario del PR", async () => {
    const { gh, calls } = fakeGh(() => "https://github.com/owner/repo/pull/31#issuecomment-4242\n");

    const reply = await new GitHubPullRequests(gh, "/repo").reply(31, CONVERSATION_THREAD, "Listo");

    expect(calls).toEqual([["pr", "comment", "31", "--body", "Listo"]]);
    expect(reply).toEqual({ comment: "4242" });
  });

  test("responder a un hilo de revisión verifica primero que sea de ese PR", async () => {
    const { gh, calls } = fakeGh((args) => args.some((arg) => arg.startsWith("query=query"))
      ? { data: { node: { pullRequest: { number: 31 } } } }
      : { data: { addPullRequestReviewThreadReply: { comment: { id: "PRRC_9" } } } });

    const reply = await new GitHubPullRequests(gh, "/repo").reply(31, "PRRT_1", "Corregido");

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("thread=PRRT_1");
    expect(calls[1]).toContain("body=Corregido");
    expect(reply).toEqual({ comment: "PRRC_9" });
  });

  test("un hilo de otro PR no recibe la respuesta", async () => {
    const { gh, calls } = fakeGh(() => ({ data: { node: { pullRequest: { number: 7 } } } }));

    await expect(new GitHubPullRequests(gh, "/repo").reply(31, "PRRT_1", "Corregido"))
      .rejects.toThrow("El hilo PRRT_1 no pertenece al PR #31");
    expect(calls).toHaveLength(1);
  });

  test("create pasa ramas, título y descripción y responde el PR que gh creó", async () => {
    const { gh, calls } = fakeGh(() => "Creating pull request...\nhttps://github.com/owner/repo/pull/32\n");

    const created = await new GitHubPullRequests(gh, "/repo").create({
      source: "feature/x", target: "main", title: "feat: x", description: "## Resumen",
    });

    expect(calls).toEqual([["pr", "create", "--head", "feature/x", "--base", "main", "--title", "feat: x", "--body", "## Resumen"]]);
    expect(created).toEqual({ id: 32, url: "https://github.com/owner/repo/pull/32" });
  });
});
