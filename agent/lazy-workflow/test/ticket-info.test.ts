import { expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { AzureTicketInfoService, commandError } from "../src/azure/ticket-info-service.ts";
import { AzureAutocodeService } from "../src/azure/autocode-service.ts";
import { HuInfo } from "../src/azure/hu-info.ts";
import { createCli } from "./_helpers/create-cli.ts";

const branch = "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBhu%2F23438";

test("el boundary Azure de produccion expone las primitivas de publicación", () => {
  const service = new AzureAutocodeService(async () => JSON.stringify({ id: 1, relations: [] }));

  for (const operation of ["createTicket", "linkParent", "linkPredecessor"] as const) {
    expect(typeof service[operation]).toBe("function");
  }
});

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
        }, {
          rel: "ArtifactLink",
          url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBticket%2F51-read",
          attributes: { name: "Branch" },
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
        lastMergeSourceCommit: { commitId: "source-merge-commit" },
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
    branch: "refs/heads/ticket/51-read",
    integrationBranch: "refs/heads/hu/23438",
    effort: { estimated: 3, real: 1.25, realHours: 1.25 },
    completionEvidence: "evidence",
    pullRequests: [expect.objectContaining({ id: 99, mergeCommit: "merge-commit" })],
    canonicalPullRequest: 99,
    mergeCommit: "merge-commit",
  }));
  expect(fixtureValue.commands.some((args) => args[0] === "repos" && args[1] === "pr")).toBeTrue();
});

test("ticket-info resolves the delivery repository from the ticket branch, not the HU branch", async () => {
  const commands: string[][] = [];
  const service = new AzureTicketInfoService(async (args) => {
    commands.push(args);
    if (args[0] === "boards" && args.includes("23438")) return JSON.stringify({
      id: 23438,
      fields: { "System.WorkItemType": "User Story", "System.TeamProject": "Team" },
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" },
        { rel: "ArtifactLink", url: "vstfs:///Git/Ref/project-id%2Fanchor-repo-id%2FGBhu%2F23438", attributes: { name: "Branch" } },
      ],
    });
    if (args[0] === "boards") return JSON.stringify({
      id: 51,
      rev: 4,
      fields: { "System.WorkItemType": "Task", "System.State": "Active" },
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" },
        { rel: "ArtifactLink", url: "vstfs:///Git/Ref/project-id%2Fprimary-repo-id%2FGBticket%2F51", attributes: { name: "Branch" } },
      ],
    });
    if (args[0] === "repos" && args.includes("work-item")) return JSON.stringify([51]);
    if (args[0] === "repos") return JSON.stringify([{
      pullRequestId: 99,
      status: "completed",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51",
      targetRefName: "refs/heads/hu/23438",
      lastMergeCommit: { commitId: "merge-commit" },
      lastMergeSourceCommit: { commitId: "source-merge-commit" },
      repository: { id: "primary-repo-id", project: { id: "project-id" } },
    }]);
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  // A multi-repository delivery anchors the HU branch and the ticket branch in different
  // repositories of the same project; the ticket's PR lives with the ticket branch.
  const result = await service.getTicketInfo(23438, 51);

  expect(result.canonicalPullRequest).toBe(99);
  expect(result.mergeCommit).toBe("merge-commit");
  const list = commands.find((args) => args[0] === "repos" && args[2] === "list");
  expect(list![list!.indexOf("--repository") + 1]).toBe("primary-repo-id");
});

test("getBranch reports a ticket branch anchored in a different repository than the HU branch", async () => {
  const service = new AzureTicketInfoService(async (args) => {
    if (args[0] === "boards" && args.includes("23438")) return JSON.stringify({
      id: 23438,
      fields: { "System.WorkItemType": "User Story", "System.TeamProject": "Team" },
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" },
        { rel: "ArtifactLink", url: "vstfs:///Git/Ref/project-id%2Fanchor-repo-id%2FGBhu%2F23438", attributes: { name: "Branch" } },
      ],
    });
    if (args[0] === "boards") return JSON.stringify({
      id: 51,
      fields: { "System.WorkItemType": "Task", "System.State": "Active" },
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" },
        { rel: "ArtifactLink", url: "vstfs:///Git/Ref/project-id%2Fprimary-repo-id%2FGBticket%2F51", attributes: { name: "Branch" } },
      ],
    });
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  // ticket-branch-info must stay readable for a ticket delivered across repositories.
  await expect(service.getBranch(23438, 51)).resolves.toEqual({
    hu: 23438,
    ticket: 51,
    branch: "refs/heads/ticket/51",
    integrationBranch: "refs/heads/hu/23438",
  });
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
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" },
        { rel: "ArtifactLink", url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBticket%2F51-read", attributes: { name: "Branch" } },
      ],
    });
    if (args[0] === "repos" && args.includes("work-item")) return JSON.stringify([]);
    if (args[0] === "repos") return JSON.stringify([{
      pullRequestId: 99,
      status: "completed",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51-read",
      targetRefName: "refs/heads/hu/23438",
      lastMergeCommit: { commitId: "merge-commit" },
      lastMergeSourceCommit: { commitId: "source-merge-commit" },
      repository: { id: "repository-id", project: { id: "project-id" } },
    }]);
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  const result = await service.getTicketInfo(23438, 51);

  expect(result.canonicalPullRequest).toBeNull();
  expect(result.gates.unmet).toContain("native-pr-association");
  expect(result.gates.unmet).not.toContain("completed-hu-targeted-pr");
});

test("coordinator creates and verifies one exact HU-targeted pull request", async () => {
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
      fields: { "System.WorkItemType": "Task", "System.State": "En progreso" },
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" },
        { rel: "ArtifactLink", url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBticket%2F51" , attributes: { name: "Branch" } },
      ],
    });
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "list") return JSON.stringify([]);
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "create") return JSON.stringify({
      pullRequestId: 99,
      status: "active",
      mergeStatus: "notSet",
      sourceRefName: "refs/heads/ticket/51",
      targetRefName: "refs/heads/hu/23438",
      repository: { id: "repository-id", project: { id: "project-id" } },
    });
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "update") return "{}";
    if (args[0] === "rest" && args.includes("patch")) throw new Error("REST unavailable");
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "show") return JSON.stringify({
      pullRequestId: 99,
      status: "completed",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51",
      targetRefName: "refs/heads/hu/23438",
      lastMergeCommit: { commitId: "merge-commit" },
      lastMergeSourceCommit: { commitId: "source-merge-commit" },
      repository: { id: "repository-id", project: { id: "project-id" } },
    });
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  await expect(service.createOrReusePullRequest(23438, 51)).resolves.toEqual({
    pullRequest: 99,
    mergeCommit: "merge-commit",
  });
  expect(commands.some((args) => args[2] === "create")).toBeTrue();
  // Azure rejects a completion that does not echo the source commit its merge was computed from.
  const complete = commands.find((args) => args[0] === "rest" && args.includes("patch"));
  expect(complete).toBeDefined();
  expect(JSON.parse(complete![complete!.indexOf("--body") + 1]!)).toEqual({
    status: "completed",
    lastMergeSourceCommit: { commitId: "source-merge-commit" },
    completionOptions: { deleteSourceBranch: true },
  });
  const fallback = commands.find((args) => args[0] === "repos" && args[1] === "pr" && args[2] === "update");
  const deleteSourceBranch = fallback?.indexOf("--delete-source-branch") ?? -1;
  expect(fallback?.slice(deleteSourceBranch, deleteSourceBranch + 2)).toEqual(["--delete-source-branch", "true"]);
});

