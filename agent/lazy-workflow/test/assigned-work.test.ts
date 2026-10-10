import { afterEach, expect, test } from "bun:test";
import { githubAssignedWork } from "../src/github/assigned-work.ts";
import { azureAssignedWork } from "../src/azure/assigned-work.ts";
import { workPreset, historyLabel, type WorkItem } from "../gui/src/lib/work.ts";
import { foldRuns } from "../gui/src/lib/history.ts";

const previousOrganization = process.env.LAZY_WORKFLOW_AZURE_ORGANIZATION;
afterEach(() => {
  if (previousOrganization === undefined) delete process.env.LAZY_WORKFLOW_AZURE_ORGANIZATION;
  else process.env.LAZY_WORKFLOW_AZURE_ORGANIZATION = previousOrganization;
});

test("assigned GitHub work uses the authenticated account, including issues outside the managed queue", async () => {
  const calls: string[][] = [];
  const result = await githubAssignedWork(async (args, cwd) => {
    expect(cwd).toBe("/synthetic/repo"); calls.push(args);
    return JSON.stringify(args[0] === "repo" ? { nameWithOwner: "owner/repo" } : [{ number: 7, title: "My assigned work", state: "OPEN", url: "https://github.com/owner/repo/issues/7" }]);
  }, "/synthetic/repo");
  expect(calls[1]).toContain("@me");
  expect(calls[1]).not.toContain("--label");
  expect(result.items[0]).toMatchObject({ id: 7, type: "Issue", hu: null });
});

test("Azure uses @Me and only offers a verified User Story as a Task's HU", async () => {
  process.env.LAZY_WORKFLOW_AZURE_ORGANIZATION = "https://dev.azure.com/synthetic";
  const calls: Array<{ uri: string; body: Record<string, unknown> }> = [];
  const result = await azureAssignedWork(async (args) => {
    const uri = args[args.indexOf("--uri") + 1]!;
    const body = JSON.parse(args[args.indexOf("--body") + 1]!); calls.push({ uri, body });
    if (uri.includes("wiql")) return JSON.stringify({ workItems: [{ id: 8 }, { id: 9 }] });
    if (body.fields) return JSON.stringify({ value: [{ id: 50, fields: { "System.WorkItemType": "User Story" } }, { id: 51, fields: { "System.WorkItemType": "Feature" } }] });
    return JSON.stringify({ value: [8, 9].map((id) => ({ id, fields: { "System.Title": "Synthetic task", "System.WorkItemType": "Task", "System.State": "Active" }, relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `https://dev.azure.com/synthetic/_apis/wit/workItems/${id === 8 ? 50 : 51}` }] })) });
  }, "git@ssh.dev.azure.com:v3/synthetic/My%20Project/repo");
  expect(calls[0]!.body.query).toContain("[System.AssignedTo] = @Me");
  expect(calls[0]!.uri).toContain("/My%20Project/");
  expect(result.items.map((item) => item.hu)).toEqual([50, null]);
});

test("Azure rejects a different organization before reading and handles an empty inventory", async () => {
  process.env.LAZY_WORKFLOW_AZURE_ORGANIZATION = "https://dev.azure.com/synthetic";
  let reads = 0;
  const az = async () => { reads++; return JSON.stringify({ workItems: [] }); };
  await expect(azureAssignedWork(az, "https://dev.azure.com/another/project/_git/repo")).rejects.toThrow("LAZY_WORKFLOW_AZURE_ORGANIZATION");
  expect(reads).toBe(0);
  expect((await azureAssignedWork(az, "https://dev.azure.com/synthetic/project/_git/repo")).items).toEqual([]);
  expect(reads).toBe(1);
});

test("task selection clears previous workflow scope and never presents a GitHub issue as a fixed Code run", () => {
  const item: WorkItem = { id: 8, title: "Task", type: "Task", state: "Active", url: "https://example.com/8", hu: 50, tracker: "azure", scope: "project", repository: "/synthetic/repo" };
  expect(workPreset(item)).toMatchObject({ name: "code", values: { "--working-directory": "/synthetic/repo", "--hu": "50", "--ticket": "8", "--session": "" } });
  expect(workPreset({ ...item, hu: null }).name).toBe("ticket-type-info");
  expect(workPreset({ ...item, tracker: "github", type: "Issue" }).name).toBe("github-issue-info");
  expect(workPreset({ ...item, type: "Feature" }).name).toBe("hu-info");
});

test("recent activity keeps incomplete runs distinct from completed work", () => {
  const run = foldRuns([{ run_id: "synthetic", ts: "2026-10-10T12:00:00Z", event: "run.started", command: "code", context: { hu: 50, ticket: 8 } }])[0]!;
  expect(run.outcome).toBe("unfinished");
  expect(historyLabel(run)).toBe("Implementación · HU #50 · Task #8");
});
