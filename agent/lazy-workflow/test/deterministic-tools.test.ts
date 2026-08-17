import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import {
  createDeterministicToolServices,
  isDeterministicToolCommand,
  runDeterministicTool,
  toBranchRef,
  type AzureToolBoundary,
  type DeterministicToolServices,
} from "../src/cli/deterministic-tools.ts";
import { DETERMINISTIC_TOOL_COMMANDS } from "../src/cli/tool-commands.ts";
import { buildCli, type CliOptions } from "../src/cli/parse-cli-options.ts";
import { createReporter } from "../src/output/reporter.ts";
import { setDefaultReporter } from "../src/output/operator-output.ts";
import { fakeSelectedIssue } from "./_helpers/managed-queue-fixtures.ts";

const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);

/** Every call the tool commands made, so a test asserts the operation and its arguments. */
type Call = { operation: string; args: unknown[] };

function recordingServices(): { services: DeterministicToolServices; calls: Call[] } {
  const calls: Call[] = [];
  const record = <T>(operation: string, result: T) => (...args: unknown[]): Promise<T> => {
    calls.push({ operation, args });
    return Promise.resolve(result);
  };
  const services: DeterministicToolServices = {
    azure: {
      getHuChildren: record("getHuChildren", [{ id: 51, type: "Task", state: "New" }]),
      setHuState: record("setHuState", { hu: 23438, state: "Done", revision: 13 }),
      ensureIntegrationBranch: record("ensureIntegrationBranch", "hu/23438"),
      getTicket: record("getTicket", { id: 51, type: "Task" as const }),
      createOrReusePullRequest: record("createOrReusePullRequest", { pullRequest: 7, mergeCommit: COMMIT }),
      pushTicketBranch: record("pushTicketBranch", undefined),
      checkoutTicketBranch: record("checkoutTicketBranch", undefined),
      writeCompletionManifest: record("writeCompletionManifest", {
        ticket: 51,
        ticketBranch: "refs/heads/ticket/51",
        commit: COMMIT,
        validation: [{ command: "bun test", result: "18 passed" }],
        evidence: [],
      }),
    },
    queue: {
      verifyAuthentication: record("verifyAuthentication", { login: "elvis" }),
      verifyRepository: record("verifyRepository", { nameWithOwner: "owner/repo" }),
      listManagedIssues: record("listManagedIssues", [fakeSelectedIssue(201)]),
      readIssueDetail: record("readIssueDetail", fakeSelectedIssue(201)),
      selectEligibleIssue: record("selectEligibleIssue", { kind: "empty" as const }),
      claimSelectedIssue: record("claimSelectedIssue", fakeSelectedIssue(201)),
      releaseOwnClaim: record("releaseOwnClaim", undefined),
    },
    delivery: {
      prepareBranch: record("prepareBranch", { branch: "refs/heads/issue/201", baseBranch: "refs/heads/main", manifestPath: "/repo/.git/manifest.json" }),
      checkoutBranch: record("checkoutBranch", undefined),
      verifyBranch: record("verifyBranch", undefined),
      cleanupBranch: record("cleanupBranch", undefined),
      readManifest: record("readManifest", { issue: 201, branch: "refs/heads/issue/201", commit: COMMIT, validation: [], clean: true, summary: "ok" }),
      writeManifest: record("writeManifest", { issue: 201, branch: "refs/heads/issue/201", commit: COMMIT, validation: [], clean: true, summary: "ok" }),
      pushCommit: record("pushCommit", undefined),
      createOrReusePullRequest: record("createOrReusePullRequest", { number: 9 }),
      mergePullRequest: record("mergePullRequest", { number: 9, mergeCommit: OTHER_COMMIT }),
      closeIssue: record("closeIssue", undefined),
    },
    branches: {
      deleteTicketBranch: record("deleteTicketBranch", undefined),
    },
  };
  return { services, calls };
}

/**
 * A boundary that is a class, like the production one: `AzureAutocodeService`
 * answers every Azure tool operation by delegating through `this`. The recording
 * boundary above is an object of arrow functions, which cannot lose its
 * receiver, so only a class proves a tool command still calls its operation with
 * the owner attached.
 */
