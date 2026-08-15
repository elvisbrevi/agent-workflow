import { test, expect } from "bun:test";
import { authorityConfigPath, authorityProfile } from "../src/prompts/authority-profile.ts";
import type { WorkflowPromptSpec } from "../src/prompts/workflow-prompt.ts";
import { OpenCodeService, type OpenCodeProcess } from "../src/opencode/open-code-service.ts";
import { createReporter } from "../src/output/reporter.ts";

const issue = { number: 1, title: "t", state: "OPEN", labels: [], assignees: [], createdAt: "", blockedBy: { nodes: [] }, body: "", comments: [] };
const repository = { nameWithOwner: "o/r" };
const scope = { repositories: [{ path: "/ws/a", remote: "r" }], parentDirectory: "/ws", stateDirectory: "/ws/.s" };
const topology = { integrationBranch: "refs/heads/hu/1", ticketBranch: "refs/heads/ticket/2" };

const specs: Array<[WorkflowPromptSpec, string]> = [
  [{ kind: "github-plan" }, "lazy-github-plan"],
  [{ kind: "azure-plan", huInfo: { id: 1 } as never }, "lazy-azure-plan"],
  [{ kind: "workspace-plan", scope: scope as never, huInfo: null }, "lazy-github-plan"],
  [{ kind: "workspace-plan", scope: scope as never, huInfo: { id: 1 } as never }, "lazy-azure-plan"],
  [{ kind: "github-delivery", issue: issue as never, repository, branch: "b", manifestPath: "m" }, "lazy-github-code"],
  [{ kind: "github-code-uncoordinated", issue: issue as never, repository }, "lazy-github-code"],
  [{ kind: "github-workspace-delivery", scope: scope as never, issue: issue as never, units: [] }, "lazy-github-code"],
  [{
    kind: "github-reconciliation",
    issue: issue as never,
    repository,
    branch: "b",
    manifestPath: "m",
    pullRequest: 1,
    originalCommit: "a",
    baseCommit: "b",
  }, "lazy-github-code"],
  [{
    kind: "azure-workspace-delivery",
    scope: scope as never,
    hu: 1,
    ticket: 2,
    topology: topology as never,
    ticketTopology: topology as never,
  }, "lazy-azure-code"],
  [{
    kind: "azure-delivery",
    context: {} as never,
    ticketBranch: null,
    evidenceDirectory: null,
    manifestPath: null,
    workflowPhase: "implementing",
    completionGates: [],
  }, "lazy-azure-code"],
  [{ kind: "architecture-review-sag", scope: {}, context: {} as never }, "lazy-review"],
];

test("cada clase de run recibe su perfil de autoridad", () => {
  for (const [spec, profile] of specs) {
    expect(`${spec.kind}: ${authorityProfile(spec)}`).toBe(`${spec.kind}: ${profile}`);
  }
});

test("todo perfil referenciado existe en la configuracion de autoridad", async () => {
  const config = await Bun.file(authorityConfigPath()).json();
  const defined = Object.keys(config.agent);
  for (const [spec] of specs) {
    expect(`${spec.kind}: ${defined.includes(authorityProfile(spec))}`).toBe(`${spec.kind}: true`);
  }
});

test("ningun perfil de entrega puede empujar, ramificar ni usar el proveedor ajeno", async () => {
  const config = await Bun.file(authorityConfigPath()).json();
  for (const profile of ["lazy-github-code", "lazy-azure-code"]) {
    const bash = config.agent[profile].permission.bash;
    for (const pattern of ["git push*", "git branch*", "git checkout -b*", "git remote*"]) {
      expect(`${profile} ${pattern}: ${bash[pattern]}`).toBe(`${profile} ${pattern}: deny`);
    }
  }
  // Each delivery profile denies the tracker CLI of the provider it does not own.
  expect(config.agent["lazy-github-code"].permission.bash["az*"]).toBe("deny");
  expect(config.agent["lazy-azure-code"].permission.bash["gh*"]).toBe("deny");
  expect(config.agent["lazy-azure-code"].permission.bash["az*"]).toBe("deny");
});

test("el perfil de revision no puede editar", async () => {
  const config = await Bun.file(authorityConfigPath()).json();
  expect(config.agent["lazy-review"].permission.edit).toBe("deny");
});

test("run pasa --agent y OPENCODE_CONFIG al proceso OpenCode", async () => {
  let command: string[] = [];
  let options: { cwd?: string; env?: Record<string, string> } | undefined;
  const spawn = (received: string[], receivedOptions?: { cwd?: string; env?: Record<string, string> }): OpenCodeProcess => {
    command = received;
    options = receivedOptions;
    return {
      stdout: new ReadableStream({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text: "ok" } })}\n`));
          controller.close();
        },
      }),
      stderr: new ReadableStream({ start: (controller) => controller.close() }),
      exited: Promise.resolve(0),
      kill: () => undefined,
    };
  };

  await new OpenCodeService(spawn, createReporter({ quiet: true, verbose: false, noColor: true })).run({
    model: "m",
    variant: "v",
    session: null,
    prompt: "p",
    workingDirectory: "/repo",
    agent: { profile: "lazy-github-code", configPath: "/cfg/authority.json" },
  });

  expect(command).toContain("--agent");
  expect(command[command.indexOf("--agent") + 1]).toBe("lazy-github-code");
  expect(options?.env?.OPENCODE_CONFIG).toBe("/cfg/authority.json");
});

test("un run sin autoridad no inyecta --agent ni configuracion", async () => {
  let command: string[] = [];
  let options: { cwd?: string; env?: Record<string, string> } | undefined;
  const spawn = (received: string[], receivedOptions?: { cwd?: string; env?: Record<string, string> }): OpenCodeProcess => {
    command = received;
    options = receivedOptions;
    return {
      stdout: new ReadableStream({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", text: "ok" } })}\n`));
          controller.close();
        },
      }),
      stderr: new ReadableStream({ start: (controller) => controller.close() }),
      exited: Promise.resolve(0),
      kill: () => undefined,
    };
  };

  await new OpenCodeService(spawn, createReporter({ quiet: true, verbose: false, noColor: true })).run({
    model: "m",
    variant: "v",
    session: null,
    prompt: "p",
  });

  expect(command).not.toContain("--agent");
  expect(options?.env).toBeUndefined();
});