test("coordinator creates the pull request in the participant repository, not the ticket's linked one", async () => {
  const commands: string[][] = [];
  const service = new AzureTicketInfoService(async (args) => {
    commands.push(args);
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "list") return JSON.stringify([]);
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "create") return JSON.stringify({
      pullRequestId: 77,
      status: "active",
      mergeStatus: "notSet",
      sourceRefName: "refs/heads/ticket/51",
      targetRefName: "refs/heads/hu/23438",
      repository: { id: "participant-repository-id", name: "participant-repository", project: { id: "participant-project-id", name: "participant-project" } },
    });
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "update") return "{}";
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "show") return JSON.stringify({
      pullRequestId: 77,
      status: "completed",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51",
      targetRefName: "refs/heads/hu/23438",
      lastMergeCommit: { commitId: "participant-merge" },
      lastMergeSourceCommit: { commitId: "source-participant-merge" },
      repository: { id: "participant-repository-id", name: "participant-repository", project: { id: "participant-project-id", name: "participant-project" } },
    });
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  await expect(service.createOrReusePullRequest(23438, 51, {
    project: "participant-project-id",
    repository: "participant-repository-id",
    source: "refs/heads/ticket/51",
    target: "refs/heads/hu/23438",
  })).resolves.toEqual({ pullRequest: 77, mergeCommit: "participant-merge" });

  const create = commands.find((args) => args[2] === "create");
  expect(create).toBeDefined();
  expect(create![create!.indexOf("--repository") + 1]).toBe("participant-repository-id");
  expect(create![create!.indexOf("--project") + 1]).toBe("participant-project-id");
  expect(create![create!.indexOf("--target-branch") + 1]).toBe("refs/heads/hu/23438");
  expect(commands.some((args) => args[0] === "boards")).toBeFalse();
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
      relations: [{ rel: "ArtifactLink", url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBticket%2F51-read", attributes: { name: "Branch" } }],
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
      lastMergeSourceCommit: { commitId: "source-merge-commit" },
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
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" },
        { rel: "ArtifactLink", url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBticket%2F51-read", attributes: { name: "Branch" } },
      ],
    });
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "show") return JSON.stringify({
      pullRequestId: 99,
      status: "completed",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51-read",
      targetRefName: "refs/heads/hu/23438",
      lastMergeCommit: { commitId: "merge-commit" },
      lastMergeSourceCommit: { commitId: "source-merge-commit" },
      repository: { id: "repository-id", project: { id: "project-id" } },
    });
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "list") return JSON.stringify([{
      pullRequestId: 99,
      status: "completed",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51-read",
      targetRefName: "refs/heads/hu/23438",
      lastMergeCommit: { commitId: "merge-commit" },
      lastMergeSourceCommit: { commitId: "source-merge-commit" },
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
      lastMergeSourceCommit: { commitId: "source-merge-commit" },
      repository: { id: "repository-id", project: { id: "project-id" } },
    });
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "list") return JSON.stringify([{
      pullRequestId: 99,
      status: "completed",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51-read",
      targetRefName: "refs/heads/hu/23438",
      lastMergeCommit: { commitId: "merge-commit" },
      lastMergeSourceCommit: { commitId: "source-merge-commit" },
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

test("linking a participant merge commit is idempotent and keeps the primary Fixed in Commit", async () => {
  const primary = "vstfs:///Git/Commit/project-id%2Frepository-id%2Fprimary-merge";
  const participantLink = "vstfs:///Git/Commit/participant-project-id%2Fparticipant-repository-id%2Fparticipant-merge";
  let patches = 0;
  let linked = false;
  const service = new AzureTicketInfoService(async (args) => {
    if (args[0] === "boards" && args.includes("23438")) return JSON.stringify({
      id: 23438,
      fields: { "System.WorkItemType": "User Story" },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" }],
    });
    if (args[0] === "boards") return JSON.stringify({
      id: 51,
      rev: 4,
      fields: { "System.WorkItemType": "Task", "Custom.URLCommit": primary },
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" },
        { rel: "ArtifactLink", url: primary, attributes: { name: "Fixed in Commit" } },
        ...(linked ? [{ rel: "ArtifactLink", url: participantLink, attributes: { name: "Fixed in Commit" } }] : []),
      ],
    });
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "show") return JSON.stringify({
      pullRequestId: 77,
      status: "completed",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51",
      targetRefName: "refs/heads/hu/23438",
      lastMergeCommit: { commitId: "participant-merge" },
      lastMergeSourceCommit: { commitId: "source-participant-merge" },
      repository: { id: "participant-repository-id", name: "participant-repository", project: { id: "participant-project-id", name: "participant-project" } },
    });
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "list") return JSON.stringify([{
      pullRequestId: 77,
      status: "completed",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51",
      targetRefName: "refs/heads/hu/23438",
      lastMergeCommit: { commitId: "participant-merge" },
      lastMergeSourceCommit: { commitId: "source-participant-merge" },
      repository: { id: "participant-repository-id", name: "participant-repository", project: { id: "participant-project-id", name: "participant-project" } },
    }]);
    if (args[0] === "repos" && args.includes("work-item")) return JSON.stringify([51]);
    if (args[0] === "rest" && args.includes("patch")) {
      patches += 1;
      linked = true;
      return "{}";
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  const participant = {
    project: "participant-project-id",
    repository: "participant-repository-id",
    source: "refs/heads/ticket/51",
    target: "refs/heads/hu/23438",
  };
  await expect(service.linkCommit(51, 77, participant)).resolves.toEqual(expect.objectContaining({
    artifactLink: participantLink,
  }));
  await expect(service.linkCommit(51, 77, participant)).resolves.toEqual(expect.objectContaining({
    artifactLink: participantLink,
  }));
  expect(patches).toBe(1);
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
    validateDirectTicketContext: async () => undefined,
    getBranch: async (hu: number, ticket: number) => ({ hu, ticket, branch: info.branch, integrationBranch: info.integrationBranch }),
    getDescription: async (ticket: number) => ({ ticket, description: "text" }),
    getState: async (ticket: number) => ({ ticket, state: "Active", revision: 4 }),
    getEffort: async (ticket: number) => ({ ticket, effort: { real: 1 } }),
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
      ["ticket-completion-info", "--hu", "23438", "--ticket", "51"],
    ]) {
      expect(await createCli({ huInfoService: service }).run(args)).toBe(0);
    }
  } finally {
    console.log = originalLog;
  }

  expect(output).toHaveLength(7);
  expect(JSON.parse(output[0]!)).toEqual(info);
  expect(JSON.parse(output[6]!)).toEqual({ hu: 23438, ticket: 51, gates: info.gates });
});