class StatefulAzureBoundary implements AzureToolBoundary {
  readonly seen: string[] = [];
  private readonly delegate = { hu: 23438, ticket: 51, branch: "hu/23438", commit: COMMIT };

  private record<T>(operation: string, result: T): Promise<T> {
    this.seen.push(operation);
    return Promise.resolve(result);
  }

  getHuChildren(): Promise<Array<{ id: number; type: string; state: string }>> {
    return this.record("getHuChildren", [{ id: this.delegate.ticket, type: "Task", state: "New" }]);
  }
  setHuState(hu: number, desiredState: string): Promise<{ hu: number; state: string; revision: number }> {
    return this.record("setHuState", { hu: this.delegate.hu, state: desiredState, revision: 13 });
  }
  ensureIntegrationBranch(): Promise<string | null> {
    return this.record("ensureIntegrationBranch", this.delegate.branch);
  }
  getTicket(): Promise<{ id: number; type: "Task" | "Bug" }> {
    return this.record("getTicket", { id: this.delegate.ticket, type: "Task" });
  }
  createOrReusePullRequest(): Promise<{ pullRequest: number; mergeCommit: string }> {
    return this.record("createOrReusePullRequest", { pullRequest: 7, mergeCommit: this.delegate.commit });
  }
  pushTicketBranch(): Promise<void> {
    return this.record("pushTicketBranch", undefined);
  }
  checkoutTicketBranch(): Promise<void> {
    return this.record("checkoutTicketBranch", undefined);
  }
  writeCompletionManifest(): Promise<any> {
    return this.record("writeCompletionManifest", {
      ticket: this.delegate.ticket,
      ticketBranch: `refs/heads/ticket/${this.delegate.ticket}`,
      commit: this.delegate.commit,
      validation: [{ command: "bun test", result: "18 passed" }],
      evidence: [],
    });
  }
}

/** Every Azure tool command, with the boundary operation it must reach. */
const AZURE_TOOL_INVOCATIONS: Array<{ args: string[]; operation: string }> = [
  { args: ["hu-children-info", "--hu", "23438"], operation: "getHuChildren" },
  {
    args: ["hu-state-set", "--hu", "23438", "--state", "Done", "--expected-state", "En progreso", "--expected-rev", "12"],
    operation: "setHuState",
  },
  { args: ["hu-branch-ensure", "--hu", "23438", "--working-directory", "/repo"], operation: "ensureIntegrationBranch" },
  { args: ["ticket-type-info", "--ticket", "51"], operation: "getTicket" },
  { args: ["ticket-pr-create", "--hu", "23438", "--ticket", "51"], operation: "createOrReusePullRequest" },
  { args: ["ticket-branch-push", "--branch", "ticket/51", "--working-directory", "/repo"], operation: "pushTicketBranch" },
  { args: ["ticket-branch-checkout", "--branch", "ticket/51", "--working-directory", "/repo"], operation: "checkoutTicketBranch" },
  {
    args: [
      "ticket-manifest-set", "--ticket", "51", "--branch", "ticket/51", "--manifest", "/repo/.git/m.json",
      "--validation", "bun test", "--validation-result", "18 passed",
      "--evidence", "http-json:/repo/.git/lazy-workflow/api.json", "--working-directory", "/repo",
    ],
    operation: "writeCompletionManifest",
  },
];

/** The options a real invocation would produce, so the tools read what the parser writes. */
function parseOptions(args: string[]): CliOptions {
  const result = buildCli(() => true)(args, { onHelp: () => 0, onError: () => 1 });
  if (result.kind !== "options") throw new Error(`no parseo: ${JSON.stringify(result)}`);
  return result.options;
}

async function runTool(args: string[]): Promise<{ code: number; printed: string[]; calls: Call[] }> {
  const { services, calls } = recordingServices();
  const printed: string[] = [];
  const options = parseOptions(args);
  const code = await runDeterministicTool(
    options.command as never,
    options,
    services,
    (line) => printed.push(line),
  );
  return { code, printed, calls };
}

const parsed = (printed: string[]): unknown => JSON.parse(printed[0] ?? "null");

