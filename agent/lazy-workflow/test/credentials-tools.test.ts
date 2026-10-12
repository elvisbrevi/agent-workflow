/**
 * `credentials-*` como comandos: leen y escriben los archivos del operador, no
 * abren sesión, y el valor solo sale hacia una terminal o hacia un `--force`
 * declarado — nunca por accidente hacia un pipe. `credentials-set` es la
 * escritura: toma el valor de un prompt oculto o de `--stdin`, jamás de una
 * bandera, y lo guarda sin imprimirlo.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDeterministicTool,
  type CredentialTools,
  type DeterministicToolServices,
} from "../src/cli/deterministic-tools.ts";
import { buildCli, type CliOptions } from "../src/cli/parse-cli-options.ts";
import {
  defaultSecretsDirectory,
  listCredentials,
  auditCredentialFiles,
  readCredential,
  storeCredential,
} from "../src/credentials/credential-store.ts";
import { keychainPresence, readKeychainCredential } from "../src/credentials/keychain.ts";
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
  audit: unreachable,
  list: async () => [],
  read: unreachable,
  readSecret: unreachable,
  store: unreachable,
  migrate: unreachable,
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

  test("credentials-audit informa ubicaciones sin valores, con o sin --name", async () => {
    const printed: string[] = [];
    const calls: Array<string | null> = [];
    const credentials = credentialTools({
      audit: async (_directory, name) => {
        calls.push(name);
        return [{ name: "ALPHA_API_KEY", secrets: ["alpha.env"], keychain: "missing" }];
      },
    });
    const named = parseOptions(["credentials-audit", "--name", "ALPHA_API_KEY"]);
    const all = parseOptions(["credentials-audit"]);
    expect(await runDeterministicTool("credentials-audit", named, servicesWith(credentials), (line) => printed.push(line))).toBe(0);
    expect(await runDeterministicTool("credentials-audit", all, servicesWith(credentials), (line) => printed.push(line))).toBe(0);
    expect(calls).toEqual(["ALPHA_API_KEY", null]);
    expect(JSON.parse(printed[0]!)).toEqual({ name: "ALPHA_API_KEY", secrets: ["alpha.env"], keychain: "missing" });
    expect(JSON.parse(printed[1]!)).toEqual([{ name: "ALPHA_API_KEY", secrets: ["alpha.env"], keychain: "missing" }]);
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

  test("credentials-migrate usa Keychain y devuelve solo metadatos", async () => {
    const printed: string[] = [];
    const calls: Array<{ name: string; service: string | null }> = [];
    const credentials = credentialTools({
      migrate: async (_directory, name, service) => {
        calls.push({ name, service });
        return { name, file: "crates-io.env", chezmoiSource: "published" };
      },
    });
    const options = parseOptions(["credentials-migrate", "--name", "CARGO_REGISTRY_TOKEN", "--service", "crates-io"]);
    expect(await runDeterministicTool("credentials-migrate", options, servicesWith(credentials), (line) => printed.push(line))).toBe(0);
    expect(calls).toEqual([{ name: "CARGO_REGISTRY_TOKEN", service: "crates-io" }]);
    expect(JSON.parse(printed[0]!)).toEqual({ name: "CARGO_REGISTRY_TOKEN", file: "crates-io.env", chezmoiSource: "published" });
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

  test("--service aplica a las escrituras y --stdin solo a credentials-set", () => {
    expect(() => parseOptions(["credentials-get", "--name", "ALPHA_API_KEY", "--service", "alpha"])).toThrow();
    expect(() => parseOptions(["credentials-list", "--stdin"])).toThrow();
    expect(() => parseOptions(["credentials-migrate", "--name", "ALPHA_API_KEY", "--service", "alpha"])).not.toThrow();
    expect(() => parseOptions(["credentials-migrate", "--name", "ALPHA_API_KEY", "--stdin"])).toThrow();
  });

  test("credentials-update trae los dotfiles publicados sin pedir nombre", async () => {
    const printed: string[] = [];
    let updates = 0;
    const credentials = credentialTools({
      update: async () => { updates++; },
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
    expect(updates).toBe(1);
    expect(printed).toHaveLength(1);
    expect(JSON.parse(printed[0]!)).toEqual({ updated: true, directory: defaultSecretsDirectory() });
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

describe.skipIf(process.platform === "win32")("credentials-update con chezmoi", () => {
  async function withChezmoi(
    failOn: string,
    check: (result: { directory: string; stdout: string; stderr: string; code: number; calls: string[][] }) => Promise<void>,
  ): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "credential-update."));
    try {
      const bin = join(directory, "bin");
      const secrets = join(directory, ".config", "secrets");
      await mkdir(bin);
      await mkdir(secrets, { recursive: true });
      await Bun.write(join(directory, ".bashrc"), "# local bashrc\n");
      await Bun.write(join(secrets, "alpha.env"), "export ALPHA_API_KEY='local-fake-secret'\n");
      const chezmoi = join(bin, "chezmoi");
      await Bun.write(chezmoi, `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = Bun.argv.slice(2);
const root = process.env.FAKE_CHEZMOI_ROOT;
appendFileSync(join(root, "calls.jsonl"), JSON.stringify(args) + "\\n");
console.log("published-fake-secret");
console.error("published-fake-secret");
if (args[0] === process.env.FAKE_CHEZMOI_FAIL_ON) process.exit(1);
if (args[0] === "apply" || (args[0] === "update" && !args.includes("--apply=false"))) {
  if (!args.some((arg) => arg === process.env.LAZY_WORKFLOW_SECRETS_DIR)) {
    writeFileSync(join(root, ".bashrc"), "# published bashrc\\n");
  }
  writeFileSync(join(root, ".config", "secrets", "alpha.env"), "export ALPHA_API_KEY='published-fake-secret'\\n");
}
`);
      await chmod(chezmoi, 0o700);
      const child = Bun.spawn([
        process.execPath,
        Bun.fileURLToPath(new URL("../main.ts", import.meta.url)),
        "credentials-update", "--no-log-file", "--no-color",
      ], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          LAZY_WORKFLOW_SECRETS_DIR: secrets,
          FAKE_CHEZMOI_ROOT: directory,
          FAKE_CHEZMOI_FAIL_ON: failOn,
        },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      const calls = (await Bun.file(join(directory, "calls.jsonl")).text()).trim().split("\n").map((line) => JSON.parse(line));
      await check({ directory, stdout, stderr, code, calls });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  test("actualiza bashrc y secretos sin exponer valores ni pedir confirmacion", async () => {
    await withChezmoi("", async ({ directory, stdout, stderr, code, calls }) => {
      expect(code).toBe(0);
      expect(await Bun.file(join(directory, ".bashrc")).text()).toBe("# published bashrc\n");
      expect(await Bun.file(join(directory, ".config", "secrets", "alpha.env")).text()).toContain("published-fake-secret");
      expect(calls).toEqual([["update", "--force"]]);
      expect(JSON.parse(stdout)).toEqual({ updated: true, directory: join(directory, ".config", "secrets") });
      expect(stdout + stderr).not.toContain("fake-secret");
    });
  });

  test("un error de chezmoi falla sin anunciar actualizacion ni exponer valores", async () => {
    await withChezmoi("update", async ({ directory, stdout, stderr, code }) => {
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("chezmoi update --force");
      expect(stdout + stderr).not.toContain("fake-secret");
      expect(await Bun.file(join(directory, ".bashrc")).text()).toBe("# local bashrc\n");
      expect(await Bun.file(join(directory, ".config", "secrets", "alpha.env")).text()).toContain("local-fake-secret");
    });
  });
});

describe("credential-store", () => {
  test("la organizacion Azure se guarda y audita junto al PAT sin exponer valores", async () => {
    const directory = await mkdtemp(join(tmpdir(), "credential-azure."));
    try {
      await storeCredential(directory, "LAZY_WORKFLOW_AZURE_ORGANIZATION", "azure", "https://dev.azure.com/synthetic");
      await storeCredential(directory, "AZURE_DEVOPS_EXT_PAT", "azure", "synthetic-pat");
      expect(await auditCredentialFiles(directory, "LAZY_WORKFLOW_AZURE_ORGANIZATION")).toEqual([
        { name: "LAZY_WORKFLOW_AZURE_ORGANIZATION", secrets: ["azure.env"] },
      ]);
      expect((await readCredential(directory, "LAZY_WORKFLOW_AZURE_ORGANIZATION"))?.value).toBe("https://dev.azure.com/synthetic");
      expect((await stat(join(directory, "azure.env"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("auditCredentialFiles informa duplicados y ausencias sin decodificar valores", async () => {
    const directory = await mkdtemp(join(tmpdir(), "credential-audit."));
    try {
      await Bun.write(join(directory, "alpha.env"), "export ALPHA_API_KEY='fake one'\nexport PATH=/bin\n");
      await Bun.write(join(directory, "beta.env"), "export ALPHA_API_KEY='fake two'\n");
      expect(await auditCredentialFiles(directory, "ALPHA_API_KEY")).toEqual([
        { name: "ALPHA_API_KEY", secrets: ["alpha.env", "beta.env"] },
      ]);
      expect(await auditCredentialFiles(directory, "MISSING_TOKEN")).toEqual([
        { name: "MISSING_TOKEN", secrets: [] },
      ]);
      expect(await auditCredentialFiles(directory, null)).toEqual([
        { name: "ALPHA_API_KEY", secrets: ["alpha.env", "beta.env"] },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("Keychain audit y lectura usan un security falso sin exponer valores", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "credential-keychain."));
    try {
      const binary = join(directory, "security");
      await Bun.write(binary, "#!/bin/sh\ncase \"$*\" in\n  *PRESENT_API_KEY*) printf 'fake-secret\\n' ;;\n  *) exit 1 ;;\nesac\n");
      await chmod(binary, 0o700);
      expect(await keychainPresence("PRESENT_API_KEY", binary)).toBe("present");
      expect(await keychainPresence("MISSING_TOKEN", binary)).toBe("missing");
      expect(await keychainPresence("PRESENT_API_KEY", null)).toBe("n/a");
      expect(await readKeychainCredential("PRESENT_API_KEY", binary)).toBe("fake-secret");
      expect(readKeychainCredential("MISSING_TOKEN", binary)).rejects.toThrow("no esta en Keychain");
      expect(readKeychainCredential("PRESENT_API_KEY", null)).rejects.toThrow("no esta disponible");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
      if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
      if (process.platform !== "win32") expect((await stat(directory)).mode & 0o777).toBe(0o700);
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