test("ticket mutation commands pass explicit identities", async () => {
  const output: string[] = [];
  const calls: unknown[][] = [];
  const originalLog = console.log;
  const service = {
    getHuInfo: async () => { throw new Error("must not use generic HU read"); },
    waitForAccess: async () => undefined,
    linkPullRequest: async (...args: [number, number, number]) => { calls.push(args); return { pullRequest: args[2] }; },
    linkCommit: async (...args: [number, number]) => { calls.push(args); return { commit: args[1] }; },
  };

  try {
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    expect(await createCli({ huInfoService: service }).run(["ticket-pr-link", "--hu", "23438", "--ticket", "51", "--pr", "99"])).toBe(0);
    expect(await createCli({ huInfoService: service }).run(["ticket-commit-link", "--ticket", "51", "--pr", "99"])).toBe(0);
  } finally {
    console.log = originalLog;
  }

  expect(calls).toEqual([
    [23438, 51, 99],
    [51, 99],
  ]);
  expect(output).toHaveLength(2);
});

test("ticket publication commands reach the required Azure boundary operations", async () => {
  const calls: unknown[][] = [];
  const output: string[] = [];
  const originalLog = console.log;
  const service = {
    getHuInfo: async () => { throw new Error("must not use generic HU read"); },
    waitForAccess: async () => undefined,
    createTicket: async (...args: [{ hu: number; type: string; title: string; descriptionFile: string }]) => {
      calls.push(args);
      return { hu: args[0].hu, ticket: 52, type: args[0].type, title: args[0].title, created: true };
    },
    linkParent: async (...args: [number, number]) => {
      calls.push(args);
      return { parent: args[0], child: args[1], linked: true };
    },
    linkPredecessor: async (...args: [number, number]) => {
      calls.push(args);
      return { blocker: args[0], blocked: args[1], linked: true };
    },
  };

  try {
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    expect(await createCli({ huInfoService: service }).run([
      "ticket-create", "--hu", "23438", "--type", "Task", "--title", "Slice", "--description-file", "/tmp/slice.html",
    ])).toBe(0);
    expect(await createCli({ huInfoService: service }).run(["ticket-link-parent", "--parent", "23438", "--child", "52"])).toBe(0);
    expect(await createCli({ huInfoService: service }).run(["ticket-link-predecessor", "--blocker", "52", "--blocked", "53"])).toBe(0);
  } finally {
    console.log = originalLog;
  }

  expect(calls).toEqual([
    [{ hu: 23438, type: "Task", title: "Slice", descriptionFile: "/tmp/slice.html" }],
    [23438, 52],
    [52, 53],
  ]);
  expect(output).toHaveLength(3);
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

test("ticket state setter normalizes In Progress to the exact En progreso delivery state", async () => {
  let state = "In Progress";
  let revision = 4;
  const patches: Array<Array<{ op: string; path: string; value?: unknown }>> = [];
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
      const patch = JSON.parse(args[args.indexOf("--body") + 1]!) as Array<{ op: string; path: string; value?: unknown }>;
      patches.push(patch);
      state = "En progreso";
      revision += 1;
      return JSON.stringify({ id: 51, rev: revision, fields: { "System.WorkItemType": "Task", "System.State": state } });
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  await expect(service.setState(51, "En progreso", "In Progress", false, 4)).resolves.toEqual({
    ticket: 51,
    state: "En progreso",
    revision: 5,
  });
  expect(patches[0]).toEqual(expect.arrayContaining([
    { op: "test", path: "/rev", value: 4 },
    { op: "replace", path: "/fields/System.State", value: "En progreso" },
  ]));
});

test("ticket state setter reaches Done from Scrum SAG's own states, not only the stock ones", async () => {
  // ScrumSAG.Task starts work items in "En espera" (Proposed) instead of "New", and resolves
  // them through "En revisión" (Resolved) instead of "Resolved" — the coordinator's own
  // completion step (`En espera` -> `Done` with `allowCompletion`) has to reach across both.
  const stateSetterFixture = (initialState: string) => {
    let state = initialState;
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
        state = "Done";
        revision = 5;
        return JSON.stringify({ id: 51, rev: revision, fields: { "System.WorkItemType": "Task", "System.State": state } });
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });
    return service;
  };

  await expect(stateSetterFixture("En espera").setState(51, "Done", "En espera", true, 4)).resolves.toEqual({
    ticket: 51,
    state: "Done",
    revision: 5,
  });
  await expect(stateSetterFixture("En revisión").setState(51, "Done", "En revisión", true, 4)).resolves.toEqual({
    ticket: 51,
    state: "Done",
    revision: 5,
  });
});


