/**
 * `credentials-list` y `credentials-get` como comandos: leen los archivos del
 * operador, no abren sesión, y el valor solo sale hacia una terminal o hacia un
 * `--force` declarado — nunca por accidente hacia un pipe.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDeterministicTool,
  type CredentialTools,
  type DeterministicToolServices,
} from "../src/cli/deterministic-tools.ts";
import { buildCli, type CliOptions } from "../src/cli/parse-cli-options.ts";
import { listCredentials, readCredential } from "../src/credentials/credential-store.ts";
import { createReporter } from "../src/output/reporter.ts";
import { setDefaultReporter } from "../src/output/operator-output.ts";

function parseOptions(args: string[]): CliOptions {
  const result = buildCli(() => true)(args, { onHelp: () => 0, onError: () => 1 });
  if (result.kind !== "options") throw new Error(`no parseo: ${JSON.stringify(result)}`);
  return result.options;
}

const servicesWith = (credentials: CredentialTools): DeterministicToolServices => ({
  azure: {},
  queue: {} as never,
  delivery: {} as never,
  branches: {} as never,
  credentials,
});

const unreachable = (): never => {
  throw new Error("no debio leer una credencial");
};

describe("credentials como comandos", () => {
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
      session: () => undefined,
    });
  });

  afterEach(() => {
    setDefaultReporter(createReporter({ verbose: false, noColor: true }));
  });

  test("credentials-list imprime un nombre por linea", async () => {
    const printed: string[] = [];
    const credentials: CredentialTools = {
      list: async () => [
        { name: "ALPHA_API_KEY", file: "alpha.env" },
        { name: "BETA_TOKEN", file: "other.env" },
      ],
      read: unreachable,
    };

    const options = parseOptions(["credentials-list"]);
    const code = await runDeterministicTool(
      "credentials-list",
      options,
      servicesWith(credentials),
      (line) => printed.push(line),
      false,
    );

    expect({ code, printed }).toEqual({ code: 0, printed: ["ALPHA_API_KEY", "BETA_TOKEN"] });
  });

  test("credentials-get fuera de una terminal exige --force y no lee nada", async () => {
    const printed: string[] = [];
    const credentials: CredentialTools = { list: async () => [], read: unreachable };

    const options = parseOptions(["credentials-get", "--name", "ALPHA_API_KEY"]);
    const code = await runDeterministicTool(
      "credentials-get",
      options,
      servicesWith(credentials),
      (line) => printed.push(line),
      false,
    );

    expect({ code, printed }).toEqual({ code: 1, printed: [] });
    expect(messages.length).toBeGreaterThan(0);
  });

  test("credentials-get con --force imprime solo el valor", async () => {
    const printed: string[] = [];
    const credentials: CredentialTools = {
      list: async () => [],
      read: async (_directory, name) => ({ name, file: "alpha.env", value: "valor-de-prueba" }),
    };

    const options = parseOptions(["credentials-get", "--name", "ALPHA_API_KEY", "--force"]);
    const code = await runDeterministicTool(
      "credentials-get",
      options,
      servicesWith(credentials),
      (line) => printed.push(line),
      false,
    );

    expect({ code, printed }).toEqual({ code: 0, printed: ["valor-de-prueba"] });
  });

  test("credentials-get en una terminal no exige --force", async () => {
    const printed: string[] = [];
    const credentials: CredentialTools = {
      list: async () => [],
      read: async (_directory, name) => ({ name, file: "alpha.env", value: "valor-de-prueba" }),
    };

    const options = parseOptions(["credentials-get", "--name", "ALPHA_API_KEY"]);
    const code = await runDeterministicTool(
      "credentials-get",
      options,
      servicesWith(credentials),
      (line) => printed.push(line),
      true,
    );

    expect({ code, printed }).toEqual({ code: 0, printed: ["valor-de-prueba"] });
  });

  test("credentials-get sin --name es un error de argumentos", async () => {
    const printed: string[] = [];
    const credentials: CredentialTools = { list: async () => [], read: unreachable };

    const options = parseOptions(["credentials-get"]);
    const code = await runDeterministicTool(
      "credentials-get",
      options,
      servicesWith(credentials),
      (line) => printed.push(line),
      true,
    );

    expect({ code, printed }).toEqual({ code: 1, printed: [] });
    expect(messages.length).toBeGreaterThan(0);
  });

  test("credentials-get de un nombre ausente falla sin imprimir el valor", async () => {
    const printed: string[] = [];
    const credentials: CredentialTools = {
      list: async () => [],
      read: async () => null,
    };

    const options = parseOptions(["credentials-get", "--name", "NOPE_API_KEY", "--force"]);
    const code = await runDeterministicTool(
      "credentials-get",
      options,
      servicesWith(credentials),
      (line) => printed.push(line),
      false,
    );

    expect({ code, printed }).toEqual({ code: 1, printed: [] });
    expect(messages.length).toBeGreaterThan(0);
  });
});

describe("credential-store", () => {
  test("lista y decodifica las citas que escribe el skill", async () => {
    const directory = await mkdtemp(join(tmpdir(), "credential-store."));
    try {
      await Bun.write(
        join(directory, "alpha.env"),
        [
          "# alpha.env - fixture",
          "export ALPHA_API_KEY='a b'",
          "export QUOTED_TOKEN='it'\\''s ok'",
          'export DOUBLE_SECRET="line\\"quoted"',
          "export ESCAPED_KEY=plain\\ value\\$x",
        ].join("\n") + "\n",
      );
      await Bun.write(join(directory, "beta.env"), "export BETA_TOKEN=beta\n");

      const listed = await listCredentials(directory);
      expect(listed.map((entry) => entry.name)).toEqual([
        "ALPHA_API_KEY",
        "BETA_TOKEN",
        "DOUBLE_SECRET",
        "ESCAPED_KEY",
        "QUOTED_TOKEN",
      ]);
      expect(await readCredential(directory, "ALPHA_API_KEY")).toEqual({
        name: "ALPHA_API_KEY",
        file: "alpha.env",
        value: "a b",
      });
      expect((await readCredential(directory, "QUOTED_TOKEN"))?.value).toBe("it's ok");
      expect((await readCredential(directory, "DOUBLE_SECRET"))?.value).toBe('line"quoted');
      expect((await readCredential(directory, "ESCAPED_KEY"))?.value).toBe("plain value$x");
      expect(await readCredential(directory, "NOPE_API_KEY")).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("un directorio ausente no es un error", async () => {
    expect(await listCredentials("/no/existe/jamas")).toEqual([]);
    expect(await readCredential("/no/existe/jamas", "ALPHA_API_KEY")).toBeNull();
  });
});
