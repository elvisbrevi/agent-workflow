import { describe, expect, test } from "bun:test";
import {
  buildCli,
  type CliParseResult,
  type CliParser,
} from "../src/cli/parse-cli-options.ts";

const captureParse = (parser: CliParser, args: string[]): CliParseResult => {
  let captured: CliParseResult | undefined;
  const result = parser(args, {
    onHelp: (output) => { captured = { kind: "help", output }; return 0; },
    onError: (message, exitCode) => { captured = { kind: "error", message, exitCode }; return exitCode; },
  });
  return captured ?? result;
};

const parse = (args: string[]): CliParseResult => captureParse(buildCli(), args);

describe("buildCli parser", () => {
  describe("defaults", () => {
    test("expone los defaults historicos de model, variant, prompt y number-of-questions", () => {
      const result = parse(["plan"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.model).toBe("opencode-go/deepseek-v4-pro");
      expect(result.options.variant).toBe("high");
      expect(result.options.hasModel).toBeFalse();
      expect(result.options.hasVariant).toBeFalse();
      expect(result.options.prompt).toBe("Follow the authoritative workflow and context.");
      expect(result.options.numberOfQuestions).toBe(5);
      expect(result.options.workingDirectory).toBe(process.cwd());
    });

    test("los flags verbosity inician en false", () => {
      const result = parse(["plan"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.verbose).toBeFalse();
      expect(result.options.quiet).toBeFalse();
      expect(result.options.noColor).toBeFalse();
      expect(result.options.normasSag).toBeFalse();
    });
  });

  describe("alias de flags", () => {
    test("--evidence-file es alias de --file", () => {
      const result = parse(["ticket-evidence-set", "--ticket", "1", "--evidence-file", "/path/ev.json"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.file).toBe("/path/ev.json");
    });

    test("--kind es alias de --evidence-kind", () => {
      const result = parse(["ticket-attachment-add", "--ticket", "1", "--file", "/p.json", "--kind", "http-json"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.evidenceKind).toBe("http-json");
    });

    test("--real-effort-hh y --expected-rev parsean como numeros", () => {
      const result = parse(["ticket-effort-set", "--ticket", "1", "--real-effort", "8", "--real-effort-hh", "8", "--expected-rev", "3"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.realEffort).toBe(8);
      expect(result.options.realEffortHours).toBe(8);
      expect(result.options.expectedRevision).toBe(3);
    });

    test("--number-of-questions acepta enteros", () => {
      const result = parse(["plan", "--number-of-questions", "3"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.numberOfQuestions).toBe(3);
    });
  });

  describe("flags booleanos nuevos", () => {
    test("--verbose activa el bit", () => {
      const result = parse(["plan", "--verbose"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.verbose).toBeTrue();
    });

    test("--quiet activa el bit", () => {
      const result = parse(["plan", "--quiet"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.quiet).toBeTrue();
    });

    test("--no-color activa el bit", () => {
      const result = parse(["plan", "--no-color"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.noColor).toBeTrue();
    });

    test("--normas-sag activa el bit", () => {
      const result = parse(["plan", "--normas-sag"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.normasSag).toBeTrue();
    });

    test("--verbose-output activa tambien --verbose, porque es mas ancho", () => {
      const result = parse(["plan", "--verbose-output"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.verboseOutput).toBeTrue();
      expect(result.options.verbose).toBeTrue();
    });

    test("--verbose no activa --verbose-output", () => {
      const result = parse(["plan", "--verbose"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.verbose).toBeTrue();
      expect(result.options.verboseOutput).toBeFalse();
    });

    test("sin flags la salida es la parseada", () => {
      const result = parse(["plan"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.verboseOutput).toBeFalse();
    });
  });

  describe("--commit", () => {
    test("acepta el nombre de objeto completo", () => {
      const commit = "a".repeat(40);
      const result = parse(["github-commit-push", "--branch", "issue/1", "--commit", commit]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.commit).toBe(commit);
    });

    test("rechaza una abreviatura, que no compara contra una referencia", () => {
      const result = parse(["github-commit-push", "--branch", "issue/1", "--commit", "abc1234"]);
      expect(result.kind).toBe("error");
    });

    test("sin --commit queda nulo", () => {
      const result = parse(["plan"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.commit).toBeNull();
    });
  });

  describe("validacion de tipo", () => {
    test("--hu rechaza un valor no entero", () => {
      const result = parse(["plan", "--hu", "abc"]);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.exitCode).toBe(1);
      expect(result.message.toLowerCase()).toContain("hu");
    });

    test("--hu rechaza un entero no positivo", () => {
      const result = parse(["plan", "--hu", "0"]);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.exitCode).toBe(1);
    });

    test("--ticket rechaza un valor no entero", () => {
      const result = parse(["ticket-info", "--hu", "1", "--ticket", "abc"]);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.exitCode).toBe(1);
    });

    test("--real-effort rechaza valores no numericos", () => {
      const result = parse(["ticket-effort-set", "--ticket", "1", "--real-effort", "abc", "--real-effort-hh", "1", "--expected-rev", "1"]);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.exitCode).toBe(1);
    });
  });

  describe("seleccion de agente CLI", () => {
    test("sin --cli el agente es opencode", () => {
      const result = parse(["plan"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.cli).toBe("opencode");
    });

    test("--cli claudecode selecciona Claude Code", () => {
      const result = parse(["plan", "--cli", "claudecode"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.cli).toBe("claudecode");
    });

    test("un --cli no soportado falla al parsear", () => {
      const result = parse(["plan", "--cli", "gemini"]);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("gemini");
    });

    test("un --cli explicito cuyo binario falta falla nombrando el CLI y el binario", () => {
      const result = captureParse(buildCli(() => false), ["plan", "--cli", "claudecode"]);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("claudecode");
      expect(result.message).toContain("claude");
    });

    test("un --cli explicito con binario presente parsea", () => {
      const result = captureParse(buildCli(() => true), ["plan", "--cli", "opencode"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.cli).toBe("opencode");
    });

    test("un --variant fuera de los esfuerzos de Claude Code falla al parsear", () => {
      const result = captureParse(buildCli(() => true), ["plan", "--cli", "claudecode", "--variant", "turbo"]);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("turbo");
      expect(result.message).toContain("--variant");
    });

    test("los esfuerzos de Claude Code se aceptan y OpenCode conserva sus variantes libres", () => {
      const claude = captureParse(buildCli(() => true), ["plan", "--cli", "claudecode", "--variant", "xhigh"]);
      expect(claude.kind).toBe("options");
      if (claude.kind !== "options") return;
      expect(claude.options.variant).toBe("xhigh");

      const opencode = parse(["plan", "--variant", "turbo"]);
      expect(opencode.kind).toBe("options");
      if (opencode.kind !== "options") return;
      expect(opencode.options.variant).toBe("turbo");
    });

    test("--help documenta --cli con sus valores y su default", () => {
      const result = parse(["plan", "--help"]);
      expect(result.kind).toBe("help");
      if (result.kind !== "help") return;
      expect(result.output).toContain("--cli");
      expect(result.output).toContain("claudecode");
      expect(result.output).toContain("opencode");
    });
  });

  describe("cadena de fallback", () => {
    test("sin --fallback la cadena queda vacia", () => {
      const result = parse(["plan"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.fallbackChain).toEqual([]);
    });

    test("--fallback acepta repeticiones y conserva el orden de declaracion", () => {
      const result = captureParse(buildCli(() => true), [
        "plan",
        "--fallback", "opencode:model-b:medium",
        "--fallback", "claudecode:model-c:high",
      ]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.fallbackChain).toEqual([
        { cli: "opencode", model: "model-b", variant: "medium" },
        { cli: "claudecode", model: "model-c", variant: "high" },
      ]);
    });

    test("un escalon con CLI desconocido falla nombrando el escalon exacto", () => {
      const result = captureParse(buildCli(() => true), ["plan", "--fallback", "gemini:model-x:high"]);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.message).toContain("gemini:model-x:high");
      expect(result.message).toContain("gemini");
    });

    test("un escalon con partes faltantes falla nombrando el escalon exacto", () => {
      const result = captureParse(buildCli(() => true), ["plan", "--fallback", "opencode:model-x"]);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.message).toContain("opencode:model-x");
    });

    test("un escalon con variante invalida para Claude Code falla nombrando el escalon exacto", () => {
      const result = captureParse(buildCli(() => true), ["plan", "--fallback", "claudecode:model-x:turbo"]);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.message).toContain("claudecode:model-x:turbo");
      expect(result.message).toContain("turbo");
    });

    test("un escalon cuyo binario no esta presente falla al parsear", () => {
      const result = captureParse(buildCli(() => false), ["plan", "--fallback", "claudecode:model-x:high"]);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.message).toContain("claudecode:model-x:high");
      expect(result.message).toContain("claude");
    });

    test("un escalon identico al primario se rechaza", () => {
      const result = captureParse(buildCli(() => true), ["plan", "--fallback", "opencode:opencode-go/deepseek-v4-pro:high"]);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.message).toContain("repite");
    });

    test("un escalon repetido dos veces se rechaza", () => {
      const result = captureParse(buildCli(() => true), [
        "plan",
        "--fallback", "claudecode:model-x:high",
        "--fallback", "claudecode:model-x:high",
      ]);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.message).toContain("repite");
    });

    test("--help documenta el formato y la semantica de orden de --fallback", () => {
      const result = parse(["plan", "--help"]);
      expect(result.kind).toBe("help");
      if (result.kind !== "help") return;
      expect(result.output).toContain("--fallback");
      expect(result.output.toLowerCase()).toContain("prioridad");
    });
  });

  describe("espera de la cadena agotada", () => {
    test("sin flags la espera y su tope traen los valores por defecto", () => {
      const result = parse(["code"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.fallbackWaitSeconds).toBe(300);
      expect(result.options.fallbackWaitMaxSeconds).toBe(3600);
    });

    test("--fallback-wait y --fallback-wait-max ajustan el intervalo y el tope", () => {
      const result = parse(["code", "--fallback-wait", "60", "--fallback-wait-max", "900"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.fallbackWaitSeconds).toBe(60);
      expect(result.options.fallbackWaitMaxSeconds).toBe(900);
    });

    test("un intervalo no positivo falla al parsear", () => {
      const result = parse(["code", "--fallback-wait", "0"]);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.message).toContain("--fallback-wait");
    });

    test("un tope menor que el intervalo falla al parsear", () => {
      const result = parse(["code", "--fallback-wait", "600", "--fallback-wait-max", "300"]);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.message).toContain("--fallback-wait-max");
    });
  });

  describe("flags desconocidos", () => {
    test("rechaza un flag desconocido con codigo de salida 1", () => {
      const result = parse(["plan", "--unknown-flag"]);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain("unknown-flag");
    });

    test("rechaza un alias no soportado", () => {
      const result = parse(["plan", "--made-up"]);
      expect(result.kind).toBe("error");
      if (result.kind !== "error") return;
      expect(result.exitCode).toBe(1);
    });
  });

  describe("comando y sub-comando", () => {
    test("captura el comando como primer argumento", () => {
      const result = parse(["code", "--working-directory", "/repo"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.command).toBe("code");
      expect(result.options.workingDirectory).toBe("/repo");
    });

    test("comando plan sin flags devuelve command plan", () => {
      const result = parse(["plan"]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options.command).toBe("plan");
    });

    test("sin comando devuelve help", () => {
      const result = parse([]);
      expect(result.kind).toBe("help");
      if (result.kind !== "help") return;
      expect(result.output).toContain("plan");
      expect(result.output).toContain("code");
    });

    test("comando no soportado devuelve help", () => {
      const result = parse(["nope"]);
      expect(result.kind).toBe("help");
    });

    test("--help devuelve help aunque haya otros flags", () => {
      const result = parse(["plan", "--help"]);
      expect(result.kind).toBe("help");
    });
  });

  describe("separacion entre opciones y command original", () => {
    test("preserva todos los flags del parser historico", () => {
      const result = parse([
        "plan",
        "--hu", "23438",
        "--issue", "5",
        "--session", "ses_1",
        "--model", "model-x",
        "--variant", "low",
        "--prompt", "pregunta",
        "--branch", "refs/heads/hu/23438",
        "--base-branch", "main",
        "--ticket", "51",
        "--pr", "99",
        "--manifest", "/path/manifest.json",
        "--evidence-file", "/path/file.json",
        "--description-file", "/path/desc.md",
        "--state", "Done",
        "--expected-state", "Active",
        "--environment", "dev",
        "--real-effort", "4",
        "--real-effort-hh", "4",
        "--expected-rev", "2",
        "--evidence-kind", "http-json",
        "--number-of-questions", "2",
        "--normas-sag",
        "--working-directory", "/repo",
        "--verbose",
        "--quiet",
        "--no-color",
      ]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options).toMatchObject({
        hu: 23438,
        issue: 5,
        session: "ses_1",
        model: "model-x",
        variant: "low",
        hasModel: true,
        hasVariant: true,
        prompt: "pregunta",
        branch: "refs/heads/hu/23438",
        baseBranch: "main",
        ticket: 51,
        pullRequest: 99,
        manifest: "/path/manifest.json",
        file: "/path/file.json",
        descriptionFile: "/path/desc.md",
        state: "Done",
        expectedState: "Active",
        environment: "dev",
        realEffort: 4,
        realEffortHours: 4,
        expectedRevision: 2,
        evidenceKind: "http-json",
        numberOfQuestions: 2,
        normasSag: true,
        workingDirectory: "/repo",
        verbose: true,
        quiet: true,
        noColor: true,
      });
    });
  });

  describe("comandos de publicacion de plan", () => {
    test("ticket-create acepta tipo, titulo, estimacion, asignado y campos explicitos", () => {
      const result = parse([
        "ticket-create", "--hu", "23438", "--type", "Task", "--title", "Slice uno",
        "--description-file", "/tmp/d.html", "--estimate", "8", "--assignee", "dev@example.com",
        "--field", "Custom.Mes=enero", "--field", "Custom.Otro=a=b",
      ]);
      expect(result.kind).toBe("options");
      if (result.kind !== "options") return;
      expect(result.options).toMatchObject({
        command: "ticket-create",
        hu: 23438,
        type: "Task",
        title: "Slice uno",
        descriptionFile: "/tmp/d.html",
        estimate: 8,
        assignee: "dev@example.com",
      });
      // The value may contain "=": only the first separator splits the pair.
      expect(result.options.fields).toEqual([
        { referenceName: "Custom.Mes", value: "enero" },
        { referenceName: "Custom.Otro", value: "a=b" },
      ]);
    });

    test("los comandos de enlace aceptan sus pares de identificadores", () => {
      const parent = parse(["ticket-link-parent", "--parent", "10", "--child", "11"]);
      expect(parent.kind).toBe("options");
      if (parent.kind === "options") expect(parent.options).toMatchObject({ parent: 10, child: 11 });

      const predecessor = parse(["ticket-link-predecessor", "--blocker", "10", "--blocked", "11"]);
      expect(predecessor.kind).toBe("options");
      if (predecessor.kind === "options") expect(predecessor.options).toMatchObject({ blocker: 10, blocked: 11 });
    });

    test("un --field sin separador falla", () => {
      expect(parse(["ticket-create", "--field", "sinIgual"]).kind).toBe("error");
    });
  });
  describe("entrevista de planificacion", () => {
    const interviewOf = (args: string[]) => {
      const result = parse(args);
      if (result.kind !== "options") throw new Error(`se esperaban opciones, llego ${result.kind}`);
      return result.options.interview;
    };

    test("sin --interview no hay entrevista y los valores quedan en su default", () => {
      expect(interviewOf(["plan"])).toEqual({
        channel: "off",
        host: "127.0.0.1",
        port: 0,
        directory: null,
        timeoutSeconds: 900,
        rounds: 8,
      });
    });

    test("cada canal soportado se acepta", () => {
      expect(interviewOf(["plan", "--interview", "http"]).channel).toBe("http");
      expect(interviewOf(["plan", "--interview", "terminal"]).channel).toBe("terminal");
      expect(interviewOf(["plan", "--interview", "file", "--interview-dir", "/tmp/i"]).channel).toBe("file");
    });

    test("un canal desconocido es un error de argumentos", () => {
      expect(parse(["plan", "--interview", "telepatia"]).kind).toBe("error");
    });

    test("el canal http toma su host, su puerto y sus topes", () => {
      expect(interviewOf([
        "plan", "--interview", "http",
        "--interview-host", "0.0.0.0", "--interview-port", "7777",
        "--interview-timeout", "60", "--interview-rounds", "2",
      ])).toMatchObject({ host: "0.0.0.0", port: 7777, timeoutSeconds: 60, rounds: 2 });
    });

    test("el puerto 0 es valido: pide uno libre al sistema", () => {
      expect(interviewOf(["plan", "--interview", "http", "--interview-port", "0"]).port).toBe(0);
      expect(parse(["plan", "--interview", "http", "--interview-port", "-1"]).kind).toBe("error");
    });

    test("un sub-flag que su canal nunca leeria es un error de argumentos", () => {
      expect(parse(["plan", "--interview", "terminal", "--interview-port", "7777"]).kind).toBe("error");
      expect(parse(["plan", "--interview", "http", "--interview-dir", "/tmp/i"]).kind).toBe("error");
      expect(parse(["plan", "--interview-timeout", "60"]).kind).toBe("error");
    });

    test("el canal file exige su directorio de intercambio", () => {
      expect(parse(["plan", "--interview", "file"]).kind).toBe("error");
    });
  });
});
