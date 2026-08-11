import { expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { AzureTicketInfoService } from "../src/azure/ticket-info-service.ts";
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
          attributes: { name: "evidence.json" },
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
    if (args.includes("23438")) return JSON.stringify({ id: 23438, fields: {}, relations: [] });
    return JSON.stringify({ id: 51, fields: { "System.WorkItemType": "Task" }, relations: [] });
  });

  await expect(service.getTicketInfo(23438, 51)).rejects.toThrow("hijo directo");
  await expect(service.getTicket(0)).rejects.toThrow("entero positivo");
  await expect(new AzureTicketInfoService(async () => JSON.stringify({ id: 51, fields: { "System.WorkItemType": "Epic" }, relations: [] })).getTicket(51))
    .rejects.toThrow("Task o Bug");
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
