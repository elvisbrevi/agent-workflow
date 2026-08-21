import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import chalk from "chalk";
import {
  createReporter,
  type Reporter,
  type ReporterStream,
} from "../src/output/reporter.ts";
import { parseReportedChunk } from "./_helpers/reported-lines.ts";

beforeAll(() => {
  chalk.level = 1;
});

/** A clock the reporter reads instead of the wall one, so a stamp is assertable. */
const FIXED_DATE = new Date(2026, 7, 10, 16, 23, 5);
const FIXED_STAMP = "10/08/26 16:23:05";
const now = () => FIXED_DATE;

const captureStream = (): { stream: ReporterStream; chunks: string[] } => {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    }) as unknown as ReporterStream,
    chunks,
  };
};

const stripAnsi = (text: string): string => text.replace(/\[[0-9;]*m/g, "");
const plain = (chunks: string[]): string[] => chunks.map(stripAnsi);

describe("createReporter", () => {
  describe("linea parseada", () => {
    test("estampa fecha, hora, minuto y segundo antes del glifo", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: true, stream, now });
      reporter.info("hola");

      expect(chunks).toEqual([`${FIXED_STAMP} │ ● hola\n`]);
    });

    test("cada nivel tiene su propio glifo en la misma columna", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: true, verboseOutput: true, noColor: true, stream, now });
      reporter.info("uno");
      reporter.warn("dos");
      reporter.error("tres");
      reporter.debug("cuatro");
      reporter.trace("cinco");

      expect(chunks).toEqual([
        `${FIXED_STAMP} │ ● uno\n`,
        `${FIXED_STAMP} │ ▲ dos\n`,
        `${FIXED_STAMP} │ ✖ tres\n`,
        `${FIXED_STAMP} │ · cuatro\n`,
        `${FIXED_STAMP} │ ⋮ cinco\n`,
      ]);
    });

    test("multiples llamadas escriben lineas independientes", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: true, stream, now });
      reporter.info("uno");
      reporter.info("dos");

      expect(chunks).toEqual([
        `${FIXED_STAMP} │ ● uno\n`,
        `${FIXED_STAMP} │ ● dos\n`,
      ]);
    });

    test("las lineas se leen de vuelta con su nivel", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: true, noColor: true, stream, now });
      reporter.info("a");
      reporter.debug("b");
      reporter.warn("c");

      expect(chunks.flatMap(parseReportedChunk)).toEqual([
        { level: "info", message: "a" },
        { level: "debug", message: "b" },
        { level: "warn", message: "c" },
      ]);
    });
  });

  describe("color", () => {
    test("cada nivel pinta su glifo y su texto", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: false, stream, now });
      reporter.info("hola");

      expect(chunks[0]).toContain("[");
      expect(stripAnsi(chunks[0]!)).toBe(`${FIXED_STAMP} │ ● hola\n`);
    });

    test("info, warn y error no comparten el mismo color", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: false, stream, now });
      reporter.info("uno");
      reporter.warn("dos");
      reporter.error("tres");

      const codes = chunks.map((chunk) => chunk.match(/\[[0-9;]*m/g)?.join(",") ?? "");
      expect(new Set(codes).size).toBe(3);
    });
  });

  describe("debug", () => {
    test("se silencia cuando verbose es false", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: true, stream, now });
      reporter.debug("traza");

      expect(chunks).toEqual([]);
    });

    test("se emite cuando verbose es true", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: true, noColor: true, stream, now });
      reporter.debug("traza");

      expect(chunks).toEqual([`${FIXED_STAMP} │ · traza\n`]);
    });
  });

  describe("trace", () => {
    test("se silencia con verbose solo, porque es la salida completa", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: true, noColor: true, stream, now });
      reporter.trace("evento crudo");

      expect(chunks).toEqual([]);
      expect(reporter.tracing).toBeFalse();
    });

    test("verboseOutput lo habilita y tambien habilita debug", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, verboseOutput: true, noColor: true, stream, now });
      reporter.debug("herramienta");
      reporter.trace("evento crudo");

      expect(chunks).toEqual([
        `${FIXED_STAMP} │ · herramienta\n`,
        `${FIXED_STAMP} │ ⋮ evento crudo\n`,
      ]);
      expect(reporter.tracing).toBeTrue();
    });

    test("quiet apaga tracing incluso con verboseOutput", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: true, verboseOutput: true, quiet: true, noColor: true, stream, now });
      reporter.trace("evento crudo");

      expect(chunks).toEqual([]);
      expect(reporter.tracing).toBeFalse();
    });
  });

  describe("verbose", () => {
    test("info, warn y error se emiten independientemente del flag verbose", () => {
      const quietStream = captureStream();
      const loudStream = captureStream();
      const quiet = createReporter({ verbose: false, noColor: true, stream: quietStream.stream, now });
      const loud = createReporter({ verbose: true, noColor: true, stream: loudStream.stream, now });

      for (const reporter of [quiet, loud]) {
        reporter.info("a");
        reporter.warn("b");
        reporter.error("c");
      }

      expect(quietStream.chunks).toEqual(loudStream.chunks);
    });
  });

  describe("NO_COLOR", () => {
    let originalNoColor: string | undefined;

    beforeEach(() => {
      originalNoColor = process.env.NO_COLOR;
      process.env.NO_COLOR = "1";
    });

    afterEach(() => {
      if (originalNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = originalNoColor;
    });

    test("cada nivel emite texto plano sin codigos ANSI", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: true, verboseOutput: true, stream, now });
      reporter.info("hola");
      reporter.warn("cuidado");
      reporter.error("fallo");
      reporter.debug("traza");
      reporter.trace("crudo");

      expect(chunks).toEqual([
        `${FIXED_STAMP} │ ● hola\n`,
        `${FIXED_STAMP} │ ▲ cuidado\n`,
        `${FIXED_STAMP} │ ✖ fallo\n`,
        `${FIXED_STAMP} │ · traza\n`,
        `${FIXED_STAMP} │ ⋮ crudo\n`,
      ]);
    });
  });

  describe("quiet", () => {
    test("silencia info, warn, debug y trace pero conserva error", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: true, verboseOutput: true, quiet: true, noColor: true, stream, now });
      reporter.info("uno");
      reporter.warn("dos");
      reporter.debug("tres");
      reporter.trace("cuatro");
      reporter.heading("titulo");
      reporter.error("cinco");

      expect(chunks).toEqual([`${FIXED_STAMP} │ ✖ cinco\n`]);
    });

    test("quiet por defecto es false", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: true, stream, now });
      reporter.info("visible");

      expect(chunks).toEqual([`${FIXED_STAMP} │ ● visible\n`]);
    });
  });

  describe("run log", () => {
    test("warn y error se reenvian al run log ademas de imprimirse", () => {
      const { stream } = captureStream();
      const events: Array<{ severity: string; message: string }> = [];
      const reporter = createReporter({
        verbose: false,
        noColor: true,
        stream,
        now,
        runLog: { event: (severity, message) => events.push({ severity, message }) },
      });

      reporter.info("no reenviado");
      reporter.warn("cuidado");
      reporter.error("fallo");

      expect(events).toEqual([
        { severity: "warn", message: "cuidado" },
        { severity: "error", message: "fallo" },
      ]);
    });

    test("el reenvio ocurre incluso con --quiet, donde warn no llega a la terminal", () => {
      const { stream, chunks } = captureStream();
      const events: Array<{ severity: string; message: string }> = [];
      const reporter = createReporter({
        verbose: false,
        quiet: true,
        noColor: true,
        stream,
        now,
        runLog: { event: (severity, message) => events.push({ severity, message }) },
      });

      reporter.warn("silenciado en terminal");

      expect(chunks).toEqual([]);
      expect(events).toEqual([{ severity: "warn", message: "silenciado en terminal" }]);
    });

    test("sin runLog no cambia nada del comportamiento existente", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: true, stream, now });

      expect(() => {
        reporter.warn("uno");
        reporter.error("dos");
      }).not.toThrow();
      expect(chunks).toEqual([
        `${FIXED_STAMP} │ ▲ uno\n`,
        `${FIXED_STAMP} │ ✖ dos\n`,
      ]);
    });
  });

  describe("noColor explicito", () => {
    let originalNoColor: string | undefined;

    beforeEach(() => {
      originalNoColor = process.env.NO_COLOR;
      delete process.env.NO_COLOR;
    });

    afterEach(() => {
      if (originalNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = originalNoColor;
    });

    test("noColor=true fuerza texto plano aunque NO_COLOR no este definido", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: true, stream, now });
      reporter.info("hola");
      reporter.error("fallo");

      expect(chunks).toEqual([
        `${FIXED_STAMP} │ ● hola\n`,
        `${FIXED_STAMP} │ ✖ fallo\n`,
      ]);
    });

    test("noColor=false preserva los colores cuando NO_COLOR no esta definido", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: false, stream, now });
      reporter.info("hola");

      expect(chunks[0]).toContain("[");
    });

    test("el spinner arranca silencioso con noColor=true", () => {
      const { stream } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: true, stream });
      const spinner = reporter.start("cargando");

      expect(spinner.isSilent).toBeTrue();
      spinner.stop();
    });
  });

  describe("heading", () => {
    test("dibuja un panel redondeado con el titulo y sus detalles", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: true, stream, now });
      reporter.heading("lazy-workflow · code", ["alcance    GitHub"]);

      expect(plain(chunks)).toEqual([
        [
          "╭──────────────────────╮",
          "│ lazy-workflow · code │",
          "│ alcance    GitHub    │",
          "╰──────────────────────╯",
          "",
        ].join("\n"),
      ]);
    });

    test("el ancho lo fija la fila mas larga", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: true, stream, now });
      reporter.heading("corto", ["una fila bastante mas larga"]);

      const rendered = stripAnsi(chunks[0]!).split("\n");
      const widths = new Set(rendered.filter(Boolean).map((line) => [...line].length));
      expect(widths.size).toBe(1);
    });
  });

  describe("factory", () => {
    test("acepta un booleano para usos publicos", () => {
      const reporter = createReporter(false);

      expect(typeof reporter.info).toBe("function");
      expect(typeof reporter.trace).toBe("function");
      expect(typeof reporter.heading).toBe("function");
      expect(reporter.tracing).toBeFalse();
    });

    test("las instancias son independientes", () => {
      const a = captureStream();
      const b = captureStream();
      const reporterA = createReporter({ verbose: false, noColor: true, stream: a.stream, now });
      const reporterB = createReporter({ verbose: true, noColor: true, stream: b.stream, now });

      reporterA.info("uno");
      reporterA.debug("ignorado");
      reporterB.debug("dos");

      expect(a.chunks).toEqual([`${FIXED_STAMP} │ ● uno\n`]);
      expect(b.chunks).toEqual([`${FIXED_STAMP} │ · dos\n`]);
    });
  });

  describe("start/stop spinner", () => {
    test("start devuelve un spinner ora con el texto solicitado", () => {
      const { stream } = captureStream();
      const reporter: Reporter = createReporter({ verbose: false, stream });
      const spinner = reporter.start("cargando");

      expect(spinner).toBeDefined();
      expect(spinner.text).toBe("cargando");
      spinner.stop();
    });

    test("stop sin argumento no lanza", () => {
      const { stream } = captureStream();
      const reporter = createReporter({ verbose: false, stream });

      expect(() => reporter.stop()).not.toThrow();
    });

    test("stop con spinner se ejecuta sin lanzar", () => {
      const { stream } = captureStream();
      const reporter = createReporter({ verbose: false, stream });
      const spinner = reporter.start("procesando");

      expect(() => reporter.stop(spinner)).not.toThrow();
    });
  });

  describe("mensajes multilinea", () => {
    test("solo la primera linea se estampa; el resto cuelga del mismo canal", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: true, stream, now });
      reporter.info("uno\ndos\ntres");

      expect(chunks).toEqual([
        [
          `${FIXED_STAMP} │ ● uno`,
          `${" ".repeat(FIXED_STAMP.length)} │   dos`,
          `${" ".repeat(FIXED_STAMP.length)} │   tres`,
          "",
        ].join("\n"),
      ]);
    });

    test("un mensaje multilinea se lee de vuelta como uno solo", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: true, stream, now });
      reporter.warn("primera\nsegunda");

      expect(chunks.flatMap(parseReportedChunk)).toEqual([
        { level: "warn", message: "primera\nsegunda" },
      ]);
    });

    test("error con texto vacio emite el glifo y una linea vacia", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: true, stream, now });
      reporter.error("");

      expect(chunks).toEqual([`${FIXED_STAMP} │ ✖ \n`]);
    });
  });

  describe("orden de niveles", () => {
    test("info, warn y error producen lineas en orden", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: true, stream, now });
      reporter.info("primero");
      reporter.warn("segundo");
      reporter.error("tercero");

      expect(plain(chunks)).toEqual([
        `${FIXED_STAMP} │ ● primero\n`,
        `${FIXED_STAMP} │ ▲ segundo\n`,
        `${FIXED_STAMP} │ ✖ tercero\n`,
      ]);
    });
  });
});

describe("reportOperator shim", () => {
  beforeEach(() => {
    process.env.NO_COLOR = "1";
  });

  afterEach(() => {
    delete process.env.NO_COLOR;
  });

  test("routea al info del reporter por defecto y emite una linea estampada", async () => {
    const { reportOperator, setDefaultReporter, getDefaultReporter } = await import("../src/output/operator-output.ts");
    const { stream, chunks } = captureStream();
    const previous = getDefaultReporter();
    setDefaultReporter(createReporter({ verbose: false, stream, now }));

    try {
      reportOperator("hola");
      expect(chunks).toEqual([`${FIXED_STAMP} │ ● hola\n`]);
    } finally {
      setDefaultReporter(previous);
    }
  });
});
