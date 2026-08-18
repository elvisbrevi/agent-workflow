import { test, expect } from "bun:test";
import {
  AUTHORITY_PROFILES,
  authorityConfigPath,
  authorityProfile,
} from "../src/prompts/authority-profile.ts";
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
  [{ kind: "workspace-plan", scope: scope as never, run: { kind: "github-repository-run" }, huInfo: null }, "lazy-github-plan"],
  [{ kind: "workspace-plan", scope: scope as never, run: { kind: "azure-hu-run", hu: 1 }, huInfo: { id: 1 } as never }, "lazy-azure-plan"],
  [{ kind: "github-delivery", issue: issue as never, repository, branch: "b", manifestPath: "m" }, "lazy-github-code"],
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
    context: {} as never,
    description: null,
    topology: topology as never,
    ticketTopology: topology as never,
    manifestPaths: [],
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
  const config = await Bun.file(authorityConfigPath("opencode", "lazy-github-code")).json();
  const defined = Object.keys(config.agent);
  for (const [spec] of specs) {
    expect(`${spec.kind}: ${defined.includes(authorityProfile(spec))}`).toBe(`${spec.kind}: true`);
  }
});

test("cada CLI resuelve su propia autoridad para cada perfil", async () => {
  for (const profile of AUTHORITY_PROFILES) {
    const opencode = authorityConfigPath("opencode", profile);
    const claudecode = authorityConfigPath("claudecode", profile);
    expect(`${profile} opencode: ${opencode.endsWith("/opencode/authority.json")}`)
      .toBe(`${profile} opencode: true`);
    expect(`${profile} claudecode: ${claudecode.endsWith(`/claudecode/${profile}.json`)}`)
      .toBe(`${profile} claudecode: true`);
    expect(`${profile} existe: ${await Bun.file(claudecode).exists()}`).toBe(`${profile} existe: true`);
  }
});

test("ningun flujo queda sin autoridad al usar Claude Code", async () => {
  for (const [spec] of specs) {
    const path = authorityConfigPath("claudecode", authorityProfile(spec));
    expect(`${spec.kind}: ${await Bun.file(path).exists()}`).toBe(`${spec.kind}: true`);
  }
});

/** The Claude Code spelling of an OpenCode bash pattern: `git push*` is `Bash(git push:*)`. */
const asDenyRule = (pattern: string): string => `Bash(${pattern.replace(/\*$/, "")}:*)`;

test("cada perfil de Claude Code prohibe lo mismo que su gemelo de OpenCode", async () => {
  const opencode = await Bun.file(authorityConfigPath("opencode", "lazy-review")).json();
  for (const profile of AUTHORITY_PROFILES) {
    const { permissions } = await Bun.file(authorityConfigPath("claudecode", profile)).json();
    for (const pattern of Object.keys(opencode.agent[profile].permission.bash)) {
      const rule = asDenyRule(pattern);
      expect(`${profile} ${rule}: ${permissions.deny.includes(rule)}`).toBe(`${profile} ${rule}: true`);
    }
  }
});

test("el perfil de revision de Claude Code tampoco puede editar el arbol", async () => {
  const { permissions } = await Bun.file(authorityConfigPath("claudecode", "lazy-review")).json();
  for (const tool of ["Edit", "Write", "NotebookEdit"]) {
    expect(`${tool}: ${permissions.deny.includes(tool)}`).toBe(`${tool}: true`);
  }
});

test("los perfiles de entrega de Claude Code siguen pudiendo commitear", async () => {
  // The manifest names a commit the session itself must produce.
  for (const profile of ["lazy-github-code", "lazy-azure-code"] as const) {
    const { permissions } = await Bun.file(authorityConfigPath("claudecode", profile)).json();
    const commits = permissions.deny.filter((rule: string) => rule.startsWith("Bash(git commit"));
    expect(`${profile}: ${commits.length}`).toBe(`${profile}: 0`);
  }
});

test("ningun perfil de entrega puede empujar, ramificar ni usar el proveedor ajeno", async () => {
  const config = await Bun.file(authorityConfigPath("opencode", "lazy-github-code")).json();
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

test("ningun perfil de planificacion puede mutar el tracker", async () => {
  const config = await Bun.file(authorityConfigPath("opencode", "lazy-github-code")).json();
  // The coordinator publishes planning work items, so no planning run needs `az`.
  expect(config.agent["lazy-azure-plan"].permission.bash["az*"]).toBe("deny");
  expect(config.agent["lazy-github-plan"].permission.bash["az*"]).toBe("deny");
  for (const profile of ["lazy-azure-plan", "lazy-github-plan"]) {
    expect(`${profile}: ${config.agent[profile].permission.bash["git push*"]}`).toBe(`${profile}: deny`);
  }
});

test("el perfil de revision no puede editar", async () => {
  const config = await Bun.file(authorityConfigPath("opencode", "lazy-github-code")).json();
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
