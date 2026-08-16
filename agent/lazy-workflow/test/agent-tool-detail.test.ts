import { describe, expect, test } from "bun:test";
import {
  describeToolInput,
  renderToolCall,
  renderToolInput,
  renderToolOutput,
} from "../src/output/agent-tool-detail.ts";

describe("describeToolInput", () => {
  test("nombra el archivo que la herramienta edita", () => {
    expect(describeToolInput({ file_path: "src/output/reporter.ts", old_string: "a", new_string: "b" }))
      .toEqual({ target: "src/output/reporter.ts", detail: null });
  });

  test("acepta las variantes de nombre que usa cada proveedor", () => {
    expect(describeToolInput({ filePath: "a.ts" }).target).toBe("a.ts");
    expect(describeToolInput({ notebook_path: "b.ipynb" }).target).toBe("b.ipynb");
    expect(describeToolInput({ path: "c/" }).target).toBe("c/");
    expect(describeToolInput({ pattern: "**/*.ts" }).target).toBe("**/*.ts");
    expect(describeToolInput({ url: "https://ejemplo.cl" }).target).toBe("https://ejemplo.cl");
  });

  test("el comando es el detalle, y una busqueda tiene ambos", () => {
    expect(describeToolInput({ command: "git status --short" }))
      .toEqual({ target: null, detail: "git status --short" });
    expect(describeToolInput({ pattern: "TODO", path: "src" }))
      .toEqual({ target: "src", detail: null });
  });

  test("una entrada vacia, ausente o no-objeto no inventa nada", () => {
    expect(describeToolInput(undefined)).toEqual({ target: null, detail: null });
    expect(describeToolInput("texto")).toEqual({ target: null, detail: null });
    expect(describeToolInput({ file_path: "   " })).toEqual({ target: null, detail: null });
  });
});

describe("renderToolCall", () => {
  test("nombra herramienta, estado, artefacto y resumen", () => {
    expect(renderToolCall("OpenCode", "edit", "completed", { file_path: "src/a.ts", description: "ajusta el borde" }))
      .toBe('OpenCode herramienta edit (completed) en src/a.ts: "ajusta el borde"');
  });

  test("sin estado ni artefacto queda el comando solo", () => {
    expect(renderToolCall("Claude Code", "Bash", undefined, { command: "bun test" }))
      .toBe('Claude Code herramienta Bash: "bun test"');
  });

  test("una herramienta sin nombre se reporta como desconocida", () => {
    expect(renderToolCall("OpenCode", undefined, undefined, {})).toBe("OpenCode herramienta desconocida");
  });

  test("no repite el artefacto como resumen cuando son el mismo valor", () => {
    expect(renderToolCall("OpenCode", "read", "completed", { path: "AGENTS.md", description: "AGENTS.md" }))
      .toBe("OpenCode herramienta read (completed) en AGENTS.md");
  });
});

describe("renderToolInput", () => {
  test("devuelve la entrada completa como JSON", () => {
    expect(renderToolInput({ file_path: "src/a.ts", old_string: "antes" }))
      .toBe('{"file_path":"src/a.ts","old_string":"antes"}');
  });

  test("acorta los valores largos, para reportar la llamada y no el archivo", () => {
    const rendered = renderToolInput({ content: "x".repeat(5_000) });
    expect(rendered).not.toBeNull();
    expect(rendered!.length).toBeLessThan(1_000);
    expect(rendered).toContain("…");
  });

  test("una entrada vacia o ausente no se reporta", () => {
    expect(renderToolInput({})).toBeNull();
    expect(renderToolInput(undefined)).toBeNull();
  });
});

describe("renderToolOutput", () => {
  test("el texto de salida se reporta tal cual, ya recortado", () => {
    expect(renderToolOutput("  1 archivo actualizado  ")).toBe("1 archivo actualizado");
    expect(renderToolOutput("")).toBeNull();
    expect(renderToolOutput(undefined)).toBeNull();
  });

  test("una salida estructurada se serializa", () => {
    expect(renderToolOutput([{ ok: true }])).toBe('[{"ok":true}]');
  });
});