test("hasOpenDeliveryChildren treats Scrum SAG's En espera and En revisión as open, not just Active/Resolved", async () => {
  const childInState = (state: string) => new AzureTicketInfoService(async (args) => {
    if (args[0] === "boards" && args.includes("23438")) return JSON.stringify({
      id: 23438,
      fields: { "System.WorkItemType": "Product Backlog Item" },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" }],
    });
    return JSON.stringify({
      id: 51,
      fields: { "System.WorkItemType": "Task", "System.State": state, "System.Title": "Child" },
      relations: [],
    });
  });

  await expect(childInState("En espera").hasOpenDeliveryChildren(23438)).resolves.toBeTrue();
  await expect(childInState("En revisión").hasOpenDeliveryChildren(23438)).resolves.toBeTrue();
  await expect(childInState("Done").hasOpenDeliveryChildren(23438)).resolves.toBeFalse();
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

test("getHuChildren accepts a Product Backlog Item parent, not only User Story", async () => {
  const service = new AzureTicketInfoService(async (args) => {
    if (args[0] === "boards" && args.includes("23438")) return JSON.stringify({
      id: 23438,
      fields: { "System.WorkItemType": "Product Backlog Item" },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" }],
    });
    return JSON.stringify({
      id: 51,
      fields: { "System.WorkItemType": "Task", "System.State": "En espera", "System.Title": "Child" },
      relations: [],
    });
  });

  await expect(service.getHuChildren(23438)).resolves.toEqual([
    { id: 51, type: "Task", state: "En espera", title: "Child" },
  ]);
});

test("getHuChildren still rejects a parent that is neither User Story nor Product Backlog Item", async () => {
  const service = new AzureTicketInfoService(async () => JSON.stringify({
    id: 23438,
    fields: { "System.WorkItemType": "Epic" },
    relations: [],
  }));

  await expect(service.getHuChildren(23438)).rejects.toThrow("no es una User Story ni un Product Backlog Item");
});

test("validateDirectTicketContext accepts a Product Backlog Item HU and still rejects other types", async () => {
  const az = (huType: string) => async (args: string[]) => {
    if (args[0] === "boards" && args.includes("23438")) {
      return JSON.stringify({
        id: 23438,
        fields: { "System.WorkItemType": huType },
        relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" }],
      });
    }
    return JSON.stringify({
      id: 51,
      rev: 4,
      fields: { "System.WorkItemType": "Task", "System.State": "Active" },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" }],
    });
  };

  await expect(new AzureTicketInfoService(az("Product Backlog Item")).validateDirectTicketContext(23438, 51))
    .resolves.toBeUndefined();
  await expect(new AzureTicketInfoService(az("Epic")).validateDirectTicketContext(23438, 51))
    .rejects.toThrow("no es una User Story ni un Product Backlog Item");
});

test("getTicketInfo accepts a Product Backlog Item HU and still rejects other types", async () => {
  const az = (huType: string) => async (args: string[]) => {
    if (args[0] === "boards" && args.includes("23438")) {
      return JSON.stringify({
        id: 23438,
        fields: { "System.WorkItemType": huType, "System.Title": "HU", "System.TeamProject": "Team" },
        relations: [
          { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" },
          { rel: "ArtifactLink", url: branch, attributes: { name: "Branch" } },
        ],
      });
    }
    if (args[0] === "boards") {
      return JSON.stringify({
        id: 51,
        rev: 4,
        fields: { "System.WorkItemType": "Task", "System.Title": "Read ticket", "System.State": "Active" },
        relations: [
          { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" },
          { rel: "ArtifactLink", url: "vstfs:///Git/Ref/project-id%2Frepository-id%2FGBticket%2F51-read", attributes: { name: "Branch" } },
        ],
      });
    }
    if (args[0] === "repos" && args.includes("work-item")) return JSON.stringify([51]);
    if (args[0] === "repos") return JSON.stringify([]);
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };

  await expect(new AzureTicketInfoService(az("Product Backlog Item")).getTicketInfo(23438, 51))
    .resolves.toMatchObject({ hu: { id: 23438, title: "HU" }, branch: "refs/heads/ticket/51-read" });
  await expect(new AzureTicketInfoService(az("Epic")).getTicketInfo(23438, 51))
    .rejects.toThrow("no es una User Story ni un Product Backlog Item");
});

test("setHuState accepts a Product Backlog Item HU and still rejects other types", async () => {
  const az = (huType: string) => async () => JSON.stringify({
    id: 23438,
    rev: 7,
    fields: { "System.WorkItemType": huType, "System.State": "Active" },
    relations: [],
  });

  // A no-op transition exercises the work item type gate without patching the HU.
  await expect(new AzureTicketInfoService(az("Product Backlog Item")).setHuState(23438, "Active", "Active", 7))
    .resolves.toEqual({ hu: 23438, state: "Active", revision: 7 });
  await expect(new AzureTicketInfoService(az("Epic")).setHuState(23438, "Active", "Active", 7))
    .rejects.toThrow("no es una User Story ni un Product Backlog Item");
});

test("getHuState reads a Product Backlog Item HU that getState (Task/Bug-only) rejects", async () => {
  // The multi-repository workspace coordinator has to read and verify the HU's own state
  // around its "Desarrollo Terminado" transition — getState/readWorkItemValidated only accept
  // Task or Bug, so calling it on the HU itself always threw "no es un Task o Bug de entrega".
  const az = (workItemType: string) => async () => JSON.stringify({
    id: 23438,
    rev: 7,
    fields: { "System.WorkItemType": workItemType, "System.State": "En Desarrollo" },
    relations: [],
  });

  await expect(new AzureTicketInfoService(az("Product Backlog Item")).getHuState(23438))
    .resolves.toEqual({ hu: 23438, state: "En Desarrollo", revision: 7 });
  await expect(new AzureTicketInfoService(az("User Story")).getHuState(23438))
    .resolves.toEqual({ hu: 23438, state: "En Desarrollo", revision: 7 });
  await expect(new AzureTicketInfoService(az("Product Backlog Item")).getState(23438))
    .rejects.toThrow("no es un Task o Bug de entrega");
  await expect(new AzureTicketInfoService(az("Epic")).getHuState(23438))
    .rejects.toThrow("no es una User Story ni un Product Backlog Item");
});

test("linkPullRequest accepts a Product Backlog Item HU and still rejects other types", async () => {
  const az = (huType: string) => {
    let associated = false;
    return async (args: string[]) => {
      if (args[0] === "boards" && args.includes("23438")) return JSON.stringify({
        id: 23438,
        fields: { "System.WorkItemType": huType, "System.TeamProject": "Team" },
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
        ],
      });
      const pullRequest = {
        pullRequestId: 99,
        status: "completed",
        mergeStatus: "succeeded",
        sourceRefName: "refs/heads/ticket/51-read",
        targetRefName: "refs/heads/hu/23438",
        lastMergeCommit: { commitId: "merge-commit" },
        lastMergeSourceCommit: { commitId: "source-merge-commit" },
        repository: { id: "repository-id", project: { id: "project-id" } },
      };
      if (args[0] === "repos" && args[1] === "pr" && args[2] === "show") return JSON.stringify(pullRequest);
      if (args[0] === "repos" && args[1] === "pr" && args[2] === "list") return JSON.stringify([pullRequest]);
      if (args[0] === "repos" && args[2] === "work-item" && args[3] === "add") {
        associated = true;
        return "{}";
      }
      if (args[0] === "repos" && args.includes("work-item")) return JSON.stringify(associated ? [51] : []);
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };
  };

  await expect(new AzureTicketInfoService(az("Product Backlog Item")).linkPullRequest(23438, 51, 99)).resolves.toEqual({
    hu: 23438,
    ticket: 51,
    pullRequest: 99,
    mergeCommit: "merge-commit",
  });
  await expect(new AzureTicketInfoService(az("Epic")).linkPullRequest(23438, 51, 99))
    .rejects.toThrow("no es una User Story ni un Product Backlog Item");
});

test("the direct parent gate accepts a Product Backlog Item parent and still rejects other types", async () => {
  const az = (parentType: string) => {
    let state = "Active";
    let revision = 4;
    return async (args: string[]) => {
      if (args[0] === "boards" && args.includes("51")) return JSON.stringify({
        id: 51,
        rev: revision,
        fields: { "System.WorkItemType": "Task", "System.State": state },
        relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" }],
      });
      if (args[0] === "boards") return JSON.stringify({
        id: 23438,
        fields: { "System.WorkItemType": parentType },
        relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" }],
      });
      if (args[0] === "rest" && args.includes("patch")) {
        state = "En progreso";
        revision = 5;
        return JSON.stringify({
          id: 51,
          rev: revision,
          fields: { "System.WorkItemType": "Task", "System.State": state },
          relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" }],
        });
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    };
  };

  await expect(new AzureTicketInfoService(az("Product Backlog Item")).setState(51, "En progreso", "Active"))
    .resolves.toEqual({ ticket: 51, state: "En progreso", revision: 5 });
  await expect(new AzureTicketInfoService(az("Epic")).setState(51, "En progreso", "Active"))
    .rejects.toThrow("no es una HU User Story ni un Product Backlog Item");
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
    expect(await createCli({ huInfoService: service }).run([
      "ticket-description-set", "--ticket", "51", "--description-file", "/tmp/description.html",
    ])).toBe(0);
    expect(await createCli({ huInfoService: service }).run([
      "ticket-state-set", "--ticket", "51", "--state", "En progreso", "--expected-state", "Active",
    ])).toBe(0);
    expect(await createCli({ huInfoService: service }).run([
      "ticket-effort-set", "--ticket", "51", "--real-effort", "2.25", "--real-effort-hh", "2.5", "--expected-rev", "7",
    ])).toBe(0);
    expect(await createCli({ huInfoService: service }).run([
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

test("ticket-completion-apply cierra un ticket ya completo sin repetir ningún efecto", async () => {
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
    completionEvidence: "lo que la sesión dijo",
    gates: { satisfied: [], unmet: [] },
  };
  const service = {
    getHuInfo: async () => { throw new Error("must not use generic HU read"); },
    waitForAccess: async () => undefined,
    getTicketInfo: async () => info,
    validateDirectTicketContext: async () => undefined,
    validateSummary: async () => undefined,
    linkPullRequest: async () => { throw new Error("must not link an existing PR"); },
    linkCommit: async () => { throw new Error("must not link an existing commit"); },
    setSummary: async () => { throw new Error("must not set existing evidence"); },
    setState: async () => { throw new Error("must not set an existing state"); },
  };

  try {
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    expect(await createCli({ huInfoService: service }).run([
      "ticket-completion-apply",
      "--hu", "23438",
      "--ticket", "51",
      "--pr", "99",
      "--summary", "lo que la sesión dijo",
      "--working-directory", "/repo",
    ])).toBe(0);
  } finally {
    console.log = originalLog;
  }

  expect(JSON.parse(output[0]!)).toEqual({
    hu: 23438,
    ticket: 51,
    pullRequest: 99,
    state: "Done",
    gates: { satisfied: [], unmet: [] },
  });
});

test("ticket-completion-apply exige el resumen de la sesión", async () => {
  const service = {
    getHuInfo: async () => { throw new Error("must not touch Azure"); },
    waitForAccess: async () => undefined,
    getTicketInfo: async () => { throw new Error("must not touch Azure"); },
  };

  expect(await createCli({ huInfoService: service }).run([
    "ticket-completion-apply", "--hu", "23438", "--ticket", "51", "--pr", "99", "--working-directory", "/repo",
  ])).toBe(1);
});

test("completion apply reconciles missing effects before moving the ticket to Done", async () => {
  const summary = "Migré el endpoint y corrí la suite: 18 passed.";
  const calls: string[] = [];
  let state = "Active";
  let canonicalPullRequest: number | null = null;
  let hasCommit = false;
  let completionEvidence: string | null = null;

  const service = {
    getHuInfo: async () => new HuInfo({ id: 23438 }),
    waitForAccess: async () => undefined,
    getTicketInfo: async () => {
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
        attachments: [],
        completionEvidence,
        gates: { satisfied: [], unmet },
      } as any;
    },
    validateDirectTicketContext: async () => undefined,
    validateSummary: async () => undefined,
    linkPullRequest: async () => { calls.push("pr"); canonicalPullRequest = 99; return {}; },
    linkCommit: async () => { calls.push("commit"); hasCommit = true; return {}; },
    setSummary: async (_ticket: number, text: string) => { calls.push(`evidence:${text}`); completionEvidence = text; return {}; },
    setState: async () => { calls.push("state"); state = "Done"; return {}; },
  };

  await expect(createCli({ huInfoService: service }).run([
    "ticket-completion-apply", "--hu", "23438", "--ticket", "51", "--pr", "99",
    "--summary", summary, "--working-directory", process.cwd(),
  ])).resolves.toBe(0);
  // La completion-evidence del ticket es lo último que dijo la sesión, y nada más (ADR-0037).
  expect(calls).toEqual(["pr", "commit", `evidence:${summary}`, "state"]);
});

test("un fallo de az explica la razón que Azure dio en stderr, no solo el exit code", () => {
  // Bun shell leaves the thrown message as a bare exit code, so an unread stderr is the difference
  // between "refresh your multi-factor authentication" and an operator with nothing to act on.
  const shellFailure = Object.assign(new Error("Failed with exit code 1"), {
    stderr: new TextEncoder().encode("ERROR: AADSTS50078: Presented multi-factor authentication has expired\n"),
  });

  const reported = commandError(shellFailure).message;

  expect(reported).toContain("Failed with exit code 1");
  expect(reported).toContain("AADSTS50078");
  expect(reported).toContain("multi-factor authentication has expired");
});

test("un fallo de az no filtra credenciales del stderr", () => {
  const shellFailure = Object.assign(new Error("Failed with exit code 1"), {
    stderr: "ERROR: rejected request with Bearer eyJ0eXAiOiJKV1Qi and accessToken=super-secreto\n",
  });

  const reported = commandError(shellFailure).message;

  expect(reported).toContain("[REDACTED]");
  expect(reported).not.toContain("eyJ0eXAiOiJKV1Qi");
  expect(reported).not.toContain("super-secreto");
});

test("un fallo de az sin stderr conserva el mensaje original", () => {
  expect(commandError(new Error("boom")).message).toBe("Azure command failed: boom");
});

test("un PR sin commit fuente de merge no se completa a ciegas", async () => {
  // Azure has not finished computing the merge yet, so there is nothing to guard the completion
  // against; completing anyway would merge a state nobody evaluated.
  const service = new AzureTicketInfoService(async (args) => {
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "list") return JSON.stringify([]);
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "create") return JSON.stringify({
      pullRequestId: 77,
      status: "active",
      mergeStatus: "queued",
      sourceRefName: "refs/heads/ticket/51",
      targetRefName: "refs/heads/hu/23438",
      repository: { id: "repository-id", project: { id: "project-id" } },
    });
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "show") return JSON.stringify({
      pullRequestId: 77,
      status: "active",
      mergeStatus: "queued",
      sourceRefName: "refs/heads/ticket/51",
      targetRefName: "refs/heads/hu/23438",
      repository: { id: "repository-id", project: { id: "project-id" } },
    });
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  await expect(service.createOrReusePullRequest(23438, 51, {
    project: "project-id",
    repository: "repository-id",
    source: "refs/heads/ticket/51",
    target: "refs/heads/hu/23438",
  })).rejects.toThrow("no expone el commit fuente del merge");
});

test("un PR completado sin nada que mergear entrega el commit fuente como commit del ticket", async () => {
  // A participant repository this ticket did not change ends with source and target on the same
  // commit, so Azure completes and closes the PR without creating a merge commit. The delivered
  // commit is the source commit, and the ticket has to be linked to something.
  const service = new AzureTicketInfoService(async (args) => {
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "list") return JSON.stringify([]);
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "create") return JSON.stringify({
      pullRequestId: 88,
      status: "active",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51",
      targetRefName: "refs/heads/hu/23438",
      lastMergeSourceCommit: { commitId: "c".repeat(40) },
      repository: { id: "repository-id", project: { id: "project-id" } },
    });
    if (args[0] === "rest" && args.includes("patch")) return "{}";
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "show") return JSON.stringify({
      pullRequestId: 88,
      status: "completed",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51",
      targetRefName: "refs/heads/hu/23438",
      // Azure reports no lastMergeCommit: there was nothing to merge.
      lastMergeSourceCommit: { commitId: "c".repeat(40) },
      repository: { id: "repository-id", project: { id: "project-id" } },
    });
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  await expect(service.createOrReusePullRequest(23438, 51, {
    project: "project-id",
    repository: "repository-id",
    source: "refs/heads/ticket/51",
    target: "refs/heads/hu/23438",
  })).resolves.toEqual({ pullRequest: 88, mergeCommit: "c".repeat(40) });
});

function queuedMergeService(shows: string[], sleeps: number[]) {
  let show = 0;
  return new AzureTicketInfoService(
    async (args) => {
      if (args[0] === "repos" && args[1] === "pr" && args[2] === "list") return JSON.stringify([]);
      if (args[0] === "repos" && args[1] === "pr" && args[2] === "create") return JSON.stringify({
        pullRequestId: 4604,
        status: "active",
        mergeStatus: "succeeded",
        sourceRefName: "refs/heads/ticket/23574",
        targetRefName: "refs/heads/feature/sdui-payment-actions-plan",
        lastMergeSourceCommit: { commitId: "6".repeat(40) },
        repository: { id: "repository-id", project: { id: "project-id" } },
      });
      if (args[0] === "rest" && args.includes("patch")) return "{}";
      if (args[0] === "repos" && args[1] === "pr" && args[2] === "show") {
        return shows[Math.min(show++, shows.length - 1)]!;
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
    undefined,
    async (milliseconds) => { sleeps.push(milliseconds); },
  );
}

const queuedShow = JSON.stringify({
  pullRequestId: 4604,
  status: "active",
  mergeStatus: "queued",
  sourceRefName: "refs/heads/ticket/23574",
  targetRefName: "refs/heads/feature/sdui-payment-actions-plan",
  lastMergeSourceCommit: { commitId: "6".repeat(40) },
  repository: { id: "repository-id", project: { id: "project-id" } },
});

const mergedShow = JSON.stringify({
  pullRequestId: 4604,
  status: "completed",
  mergeStatus: "succeeded",
  sourceRefName: "refs/heads/ticket/23574",
  targetRefName: "refs/heads/feature/sdui-payment-actions-plan",
  lastMergeCommit: { commitId: "1".repeat(40) },
  lastMergeSourceCommit: { commitId: "6".repeat(40) },
  repository: { id: "repository-id", project: { id: "project-id" } },
});

test("el merge que Azure encoló se espera en vez de juzgarse a medio completar", async () => {
  // Azure devuelve el PATCH antes de materializar el merge: releer en ese
  // instante mostraba el PR todavía en cola y detenía la entrega con el trabajo
  // ya integrado un segundo después.
  const sleeps: number[] = [];
  const service = queuedMergeService([queuedShow, queuedShow, queuedShow, mergedShow], sleeps);

  await expect(service.createOrReusePullRequest(23553, 23574, {
    project: "project-id",
    repository: "repository-id",
    source: "refs/heads/ticket/23574",
    target: "refs/heads/feature/sdui-payment-actions-plan",
  })).resolves.toEqual({ pullRequest: 4604, mergeCommit: "1".repeat(40) });
  expect(sleeps).not.toBeEmpty();
});

test("un PR que nunca se asienta sigue fallando cerrado en vez de esperar para siempre", async () => {
  const sleeps: number[] = [];
  const service = queuedMergeService([queuedShow], sleeps);

  await expect(service.createOrReusePullRequest(23553, 23574, {
    project: "project-id",
    repository: "repository-id",
    source: "refs/heads/ticket/23574",
    target: "refs/heads/feature/sdui-payment-actions-plan",
  })).rejects.toThrow("no cumple el target o estado de merge requerido");
  expect(sleeps).toHaveLength(15);
});

test("un merge que Azure rechaza por conflictos no espera la ventana completa", async () => {
  const sleeps: number[] = [];
  // La primera lectura la consume completePullRequest; la segunda es la que la
  // espera juzga, y un conflicto ya es definitivo: no hay nada que aguardar.
  const service = queuedMergeService([queuedShow, JSON.stringify({
    pullRequestId: 4604,
    status: "active",
    mergeStatus: "conflicts",
    sourceRefName: "refs/heads/ticket/23574",
    targetRefName: "refs/heads/feature/sdui-payment-actions-plan",
    lastMergeSourceCommit: { commitId: "6".repeat(40) },
    repository: { id: "repository-id", project: { id: "project-id" } },
  })], sleeps);

  await expect(service.createOrReusePullRequest(23553, 23574, {
    project: "project-id",
    repository: "repository-id",
    source: "refs/heads/ticket/23574",
    target: "refs/heads/feature/sdui-payment-actions-plan",
  })).rejects.toThrow("no cumple el target o estado de merge requerido");
  expect(sleeps).toBeEmpty();
});

test("un PR activo no reporta el commit fuente como si hubiera entregado algo", async () => {
  const service = new AzureTicketInfoService(async (args) => {
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "list") return JSON.stringify([{
      pullRequestId: 89,
      status: "active",
      mergeStatus: "succeeded",
      sourceRefName: "refs/heads/ticket/51",
      targetRefName: "refs/heads/hu/23438",
      lastMergeSourceCommit: { commitId: "d".repeat(40) },
      repository: { id: "repository-id", project: { id: "project-id" } },
    }]);
    if (args[0] === "repos" && args[2] === "work-item") return JSON.stringify([]);
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  const [pullRequest] = await service.readPullRequests(51, "project-id");
  expect(pullRequest!.status).toBe("active");
  expect(pullRequest!.mergeCommit).toBeUndefined();
  expect(pullRequest!.lastMergeSourceCommit).toBe("d".repeat(40));
});

function completionEvidenceService(options: {
  definedFields: string[];
  existing?: string;
  /** Relations the ticket already carries, so a published document can point at real attachments. */
  attachments?: unknown[];
  onPatch?: (body: unknown[]) => void;
}) {
  const stored: Record<string, string> = options.existing
    ? { [options.definedFields[0] ?? "Custom.CompletionEvidence"]: options.existing }
    : {};
  return new AzureTicketInfoService(async (args) => {
    if (args[0] === "boards" && args.includes("23438")) return JSON.stringify({
      id: 23438,
      fields: { "System.WorkItemType": "User Story" },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" }],
    });
    if (args[0] === "boards") return JSON.stringify({
      id: 51,
      rev: 4,
      fields: { "System.WorkItemType": "Task", ...stored },
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" },
        ...(options.attachments ?? []),
      ],
    });
    if (args[0] === "rest" && args.includes("get")) {
      // The project defines only some of the candidate reference names; Azure answers TF51535 for
      // the rest, exactly as it does for a field that was never created here.
      const uri = args[args.indexOf("--uri") + 1]!;
      const field = options.definedFields.find((name) => uri.includes(encodeURIComponent(name)) || uri.includes(name));
      if (!field) throw new Error("ERROR: Not Found(TF51535: Cannot find field)");
      return JSON.stringify({ referenceName: field, type: "html" });
    }
    if (args[0] === "rest" && args.includes("patch")) {
      const body = JSON.parse(args[args.indexOf("--body") + 1]!) as Array<{ op: string; path: string; value?: unknown }>;
      options.onPatch?.(body);
      // Azure applies the write, so a later read has to see it.
      for (const operation of body) {
        if (operation.op !== "add" || !operation.path.startsWith("/fields/")) continue;
        stored[operation.path.slice("/fields/".length)] = String(operation.value);
      }
      return "{}";
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });
}

test("completion-evidence se escribe en el campo que el proyecto define, no en el primero de la lista", async () => {
  const guid = "Custom.b505c83e-3745-4d8b-b76b-b3086a0c4c71";
  const patches: unknown[][] = [];
  const service = completionEvidenceService({ definedFields: [guid], onPatch: (body) => patches.push(body) });

  // The read-back reports the field the project defines, so the write has to have landed there.
  await expect(service.setSummary(51, "Validaciones ejecutadas: npm test, npm run build.")).resolves.toMatchObject({ ticket: 51 });
  const operations = patches[0] as Array<{ op: string; path: string }>;
  expect(operations.some(({ op, path: target }) => op === "add" && target === `/fields/${guid}`)).toBeTrue();
  expect(operations.some(({ path: target }) => target === "/fields/Custom.CompletionEvidence")).toBeFalse();
});

test("el resumen de la sesión se publica escapado y conservando sus líneas", async () => {
  const patches: unknown[][] = [];
  const service = completionEvidenceService({
    definedFields: ["Custom.CompletionEvidence"],
    onPatch: (body) => patches.push(body),
  });

  await expect(service.setSummary(51, "Migré <Pago> & corrí la suite.\n18 passed."))
    .resolves.toMatchObject({ ticket: 51 });

  const operations = patches[0] as Array<{ op: string; path: string; value?: unknown }>;
  const written = operations.find(({ path: target }) => target === "/fields/Custom.CompletionEvidence")?.value;
  // El campo es HTML: sin escapar, `<Pago>` desaparece; sin `<br>`, el texto se lee como una sola línea.
  expect(written).toBe("Migré &lt;Pago&gt; &amp; corrí la suite.<br>18 passed.");
});

test("republicar el mismo resumen no es un conflicto, y otro sí lo es", async () => {
  const summary = "Migré el endpoint y corrí la suite: 18 passed.";
  const service = completionEvidenceService({ definedFields: ["Custom.CompletionEvidence"] });

  await service.setSummary(51, summary);

  // El campo guardó HTML y el resumen es texto plano: la comparación deshace el marcado, así que
  // una entrega retomada reconoce lo suyo en vez de chocar contra ello.
  await expect(service.setSummary(51, summary)).resolves.toMatchObject({ ticket: 51 });
  await expect(service.validateSummary(51, summary)).resolves.toBeUndefined();
  await expect(service.setSummary(51, "Otra cosa distinta.")).rejects.toThrow("conflicto");
  await expect(service.validateSummary(51, "Otra cosa distinta.")).rejects.toThrow("conflicto");
});

test("un resumen vacío no puede cerrar un ticket", async () => {
  const service = completionEvidenceService({ definedFields: ["Custom.CompletionEvidence"] });

  await expect(service.setSummary(51, "   ")).rejects.toThrow("resumen de la sesión está vacío");
});

test("completion-evidence falla claro si el proyecto no define ningún campo candidato", async () => {
  const service = completionEvidenceService({ definedFields: [] });
  await expect(service.setSummary(51, "Validaciones ejecutadas: npm test.")).rejects.toThrow("no define ningún campo de completion-evidence");
});

test("ticket-info lee la rama del ticket del PR que la integró cuando el merge ya la borró", async () => {
  // Completar el PR con deleteSourceBranch borra la rama del ticket (ADR-0010) y Azure
  // retira con ella el Branch ArtifactLink. Dar el ticket por "sin rama" en ese punto
  // dejaba el manifest inverificable y los gates incumplidos con la entrega ya mergeada.
  const service = new AzureTicketInfoService(async (args) => {
    if (args[0] === "boards" && args.includes("23438")) {
      return JSON.stringify({
        id: 23438,
        fields: { "System.WorkItemType": "User Story", "System.Title": "HU", "System.TeamProject": "Team" },
        relations: [
          { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/_apis/wit/workItems/51" },
          { rel: "ArtifactLink", url: branch, attributes: { name: "Branch" } },
        ],
      });
    }
    if (args[0] === "boards" && args.includes("51")) {
      return JSON.stringify({
        id: 51,
        rev: 9,
        fields: { "System.WorkItemType": "Task", "System.Title": "Ticket", "System.State": "Active" },
        relations: [{
          rel: "ArtifactLink",
          url: "vstfs:///Git/PullRequestId/project-id%2Frepository-id%2F99",
          attributes: { name: "Pull Request" },
        }],
      });
    }
    if (args[0] === "repos" && args[1] === "pr") {
      if (args.includes("work-item")) return JSON.stringify([51]);
      return JSON.stringify([{
        pullRequestId: 99,
        status: "completed",
        mergeStatus: "succeeded",
        sourceRefName: "refs/heads/ticket/51",
        targetRefName: "refs/heads/hu/23438",
        lastMergeCommit: { commitId: "merge-commit" },
        repository: { id: "repository-id", project: { id: "project-id" } },
      }]);
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  const info = await service.getTicketInfo(23438, 51);

  expect(info.branch).toBe("refs/heads/ticket/51");
  expect(info.canonicalPullRequest).toBe(99);
  expect(info.gates.unmet).not.toContain("completed-hu-targeted-pr");
  expect(info.gates.unmet).not.toContain("native-pr-association");
});

/** Un ticket cuya rama ya borró el merge: sin Branch ArtifactLink, con su PR ya integrado. */
function mergedTicketFixture(): (args: string[]) => Promise<string> {
  let associated = false;
  const pullRequest = {
    pullRequestId: 99,
    status: "completed",
    mergeStatus: "succeeded",
    sourceRefName: "refs/heads/ticket/51",
    targetRefName: "refs/heads/hu/23438",
    lastMergeCommit: { commitId: "merge-commit" },
    lastMergeSourceCommit: { commitId: "source-merge-commit" },
    repository: { id: "repository-id", project: { id: "project-id" } },
  };
  return async (args) => {
    if (args[0] === "boards" && args.includes("23438")) return JSON.stringify({
      id: 23438,
      fields: { "System.WorkItemType": "User Story", "System.TeamProject": "Team" },
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" },
        { rel: "ArtifactLink", url: branch, attributes: { name: "Branch" } },
      ],
    });
    if (args[0] === "boards" && args.includes("51")) return JSON.stringify({
      id: 51,
      rev: 4,
      fields: { "System.WorkItemType": "Task" },
      relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://example.test/workItems/23438" }],
    });
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "show") return JSON.stringify(pullRequest);
    if (args[0] === "repos" && args[1] === "pr" && args[2] === "list") return JSON.stringify([pullRequest]);
    if (args[0] === "repos" && args[2] === "work-item" && args[3] === "add") {
      associated = true;
      return "{}";
    }
    if (args[0] === "repos" && args.includes("work-item")) return JSON.stringify(associated ? [51] : []);
    if (args[0] === "boards" && args[1] === "work-item" && args[2] === "update") return "{}";
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
}

test("el PR se asocia aunque el merge ya haya borrado la rama del ticket", async () => {
  // El coordinador asocia el PR después de completarlo, y completar borra la rama: exigir
  // el Branch ArtifactLink ahí dejaba la asociación imposible con el trabajo ya integrado.
  const service = new AzureTicketInfoService(mergedTicketFixture());

  await expect(service.linkPullRequest(23438, 51, 99)).resolves.toEqual({
    hu: 23438,
    ticket: 51,
    pullRequest: 99,
    mergeCommit: "merge-commit",
  });
});

test("el PR de otra rama sigue rechazado cuando el ticket no tiene rama vinculada", async () => {
  const az = mergedTicketFixture();
  const service = new AzureTicketInfoService(async (args) => {
    const payload = await az(args);
    return args[0] === "repos" && args[1] === "pr" && (args[2] === "show" || args[2] === "list")
      ? payload.replaceAll("refs/heads/ticket/51", "refs/heads/feature/otra")
      : payload;
  });

  await expect(service.linkPullRequest(23438, 51, 99)).rejects.toThrow(/no tiene una rama vinculada/);
});

test("ticket-info busca el PR en el repositorio primario que designó el commit, no en el de la HU", async () => {
  // Sin Branch ArtifactLink el repositorio primario ya no viaja en la rama del ticket. El
  // Fixed in Commit designado lo sigue nombrando, y buscar en el repositorio de la HU dejaba
  // sin PR — y por tanto sin rama ni gates — a una entrega cuyo primario no es el ancla.
  const commands: string[][] = [];
  const artifactLink = `vstfs:///Git/Commit/${encodeURIComponent("project-id/primary-id/merge-commit")}`;
  const service = new AzureTicketInfoService(async (args) => {
    commands.push(args);
    if (args[0] === "boards" && args.includes("23438")) return JSON.stringify({
      id: 23438,
      fields: { "System.WorkItemType": "User Story", "System.TeamProject": "Team" },
      relations: [
        { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example.test/workItems/51" },
        { rel: "ArtifactLink", url: branch, attributes: { name: "Branch" } },
      ],
    });
    if (args[0] === "boards" && args.includes("51")) return JSON.stringify({
      id: 51,
      rev: 4,
      fields: { "System.WorkItemType": "Task", "System.State": "Active", "Custom.URLCommit": artifactLink },
      relations: [{ rel: "ArtifactLink", url: artifactLink, attributes: { name: "Fixed in Commit" } }],
    });
    if (args[0] === "repos" && args[1] === "pr") {
      if (args.includes("work-item")) return JSON.stringify([51]);
      const repository = args[args.indexOf("--repository") + 1];
      return JSON.stringify(repository === "primary-id" ? [{
        pullRequestId: 99,
        status: "completed",
        mergeStatus: "succeeded",
        sourceRefName: "refs/heads/ticket/51",
        targetRefName: "refs/heads/hu/23438",
        lastMergeCommit: { commitId: "merge-commit" },
        repository: { id: "primary-id", project: { id: "project-id" } },
      }] : []);
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  const info = await service.getTicketInfo(23438, 51);

  expect(info.branch).toBe("refs/heads/ticket/51");
  expect(info.canonicalPullRequest).toBe(99);
  expect(commands.find((args) => args[1] === "pr" && !args.includes("work-item"))).toContain("primary-id");
});
