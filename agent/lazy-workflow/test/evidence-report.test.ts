import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHttpCaptures, readHttpCaptures } from "../src/evidence/http-capture.ts";
import { renderEvidenceHtml, renderEvidenceMarkdown } from "../src/evidence/evidence-report.ts";
import { GitHubDeliveryService } from "../src/github/github-delivery-service.ts";
import { HTTP_CAPTURE, HTTP_CAPTURE_BODY, SCREENSHOT_BYTES, SCREENSHOT_NAME } from "./_helpers/evidence-fixtures.ts";

/**
 * What a reviewer opens. The evidence a delivery produced used to reach the tracker as the bytes of
 * a file — no endpoint, no status, no picture of the browser that made the request — so what these
 * tests pin is that every part a reader looks for survives into the published document, and that a
 * file with nothing to lay out is refused while the session can still rewrite it.
 */

const capture = { ...HTTP_CAPTURE };

/** What the tracker compares when it asks whether evidence it already holds is this delivery's. */
const textOf = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const documentInput = {
  subject: "Ticket 23575",
  facts: [{ label: "Rama del ticket", value: "refs/heads/ticket/23575" }, { label: "Commit", value: "a".repeat(40) }],
  validation: [{ command: "bun test", result: "198 pass, 0 fail" }],
  files: [
    { name: "pago-endpoint.json", kind: "http-json" as const, content: HTTP_CAPTURE_BODY },
    { name: SCREENSHOT_NAME, kind: "screen" as const, imageUrl: "https://azure.test/attachments/1?fileName=pantalla.png" },
    { name: "bun-test.txt", kind: "command-output" as const, content: "198 pass\n0 fail\n" },
  ],
};

describe("http capture", () => {
  test("acepta las cabeceras como mapa y como lista de pares, conservando el orden", () => {
    const [asMap] = parseHttpCaptures(capture);
    const [asList] = parseHttpCaptures({
      ...capture,
      request: { ...capture.request, headers: [{ name: "content-type", value: "application/json" }] },
    });

    expect(asMap!.request.headers[0]).toEqual({ name: "content-type", value: "application/json" });
    expect(asList!.request.headers).toEqual([{ name: "content-type", value: "application/json" }]);
  });

  test("nombra el campo que falta en vez de rechazar el archivo entero", () => {
    expect(() => parseHttpCaptures({ ...capture, response: { headers: {} } })).toThrow("response.status");
    expect(() => parseHttpCaptures({ ...capture, request: { ...capture.request, url: "/relativa" } }))
      .toThrow("request.url debe ser una URL http o https completa");
    expect(() => parseHttpCaptures({ ...capture, screenshot: "capturas/pantalla.png" }))
      .toThrow("sin ruta");
    expect(() => parseHttpCaptures({ ...capture, screenshot: "pantalla.txt" })).toThrow(".png");
  });

  test("lee varias capturas de un solo archivo", () => {
    expect(parseHttpCaptures({ captures: [capture, { ...capture, title: "Segunda" }] })).toHaveLength(2);
    expect(parseHttpCaptures([capture])).toHaveLength(1);
  });

  test("un JSON que no es una captura se reconoce como tal, sin lanzar", () => {
    expect(readHttpCaptures('{ "ok": true }')).toBeNull();
    expect(readHttpCaptures("no json")).toBeNull();
  });
});

describe("documento HTML del ticket", () => {
  const html = renderEvidenceHtml(documentInput);

  test("muestra endpoint, estado, cabeceras y cuerpos donde un lector los busca", () => {
    expect(html).toContain("Evidencia de completitud &mdash; Ticket 23575");
    expect(html).toContain("Validaciones ejecutadas");
    expect(html).toContain("198 pass, 0 fail");
    expect(html).toContain("<b>POST</b> https://api.test/payment-attempts/42/reconcile");
    expect(html).toContain("200 OK");
    expect(html).toContain("Cabecera de la petición");
    expect(html).toContain("Cabecera de la respuesta");
    expect(html).toContain("&quot;reconciled&quot;: true");
  });

  test("muestra la captura del navegador dentro de su propio intercambio, no como archivo suelto", () => {
    expect(html).toContain('<img src="https://azure.test/attachments/1?fileName=pantalla.png"');
    expect(html).toContain("Captura del navegador");
    // Reclamada por la captura HTTP, no se repite en la galería del final.
    expect(html).not.toContain("Capturas de pantalla");
  });

  test("el contenido de la evidencia se escapa: el documento nunca ejecuta lo que transporta", () => {
    const rendered = renderEvidenceHtml({
      ...documentInput,
      files: [{ name: "salida.txt", kind: "command-output", content: "<img onerror=alert(1)>" }],
    });

    expect(rendered).toContain("&lt;img onerror=alert(1)&gt;");
    expect(rendered).not.toContain("<img onerror");
  });

  test("una captura sin adjunto publicado se nombra sin romper la imagen ni cambiar el texto", () => {
    // La publicación adjunta y solo después escribe el campo, así que la misma entrega renderiza
    // dos veces: si el texto cambiara entre ambas, una repetición leería su propia evidencia como
    // un conflicto ajeno. El pie nombra el archivo igual en los dos casos.
    const files = [
      { name: "pago-endpoint.json", kind: "http-json" as const, content: HTTP_CAPTURE_BODY },
      { name: SCREENSHOT_NAME, kind: "screen" as const },
    ];
    const sinAdjunto = renderEvidenceHtml({ ...documentInput, files: [files[0]!, { ...files[1]!, imageUrl: null }] });
    const conAdjunto = renderEvidenceHtml({
      ...documentInput,
      files: [files[0]!, { ...files[1]!, imageUrl: "https://azure.test/attachments/1?fileName=pantalla.png" }],
    });

    expect(sinAdjunto).not.toContain("<img src");
    expect(sinAdjunto).toContain(`Captura del navegador · ${SCREENSHOT_NAME}`);
    expect(textOf(sinAdjunto)).toBe(textOf(conAdjunto));
  });
});

