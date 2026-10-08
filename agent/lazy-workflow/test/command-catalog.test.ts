/**
 * `lz catalog` describe el CLI que el parser es, no uno recordado.
 *
 * La GUI de escritorio arma sus formularios con este documento y la skill lo
 * consulta para componer comandos, así que una bandera inventada o un comando
 * olvidado sería una pantalla que falla al ejecutar. Estas pruebas fijan el
 * catálogo contra la única autoridad: los comandos que el parser acepta, las
 * banderas que `--help` anuncia, las obligatorias de cada forma de invocación,
 * y que todo comando armado desde el catálogo —con la misma función que usa la
 * GUI— pase el parser.
 */
import { expect, test } from "bun:test";
import { commandCatalog, type CatalogCommand, type CatalogFlag } from "../src/cli/command-catalog.ts";
import { buildCli, SUPPORTED_COMMANDS } from "../src/cli/parse-cli-options.ts";
import { AGENT_CLI_PROFILES } from "../src/coding-agent/agent-cli.ts";
import { applicableFlags, buildArgs, conflictsOf, type FlagValues } from "../gui/src/lib/command-line.ts";
import { createCli } from "./_helpers/create-cli.ts";

const catalog = commandCatalog();
const parse = buildCli(() => true, {});
const hooks = { onHelp: () => 0, onError: () => 1 };

const help = (() => {
  const parsed = parse(["--help"], hooks);
  return parsed.kind === "help" ? parsed.output : "";
})();

/** `--color` is hidden, so its negation is not in the text; `--no-log-file` is read off the raw arguments. */
const parserFlags = new Set([...(help.match(/--[a-z][a-z0-9-]*/g) ?? []), "--no-color", "--no-log-file"]);

const installerFlags = new Set(
  (await Bun.file(new URL("../../../install.sh", import.meta.url)).text()).match(/--[a-z][a-z0-9-]*/g) ?? [],
);

/** Every invocation form `--help` prints, split into the command and the flags it shows. */
const forms = help.split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("lz "))
  .map((line) => line.slice("lz ".length))
  .map((form): { command: string; shown: string[]; required: string[] } => ({
    command: form.split(" ")[0]!,
    shown: [...(form.match(/--[a-z][a-z0-9-]*/g) ?? [])],
    required: [...(form.replace(/\[[^\]]*\]/g, "").match(/--[a-z][a-z0-9-]*/g) ?? [])],
  }))
  .filter((form) => SUPPORTED_COMMANDS.has(form.command));

const flagsOf = (command: CatalogCommand): CatalogFlag[] => applicableFlags(catalog, command);

test("el catalogo describe exactamente los comandos que el parser acepta, una vez cada uno", () => {
  const names = catalog.commands.map((command) => command.name);
  expect(new Set(names).size).toBe(names.length);
  expect([...names].sort()).toEqual([...SUPPORTED_COMMANDS].sort());
});

test("cada comando pertenece a una familia declarada y cada grupo existe", () => {
  const families = new Set(catalog.families.map((family) => family.id));
  const groups = new Set(catalog.groups.map((group) => group.id));
  expect(catalog.commands.filter((command) => !families.has(command.family)).map((command) => command.name)).toEqual([]);
  expect(catalog.commands.flatMap((command) => command.groups.filter((group) => !groups.has(group)))).toEqual([]);
});

test("cada bandera es una que el parser o, para update, el instalador acepta", () => {
  const unknown = catalog.commands.flatMap((command) => flagsOf(command)
    .filter((flag) => !(flag.forwarded ? installerFlags : parserFlags).has(flag.flag))
    .map((flag) => `${command.name} ${flag.flag}`));
  expect(unknown).toEqual([]);
});

test("las banderas obligatorias de cada forma de --help son obligatorias en el catalogo", () => {
  const byCommand = new Map<string, string[]>();
  for (const form of forms) {
    const known = byCommand.get(form.command);
    byCommand.set(form.command, known ? known.filter((flag) => form.required.includes(flag)) : [...form.required]);
  }
  const missing = [...byCommand].flatMap(([name, flags]) => {
    const command = catalog.commands.find((candidate) => candidate.name === name)!;
    const declared = new Set(command.flags.filter((flag) => flag.required).map((flag) => flag.flag));
    return flags.filter((flag) => !declared.has(flag)).map((flag) => `${name} ${flag}`);
  });
  expect(missing).toEqual([]);
});

