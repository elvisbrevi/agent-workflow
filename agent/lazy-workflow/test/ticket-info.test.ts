import { expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { AzureTicketInfoService } from "../src/azure/ticket-info-service.ts";
import { HuInfo } from "../src/azure/hu-info.ts";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";

const branch = "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBhu%2F23438";

function fixture() {
  const commands: string[][] = [];
  const az = async (args: string[]): Promise<string> => {
    commands.push(args);
    if (args[0] === "boards" && args.includes("23438")) {
      return JSON.stringify({
        id: 23438,
        rev: 7,
        fields: {
          "System.WorkItemType": "User Story",
          "System.Title": "HU",
          "System.TeamProject": "Team",
        },
        relations: [{
          rel: "System.LinkTypes.Hierarchy-Forward",
          url: "https://example.test/_apis/wit/workItems/51",
        }, {
          rel: "ArtifactLink",
          url: branch,
          attributes: { name: "Branch" },
        }],
      });
    }
    if (args[0] === "boards" && args.includes("51")) {
      return JSON.stringify({
        id: 51,
        rev: 4,
        fields: {
          "System.WorkItemType": "Task",
          "System.Title": "Read ticket",
          "System.Description": "Description",
          "System.State": "Active",
          "System.CreatedDate": "2026-08-11T00:00:00Z",
          "Microsoft.VSTS.Scheduling.OriginalEstimate": 3,
          "Custom.EsfuerzoReal": 1.25,
          "Custom.EsfuerzoRealHH": 1.25,
          "Custom.CompletionEvidence": "evidence",
        },
        relations: [{
          rel: "AttachedFile",
           url: "https://example.test/evidence.json",
           attributes: { name: "evidence.json", comment: "http-json", digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        }],
      });
    }
    if (args[0] === "repos" && args[1] === "pr") {
      if (args.includes("work-item")) return JSON.stringify([51]);
      return JSON.stringify([{
        pullRequestId: 99,
        status: "completed",
        mergeStatus: "succeeded",
        sourceRefName: "refs/heads/ticket/51-read",
        targetRefName: "refs/heads/hu/23438",
        lastMergeCommit: { commitId: "merge-commit" },
        repository: { id: "repository-id", project: { id: "project-id" } },
      }]);
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  return { service: new AzureTicketInfoService(az), commands };
}

test("ticket-info returns normalized delivery context and validates its direct parent", async () => {
  const fixtureValue = fixture();

  await expect(fixtureValue.service.getTicketInfo(23438, 51)).resolves.toEqual(expect.objectContaining({
    hu: { id: 23438, title: "HU" },
    ticket: expect.objectContaining({
      id: 51,
      type: "Task",
      title: "Read ticket",
      description: "Description",
      state: "Active",
      revision: 4,
    }),
    branch: null,
    integrationBranch: "refs/heads/hu/23438",
    effort: { estimated: 3, real: 1.25, realHours: 1.25 },
    completionEvidence: "evidence",
    pullRequests: [expect.objectContaining({ id: 99, mergeCommit: "merge-commit" })],
    canonicalPullRequest: 99,
    mergeCommit: "merge-commit",
  }));
  expect(fixtureValue.commands.some((args) => args[0] === "repos" && args[1] === "pr")).toBeTrue();
});

test("ticket-info does not infer a canonical PR without native association", async () => {
  const service = new AzureTicketInfoService(async (args) => {
    if (args[0] === "boards" && args.includes("23438")) return JSON.stringify({
      id: 23438,
      fields: { "System.WorkItemType": "User Story", "System.TeamProject": "Team" },
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" },
        { rel: "ArtifactLink", url: branch, attributes: { name: "Branch" } },
      ],
    });
    if (args[0] === "boards") return JSON.stringify({
      id: 51,
      fields: { "System.WorkItemType": "Task", "System.State": "Active" },
      relations: [],
    });
    if (args[0] === "repos" && args.includes("work-item")) return JSON.stringify([]);
    if (args[0] === "repos") return JSON.stringify([{
      pullRequestId: 99,
      status: "completed",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51-read",
      targetRefName: "refs/heads/hu/23438",
      lastMergeCommit: { commitId: "merge-commit" },
      repository: { id: "repository-id", project: { id: "project-id" } },
    }]);
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  const result = await service.getTicketInfo(23438, 51);

  expect(result.canonicalPullRequest).toBeNull();
  expect(result.gates.unmet).toContain("native-pr-association");
  expect(result.gates.unmet).not.toContain("completed-hu-targeted-pr");
});

test("ticket-info falls back for PR listing and native association without crossing repositories", async () => {
  const commands: string[][] = [];
  const service = new AzureTicketInfoService(async (args) => {
    commands.push(args);
    if (args[0] === "boards" && args.includes("23438")) return JSON.stringify({
      id: 23438,
      fields: { "System.WorkItemType": "User Story", "System.TeamProject": "Team" },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" }, {
        rel: "ArtifactLink", url: branch, attributes: { name: "Branch" },
      }],
    });
    if (args[0] === "boards") return JSON.stringify({
      id: 51,
      fields: { "System.WorkItemType": "Task", "System.State": "Active" },
      relations: [],
    });
    if (args[0] === "repos" && args.includes("work-item")) throw new Error("route unavailable");
    if (args[0] === "repos") throw new Error("route unavailable");
    if (args[0] === "rest" && args.some((value) => value.includes("pullrequests?"))) return JSON.stringify({ value: [{
      pullRequestId: 99,
      status: "completed",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51-read",
      targetRefName: "refs/heads/hu/23438",
      lastMergeCommit: { commitId: "merge-commit" },
      repository: { id: "repository-id", project: { id: "project-id" } },
    }] });
    if (args[0] === "rest") return JSON.stringify({ value: [{ id: 51 }] });
    throw new Error("unexpected command");
  });

  const result = await service.getTicketInfo(23438, 51);
  expect(result.canonicalPullRequest).toBe(99);
  expect(result.pullRequests[0]?.associated).toBeTrue();
  expect(commands.find((args) => args[0] === "repos" && args[1] === "pr" && !args.includes("work-item"))).toContain("--repository");
});

test("PR linking validates the exact ticket branch and verifies native association", async () => {
  let associated = false;
  const commands: string[][] = [];
  const service = new AzureTicketInfoService(async (args) => {
    commands.push(args);
    if (args[0] === "boards" && args.includes("23438")) return JSON.stringify({
      id: 23438,
      fields: { "System.WorkItemType": "User Story", "System.TeamProject": "Team" },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" }, {
        rel: "ArtifactLink", url: branch, attributes: { name: "Branch" },
      }],
    });
    if (args[0] === "boards") return JSON.stringify({
      id: 51,
      rev: 4,
      fields: { "System.WorkItemType": "Task" },
      relations: [{ rel: "ArtifactLink", url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBticket%2F51-read", attributes: { name: "Branch" } }],
    });
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "show") return JSON.stringify({
      pullRequestId: 99,
      status: "completed",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51-read",
      targetRefName: "refs/heads/hu/23438",
      lastMergeCommit: { commitId: "merge-commit" },
      repository: { id: "repository-id", project: { id: "project-id" } },
    });
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "list") return JSON.stringify([{
      pullRequestId: 99,
      status: "completed",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51-read",
      targetRefName: "refs/heads/hu/23438",
      lastMergeCommit: { commitId: "merge-commit" },
      repository: { id: "repository-id", project: { id: "project-id" } },
    }]);
    if (args[0] === "repos" && args[2] === "work-item" && args[3] === "add") {
      associated = true;
      return "{}";
    }
    if (args[0] === "repos" && args.includes("work-item")) return JSON.stringify(associated ? [51] : []);
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  await expect(service.linkPullRequest(23438, 51, 99)).resolves.toEqual({
    hu: 23438,
    ticket: 51,
    pullRequest: 99,
    mergeCommit: "merge-commit",
  });
  expect(commands.some((args) => args.includes("work-item") && args.includes("add"))).toBeTrue();
});

test("commit linking is idempotent and rejects a conflicting native commit", async () => {
  let fixed = false;
  const service = new AzureTicketInfoService(async (args) => {
    if (args[0] === "boards" && args.includes("23438")) return JSON.stringify({
      id: 23438,
      fields: { "System.WorkItemType": "User Story" },
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" },
        { rel: "ArtifactLink", url: branch, attributes: { name: "Branch" } },
      ],
    });
    if (args[0] === "boards") return JSON.stringify({
      id: 51,
      rev: 4,
      fields: { "System.WorkItemType": "Task" },
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" },
        { rel: "ArtifactLink", url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBticket%2F51-read", attributes: { name: "Branch" } },
        ...(fixed ? [{
        rel: "ArtifactLink",
        url: "vstfs:///Git/Commit/project-id%2Frepository-id%2Fmerge-commit",
        attributes: { name: "Fixed in Commit" },
        }] : []),
      ],
    });
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "show") return JSON.stringify({
      pullRequestId: 99,
      status: "completed",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51-read",
      targetRefName: "refs/heads/hu/23438",
      lastMergeCommit: { commitId: "merge-commit" },
      repository: { id: "repository-id", project: { id: "project-id" } },
    });
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "list") return JSON.stringify([{
      pullRequestId: 99,
      status: "completed",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51-read",
      targetRefName: "refs/heads/hu/23438",
      lastMergeCommit: { commitId: "merge-commit" },
      repository: { id: "repository-id", project: { id: "project-id" } },
    }]);
    if (args[0] === "repos" && args.includes("work-item")) return JSON.stringify([51]);
    if (args[0] === "rest" && args.includes("patch")) {
      fixed = true;
      return "{}";
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  await expect(service.linkCommit(51, 99)).resolves.toEqual(expect.objectContaining({
    ticket: 51,
    pullRequest: 99,
    mergeCommit: "merge-commit",
  }));
  await expect(service.linkCommit(51, 99)).resolves.toEqual(expect.objectContaining({
    artifactLink: "vstfs:///Git/Commit/project-id%2Frepository-id%2Fmerge-commit",
  }));
});

test("attachment validation records a digest and retries by digest", async () => {
  const path = `${process.env.TMPDIR ?? "/tmp"}/lazy-workflow-evidence-${crypto.randomUUID()}.json`;
  await Bun.write(path, '{\n  "status": "ok"\n}\n');
  let attached = false;
  let uploads = 0;
  let digest = "";
  let patchFailures = 1;
  try {
    const service = new AzureTicketInfoService(async (args) => {
      if (args[0] === "boards" && args.includes("23438")) return JSON.stringify({
        id: 23438,
        fields: { "System.WorkItemType": "User Story" },
        relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" }],
      });
      if (args[0] === "boards") return JSON.stringify({
        id: 51,
        rev: 4,
        fields: { "System.WorkItemType": "Task" },
        relations: [
          { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" },
          ...(attached ? [{
          rel: "AttachedFile",
          url: "https://example.test/evidence.json",
          attributes: { name: "evidence.json", comment: "http-json", digest },
          }] : []),
        ],
      });
      if (args[0] === "rest" && args.some((value) => value.includes("attachments?"))) {
        uploads += 1;
        return JSON.stringify({ url: "https://example.test/evidence.json" });
      }
      if (args[0] === "rest" && args.includes("patch")) {
        attached = true;
        const patch = JSON.parse(args[args.indexOf("--body") + 1]!);
        digest = patch[1].value.attributes.digest;
        if (patchFailures-- > 0) throw new Error("response lost after Azure applied relation");
        return "{}";
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });

    const first = await service.addAttachment(51, path, "http-json");
    const second = await service.addAttachment(51, path, "http-json");
    expect(first.url).toBe(second.url);
    expect(uploads).toBe(1);
  } finally {
    await unlink(path);
  }
});

test("ticket-info falls back to the authenticated Azure REST read boundary", async () => {
  const commands: string[][] = [];
  const service = new AzureTicketInfoService(async (args) => {
    commands.push(args);
    if (args[0] === "boards") throw new Error("Azure command failed: unrecognized arguments: --expand");
    if (args[0] === "rest") return JSON.stringify({ id: Number(args[args.indexOf("--uri") + 1]?.match(/workitems\/(\d+)/)?.[1]), rev: 1, fields: { "System.WorkItemType": "Task" }, relations: [] });
    throw new Error("unexpected command");
  });

  await expect(service.getTicket(51)).resolves.toEqual(expect.objectContaining({ id: 51, type: "Task" }));
  expect(commands[1]).toEqual(expect.arrayContaining([
    "rest",
    "--resource", "499b84ac-1321-427f-aa17-267ca6975798",
    "--method", "get",
  ]));
});

test("ticket reads reject invalid or non-direct delivery tickets", async () => {
  const service = new AzureTicketInfoService(async (args) => {
    if (args.includes("23438")) return JSON.stringify({ id: 23438, fields: { "System.WorkItemType": "User Story" }, relations: [] });
    return JSON.stringify({ id: 51, fields: { "System.WorkItemType": "Task" }, relations: [] });
  });

  await expect(service.getTicketInfo(23438, 51)).rejects.toThrow("hijo directo");
  await expect(service.getTicket(0)).rejects.toThrow("entero positivo");
  await expect(new AzureTicketInfoService(async () => JSON.stringify({ id: 51, fields: { "System.WorkItemType": "Epic" }, relations: [] })).getTicket(51))
    .rejects.toThrow("Task o Bug");
});

test("completion-info reports pinned-ticket-context when the HU relationship is invalid", async () => {
  const service = new AzureTicketInfoService(async (args) => {
    if (args.includes("23438")) return JSON.stringify({
      id: 23438,
      fields: { "System.WorkItemType": "User Story" },
      relations: [],
    });
    return JSON.stringify({
      id: 51,
      fields: { "System.WorkItemType": "Task" },
      relations: [],
    });
  });

  await expect(service.getCompletionInfo(23438, 51)).resolves.toEqual(expect.objectContaining({
    hu: 23438,
    ticket: 51,
    gates: expect.objectContaining({
      satisfied: [],
      unmet: expect.arrayContaining(["pinned-ticket-context"]),
    }),
  }));
});

test("ticket branch reads reject native links that are not valid Git refs", async () => {
  const service = new AzureTicketInfoService(async (args) => {
    if (args.includes("23438")) return JSON.stringify({
      id: 23438,
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" },
        { rel: "ArtifactLink", url: "vstfs:///Git/Ref/project%2Frepository%2FGBfoo..bar", attributes: { name: "Branch" } },
      ],
    });
    return JSON.stringify({ id: 51, fields: { "System.WorkItemType": "Task" }, relations: [] });
  });

  await expect(service.getBranch(23438, 51)).rejects.toThrow("URI de rama Azure Git malformada");
});

test("ticket read commands return one normalized JSON object without OpenCode", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  const info = {
    hu: { id: 23438 },
    ticket: { id: 51, type: "Task" as const },
    branch: null,
    integrationBranch: "refs/heads/hu/23438",
    effort: {},
    pullRequests: [],
    canonicalPullRequest: null,
    mergeCommit: null,
    attachments: [],
    completionEvidence: null,
    gates: { satisfied: [], unmet: [] },
  };
  const service = {
    getHuInfo: async () => { throw new Error("Azure HU path must not be used"); },
    waitForAccess: async () => undefined,
    getTicketInfo: async () => info,
    getBranch: async (hu: number, ticket: number) => ({ hu, ticket, branch: info.branch, integrationBranch: info.integrationBranch }),
    getDescription: async (ticket: number) => ({ ticket, description: "text" }),
    getState: async (ticket: number) => ({ ticket, state: "Active", revision: 4 }),
    getEffort: async (ticket: number) => ({ ticket, effort: { real: 1 } }),
    getAttachments: async (ticket: number) => ({ ticket, attachments: [] }),
    getEvidence: async (ticket: number) => ({ ticket, completionEvidence: null }),
  };

  try {
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    for (const args of [
      ["ticket-info", "--hu", "23438", "--ticket", "51"],
      ["ticket-description-info", "--ticket", "51"],
      ["ticket-state-info", "--ticket", "51"],
      ["ticket-effort-info", "--ticket", "51"],
      ["ticket-branch-info", "--hu", "23438", "--ticket", "51"],
      ["ticket-pr-info", "--hu", "23438", "--ticket", "51"],
      ["ticket-attachment-info", "--ticket", "51"],
      ["ticket-evidence-info", "--ticket", "51"],
      ["ticket-completion-info", "--hu", "23438", "--ticket", "51"],
    ]) {
      expect(await new LazyWorkflowCli(service).run(args)).toBe(0);
    }
  } finally {
    console.log = originalLog;
  }

  expect(output).toHaveLength(9);
  expect(JSON.parse(output[0]!)).toEqual(info);
  expect(JSON.parse(output[8]!)).toEqual({ hu: 23438, ticket: 51, gates: info.gates });
});

test("ticket mutation commands pass explicit identities and evidence files", async () => {
  const output: string[] = [];
  const calls: unknown[][] = [];
  const originalLog = console.log;
  const service = {
    getHuInfo: async () => { throw new Error("must not use generic HU read"); },
    waitForAccess: async () => undefined,
    linkPullRequest: async (...args: [number, number, number]) => { calls.push(args); return { pullRequest: args[2] }; },
    linkCommit: async (...args: [number, number]) => { calls.push(args); return { commit: args[1] }; },
    addAttachment: async (...args: [number, string, "http-json"]) => { calls.push(args); return { file: args[1] }; },
    setEvidence: async (...args: [number, string]) => { calls.push(args); return { file: args[1] }; },
  };

  try {
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    expect(await new LazyWorkflowCli(service).run(["ticket-pr-link", "--hu", "23438", "--ticket", "51", "--pr", "99"])).toBe(0);
    expect(await new LazyWorkflowCli(service).run(["ticket-commit-link", "--ticket", "51", "--pr", "99"])).toBe(0);
    expect(await new LazyWorkflowCli(service).run(["ticket-attachment-add", "--ticket", "51", "--file", "/tmp/evidence.json", "--kind", "http-json"])).toBe(0);
    expect(await new LazyWorkflowCli(service).run(["ticket-evidence-set", "--ticket", "51", "--evidence-file", "/tmp/evidence.html"])).toBe(0);
  } finally {
    console.log = originalLog;
  }

  expect(calls).toEqual([
    [23438, 51, 99],
    [51, 99],
    [51, "/tmp/evidence.json", "http-json"],
    [51, "/tmp/evidence.html"],
  ]);
  expect(output).toHaveLength(4);
});

test("ticket field setters use revision guards, reread their results, and retry idempotently", async () => {
  const items = new Map<number, { id: number; rev: number; fields: Record<string, unknown>; relations: unknown[] }>([
    [23438, {
      id: 23438,
      rev: 7,
      fields: { "System.WorkItemType": "User Story" },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" }],
    }],
    [51, {
      id: 51,
      rev: 4,
      fields: {
        "System.WorkItemType": "Task",
        "System.Description": "old",
        "System.State": "Active",
        "Custom.EsfuerzoReal": 1,
        "Custom.EsfuerzoRealHH": 1,
      },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" }],
    }],
  ]);
  const patches: unknown[][] = [];
  const service = new AzureTicketInfoService(async (args) => {
    if (args[0] === "boards") {
      const id = Number(args[args.indexOf("--id") + 1]);
      return JSON.stringify(items.get(id));
    }
    if (args[0] === "rest" && args.includes("patch")) {
      const id = Number(args[args.findIndex((value) => value.includes("workitems/"))]?.match(/workitems\/(\d+)/)?.[1]);
      const item = items.get(id)!;
      const patch = JSON.parse(args[args.indexOf("--body") + 1]!) as Array<{ op: string; path: string; value?: unknown }>;
      patches.push(patch);
      for (const operation of patch) {
        if (operation.path.startsWith("/fields/")) item.fields[operation.path.slice("/fields/".length)] = operation.value;
      }
      item.rev += 1;
      return JSON.stringify(item);
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });
  const descriptionPath = `/tmp/lazy-workflow-description-${crypto.randomUUID()}.html`;

  try {
    await Bun.write(descriptionPath, new Uint8Array([0xff]));
    await expect(service.setDescription(51, descriptionPath)).rejects.toThrow("UTF-8");
    await Bun.write(descriptionPath, "<p>new\nvalue</p>");
    await expect(service.setDescription(51, descriptionPath)).resolves.toEqual({
      ticket: 51,
      description: "<p>new\nvalue</p>",
      revision: 5,
    });
    await expect(service.setState(51, "Active", "Active")).resolves.toEqual({
      ticket: 51,
      state: "Active",
      revision: 5,
    });
    await expect(service.setState(51, "En progreso", "Active")).resolves.toEqual({
      ticket: 51,
      state: "En progreso",
      revision: 6,
    });
    await expect(service.setEffort(51, 2.25, 2.5, 6)).resolves.toEqual({
      ticket: 51,
      effort: { real: 2.25, realHours: 2.5 },
      revision: 7,
    });
    await expect(service.setEffort(51, 2.25, 2.5, 7)).resolves.toEqual({
      ticket: 51,
      effort: { real: 2.25, realHours: 2.5 },
      revision: 7,
    });
    await expect(service.setEffort(51, 2.25, 2.5, 6)).resolves.toEqual({
      ticket: 51,
      effort: { real: 2.25, realHours: 2.5 },
      revision: 7,
    });
    await expect(service.setEffort(51, 3, 3, 4)).rejects.toThrow("revision");
    await expect(service.setEffort(51, 2, 2, 7)).rejects.toThrow("no puede disminuir");
    await expect(service.setEffort(51, 2.1, 2.25, 7)).rejects.toThrow("0.25");
  } finally {
    await unlink(descriptionPath);
  }

  expect(patches).toHaveLength(3);
  expect(patches[0]).toEqual(expect.arrayContaining([
    { op: "test", path: "/rev", value: 4 },
    { op: "add", path: "/fields/System.Description", value: "<p>new\nvalue</p>" },
  ]));
  expect(patches[2]).toEqual(expect.arrayContaining([
    { op: "test", path: "/rev", value: 6 },
    { op: "add", path: "/fields/Custom.EsfuerzoReal", value: 2.25 },
    { op: "add", path: "/fields/Custom.EsfuerzoRealHH", value: 2.5 },
  ]));
});

test("ticket state setter rejects stale and unsupported transitions before Azure mutation", async () => {
  const service = new AzureTicketInfoService(async (args) => {
    if (args[0] === "boards" && args.includes("51")) return JSON.stringify({
      id: 51,
      rev: 4,
      fields: { "System.WorkItemType": "Task", "System.State": "Active" },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" }],
    });
    if (args[0] === "boards") return JSON.stringify({
      id: 23438,
      fields: { "System.WorkItemType": "User Story" },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" }],
    });
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  await expect(service.setState(51, "Done", "New")).rejects.toThrow("estado actual");
  await expect(service.setState(51, "Unknown", "Active")).rejects.toThrow("no soportado");
  await expect(service.setState(51, "Done", "Active")).rejects.toThrow("gates");
});

test("ticket state setter reconciles a patch that applied before its response was lost", async () => {
  let state = "Active";
  let revision = 4;
  const service = new AzureTicketInfoService(async (args) => {
    if (args[0] === "boards" && args.includes("51")) return JSON.stringify({
      id: 51,
      rev: revision,
      fields: { "System.WorkItemType": "Task", "System.State": state },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" }],
    });
    if (args[0] === "boards") return JSON.stringify({
      id: 23438,
      fields: { "System.WorkItemType": "User Story" },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" }],
    });
    if (args[0] === "rest" && args.includes("patch")) {
      state = "En progreso";
      revision = 5;
      throw new Error("response lost after Azure applied patch");
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  await expect(service.setState(51, "En progreso", "Active")).resolves.toEqual({
    ticket: 51,
    state: "En progreso",
    revision: 5,
  });
});

test("ticket mutations reject a non-HU or ambiguous direct parent", async () => {
  const service = new AzureTicketInfoService(async (args) => {
    if (args[0] === "boards" && args.includes("51")) return JSON.stringify({
      id: 51,
      rev: 4,
      fields: { "System.WorkItemType": "Task", "System.State": "Active" },
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" },
        { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23439" },
      ],
    });
    return JSON.stringify({ id: 23438, fields: { "System.WorkItemType": "User Story" }, relations: [] });
  });

  await expect(service.setState(51, "En progreso", "Active")).rejects.toThrow("única HU");

  const nonHu = new AzureTicketInfoService(async (args) => {
    if (args[0] === "boards" && args.includes("51")) return JSON.stringify({
      id: 51,
      rev: 4,
      fields: { "System.WorkItemType": "Task", "System.State": "Active" },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" }],
    });
    return JSON.stringify({
      id: 23438,
      fields: { "System.WorkItemType": "Task" },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" }],
    });
  });
  await expect(nonHu.setState(51, "En progreso", "Active")).rejects.toThrow("no es una HU");
});

test("ticket field mutation commands validate their explicit contracts", async () => {
  const calls: unknown[][] = [];
  const service = {
    getHuInfo: async () => { throw new Error("must not use generic HU read"); },
    waitForAccess: async () => undefined,
    setDescription: async (...args: [number, string]) => { calls.push(args); return { ticket: args[0] }; },
    setState: async (...args: [number, string, string]) => { calls.push(args); return { ticket: args[0] }; },
    setEffort: async (...args: [number, number, number, number]) => { calls.push(args); return { ticket: args[0] }; },
  };
  const output: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    expect(await new LazyWorkflowCli(service).run([
      "ticket-description-set", "--ticket", "51", "--description-file", "/tmp/description.html",
    ])).toBe(0);
    expect(await new LazyWorkflowCli(service).run([
      "ticket-state-set", "--ticket", "51", "--state", "En progreso", "--expected-state", "Active",
    ])).toBe(0);
    expect(await new LazyWorkflowCli(service).run([
      "ticket-effort-set", "--ticket", "51", "--real-effort", "2.25", "--real-effort-hh", "2.5", "--expected-rev", "7",
    ])).toBe(0);
    expect(await new LazyWorkflowCli(service).run([
      "ticket-effort-set", "--ticket", "51", "--real-effort-hh", "2.5", "--expected-rev", "7",
    ])).toBe(1);
  } finally {
    console.log = originalLog;
  }
  expect(calls).toEqual([
    [51, "/tmp/description.html"],
    [51, "En progreso", "Active"],
    [51, 2.25, 2.5, 7],
  ]);
  expect(output).toHaveLength(3);
});

test("ticket-completion-apply passes the explicit HU, ticket, PR, manifest, and working directory", async () => {
  const calls: unknown[][] = [];
  const output: string[] = [];
  const originalLog = console.log;
  const info = {
    hu: { id: 23438 },
    ticket: { id: 51, type: "Task" as const, state: "Done" },
    branch: "refs/heads/ticket/51",
    integrationBranch: "refs/heads/hu/23438",
    effort: { real: 1, realHours: 1 },
    pullRequests: [],
    canonicalPullRequest: 99,
    mergeCommit: "merge",
    attachments: [],
    completionEvidence: "evidence",
    gates: { satisfied: [], unmet: [] },
  };
  const manifest = {
    ticket: 51,
    ticketBranch: "refs/heads/ticket/51",
    commit: "a".repeat(40),
    validation: [{ command: "bun test", result: "pass" }],
    evidence: [],
  };
  const service = {
    getHuInfo: async () => { throw new Error("must not use generic HU read"); },
    waitForAccess: async () => undefined,
    getTicketInfo: async () => info,
    readCompletionManifest: async (path: string) => { calls.push(["manifest", path]); return manifest; },
    validateCompletionManifest: async (...args: [unknown, unknown, number, string]) => { calls.push(["validate", ...args.slice(2)]); },
    validateEvidenceFile: async () => undefined,
    validateEvidence: async () => undefined,
    linkPullRequest: async () => { throw new Error("must not link an existing PR"); },
    linkCommit: async () => { throw new Error("must not link an existing commit"); },
    addAttachment: async () => { throw new Error("must not add an existing attachment"); },
    setEvidence: async () => { throw new Error("must not set existing evidence"); },
    setState: async () => { throw new Error("must not set an existing state"); },
  };

  try {
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    expect(await new LazyWorkflowCli(service).run([
      "ticket-completion-apply",
      "--hu", "23438",
      "--ticket", "51",
      "--pr", "99",
      "--manifest", "/tmp/completion.json",
      "--working-directory", "/repo",
    ])).toBe(0);
  } finally {
    console.log = originalLog;
  }

  expect(calls).toEqual([
    ["manifest", "/tmp/completion.json"],
    ["validate", 51, "/repo"],
  ]);
  expect(JSON.parse(output[0]!)).toEqual({
    hu: 23438,
    ticket: 51,
    pullRequest: 99,
    manifest: "/tmp/completion.json",
    state: "Done",
    gates: { satisfied: [], unmet: [] },
  });
});

test("completion apply reconciles missing effects before moving the ticket to Done", async () => {
  const evidencePath = `/tmp/lazy-workflow-completion-${crypto.randomUUID()}.json`;
  const manifestPath = `/tmp/lazy-workflow-manifest-${crypto.randomUUID()}.json`;
  const commit = "a".repeat(40);
  const evidence = '{\n  "ok": true\n}\n';
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(evidence)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await Bun.write(evidencePath, evidence);
  await Bun.write(manifestPath, JSON.stringify({
    ticket: 51,
    ticketBranch: "refs/heads/ticket/51",
    commit,
    validation: [{ command: "bun test", result: "18 passed" }],
    evidence: [{ path: evidencePath, kind: "http-json", sha256: digest }],
  }));

  const calls: string[] = [];
  let state = "Active";
  let canonicalPullRequest: number | null = null;
  let hasCommit = false;
  let hasAttachment = false;
  let completionEvidence: string | null = null;
  try {
    const base = new class extends AzureTicketInfoService {
      constructor() {
        super(async () => "", async (args) =>
          args[0] === "rev-parse" ? commit : args[0] === "status" ? "" : "ticket/51\n");
      }

      override async getTicketInfo(): Promise<any> {
        const unmet = state === "Done" ? [] : [
          "ticket-state",
          ...(completionEvidence ? [] : ["completion-evidence"]),
          ...(hasCommit ? [] : ["merge-commit-artifact-link"]),
        ];
        return {
          hu: { id: 23438 },
          ticket: { id: 51, type: "Task", state },
          branch: "refs/heads/ticket/51",
          integrationBranch: "refs/heads/hu/23438",
          effort: { real: 1, realHours: 1 },
          pullRequests: [],
          canonicalPullRequest,
          mergeCommit: hasCommit ? "merge" : null,
          attachments: hasAttachment ? [{ kind: "AttachedFile", evidenceKind: "http-json", digest }] : [],
          completionEvidence,
          gates: { satisfied: [], unmet },
        };
      }

      override async readCompletionManifest(): Promise<any> {
        return {
          ticket: 51,
          ticketBranch: "refs/heads/ticket/51",
          commit,
          validation: [{ command: "bun test", result: "18 passed" }],
          evidence: [{ path: evidencePath, kind: "http-json", sha256: digest }],
        };
      }

      override async validateCompletionManifest(manifest: any, info: any, ticket: number, workingDirectory: string): Promise<void> {
        return super.validateCompletionManifest(manifest, info, ticket, workingDirectory);
      }

      override async validateEvidence(): Promise<void> {}

      override async linkPullRequest(): Promise<any> {
        calls.push("pr");
        canonicalPullRequest = 99;
        return {};
      }

      override async linkCommit(): Promise<any> {
        calls.push("commit");
        hasCommit = true;
        return {};
      }

      override async addAttachment(): Promise<any> {
        calls.push("attachment");
        hasAttachment = true;
        return {};
      }

      override async setEvidence(): Promise<any> {
        calls.push("evidence");
        completionEvidence = evidence;
        return {};
      }

      override async setState(): Promise<any> {
        calls.push("state");
        state = "Done";
        return {};
      }
    }();
    const service = {
      getHuInfo: async () => new HuInfo({ id: 23438 }),
      waitForAccess: async () => undefined,
      getTicketInfo: base.getTicketInfo.bind(base),
      readCompletionManifest: base.readCompletionManifest.bind(base),
      validateCompletionManifest: base.validateCompletionManifest.bind(base),
      validateEvidenceFile: base.validateEvidenceFile.bind(base),
      validateEvidence: base.validateEvidence.bind(base),
      linkPullRequest: base.linkPullRequest.bind(base),
      linkCommit: base.linkCommit.bind(base),
      addAttachment: base.addAttachment.bind(base),
      setEvidence: base.setEvidence.bind(base),
      setState: base.setState.bind(base),
    };

    await expect(new LazyWorkflowCli(service).run([
      "ticket-completion-apply", "--hu", "23438", "--ticket", "51", "--pr", "99",
      "--manifest", manifestPath, "--working-directory", "/repo",
    ])).resolves.toBe(0);
    expect(calls).toEqual(["pr", "commit", "attachment", "evidence", "state"]);
  } finally {
    await unlink(evidencePath);
    await unlink(manifestPath);
  }
});
