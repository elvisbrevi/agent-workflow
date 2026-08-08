import { describe, expect, test } from "bun:test"
import type { CommandRunnerPort } from "../../src/domain/ports"
import { createAzureTracker, parseAzureRemoteUrl, parseAzureTrackerDocument, preflightAzureTracker } from "../../src/tracker/azure"
import { asHuNumber, asTicketNumber } from "../../src/domain/checkpoint"

const document = `# Issue Tracker: Azure DevOps

Use the \`az\` CLI for all operations.

## Azure DevOps configuration
organization = "example-org"
project = "example-project"
repository = "example-repo"
eligible_work_item_types = ["User Story", "Bug", "Task"]
epic_work_item_types = ["Epic"]
delivery_hu_work_item_types = ["User Story"]
delivery_ticket_work_item_types = ["Task", "Bug"]
open_states = ["New", "Active"]
closed_states = ["Closed", "Done"]
ready_tag = "ready-for-agent"
claim_identity = "operator@example.com"
predecessor_relation = "System.LinkTypes.Dependency-Reverse"
closed_state = "Done"
completion_evidence_field = "Completion Evidence"
real_effort_field = "Real Effort"
`

const response = (stdout: string, exitCode = 0) => ({ stdout, stderr: "", exitCode })

const runnerFor = (handler: (program: string, args: ReadonlyArray<string>) => ReturnType<typeof response>): CommandRunnerPort => ({
  spawn: async ({ program, args }) => handler(program, args),
})

const workItem = (id: number, type: string, state: string, extra = ""): string => JSON.stringify({
  id,
  fields: {
    "System.WorkItemType": type,
    "System.State": state,
    "System.Tags": "ready-for-agent",
    "System.Title": `Item ${id}`,
    "System.CreatedDate": id === 100 ? "2026-08-01T09:00:00Z" : id === 101 ? "2026-08-01T10:00:00Z" : "2026-08-02T10:00:00Z",
    ...JSON.parse(extra || "{}"),
  },
  relations: [],
})

describe("parseAzureTrackerDocument", () => {
  test("fails closed when the Azure section is missing", () => {
    expect(parseAzureTrackerDocument("# Issue Tracker: GitHub")).toEqual({
      kind: "invalid",
      reason: "Azure DevOps configuration section is missing",
    })
  })

  test("parses the repository-owned mapping", () => {
    const result = parseAzureTrackerDocument(document)
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.mapping.organization).toBe("example-org")
  })

  test("recognizes supported Azure remote forms", () => {
    expect(parseAzureRemoteUrl("https://dev.azure.com/example-org/example-project/_git/example-repo")).toEqual({
      organization: "example-org",
      project: "example-project",
      repository: "example-repo",
    })
    expect(parseAzureRemoteUrl("git@ssh.dev.azure.com:v3/example-org/example-project/example-repo")).not.toBeNull()
    expect(parseAzureRemoteUrl("https://github.com/example/repo")).toBeNull()
  })
})

describe("preflightAzureTracker", () => {
  test("rejects a remote that does not match the repository mapping", async () => {
    const runner = runnerFor((program, args) => {
      if (program === "az" && args[0] === "version") return response("azure-cli")
      if (program === "az" && args[0] === "extension") return response('{"name":"azure-devops"}')
      if (program === "git" && args[0] === "remote") return response("origin\n")
      if (program === "git" && args[0] === "config") return response("https://dev.azure.com/other/project/_git/repo\n")
      return response("", 1)
    })
    const result = await preflightAzureTracker({ runner, cwd: "/repo", document, azPath: "az" })
    expect(result.kind).toBe("remote_mismatch")
  })
})

describe("Azure tracker", () => {
  test("selects the oldest eligible direct ticket and claims its validated identity", async () => {
    const calls: string[][] = []
    const runner = runnerFor((program, args) => {
      calls.push([program, ...args])
      if (program === "az" && args[0] === "boards" && args[1] === "query") return response('[{"id":100}]')
      if (program === "az" && args[0] === "boards" && args[1] === "work-item" && args[2] === "show") {
        const id = args[args.indexOf("--id") + 1]
        if (id === "100") return response(JSON.stringify({
          id: 100,
          fields: {
            "System.WorkItemType": "User Story",
            "System.State": "Active",
            "System.Tags": "ready-for-agent",
            "System.Title": "Payments HU",
            "System.Description": "",
            "System.CreatedDate": "2026-08-01T09:00:00Z",
          },
          relations: [
            { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example/items/101" },
            { rel: "System.LinkTypes.Hierarchy-Forward", url: "https://example/items/102" },
          ],
        }))
        if (id === "101") return response(workItem(101, "Task", "Active"))
        if (id === "102") return response(workItem(102, "Bug", "Active"))
      }
      if (program === "az" && args[0] === "boards" && args[1] === "work-item" && args[2] === "update") return response('{"id":101}')
      return response("", 1)
    })
    const parsed = parseAzureTrackerDocument(document)
    if (parsed.kind !== "ok") throw new Error("fixture mapping should parse")
    const tracker = createAzureTracker({ runner, cwd: "/repo", mapping: parsed.mapping, azPath: "az", huCandidates: [100] })
    const selection = await tracker.selectEligibleIssue({ baseBranch: "main", currentState: "starting" })
    expect(selection.kind).toBe("selected")
    if (selection.kind === "selected") {
      const hu = asHuNumber(100)
      const ticket = asTicketNumber(101)
      if (hu === null || ticket === null) throw new Error("fixture identity should be valid")
      expect(selection.identity).toEqual({ kind: "azure_ticket", hu, ticket })
      await tracker.claimIssue({ identity: selection.identity })
    }
    expect(calls.some((call) => call[0] === "az" && call[1] === "boards" && call[2] === "work-item" && call[3] === "update" && call.includes("--id") && call.includes("101"))).toBe(true)
  })
})