test("una herramienta solo describe las banderas que sus formas de --help muestran", () => {
  const sessionOrSpecial = new Set(["plan", "code", "update", "catalog"]);
  const invented = catalog.commands
    .filter((command) => !sessionOrSpecial.has(command.name))
    .flatMap((command) => {
      const shown = new Set(forms.filter((form) => form.command === command.name).flatMap((form) => form.shown));
      return command.flags.filter((flag) => !shown.has(flag.flag)).map((flag) => `${command.name} ${flag.flag}`);
    });
  expect(invented).toEqual([]);
});

test("los agentes y sus defaults son los que el parser aplica", () => {
  expect(catalog.agents.map((agent) => [agent.cli, agent.defaultModel])).toEqual(
    Object.entries(AGENT_CLI_PROFILES).map(([cli, profile]) => [cli, profile.defaultModel]),
  );
  const parsed = parse(["plan"], hooks);
  if (parsed.kind !== "options") throw new Error("plan sin opciones debia parsear");
  const defaults = Object.fromEntries(catalog.groups.flatMap((group) => group.flags).map((flag) => [flag.flag, flag.default]));
  expect({
    cli: defaults["--cli"],
    variant: defaults["--variant"],
    interview: defaults["--interview"],
    idle: defaults["--idle-timeout"],
    wait: defaults["--fallback-wait"],
  }).toEqual({
    cli: parsed.options.cli,
    variant: parsed.options.variant,
    interview: parsed.options.interview.channel,
    idle: parsed.options.idleTimeoutMinutes,
    wait: parsed.options.fallbackWaitSeconds,
  });
});

/** A value of the right kind for one flag, the way an operator would fill the form. */
function sampleValue(flag: CatalogFlag): string | boolean | string[] {
  if (flag.repeatable) return flag.flag === "--field" ? ["Custom.Area=Pagos"] : ["codex:gpt-5.6-sol:high"];
  switch (flag.kind) {
    case "boolean": return true;
    case "integer": return "7";
    case "number": return "1.5";
    case "commit": return "0123456789abcdef0123456789abcdef01234567";
    case "file": return "/tmp/descripcion.html";
    case "directory": return "/tmp/repositorio";
    case "directories": return "/tmp/api,/tmp/web";
    case "secret": return true;
    case "choice": return flag.choices!.find((choice) => choice !== flag.default) ?? flag.choices![0]!;
    default: return flag.flag === "--variant" ? "high" : "valor";
  }
}

const parsesAs = (args: string[]) => {
  const parsed = parse(args, hooks);
  return parsed.kind === "options" ? "options" : parsed.kind === "error" ? parsed.message : "help";
};

test("todo comando armado con sus obligatorias pasa el parser", () => {
  const rejected = catalog.commands
    .filter((command) => command.name !== "update")
    .map((command) => {
      const values: FlagValues = Object.fromEntries(
        command.flags.filter((flag) => flag.required).map((flag) => [flag.flag, sampleValue(flag)]),
      );
      const args = buildArgs(catalog, command, values);
      return { args: args.join(" "), result: parsesAs(args) };
    })
    .filter((outcome) => outcome.result !== "options");
  expect(rejected).toEqual([]);
});

test("todo comando armado con cada bandera que admite pasa el parser", () => {
  const rejected = catalog.commands
    .filter((command) => command.name !== "update")
    .map((command) => {
      const values: FlagValues = {};
      for (const flag of flagsOf(command)) {
        values[flag.flag] = sampleValue(flag);
        // Of two flags that exclude each other the form keeps the first; the
        // other one is what `validateFlags` would refuse to run.
        if (conflictsOf(catalog, command, values).length > 0) delete values[flag.flag];
      }
      const args = buildArgs(catalog, command, values);
      return { args: args.join(" "), result: parsesAs(args) };
    })
    .filter((outcome) => outcome.result !== "options");
  expect(rejected).toEqual([]);
});

test("update reenvia al instalador las banderas que el catalogo le describe", async () => {
  const update = catalog.commands.find((command) => command.name === "update")!;
  const calls: string[][] = [];
  const args = buildArgs(catalog, update, { "--codex": true, "--ref": "v1" });
  const code = await createCli({ runInstaller: async (forwarded) => { calls.push(forwarded); return 0; } }).run(args);
  expect({ code, calls }).toEqual({ code: 0, calls: [["--codex", "--ref", "v1"]] });
});

test("catalog imprime el documento y rechaza opciones", async () => {
  const printed: string[] = [];
  const original = console.log;
  console.log = (line: string) => { printed.push(line); };
  try {
    expect(await createCli().run(["catalog"])).toBe(0);
    expect(await createCli().run(["catalog", "--verbose"])).toBe(1);
  } finally {
    console.log = original;
  }
  expect(printed).toHaveLength(1);
  expect(JSON.parse(printed[0]!)).toEqual(JSON.parse(JSON.stringify(catalog)));
});
