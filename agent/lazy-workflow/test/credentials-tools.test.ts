/**
 * `credentials-*` como comandos: leen y escriben los archivos del operador, no
 * abren sesión, y el valor solo sale hacia una terminal o hacia un `--force`
 * declarado — nunca por accidente hacia un pipe. `credentials-set` es la
 * escritura: toma el valor de un prompt oculto o de `--stdin`, jamás de una
 * bandera, y lo guarda sin imprimirlo.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDeterministicTool,
  type CredentialTools,
  type DeterministicToolServices,
} from "../src/cli/deterministic-tools.ts";
import { buildCli, type CliOptions } from "../src/cli/parse-cli-options.ts";
import {
  listCredentials,
  readCredential,
  storeCredential,
} from "../src/credentials/credential-store.ts";
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
  throw new Error("no debio tocar una credencial");
};

/** Las operaciones que un caso no ejercita fallan si alguien las llama. */
const credentialTools = (overrides: Partial<CredentialTools>): CredentialTools => ({
  list: async () => [],
  read: unreachable,
  readSecret: unreachable,
  store: unreachable,
  update: unreachable,
  ...overrides,
});

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
    const credentials = credentialTools({
      list: async () => [
        { name: "ALPHA_API_KEY", file: "alpha.env" },
        { name: "BETA_TOKEN", file: "other.env" },
      ],
    });

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
    const credentials = credentialTools({});

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
    const credentials = credentialTools({
      read: async (_directory, name) => ({ name, file: "alpha.env", value: "valor-de-prueba" }),
    });

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
    const credentials = credentialTools({
      read: async (_directory, name) => ({ name, file: "alpha.env", value: "valor-de-prueba" }),
    });

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
    const credentials = credentialTools({});

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
    const credentials = credentialTools({ read: async () => null });

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

  test("credentials-set guarda el valor y responde donde quedo, sin imprimirlo", async () => {
    const printed: string[] = [];
    const secretCalls: Array<{ name: string; fromStdin: boolean }> = [];
    const storeCalls: Array<{ name: string; service: string | null; value: string }> = [];
    const credentials = credentialTools({
      readSecret: async (name, fromStdin) => {
        secretCalls.push({ name, fromStdin });
        return "valor-de-prueba";
      },
      store: async (_directory, name, service, value) => {
        storeCalls.push({ name, service, value });
        return { name, file: "alpha.env", chezmoiSource: "published" };
      },
    });

    const options = parseOptions(["credentials-set", "--name", "ALPHA_API_KEY"]);
    const code = await runDeterministicTool(
      "credentials-set",
      options,
      servicesWith(credentials),
      (line) => printed.push(line),
      false,
    );

    expect({ code, secretCalls, storeCalls }).toEqual({
      code: 0,
      secretCalls: [{ name: "ALPHA_API_KEY", fromStdin: false }],
      storeCalls: [{ name: "ALPHA_API_KEY", service: null, value: "valor-de-prueba" }],
    });
    expect(printed.join("\n")).not.toContain("valor-de-prueba");
    expect(JSON.parse(printed.join("\n"))).toEqual({
      name: "ALPHA_API_KEY",
      file: "alpha.env",
      chezmoiSource: "published",
    });
  });

  test("credentials-set lee de stdin y escribe en el servicio declarados", async () => {
    const printed: string[] = [];
    const secretCalls: Array<{ name: string; fromStdin: boolean }> = [];
    const storeCalls: Array<{ name: string; service: string | null; value: string }> = [];
    const credentials = credentialTools({
      readSecret: async (name, fromStdin) => {
        secretCalls.push({ name, fromStdin });
        return "otro-valor";
      },
      store: async (_directory, name, service, value) => {
        storeCalls.push({ name, service, value });
        return { name, file: "deepseek.env", chezmoiSource: "unmanaged" };
      },
    });

    const options = parseOptions([
      "credentials-set",
      "--name",
      "DEEPSEEK_API_KEY",
      "--service",
      "deepseek",
      "--stdin",
    ]);
    const code = await runDeterministicTool(
      "credentials-set",
      options,
      servicesWith(credentials),
      (line) => printed.push(line),
      false,
    );

    expect({ code, secretCalls, storeCalls }).toEqual({
      code: 0,
      secretCalls: [{ name: "DEEPSEEK_API_KEY", fromStdin: true }],
      storeCalls: [{ name: "DEEPSEEK_API_KEY", service: "deepseek", value: "otro-valor" }],
    });
    expect(printed.join("\n")).not.toContain("otro-valor");
  });

  test("credentials-set sin --name es un error de argumentos", async () => {
    const printed: string[] = [];
    const credentials = credentialTools({});

    const options = parseOptions(["credentials-set"]);
    const code = await runDeterministicTool(
      "credentials-set",
      options,
      servicesWith(credentials),
      (line) => printed.push(line),
      true,
    );

    expect({ code, printed }).toEqual({ code: 1, printed: [] });
    expect(messages.length).toBeGreaterThan(0);
  });

  test("--service y --stdin solo aplican a credentials-set", () => {
    expect(() => parseOptions(["credentials-get", "--name", "ALPHA_API_KEY", "--service", "alpha"])).toThrow();
    expect(() => parseOptions(["credentials-list", "--stdin"])).toThrow();
  });

  test("credentials-update trae los valores publicados sin pedir nombre", async () => {
    const printed: string[] = [];
    const updated: string[] = [];
    const credentials = credentialTools({
      update: async (directory) => { updated.push(directory); },
    });

    const options = parseOptions(["credentials-update"]);
    const code = await runDeterministicTool(
      "credentials-update",
      options,
      servicesWith(credentials),
      (line) => printed.push(line),
      false,
    );

    expect(code).toBe(0);
    expect(updated).toHaveLength(1);
    expect(printed).toHaveLength(1);
    expect(JSON.parse(printed[0]!)).toEqual({ updated: true, directory: updated[0] });
  });

  test("credentials-update falla ruidosamente cuando el pull o el apply fallan", async () => {
    const printed: string[] = [];
    const credentials = credentialTools({
      update: async () => { throw new Error("no se pudo traer el repositorio de dotfiles"); },
    });

    const options = parseOptions(["credentials-update"]);
    const code = await runDeterministicTool(
      "credentials-update",
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
  test("lista y decodifica las citas que escriben el skill y este modulo", async () => {
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
          "export PY_QUOTED_TOKEN='it'\"'\"'s ok'",
        ].join("\n") + "\n",
      );
      await Bun.write(join(directory, "beta.env"), "export BETA_TOKEN=beta\n");

      const listed = await listCredentials(directory);
      expect(listed.map((entry) => entry.name)).toEqual([
        "ALPHA_API_KEY",
        "BETA_TOKEN",
        "DOUBLE_SECRET",
        "ESCAPED_KEY",
        "PY_QUOTED_TOKEN",
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
      expect((await readCredential(directory, "PY_QUOTED_TOKEN"))?.value).toBe("it's ok");
      expect(await readCredential(directory, "NOPE_API_KEY")).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("un directorio ausente no es un error", async () => {
    expect(await listCredentials("/no/existe/jamas")).toEqual([]);
    expect(await readCredential("/no/existe/jamas", "ALPHA_API_KEY")).toBeNull();
  });

  test("storeCredential crea el env 0600, reemplaza en el lugar y decodifica de vuelta", async () => {
    const directory = await mkdtemp(join(tmpdir(), "credential-store."));
    try {
      const stored = await storeCredential(directory, "ALPHA_API_KEY", "alpha", "a b");
      expect(stored).toEqual({ name: "ALPHA_API_KEY", file: "alpha.env" });

      const path = join(directory, "alpha.env");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect(await Bun.file(path).text()).toBe(
        "# alpha.env - managed by chezmoi; load with: load-env alpha\n\nexport ALPHA_API_KEY='a b'\n",
      );

      await storeCredential(directory, "ALPHA_API_KEY", null, "it's ok");
      expect(await Bun.file(path).text()).toBe(
        "# alpha.env - managed by chezmoi; load with: load-env alpha\n\nexport ALPHA_API_KEY='it'\\''s ok'\n",
      );
      expect((await readCredential(directory, "ALPHA_API_KEY"))?.value).toBe("it's ok");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("storeCredential respeta el archivo que ya declara el nombre y usa --service para el nuevo", async () => {
    const directory = await mkdtemp(join(tmpdir(), "credential-store."));
    try {
      expect(await storeCredential(directory, "GAMMA_TOKEN", null, "uno")).toEqual({
        name: "GAMMA_TOKEN",
        file: "other.env",
      });
      expect(await storeCredential(directory, "GAMMA_TOKEN", "delta", "dos")).toEqual({
        name: "GAMMA_TOKEN",
        file: "other.env",
      });
      expect(await storeCredential(directory, "EPSILON_TOKEN", "epsilon.env", "tres")).toEqual({
        name: "EPSILON_TOKEN",
        file: "epsilon.env",
      });
      expect((await readCredential(directory, "GAMMA_TOKEN"))?.value).toBe("dos");
      expect((await readCredential(directory, "EPSILON_TOKEN"))?.value).toBe("tres");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("storeCredential falla cuando el nombre vive en varios archivos", async () => {
    const directory = await mkdtemp(join(tmpdir(), "credential-store."));
    try {
      await Bun.write(join(directory, "alpha.env"), "export ALPHA_API_KEY=uno\n");
      await Bun.write(join(directory, "beta.env"), "export ALPHA_API_KEY=dos\n");

      expect(storeCredential(directory, "ALPHA_API_KEY", null, "tres")).rejects.toThrow("varios");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("storeCredential rechaza un nombre que no es una credencial y un valor vacio", async () => {
    const directory = await mkdtemp(join(tmpdir(), "credential-store."));
    try {
      expect(storeCredential(directory, "PATH", null, "x")).rejects.toThrow("nombre de credencial");
      expect(storeCredential(directory, "lower_key", null, "x")).rejects.toThrow("nombre de credencial");
      expect(storeCredential(directory, "ALPHA_API_KEY", null, "")).rejects.toThrow("vacio");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
