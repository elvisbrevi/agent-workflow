import { expect, test } from "bun:test";
import { AzureTicketInfoService } from "../src/azure/ticket-info-service.ts";

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
    branch: "refs/heads/hu/23438",
    effort: { estimated: 3, real: 1.25, realHours: 1.25 },
    completionEvidence: "evidence",
    pullRequests: [expect.objectContaining({ id: 99, mergeCommit: "merge-commit" })],
    canonicalPullRequest: 99,
    mergeCommit: "merge-commit",
  }));
  expect(fixtureValue.commands.some((args) => args[0] === "repos" && args[1] === "pr")).toBeTrue();
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
    return JSON.stringify({ id: 51, fields: { "System.WorkItemType": "Epic" }, relations: [] });
  });

  await expect(service.getTicketInfo(23438, 51)).rejects.toThrow("hijo directo");
  await expect(service.getTicket(0)).rejects.toThrow("entero positivo");
});