describe("herramientas deterministas como comandos", () => {
  let messages: string[];

  beforeEach(() => {
    messages = [];
    setDefaultReporter({
      tracing: false,
      info: (message: string) => { messages.push(message); },
      warn: () => undefined,
      error: (message: string) => { messages.push(message); },
      debug: () => undefined,
      trace: () => undefined,
      heading: () => undefined,
      start: () => ({ stop: () => undefined }) as never,
      stop: () => undefined,
    });
  });

  afterEach(() => {
    setDefaultReporter(createReporter({ verbose: false, noColor: true }));
  });

  test("cada comando declarado es reconocido y ninguno es un comando de workflow", () => {
    for (const command of DETERMINISTIC_TOOL_COMMANDS) {
      expect(isDeterministicToolCommand(command)).toBeTrue();
    }
    expect(isDeterministicToolCommand("code")).toBeFalse();
    expect(isDeterministicToolCommand("plan")).toBeFalse();
    expect(isDeterministicToolCommand("ticket-info")).toBeFalse();
  });

  test("el parser acepta todos los comandos deterministas", () => {
    for (const command of DETERMINISTIC_TOOL_COMMANDS) {
      const result = buildCli(() => true)([command], { onHelp: () => 0, onError: () => 1 });
      expect(result.kind).toBe("options");
      if (result.kind === "options") expect(result.options.command).toBe(command);
    }
  });

  describe("GitHub", () => {
    test("github-auth-info devuelve la identidad autenticada", async () => {
      const { code, printed, calls } = await runTool(["github-auth-info", "--working-directory", "/repo"]);

      expect(code).toBe(0);
      expect(parsed(printed)).toEqual({ login: "elvis" });
      expect(calls).toEqual([{ operation: "verifyAuthentication", args: ["/repo"] }]);
    });

    test("github-repo-info devuelve el repositorio fijado", async () => {
      const { code, printed } = await runTool(["github-repo-info", "--working-directory", "/repo"]);

      expect(code).toBe(0);
      expect(parsed(printed)).toEqual({ nameWithOwner: "owner/repo" });
    });

    test("github-issue-list clasifica la cola igual que el workflow", async () => {
      const { code, printed } = await runTool(["github-issue-list", "--working-directory", "/repo"]);

      expect(code).toBe(0);
      const queue = parsed(printed) as { managed: number; eligible: unknown[]; blocked: unknown[]; issues: Array<{ reasons: string[] }> };
      expect(queue.managed).toBe(1);
      // El fixture ya está asignado, así que la cola lo reporta bloqueado por eso.
      expect(queue.eligible).toEqual([]);
      expect(queue.issues[0]?.reasons).toEqual(["assigned"]);
    });

    test("github-issue-info agrega las razones de elegibilidad al detalle", async () => {
      const { code, printed, calls } = await runTool(["github-issue-info", "--issue", "201", "--working-directory", "/repo"]);

      expect(code).toBe(0);
      expect((parsed(printed) as { number: number; reasons: string[] }).number).toBe(201);
      expect((parsed(printed) as { reasons: string[] }).reasons).toEqual(["assigned"]);
      expect(calls).toEqual([{ operation: "readIssueDetail", args: [201, "/repo"] }]);
    });

    test("github-issue-release libera solo el claim propio, con la identidad autenticada", async () => {
      const { code, printed, calls } = await runTool(["github-issue-release", "--issue", "201", "--working-directory", "/repo"]);

      expect(code).toBe(0);
      expect(parsed(printed)).toEqual({ issue: 201, released: true, login: "elvis" });
      expect(calls.map(({ operation }) => operation)).toEqual(["verifyAuthentication", "releaseOwnClaim"]);
      expect(calls[1]?.args).toEqual([201, "elvis", "/repo"]);
    });

    test("github-branch-prepare devuelve rama, base y manifest", async () => {
      const { code, printed, calls } = await runTool(["github-branch-prepare", "--issue", "201", "--working-directory", "/repo"]);

      expect(code).toBe(0);
      expect(parsed(printed)).toEqual({
        branch: "refs/heads/issue/201",
        baseBranch: "refs/heads/main",
        manifestPath: "/repo/.git/manifest.json",
      });
      expect(calls).toEqual([{ operation: "prepareBranch", args: [201, "/repo"] }]);
    });

    test("una rama corta se completa a su ref antes de llegar al adaptador", async () => {
      const { calls } = await runTool([
        "github-branch-verify", "--branch", "issue/201", "--base-branch", "main", "--working-directory", "/repo",
      ]);

      expect(calls).toEqual([{ operation: "verifyBranch", args: ["refs/heads/issue/201", "refs/heads/main", "/repo"] }]);
    });

    test("una rama ya escrita como ref no se vuelve a prefijar", () => {
      expect(toBranchRef("refs/heads/issue/201")).toBe("refs/heads/issue/201");
      expect(toBranchRef("issue/201")).toBe("refs/heads/issue/201");
    });

    test("github-pr-create fija issue, rama, base y commit", async () => {
      const { code, printed, calls } = await runTool([
        "github-pr-create", "--issue", "201", "--branch", "issue/201",
        "--base-branch", "main", "--commit", COMMIT, "--working-directory", "/repo",
      ]);

      expect(code).toBe(0);
      expect(parsed(printed)).toEqual({
        issue: 201,
        branch: "refs/heads/issue/201",
        baseBranch: "refs/heads/main",
        commit: COMMIT,
        number: 9,
      });
      expect(calls[0]?.args).toEqual([201, "refs/heads/issue/201", "refs/heads/main", COMMIT, "/repo"]);
    });

    test("github-pr-merge devuelve el commit de merge verificado", async () => {
      const { code, printed } = await runTool([
        "github-pr-merge", "--pr", "9", "--issue", "201", "--branch", "issue/201",
        "--base-branch", "main", "--commit", COMMIT, "--working-directory", "/repo",
      ]);

      expect(code).toBe(0);
      expect(parsed(printed)).toEqual({ number: 9, mergeCommit: OTHER_COMMIT });
    });

    test("github-manifest-set arma la declaración del manifest desde los flags", async () => {
      const { code, calls } = await runTool([
        "github-manifest-set", "--issue", "201", "--branch", "issue/201",
        "--manifest", "/repo/.git/manifest.json", "--summary", "Agrega X",
        "--validation", "bun test", "--validation-result", "198 pass",
        "--validation", "bun run build", "--validation-result", "ok",
        "--evidence", "docs/run.json", "--working-directory", "/repo",
      ]);

      expect(code).toBe(0);
      expect(calls[0]?.operation).toBe("writeManifest");
      // Los pares llegan emparejados por posición y la rama completada a su ref.
      expect(calls[0]?.args).toEqual([
        "/repo/.git/manifest.json",
        {
          issue: 201,
          branch: "refs/heads/issue/201",
          summary: "Agrega X",
          validation: [
            { command: "bun test", result: "198 pass" },
            { command: "bun run build", result: "ok" },
          ],
          evidence: ["docs/run.json"],
        },
        "/repo",
      ]);
    });

    test("github-issue-close pasa el commit de merge fijado", async () => {
      const { code, calls } = await runTool([
        "github-issue-close", "--issue", "201", "--pr", "9", "--commit", COMMIT, "--working-directory", "/repo",
      ]);

      expect(code).toBe(0);
      expect(calls).toEqual([{ operation: "closeIssue", args: [201, 9, COMMIT, "/repo"] }]);
    });
  });

  describe("Azure", () => {
    test("hu-children-info devuelve los hijos de la HU", async () => {
      const { code, printed, calls } = await runTool(["hu-children-info", "--hu", "23438"]);

      expect(code).toBe(0);
      expect(parsed(printed)).toEqual({ hu: 23438, children: [{ id: 51, type: "Task", state: "New" }] });
      expect(calls).toEqual([{ operation: "getHuChildren", args: [23438] }]);
    });

    test("hu-state-set exige la revision esperada", async () => {
      const { code } = await runTool([
        "hu-state-set", "--hu", "23438", "--state", "Done", "--expected-state", "En progreso",
      ]);

      expect(code).toBe(1);
      expect(messages).toEqual(["hu-state-set requiere --expected-rev <rev>"]);
    });

    test("hu-state-set aplica la transicion con su revision", async () => {
      const { code, printed, calls } = await runTool([
        "hu-state-set", "--hu", "23438", "--state", "Done", "--expected-state", "En progreso", "--expected-rev", "12",
      ]);

      expect(code).toBe(0);
      expect(parsed(printed)).toEqual({ hu: 23438, state: "Done", revision: 13 });
      expect(calls).toEqual([{ operation: "setHuState", args: [23438, "Done", "En progreso", 12] }]);
    });

    test("hu-branch-ensure devuelve la rama de integracion asegurada", async () => {
      const { code, printed, calls } = await runTool([
        "hu-branch-ensure", "--hu", "23438", "--base-branch", "main", "--working-directory", "/repo",
      ]);

      expect(code).toBe(0);
      expect(parsed(printed)).toEqual({ hu: 23438, branch: "hu/23438" });
      expect(calls).toEqual([{ operation: "ensureIntegrationBranch", args: [23438, "/repo", "main"] }]);
    });

    test("ticket-pr-create devuelve el PR integrado del ticket", async () => {
      const { code, printed } = await runTool(["ticket-pr-create", "--hu", "23438", "--ticket", "51"]);

      expect(code).toBe(0);
      expect(parsed(printed)).toEqual({ hu: 23438, ticket: 51, pullRequest: 7, mergeCommit: COMMIT });
    });

    test("ticket-manifest-set entrega la declaración estructurada, con el commit sin fijar", async () => {
      const { code, calls } = await runTool([
        "ticket-manifest-set", "--ticket", "23575", "--branch", "ticket/23575",
        "--manifest", "/repo/.git/lazy-workflow/completion-manifest.json",
        "--validation", "bun test", "--validation-result", "198 pass",
        "--evidence", "screen:/repo/.git/lazy-workflow/pago.png", "--working-directory", "/repo",
      ]);

      expect(code).toBe(0);
      // Sin `--commit` la declaración no lo lleva: lo resuelve el escritor desde HEAD.
      expect(calls).toEqual([{
        operation: "writeCompletionManifest",
        args: [
          "/repo/.git/lazy-workflow/completion-manifest.json",
          {
            ticket: 23575,
            ticketBranch: "refs/heads/ticket/23575",
            validation: [{ command: "bun test", result: "198 pass" }],
            evidence: [{ path: "/repo/.git/lazy-workflow/pago.png", kind: "screen" }],
          },
          "/repo",
        ],
      }]);
    });

    test("ticket-branch-checkout y ticket-branch-push operan sobre la rama declarada", async () => {
      const checkout = await runTool(["ticket-branch-checkout", "--branch", "ticket/51", "--working-directory", "/repo"]);
      const push = await runTool(["ticket-branch-push", "--branch", "ticket/51", "--working-directory", "/repo"]);

      expect(checkout.code).toBe(0);
      expect(checkout.calls).toEqual([{ operation: "checkoutTicketBranch", args: ["ticket/51", "/repo"] }]);
      expect(push.calls).toEqual([{ operation: "pushTicketBranch", args: ["ticket/51", "/repo"] }]);
    });
  });

  describe("git", () => {
    test("git-branch-delete pasa el commit remoto esperado cuando se declara", async () => {
      const { code, calls } = await runTool([
        "git-branch-delete", "--branch", "ticket/51", "--base-branch", "hu/23438",
        "--commit", COMMIT, "--working-directory", "/repo",
      ]);

      expect(code).toBe(0);
      expect(calls).toEqual([{
        operation: "deleteTicketBranch",
        args: ["refs/heads/ticket/51", "refs/heads/hu/23438", "/repo", COMMIT],
      }]);
    });

    test("sin --commit la eliminacion no fija un commit remoto", async () => {
      const { calls } = await runTool([
        "git-branch-delete", "--branch", "ticket/51", "--base-branch", "hu/23438", "--working-directory", "/repo",
      ]);

      expect(calls[0]?.args[3]).toBeUndefined();
    });
  });

  describe("receptor del boundary", () => {
    test("cada herramienta Azure alcanza su operacion con el boundary como receptor", async () => {
      for (const { args, operation } of AZURE_TOOL_INVOCATIONS) {
        const azure = new StatefulAzureBoundary();
        const { services } = recordingServices();
        const options = parseOptions(args);

        const code = await runDeterministicTool(
          options.command as never,
          options,
          { ...services, azure },
          () => undefined,
        );

        expect({ command: options.command, code, seen: azure.seen })
          .toEqual({ command: options.command, code: 0, seen: [operation] });
      }
      expect(messages).toEqual([]);
    });
  });

  describe("argumentos y fallos", () => {
    test("un argumento faltante se reporta y devuelve 1 sin llamar al adaptador", async () => {
      const { code, calls } = await runTool(["github-issue-info", "--working-directory", "/repo"]);

      expect(code).toBe(1);
      expect(calls).toEqual([]);
      expect(messages).toEqual(["github-issue-info requiere --issue <id> con un entero positivo"]);
    });

    test("una operacion ausente en el boundary se reporta como no soportada", async () => {
      const options = parseOptions(["hu-children-info", "--hu", "1"]);
      const { services } = recordingServices();
      const code = await runDeterministicTool(
        "hu-children-info",
        options,
        { ...services, azure: {} },
        () => undefined,
      );

      expect(code).toBe(1);
      expect(messages).toEqual(["El servicio no soporta hu-children-info"]);
    });

    test("un fallo del adaptador se reporta nombrando el comando", async () => {
      const options = parseOptions(["github-repo-info", "--working-directory", "/repo"]);
      const { services } = recordingServices();
      const code = await runDeterministicTool(
        "github-repo-info",
        options,
        {
          ...services,
          queue: { ...services.queue, verifyRepository: async () => { throw new Error("gh repo view fallo"); } },
        },
        () => undefined,
      );

      expect(code).toBe(1);
      expect(messages).toEqual(["lazy-workflow: no se pudo ejecutar github-repo-info (gh repo view fallo)"]);
    });
  });

  describe("integracion con la CLI", () => {
    test("la CLI despacha el comando determinista sin abrir sesion ni tocar el agente", async () => {
      const { services, calls } = recordingServices();
      const agent = {
        run: async () => { throw new Error("una herramienta determinista no abre sesion"); },
        resume: async () => { throw new Error("una herramienta determinista no abre sesion"); },
      };
      const cli = new LazyWorkflowCli(
        { getHuInfo: async () => { throw new Error("sin Azure"); }, waitForAccess: async () => undefined },
        agent,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined,
        services,
      );

      const code = await cli.run(["github-auth-info", "--working-directory", "/repo"]);

      expect(code).toBe(0);
      expect(calls).toEqual([{ operation: "verifyAuthentication", args: ["/repo"] }]);
    });

    test("la CLI arma sus servicios con el servicio Azure real y la herramienta lo alcanza", async () => {
      // No injected services: the CLI builds them from its own Azure service, as
      // a real invocation does. That service is a class, so this is the path
      // where a detached operation loses `this` (issue #256).
      class AzureServiceLikeProduction {
        private readonly children = [{ id: 51, type: "Task", state: "New" }];
        getHuInfo(): Promise<never> { throw new Error("una herramienta determinista no consulta la HU"); }
        async waitForAccess(): Promise<void> { return undefined; }
        getHuChildren(): Promise<Array<{ id: number; type: string; state: string }>> {
          return Promise.resolve(this.children);
        }
      }
      const agent = {
        run: async () => { throw new Error("una herramienta determinista no abre sesion"); },
        resume: async () => { throw new Error("una herramienta determinista no abre sesion"); },
      };
      const cli = new LazyWorkflowCli(new AzureServiceLikeProduction(), agent);

      // The CLI prints the tool result itself, and the payload is what proves the
      // receiver survived: `children` only exists behind `this`.
      const printed: string[] = [];
      const log = console.log;
      console.log = (line: string) => { printed.push(line); };
      let code: number;
      try {
        code = await cli.run(["hu-children-info", "--hu", "23438"]);
      } finally {
        console.log = log;
      }

      expect(code).toBe(0);
      expect(messages).toEqual([]);
      expect(JSON.parse(printed[0] ?? "null")).toEqual({
        hu: 23438,
        children: [{ id: 51, type: "Task", state: "New" }],
      });
    });

    test("sin boundaries inyectados la CLI construye los adaptadores reales", () => {
      const services = createDeterministicToolServices({});

      expect(typeof services.queue.verifyAuthentication).toBe("function");
      expect(typeof services.delivery.prepareBranch).toBe("function");
      expect(typeof services.branches.deleteTicketBranch).toBe("function");
    });
  });
});
