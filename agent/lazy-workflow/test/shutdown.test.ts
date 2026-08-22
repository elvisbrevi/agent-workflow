import { describe, expect, test } from "bun:test";
import { LazyWorkflowCli } from "../src/cli/lazy-workflow-cli.ts";
import type { DeterministicToolServices } from "../src/cli/deterministic-tools.ts";
import type { createReporter, Reporter, ReporterFailureDetail } from "../src/output/reporter.ts";
import { redactPassword, SudoSystemShutdown, type SystemShutdown } from "../src/system/shutdown-service.ts";

/**
 * A reporter that records what the run said and still feeds the run-log sink it
 * was built with: the CLI decides whether to shut down from the failure kinds
 * that reach that sink, so a stand-in that swallowed them would answer a
 * question this suite is not asking.
 */
function recordingReporter(): { reporterFn: typeof createReporter; lines: Array<{ level: string; message: string }> } {
  const lines: Array<{ level: string; message: string }> = [];
  const reporterFn = ((options?: { runLog?: { event(level: "info" | "warn" | "error", message: string, detail?: ReporterFailureDetail): void } }) => {
    const emit = (level: "info" | "warn" | "error") => (message: string, detail?: ReporterFailureDetail) => {
      lines.push({ level, message });
      options?.runLog?.event(level, message, detail);
    };
    const reporter: Reporter = {
      tracing: false,
      info: (message: string) => emit("info")(message),
      warn: emit("warn"),
      error: emit("error"),
      debug: () => undefined,
      trace: () => undefined,
      heading: () => undefined,
      start: () => ({ stop: () => undefined }) as never,
      stop: () => undefined,
      session: () => undefined,
    };
    return reporter;
  }) as typeof createReporter;
  return { reporterFn, lines };
}

/** Records the shutdown instead of performing it; a suite must survive its own tests. */
function fakeShutdown(behavior: "ok" | "fails" = "ok"): SystemShutdown & { calls: Array<string | null> } {
  const calls: Array<string | null> = [];
  return {
    calls,
    async shutdown(password) {
      calls.push(password);
      if (behavior === "fails") throw new Error("sudo: a password is required");
    },
  };
}

const fakeTimer = (): { wait(ms: number): Promise<void>; waits: number[] } => {
  const waits: number[] = [];
  return { waits, async wait(milliseconds: number) { waits.push(milliseconds); } };
};

/** The one deterministic tool this suite runs: an empty queue is a successful run that touches nothing. */
const queueServices = (listManagedIssues: () => Promise<never[]>): DeterministicToolServices => ({
  azure: {},
  queue: {
    verifyAuthentication: async () => ({ login: "octocat" }),
    verifyRepository: async () => ({ nameWithOwner: "o/r" }),
    listManagedIssues,
    readIssueDetail: async () => { throw new Error("not used"); },
    selectEligibleIssue: async () => { throw new Error("not used"); },
    claimSelectedIssue: async () => { throw new Error("not used"); },
    releaseOwnClaim: async () => { throw new Error("not used"); },
  },
  delivery: {
    prepareBranch: async () => { throw new Error("not used"); },
    checkoutBranch: async () => { throw new Error("not used"); },
    verifyBranch: async () => { throw new Error("not used"); },
    cleanupBranch: async () => { throw new Error("not used"); },
    readManifest: async () => { throw new Error("not used"); },
    pushCommit: async () => { throw new Error("not used"); },
    createOrReusePullRequest: async () => { throw new Error("not used"); },
    mergePullRequest: async () => { throw new Error("not used"); },
    closeIssue: async () => { throw new Error("not used"); },
  },
  branches: { deleteTicketBranch: async () => { throw new Error("not used"); } },
});

interface Harness {
  run(args: string[]): Promise<number>;
  shutdown: ReturnType<typeof fakeShutdown>;
  timer: ReturnType<typeof fakeTimer>;
  lines: Array<{ level: string; message: string }>;
}

function harness(options: { queue?: () => Promise<never[]>; shutdownBehavior?: "ok" | "fails" } = {}): Harness {
  const shutdown = fakeShutdown(options.shutdownBehavior);
  const timer = fakeTimer();
  const { reporterFn, lines } = recordingReporter();
  const services = queueServices(options.queue ?? (async () => []));
  const cli = new LazyWorkflowCli(
    undefined, undefined, undefined,
    timer, // 4: retryTimer, para no dormir la gracia de verdad
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    reporterFn, // 13: createReporterFn
    undefined, undefined, undefined, undefined, undefined, undefined,
    services, // 20: deterministicToolServices
    undefined, undefined,
    shutdown, // 23: systemShutdown
  );
  return { run: (args) => cli.run(args), shutdown, timer, lines };
}

