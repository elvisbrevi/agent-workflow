/**
 * El README de lz se verifica contra el código, no contra la memoria.
 *
 * Documentó comando por comando un sistema que el rediseño desmontó, y nada
 * fallaba por eso. Estas pruebas fijan lo que se puede fijar: los comandos que
 * nombra existen, todos los que existen están nombrados, cada ejemplo lleva las
 * opciones que su comando exige, las banderas que muestra son las que el parser
 * acepta, y el vocabulario que el rediseño retiró no vuelve.
 *
 * Lo que no cubren —si un default, una denegación o una explicación son
 * correctos— sigue siendo trabajo de lectura. Fijan los nombres y las formas,
 * que es donde el README se pudrió sin que nadie lo notara.
 */
import { expect, test } from "bun:test";
import { buildCli, SUPPORTED_COMMANDS } from "../src/cli/parse-cli-options.ts";
import { DETERMINISTIC_TOOL_COMMANDS } from "../src/cli/tool-commands.ts";

const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
const rootReadme = await Bun.file(new URL("../../../README.md", import.meta.url)).text();

test("el README principal describe cada comando registrado y usa la CLI instalada", () => {
  const documented = new Set(
    [...rootReadme.matchAll(/^\| `([a-z][a-z0-9-]*)` \|/gm)]
      .map((match) => match[1]!)
      .filter((command) => !["opencode", "claudecode", "codex"].includes(command)),
  );
  expect([...documented].sort()).toEqual([...SUPPORTED_COMMANDS].sort());
  expect(rootReadme).not.toContain("bun run");
});

const help = (() => {
  const parsed = buildCli(() => true)(["--help"], { onHelp: () => 0, onError: () => 1 });
  return parsed.kind === "help" ? parsed.output : "";
})();

/**
 * Las banderas que el propio `--help` anuncia. `--color` se declara oculta, así
 * que su negación no sale en el texto aunque el parser la acepte y sea una de
 * las cuatro banderas globales.
 */
const parserFlags = new Set([...(help.match(/--[a-z][a-z0-9-]*/g) ?? []), "--no-color"]);

/** Las banderas del instalador, que el README también documenta. */
const installerFlags = new Set(
  (await Bun.file(new URL("../../../installer/options.ts", import.meta.url)).text()).match(/--[a-z][a-z0-9-]*/g) ?? [],
);

/** Las opciones obligatorias de cada comando, tal como `--help` las declara. */
const requiredOptions = new Map<string, string[]>();
for (const [command, options] of
  help.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("lz "))
    .map((line) => line.slice("lz ".length))
    // `ticket-{branch,pr}-info` es una forma por cada alternativa, no un comando llamado asi.
    .flatMap((form) => {
      const braces = form.match(/^([a-z-]*)\{([a-z,]+)\}([a-z-]*)( .*)?$/);
      if (!braces) return [form];
      const [, prefix, alternatives, suffix, rest = ""] = braces;
      return alternatives!.split(",").map((alternative) => `${prefix}${alternative}${suffix}${rest}`);
    })
    .filter((form) => SUPPORTED_COMMANDS.has(form.split(" ")[0]!))
    .map((form) => [
      form.split(" ")[0]!,
      (form.replace(/\[[^\]]*\]/g, "").match(/--[a-z][a-z0-9-]*/g) ?? ([] as string[])),
    ] as const)
) {
  const known = requiredOptions.get(command);
  requiredOptions.set(command, known ? known.filter((option) => options.includes(option)) : [...options]);
}

/** Cada invocación de los bloques de shell, con sus continuaciones unidas. */
const shellInvocations: string[] = (readme.match(/```bash\n([\s\S]*?)```/g) ?? [])
  .flatMap((block) => block.replace(/\\\n\s*/g, " ").split("\n"))
  .map((line) => line.trim())
  .filter((line) => line.startsWith("lz "));

test("el README nombra todos los tool commands y ninguno que el código no exponga", () => {
  const named = new Set((readme.match(/lz ([a-z][a-z0-9-]*)/g) ?? [])
    .map((match) => match.slice("lz ".length)));

  expect(DETERMINISTIC_TOOL_COMMANDS.filter((command) => !named.has(command))).toEqual([]);
  const invoked = shellInvocations.map((line) => line.split(" ")[1]!);
  expect(invoked.filter((command) => !SUPPORTED_COMMANDS.has(command))).toEqual([]);
});

test("cada ejemplo del README lleva las opciones que su comando exige", () => {
  const incomplete = shellInvocations.flatMap((line) => {
    const required = requiredOptions.get(line.split(" ")[1]!) ?? [];
    return required
      .filter((option) => !line.includes(`${option} `) && !line.includes(`${option}=`))
      .map((option) => `${line.split(" ")[1]} sin ${option}`);
  });

  expect([...new Set(incomplete)]).toEqual([]);
});

test("cada bandera del README es una que el parser o el instalador aceptan", () => {
  const documented = new Set(readme.match(/--[a-z][a-z0-9-]*/g) ?? []);
  const unknown = [...documented].filter((flag) => !parserFlags.has(flag) && !installerFlags.has(flag));

  expect(unknown).toEqual([]);
  // Las dos que la issue nombra explícitamente porque faltaban.
  expect(documented.has("--idle-timeout")).toBeTrue();
  expect(documented.has("--codex")).toBeTrue();
});

test("el README no revive el vocabulario que el rediseño retiró", () => {
  // Lo retirado es el sistema, no cada palabra que lo nombraba: el campo Azure
  // `completion-evidence` y el manifest agregado del workspace siguen vivos.
  const prose = readme;
  const revived = [
    /IMPLEMENTATION_READY/,
    /completion[ -]manifest/i,
    /manifest digest/i,
    /(github|ticket)-manifest-(set|info)/,
    /evidence (kind|document|specification|system)/i,
    /architecture-review-sag|infra-sag|deploy-sag/,
    /http-json/,
  ]
    .filter((retired) => retired.test(prose))
    .map((retired) => retired.source);

  expect(revived).toEqual([]);
});