describe("documento Markdown de GitHub", () => {
  const markdown = renderEvidenceMarkdown(documentInput);

  test("publica el intercambio como tablas y bloques con lenguaje, no como texto plano", () => {
    expect(markdown).toContain("## Evidencia de entrega — Ticket 23575");
    expect(markdown).toContain("| Comando | Resultado |");
    expect(markdown).toContain("`POST` **/payment-attempts/42/reconcile** → **200 OK**");
    expect(markdown).toContain("```json");
    expect(markdown).toContain('"reconciled": true');
    expect(markdown).toContain(`![${SCREENSHOT_NAME}](https://azure.test/attachments/1?fileName=pantalla.png)`);
  });

  test("una celda con barras no puede cerrar la fila que la lleva", () => {
    const rendered = renderEvidenceMarkdown({
      ...documentInput,
      validation: [{ command: "bun test | tee salida.txt", result: "ok" }],
      files: [],
    });

    expect(rendered).toContain("bun test \\| tee salida.txt");
  });

  test("un bloque que contiene un cerco no termina el bloque antes de tiempo", () => {
    const rendered = renderEvidenceMarkdown({
      ...documentInput,
      files: [{ name: "salida.txt", kind: "command-output", content: "```\ninterno\n```" }],
    });

    expect(rendered).toContain("````\n```\ninterno\n```\n````");
  });
});

describe("entrega GitHub", () => {
  /** A repository with the evidence a manifest names, and a `gh` that records what it was told. */
  function delivery(calls: string[][]) {
    const root = mkdtempSync(join(tmpdir(), "lazy-workflow-github-evidence-"));
    const service = new GitHubDeliveryService(
      async (args) => {
        calls.push(args);
        if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "elvisbrevi/agent-workflow", defaultBranchRef: { name: "main" } });
        if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ state: args.includes("state,comments") ? "OPEN" : "CLOSED", comments: [] });
        return "";
      },
      async (args) => (args[0] === "remote" ? "git@github.com:elvisbrevi/agent-workflow.git\n" : ""),
    );
    return { root, service };
  }

  test("el comentario de cierre publica la evidencia y conserva el marcador que una repetición reconoce", async () => {
    const calls: string[][] = [];
    const { root, service } = delivery(calls);
    try {
      await Bun.write(join(root, "docs/evidence/api.json"), HTTP_CAPTURE_BODY);
      await Bun.write(join(root, `docs/evidence/${SCREENSHOT_NAME}`), SCREENSHOT_BYTES);

      await service.closeIssue(201, 12, "c".repeat(40), root, {
        issue: 201,
        branch: "refs/heads/issue/201",
        commit: "a".repeat(40),
        validation: [{ command: "bun test", result: "198 pass" }],
        clean: true,
        summary: "Integra la reconciliación de pagos",
        evidence: [
          { path: "docs/evidence/api.json", sha256: "a".repeat(64) },
          { path: `docs/evidence/${SCREENSHOT_NAME}`, sha256: "b".repeat(64) },
        ],
      });

      const comment = calls.find(([command, action]) => command === "issue" && action === "comment");
      const body = comment?.[comment.indexOf("--body") + 1] ?? "";
      expect(body).toContain("## Evidencia de entrega — Issue #201");
      expect(body).toContain("`POST` **/payment-attempts/42/reconcile** → **200 OK**");
      expect(body).toContain(
        `![docs/evidence/${SCREENSHOT_NAME}](https://github.com/elvisbrevi/agent-workflow/blob/${"c".repeat(40)}/docs/evidence/${SCREENSHOT_NAME}?raw=1)`,
      );
      expect(body).toContain("Integra la reconciliación de pagos");
      // El marcador es lo que una repetición reconoce: nunca se pierde detrás de la evidencia.
      expect(body).toContain(`lazy-workflow: delivered PR #12 (${"c".repeat(40)})`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sin manifest el cierre sigue siendo el marcador solo", async () => {
    const calls: string[][] = [];
    const { root, service } = delivery(calls);
    try {
      await service.closeIssue(201, 12, "c".repeat(40), root);

      const comment = calls.find(([command, action]) => command === "issue" && action === "comment");
      expect(comment?.[comment.indexOf("--body") + 1]).toBe(`lazy-workflow: delivered PR #12 (${"c".repeat(40)})`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
