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
  test("lee las cabeceras como el mapa que un panel de devtools copia, conservando el orden", () => {
    const [parsed] = parseHttpCaptures(capture);

    expect(parsed!.request.headers).toEqual([
      { name: "content-type", value: "application/json" },
      { name: "x-api-key", value: "[REDACTED - ADMIN_API_TOKEN]" },
    ]);
    expect(() => parseHttpCaptures({ ...capture, request: { ...capture.request, headers: [] } }))
      .toThrow("request.headers debe ser un objeto de cabeceras");
  });

  test("nombra el campo que falta en vez de rechazar el archivo entero", () => {
    expect(() => parseHttpCaptures({ ...capture, response: { headers: {} } })).toThrow("response.status");
    expect(() => parseHttpCaptures({ ...capture, request: { ...capture.request, url: "/relativa" } }))
      .toThrow("request.url debe ser una URL http o https completa");
    expect(() => parseHttpCaptures({ ...capture, screenshot: "capturas/pantalla.png" }))
      .toThrow("sin ruta");
    expect(() => parseHttpCaptures({ ...capture, screenshot: "pantalla.txt" })).toThrow(".png");
  });

  test("lee varias capturas de un solo archivo bajo `captures`", () => {
    expect(parseHttpCaptures({ captures: [capture, { ...capture, title: "Segunda" }] })).toHaveLength(2);
    // Una sola forma declarada: un arreglo suelto no es ninguna de las dos que el prompt documenta.
    expect(() => parseHttpCaptures([capture])).toThrow("cada captura debe ser un objeto");
  });

  test("un JSON que no es una captura se reconoce como tal, sin lanzar", () => {
    expect(readHttpCaptures('{ "ok": true }')).toBeNull();
    expect(readHttpCaptures("no json")).toBeNull();
  });
});

describe("documento HTML del ticket", () => {
  const html = renderEvidenceHtml(documentInput);

  test("muestra endpoint, estado, cabeceras y cuerpos donde un lector los busca", () => {
    expect(html).toContain("Evidencia de completitud — Ticket 23575");
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

  test("un documento con demasiadas secciones se corta entero, nunca a mitad de una etiqueta", () => {
    // Recortar cada bloque no acota cuántos hay: un manifest con muchos archivos podía producir un
    // valor que el propio PATCH de Azure rechaza en la última compuerta.
    const rendered = renderEvidenceHtml({
      ...documentInput,
      files: [...Array(40)].map((_unused, index) => ({
        name: `salida-${index}.txt`,
        kind: "command-output" as const,
        content: "x".repeat(9000),
      })),
    });

    expect(rendered).toContain("evidencia truncada");
    expect(rendered.length).toBeLessThan(140000);
    expect(rendered.endsWith("</div>")).toBeTrue();
    // Ninguna etiqueta partida: cada `<` abierto tiene su `>`.
    expect(rendered.split("<").length).toBe(rendered.split(">").length);
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

  test("cada captura muestra la pantalla que vive junto a ella, no la homónima de otro repositorio", () => {
    // Dos repositorios de una entrega transversal llaman `pantalla.png` a la suya: emparejar por
    // nombre publicaba el navegador de uno al lado de la petición del otro.
    const otra = { ...HTTP_CAPTURE, title: "Segundo repositorio" };
    const rendered = renderEvidenceMarkdown({
      ...documentInput,
      files: [
        { name: `api/${SCREENSHOT_NAME}`, path: `api/${SCREENSHOT_NAME}`, kind: "screen", imageUrl: "https://test/api.png" },
        { name: "api/captura.json", path: "api/captura.json", kind: "http-json", content: HTTP_CAPTURE_BODY },
        { name: `web/${SCREENSHOT_NAME}`, path: `web/${SCREENSHOT_NAME}`, kind: "screen", imageUrl: "https://test/web.png" },
        { name: "web/captura.json", path: "web/captura.json", kind: "http-json", content: `${JSON.stringify(otra, null, 2)}\n` },
      ],
    });

    const [antesDeWeb, despuesDeWeb] = rendered.split("#### Segundo repositorio") as [string, string];
    expect(antesDeWeb).toContain("https://test/api.png");
    expect(antesDeWeb).not.toContain("https://test/web.png");
    expect(despuesDeWeb).toContain("https://test/web.png");
    // Ambas quedaron dentro de su intercambio: no sobra ninguna para la galería del final.
    expect(rendered).not.toContain("### Capturas de pantalla");
  });

  test("el color de una salida no se publica como códigos de escape", () => {
    const rendered = renderEvidenceMarkdown({
      ...documentInput,
      files: [{ name: "salida.txt", kind: "command-output", content: "\u001b[32m198 pass\u001b[0m\n" }],
    });

    expect(rendered).toContain("198 pass");
    expect(rendered).not.toContain("\u001b");
  });

  test("una celda con barras no puede cerrar la fila que la lleva", () => {
    const rendered = renderEvidenceMarkdown({
      ...documentInput,
      validation: [{ command: "bun test | tee salida.txt", result: "ok" }],
      files: [],
    });

    expect(rendered).toContain("bun test \\| tee salida.txt");
  });

  test("una corrida de líneas en blanco dentro del bloque sobrevive al documento", () => {
    // Colapsar los saltos sobre el texto ya unido reescribía el interior del cerco, y una salida de
    // comando que ya no coincide con su digest no es la evidencia que el manifest fijó.
    const salida = "primera\n\n\n\nsegunda\n";
    const rendered = renderEvidenceMarkdown({
      ...documentInput,
      files: [{ name: "salida.txt", kind: "command-output", content: salida }],
    });

    expect(rendered).toContain(salida.trimEnd());
  });

  test("un bloque que contiene un cerco no termina el bloque antes de tiempo", () => {
    const rendered = renderEvidenceMarkdown({
      ...documentInput,
      files: [{ name: "salida.txt", kind: "command-output", content: "```\ninterno\n```" }],
    });

    expect(rendered).toContain("````\n```\ninterno\n```\n````");
  });
});
