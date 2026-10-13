import { afterEach, expect, test } from "bun:test";
import { githubAssignedWork } from "../src/github/assigned-work.ts";
import { azureAssignedWork } from "../src/azure/assigned-work.ts";
import { deliveryChildren, groupWork, historyLabel, homePath, huLabel, lastLine, matchesQuery, planTarget, runTitle, type RepositoryWork, type WorkItem } from "../gui/src/lib/work.ts";
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

test("an assigned GitHub epic answers its type, by title prefix or label, so Plan can offer it", async () => {
  const result = await githubAssignedWork(async (args) => JSON.stringify(args[0] === "repo" ? { nameWithOwner: "owner/repo" } : [
    { number: 1, title: "[Epic] Pagos", state: "OPEN", url: "u1", labels: [] },
    { number: 2, title: "Portal", state: "OPEN", url: "u2", labels: [{ name: "epic" }] },
    { number: 3, title: "Login", state: "OPEN", url: "u3", labels: [{ name: "bug" }] },
  ]), "/synthetic/repo");
  expect(result.items.map((item) => item.type)).toEqual(["Epic", "Epic", "Issue"]);
});

test("Azure groups a Task under a Bug planned on its own, as it would under a story (ADR-0047)", async () => {
  process.env.LAZY_WORKFLOW_AZURE_ORGANIZATION = "https://dev.azure.com/synthetic";
  const result = await azureAssignedWork(async (args) => {
    const body = JSON.parse(args[args.indexOf("--body") + 1]!);
    if (args[args.indexOf("--uri") + 1]!.includes("wiql")) return JSON.stringify({ workItems: [{ id: 8 }] });
    if (body.fields) return JSON.stringify({ value: [{ id: 70, fields: { "System.WorkItemType": "Bug" } }] });
    return JSON.stringify({ value: [{ id: 8, fields: { "System.Title": "Fix", "System.WorkItemType": "Task", "System.State": "Active" }, relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/synthetic/_apis/wit/workItems/70" }] }] });
  }, "git@ssh.dev.azure.com:v3/synthetic/Project/repo");
  expect(result.items[0]!.hu).toBe(70);
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

const azureItem = (id: number, type: string, hu: number | null, title = `Item ${id}`): WorkItem =>
  ({ id, title, type, state: "Active", url: `https://example.com/${id}`, hu, tracker: "azure", scope: "Project", repository: "/synthetic/azure" });

test("assigned Azure tasks gather under their HU; an empty repository still has its section", () => {
  const results: RepositoryWork[] = [
    { repository: "/synthetic/azure", tracker: "azure", scope: "Project", truncated: false, error: null, items: [azureItem(8, "Task", 50), azureItem(50, "User Story", null, "Portal"), azureItem(9, "Bug", 60), azureItem(10, "Task", null), azureItem(11, "Feature", null)] },
    // A second folder of the same project answers the same items: the first one keeps them.
    { repository: "/synthetic/azure-2", tracker: "azure", scope: "Project", truncated: false, error: null, items: [{ ...azureItem(8, "Task", 50), repository: "/synthetic/azure-2" }] },
    { repository: "/synthetic/github", tracker: "github", scope: "owner/repo", truncated: false, error: null, items: [] },
    { repository: "/synthetic/broken", tracker: null, scope: "broken", truncated: false, error: "gh: not logged in", items: [] },
  ];
  const sections = groupWork(results);
  expect(sections.map((section) => [section.key, section.repository, section.entries.length])).toEqual([
    ["azure:Project", "/synthetic/azure", 4],
    ["github:owner/repo", "/synthetic/github", 0],
  ]);
  const [story, other, task, feature] = sections[0]!.entries;
  expect(story).toMatchObject({ kind: "hu", hu: 50, story: { title: "Portal" } });
  expect(story!.kind === "hu" && story.tasks.map((item) => item.id)).toEqual([8]);
  expect(other).toMatchObject({ kind: "hu", hu: 60, story: null });
  expect(task).toMatchObject({ kind: "item", item: { id: 10 } });
  expect(feature).toMatchObject({ kind: "item", item: { id: 11 } });
  expect(matchesQuery(story!, "item 8")).toBe(true);
  expect(matchesQuery(story!, "#50")).toBe(true);
  expect(matchesQuery(other!, "portal")).toBe(false);
});

test("Trabajo plans an HU, a lone Bug or an epic it lists, each with its own flag", () => {
  const github = (id: number, title: string, type = "Issue"): WorkItem =>
    ({ id, title, type, state: "OPEN", url: `https://github.com/o/r/issues/${id}`, hu: null, tracker: "github", scope: "o/r", repository: "/synthetic/github" });
  const [azure, gh] = groupWork([
    { repository: "/synthetic/azure", tracker: "azure", scope: "Project", truncated: false, error: null, items: [azureItem(50, "User Story", null, "Portal"), azureItem(70, "Bug", null, "Falla el login"), azureItem(71, "Bug", 50)] },
    { repository: "/synthetic/github", tracker: "github", scope: "o/r", truncated: false, error: null, items: [github(1, "Portal", "Epic"), github(3, "Login")] },
  ]);
  expect(azure!.entries.map((entry) => entry.kind === "hu" && `${huLabel(entry)} #${entry.hu}`)).toEqual(["HU #50", "Bug #70"]);
  expect(planTarget(azure!.entries[1]!)).toEqual({ kind: "azure-hu", repository: "/synthetic/azure", hu: 70, title: "Falla el login", bug: true });
  expect(planTarget(gh!.entries[0]!)).toEqual({ kind: "github-epic", repository: "/synthetic/github", nameWithOwner: "o/r", issue: 1, title: "Portal", url: "https://github.com/o/r/issues/1" });
  expect(planTarget(gh!.entries[1]!)).toBeNull();
  expect(runTitle("plan", ["plan", "--working-directory", "/r/github", "--issue", "1"])).toBe("Plan · Issue #1");
});

test("hu-children-info answers { hu, children }; only Tasks and Bugs are delivery units", () => {
  const children = [{ id: 1, type: "Task", state: "New" }, { id: 2, type: "Test Case", state: "New" }, { id: 3, type: "Bug", state: "Done" }];
  expect(deliveryChildren({ hu: 50, children }).map((child) => child.id)).toEqual([1, 3]);
  expect(deliveryChildren(children).map((child) => child.id)).toEqual([1, 3]);
  expect(deliveryChildren(null)).toEqual([]);
});

test("a failed read shows its reason, not the panel, the stamps or the run-log pointer", () => {
  const stderr = [
    "╭──────────────╮",
    "│ lazy-workflow · work-assigned │",
    "╰──────────────╯",
    "11/10/26 23:34:58 │ ✖ \u001b[31mlazy-workflow: no se pudo ejecutar work-assigned (gh: not logged in)\u001b[0m",
    "lazy-workflow: revisa el run log para el detalle del fallo: grep 0 /tmp/runs.jsonl",
  ].join("\n");
  expect(lastLine(stderr)).toBe("no se pudo ejecutar work-assigned (gh: not logged in)");
});

test("a reason that wraps shows its first line, not the last line of its detail", () => {
  const stderr = [
    "12/10/26 09:47:25 │ ✖ lazy-workflow: no se pudo ejecutar github-issue-list (gh issue fallo (Unknown JSON field: \"blockedBy\"",
    "                  │   Available fields:",
    "                  │     title",
    "                  │     url))",
  ].join("\n");
  expect(lastLine(stderr)).toBe("no se pudo ejecutar github-issue-list (gh issue fallo (Unknown JSON field: \"blockedBy\"");
});

test("a run is titled by the work it names, or by its repository", () => {
  expect(runTitle("code", ["code", "--working-directory", "/r/azure", "--hu", "50", "--ticket", "51"])).toBe("Code · HU #50 · Task #51");
  expect(runTitle("code", ["code", "--working-directory", "/r/github,/r/other"])).toBe("Code · github");
  expect(runTitle("plan", ["plan", "--working-directory", "/r/github", "--prompt", "Planifica a partir de la issue #9 «Epic» (url).\n\nmás"])).toBe("Plan · Issue #9");
  expect(runTitle("setup", ["setup", "--working-directory", "/r/github"])).toBe("Configuración");
});

test("a server path shows the lz account's home as ~, and only a whole folder of it", () => {
  expect(homePath("/home/owner", "/home/owner")).toBe("~");
  expect(homePath("/home/owner/src/app", "/home/owner")).toBe("~/src/app");
  expect(homePath("/home/owner2/src", "/home/owner")).toBe("/home/owner2/src");
  expect(homePath("/srv/repos", null)).toBe("/srv/repos");
});

test("recent activity keeps incomplete runs distinct from completed work", () => {
  const run = foldRuns([{ run_id: "synthetic", ts: "2026-10-10T12:00:00Z", event: "run.started", command: "code", context: { hu: 50, ticket: 8 } }])[0]!;
  expect(run.outcome).toBe("unfinished");
  expect(historyLabel(run)).toBe("Code · HU #50 · Task #8");
});