const listArgs = ["github-issue-list", "--working-directory", "/tmp", "--no-log-file"];

describe("apagado del equipo al terminar el run (--off)", () => {
  test("sin --off el run no apaga nada", async () => {
    const cli = harness();
    expect(await cli.run(listArgs)).toBe(0);
    expect(cli.shutdown.calls).toEqual([]);
    expect(cli.timer.waits).toEqual([]);
  });

  test("un run exitoso con --off apaga con la contrasena declarada, tras la gracia por defecto", async () => {
    const cli = harness();
    expect(await cli.run([...listArgs, "--off", "MiPassword123"])).toBe(0);
    expect(cli.shutdown.calls).toEqual(["MiPassword123"]);
    expect(cli.timer.waits).toEqual([15_000]);
    expect(cli.lines.some((line) => line.level === "warn" && line.message.includes("apagará el equipo en 15s"))).toBeTrue();
  });

  test("-off es la misma forma con un solo guion", async () => {
    const cli = harness();
    expect(await cli.run([...listArgs, "-off", "MiPassword123"])).toBe(0);
    expect(cli.shutdown.calls).toEqual(["MiPassword123"]);
  });

  test("--off-delay 0 apaga sin gracia previa", async () => {
    const cli = harness();
    expect(await cli.run([...listArgs, "--off", "clave", "--off-delay", "0"])).toBe(0);
    expect(cli.timer.waits).toEqual([]);
    expect(cli.shutdown.calls).toEqual(["clave"]);
  });

  test("un run que falla igual apaga: quien lo dejo corriendo ya no esta frente al equipo", async () => {
    const cli = harness({ queue: async () => { throw new Error("tracker inalcanzable"); } });
    expect(await cli.run([...listArgs, "--off", "clave"])).toBe(1);
    expect(cli.shutdown.calls).toEqual(["clave"]);
  });

  test("un run que murio por un error de argumentos no apaga el equipo", async () => {
    const cli = harness();
    expect(await cli.run(["code", "--branch", "foo", "--working-directory", "/tmp", "--no-log-file", "--off", "clave"])).toBe(1);
    expect(cli.shutdown.calls).toEqual([]);
  });

  test("un apagado que falla se reporta y deja el resultado del run intacto", async () => {
    const cli = harness({ shutdownBehavior: "fails" });
    expect(await cli.run([...listArgs, "--off", "clave"])).toBe(0);
    expect(cli.lines.some((line) => line.level === "error" && line.message.includes("no se pudo apagar el equipo"))).toBeTrue();
  });
});

/** A stand-in for `Bun.spawn`, so the adapter's own command and stdin are read without a real sudo. */
function spawnRecorder(exitCode: number, stderr = ""): { spawn: typeof Bun.spawn; commands: string[][]; stdin: string[] } {
  const commands: string[][] = [];
  const stdin: string[] = [];
  const spawn = ((command: string[]) => {
    commands.push(command);
    return {
      stdin: { write: (chunk: string) => { stdin.push(chunk); }, end: async () => 0 },
      stdout: new Response("").body,
      stderr: new Response(stderr).body,
      exited: Promise.resolve(exitCode),
    };
  }) as unknown as typeof Bun.spawn;
  return { spawn, commands, stdin };
}

describe("SudoSystemShutdown", () => {
  test("con contrasena la entrega por stdin, nunca como argumento", async () => {
    const recorder = spawnRecorder(0);
    await new SudoSystemShutdown(recorder.spawn).shutdown("MiPassword123");

    expect(recorder.commands).toEqual([["sudo", "-S", "-p", "", "shutdown", "-h", "now"]]);
    expect(recorder.stdin).toEqual(["MiPassword123\n"]);
  });

  test("sin contrasena usa un sudo que no la pide, en vez de esperar un prompt que nadie responde", async () => {
    const recorder = spawnRecorder(0);
    await new SudoSystemShutdown(recorder.spawn).shutdown(null);

    expect(recorder.commands).toEqual([["sudo", "-n", "shutdown", "-h", "now"]]);
    expect(recorder.stdin).toEqual([]);
  });

  test("un comando que falla explica el motivo con la contrasena redactada", async () => {
    const recorder = spawnRecorder(1, "sudo: 1 incorrect password attempt para MiPassword123");
    const shutdown = new SudoSystemShutdown(recorder.spawn).shutdown("MiPassword123");

    await expect(shutdown).rejects.toThrow("incorrect password");
    await shutdown.catch((error: unknown) => {
      expect(String(error)).not.toContain("MiPassword123");
      expect(String(error)).toContain("***");
    });
  });

  test("redactPassword deja el texto intacto cuando no hay contrasena que ocultar", () => {
    expect(redactPassword("sudo: command not found", null)).toBe("sudo: command not found");
  });
});
