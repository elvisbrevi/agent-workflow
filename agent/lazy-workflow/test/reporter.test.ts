import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import chalk from "chalk";
import {
  createReporter,
  type Reporter,
  type ReporterStream,
} from "../src/output/reporter.ts";

beforeAll(() => {
  chalk.level = 1;
});

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

describe("createReporter", () => {
  describe("info", () => {
    test("emite una sola linea con icono informativo", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, stream });
      reporter.info("hola");

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe("\u001b[34mℹ hola\u001b[39m\n");
    });

    test("multiples llamadas escriben lineas independientes", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, stream });
      reporter.info("uno");
      reporter.info("dos");

      expect(chunks).toEqual([
        "\u001b[34mℹ uno\u001b[39m\n",
        "\u001b[34mℹ dos\u001b[39m\n",
      ]);
    });
  });

  describe("warn", () => {
    test("emite una linea amarilla con icono de advertencia", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, stream });
      reporter.warn("cuidado");

      expect(chunks).toEqual(["\u001b[33m⚠ cuidado\u001b[39m\n"]);
    });
  });

  describe("error", () => {
    test("emite una linea roja con icono de error", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, stream });
      reporter.error("fallo");

      expect(chunks).toEqual(["\u001b[31m✗ fallo\u001b[39m\n"]);
    });
  });

  describe("debug", () => {
    test("se silencia cuando verbose es false", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, stream });
      reporter.debug("traza");

      expect(chunks).toEqual([]);
    });

    test("emite linea gris cuando verbose es true", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: true, stream });
      reporter.debug("traza");

      expect(chunks).toEqual(["\u001b[90m· traza\u001b[39m\n"]);
    });
  });

  describe("verbose", () => {
    test("info, warn y error se emiten independientemente del flag verbose", () => {
      const quietStream = captureStream();
      const loudStream = captureStream();
      const quiet = createReporter({ verbose: false, stream: quietStream.stream });
      const loud = createReporter({ verbose: true, stream: loudStream.stream });

      quiet.info("a");
      quiet.warn("b");
      quiet.error("c");
      loud.info("a");
      loud.warn("b");
      loud.error("c");

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

    test("info emite texto plano sin codigos ANSI", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, stream });
      reporter.info("hola");

      expect(chunks).toEqual(["ℹ hola\n"]);
    });

    test("warn emite texto plano sin codigos ANSI", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, stream });
      reporter.warn("cuidado");

      expect(chunks).toEqual(["⚠ cuidado\n"]);
    });

    test("error emite texto plano sin codigos ANSI", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, stream });
      reporter.error("fallo");

      expect(chunks).toEqual(["✗ fallo\n"]);
    });

    test("debug verbose emite texto plano sin codigos ANSI", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: true, stream });
      reporter.debug("traza");

      expect(chunks).toEqual(["· traza\n"]);
    });
  });

  describe("quiet", () => {
    test("silencia info, warn y debug pero conserva error", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: true, quiet: true, stream });
      reporter.info("uno");
      reporter.warn("dos");
      reporter.debug("tres");
      reporter.error("cuatro");

      expect(chunks).toEqual(["\u001b[31m✗ cuatro\u001b[39m\n"]);
    });

    test("quiet con verbose false coincide con quiet con verbose true en errores", () => {
      const quietStream = captureStream();
      const quietLoudStream = captureStream();
      const quietReporter = createReporter({ verbose: false, quiet: true, stream: quietStream.stream });
      const quietLoudReporter = createReporter({ verbose: true, quiet: true, stream: quietLoudStream.stream });

      quietReporter.info("a");
      quietReporter.warn("b");
      quietReporter.error("c");
      quietReporter.debug("d");
      quietLoudReporter.info("a");
      quietLoudReporter.warn("b");
      quietLoudReporter.error("c");
      quietLoudReporter.debug("d");

      expect(quietStream.chunks).toEqual(quietLoudStream.chunks);
    });

    test("quiet false mantiene el comportamiento original de info y warn", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, quiet: false, stream });
      reporter.info("hola");
      reporter.warn("cuidado");

      expect(chunks).toEqual([
        "\u001b[34mℹ hola\u001b[39m\n",
        "\u001b[33m⚠ cuidado\u001b[39m\n",
      ]);
    });

    test("quiet por defecto es false", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, stream });
      reporter.info("visible");

      expect(chunks).toEqual(["\u001b[34mℹ visible\u001b[39m\n"]);
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
      const reporter = createReporter({ verbose: false, noColor: true, stream });
      reporter.info("hola");
      reporter.error("fallo");

      expect(chunks).toEqual(["ℹ hola\n", "✗ fallo\n"]);
    });

    test("noColor=false preserva los colores cuando NO_COLOR no esta definido", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: false, stream });
      reporter.info("hola");

      expect(chunks).toEqual(["\u001b[34mℹ hola\u001b[39m\n"]);
    });

    test("el spinner arranca silencioso con noColor=true", () => {
      const { stream } = captureStream();
      const reporter = createReporter({ verbose: false, noColor: true, stream });
      const spinner = reporter.start("cargando");

      expect(spinner.isSilent).toBeTrue();
      spinner.stop();
    });
  });

  describe("factory", () => {
    test("acepta un booleano para usos publicos", () => {
      const reporter = createReporter(false);
      const loud = createReporter(true);

      expect(typeof reporter.info).toBe("function");
      expect(typeof reporter.warn).toBe("function");
      expect(typeof reporter.error).toBe("function");
      expect(typeof reporter.debug).toBe("function");
      expect(typeof reporter.start).toBe("function");
      expect(typeof reporter.stop).toBe("function");
      expect(typeof loud.debug).toBe("function");
    });

    test("las instancias son independientes", () => {
      const a = captureStream();
      const b = captureStream();
      const reporterA = createReporter({ verbose: false, stream: a.stream });
      const reporterB = createReporter({ verbose: true, stream: b.stream });

      reporterA.info("uno");
      reporterA.debug("ignorado");
      reporterB.debug("dos");

      expect(a.chunks).toEqual(["\u001b[34mℹ uno\u001b[39m\n"]);
      expect(b.chunks).toEqual(["\u001b[90m· dos\u001b[39m\n"]);
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

    test("con NO_COLOR el spinner arranca silencioso", () => {
      const originalNoColor = process.env.NO_COLOR;
      process.env.NO_COLOR = "1";
      try {
        const { stream } = captureStream();
        const reporter = createReporter({ verbose: false, stream });
        const spinner = reporter.start("cargando");

        expect(spinner.isSilent).toBeTrue();
        spinner.stop();
      } finally {
        if (originalNoColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = originalNoColor;
      }
    });
  });

  describe("multi-line messages", () => {
    test("info aplica color por linea, con icono solo en la primera", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, stream });
      reporter.info("uno\ndos\ntres");

      expect(chunks).toEqual([
        "\u001b[34mℹ uno\u001b[39m\n\u001b[34mdos\u001b[39m\n\u001b[34mtres\u001b[39m\n",
      ]);
    });

    test("warn preserva saltos de linea internos con color por linea", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, stream });
      reporter.warn("primera\nsegunda");

      expect(chunks).toEqual(["\u001b[33m⚠ primera\u001b[39m\n\u001b[33msegunda\u001b[39m\n"]);
    });

    test("error con texto vacio emite icono y linea vacia", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, stream });
      reporter.error("");

      expect(chunks).toEqual(["\u001b[31m✗ \u001b[39m\n"]);
    });
  });

  describe("orden de niveles", () => {
    test("info, warn y error producen lineas en orden", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: false, stream });
      reporter.info("primero");
      reporter.warn("segundo");
      reporter.error("tercero");

      expect(chunks).toEqual([
        "\u001b[34mℹ primero\u001b[39m\n",
        "\u001b[33m⚠ segundo\u001b[39m\n",
        "\u001b[31m✗ tercero\u001b[39m\n",
      ]);
    });

    test("debug verbose se intercala con info sin perder orden", () => {
      const { stream, chunks } = captureStream();
      const reporter = createReporter({ verbose: true, stream });
      reporter.info("a");
      reporter.debug("b");
      reporter.warn("c");

      expect(chunks).toEqual([
        "\u001b[34mℹ a\u001b[39m\n",
        "\u001b[90m· b\u001b[39m\n",
        "\u001b[33m⚠ c\u001b[39m\n",
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

  test("routea al info del reporter por defecto y emite texto plano", async () => {
    const { reportOperator, setDefaultReporter } = await import("../src/output/operator-output.ts");
    const { stream, chunks } = captureStream();
    const previous = (await import("../src/output/operator-output.ts")).getDefaultReporter();
    setDefaultReporter(createReporter({ verbose: false, stream }));

    try {
      reportOperator("hola");
      expect(chunks).toEqual(["ℹ hola\n"]);
    } finally {
      setDefaultReporter(previous);
    }
  });
});
