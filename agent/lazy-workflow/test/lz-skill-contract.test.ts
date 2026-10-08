/**
 * La skill `lz` se verifica contra el CLI, como el README.
 *
 * Siguió documentando comandos que el rediseño retiró —las revisiones SAG, las
 * herramientas de manifest, `IMPLEMENTATION_READY`— y nada fallaba, aunque un
 * agente que la sigue ejecuta exactamente lo que dice. Estas pruebas fijan lo que
 * se puede fijar: cada `lz <comando>` que nombra existe, cada invocación de sus
 * bloques lleva las opciones obligatorias y solo banderas que el parser o el
 * instalador aceptan, el vocabulario retirado no vuelve, y cada ejemplo del
 * helper de la GUI usa claves y banderas reales.
 */
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { commandCatalog } from "../src/cli/command-catalog.ts";
import { buildCli, SUPPORTED_COMMANDS } from "../src/cli/parse-cli-options.ts";
import { DEFAULTS } from "../../../utility/lz/scripts/gui-settings.ts";

const skillDirectory = new URL("../../../utility/lz/", import.meta.url);
const documents = await Promise.all(
  readdirSync(skillDirectory).filter((name) => name.endsWith(".md")).map(async (name) => ({
    name,
    text: await Bun.file(new URL(name, skillDirectory)).text(),
  })),
);
const catalog = commandCatalog();

/** `ticket-{branch,pr}-info` names one command per alternative. */
const expand = (command: string): string[] => {
  const braces = command.match(/^([a-z-]*)\{([a-z,]+)\}([a-z-]*)$/);
  return braces ? braces[2]!.split(",").map((alternative) => `${braces[1]}${alternative}${braces[3]}`) : [command];
};

/** Every line of a shell block that invokes lz, continuations joined and comments dropped. */
const invocations = documents.flatMap(({ name, text }) =>
  (text.match(/```(?:bash|zsh|sh)\n([\s\S]*?)```/g) ?? [])
    .flatMap((block) => block.replace(/\\\n\s*/g, " ").split("\n"))
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line.startsWith("lz "))
    .map((line) => ({ name, line, command: line.split(/\s+/)[1]! })));

test("cada lz <comando> que la skill nombra es un comando del CLI", () => {
  const named = documents.flatMap(({ name, text }) => [
    ...[...text.matchAll(/`lz ([a-z][a-z0-9{},-]*)/g)].map((match) => ({ name, command: match[1]! })),
    ...invocations.filter((invocation) => invocation.name === name),
  ]);
  const unknown = named.flatMap(({ name, command }) => expand(command).filter((candidate) => !SUPPORTED_COMMANDS.has(candidate)).map((candidate) => `${name}: ${candidate}`));
  expect([...new Set(unknown)]).toEqual([]);
});

const help = (() => {
  const parsed = buildCli(() => true)(["--help"], { onHelp: () => 0, onError: () => 1 });
  return parsed.kind === "help" ? parsed.output : "";
})();
const parserFlags = new Set([...(help.match(/--[a-z][a-z0-9-]*/g) ?? []), "--no-color", "--no-log-file"]);
const installerFlags = new Set((await Bun.file(new URL("../../../install.sh", import.meta.url)).text()).match(/--[a-z][a-z0-9-]*/g) ?? []);

test("cada invocacion de la skill usa banderas reales y lleva las obligatorias", () => {
  const problems = invocations.flatMap(({ name, line, command }) => {
    // Inside quotes a `--` belongs to the prompt or a jq filter, not to lz.
    const unquoted = line.replace(/'[^']*'|"[^"]*"/g, "''").split(/\s\|\s/)[0]!;
    const flags: string[] = [...(unquoted.match(/(?<=\s)--[a-z][a-z0-9-]*/g) ?? [])];
    const accepted = command === "update" ? installerFlags : parserFlags;
    return expand(command).flatMap((candidate) => {
      const definition = catalog.commands.find((entry) => entry.name === candidate);
      const required = definition?.flags.filter((flag) => flag.required && flag.flag !== "--working-directory").map((flag) => flag.flag) ?? [];
      return [
        ...flags.filter((flag) => !accepted.has(flag)).map((flag) => `${name}: ${candidate} ${flag} no existe`),
        ...required.filter((flag) => !flags.includes(flag)).map((flag) => `${name}: ${candidate} sin ${flag}`),
      ];
    });
  });
  expect([...new Set(problems)]).toEqual([]);
});

test("la skill no revive comandos ni vocabulario retirados", () => {
  const retired = [
    /architecture-review-sag|infra-sag|deploy-sag/,
    /(github|ticket)-manifest-(set|info)/,
    /ticket-(attachment|evidence)-/,
    /IMPLEMENTATION_READY|ARCHITECTURE_REVIEW_RESULT/,
    /http-json/,
    /--environment\b/,
  ];
  const revived = documents.flatMap(({ name, text }) => retired.filter((pattern) => pattern.test(text)).map((pattern) => `${name}: ${pattern}`));
  expect(revived).toEqual([]);
});

test("cada ejemplo del helper de la GUI usa una clave y una bandera reales", () => {
  const examples = documents.flatMap(({ name, text }) =>
    [...text.matchAll(/gui-settings\.ts (set|unset|get|add|remove) (\S+)/g)].map((match) => ({ name, key: match[2]! })));
  expect(examples.length).toBeGreaterThan(0);
  const allFlags = new Set(catalog.commands.flatMap((command) => [
    ...command.flags.map((flag) => flag.flag),
    ...command.groups.flatMap((id) => catalog.groups.find((group) => group.id === id)!.flags.map((flag) => flag.flag)),
  ]));
  const problems = examples.flatMap(({ name, key }) => {
    const [top, second, third] = key.split(".");
    if (!(top! in DEFAULTS)) return [`${name}: ${top} no es una clave de gui.json`];
    if (top === "flagDefaults" && !allFlags.has(second!)) return [`${name}: ${second} no es una bandera`];
    if (top === "commandDefaults") {
      const command = catalog.commands.find((entry) => entry.name === second);
      if (!command) return [`${name}: ${second} no es un comando`];
      const flags = [...command.flags, ...command.groups.flatMap((id) => catalog.groups.find((group) => group.id === id)!.flags)].map((flag) => flag.flag);
      if (third && !flags.includes(third)) return [`${name}: ${second} no acepta ${third}`];
    }
    return [];
  });
  expect(problems).toEqual([]);
});
