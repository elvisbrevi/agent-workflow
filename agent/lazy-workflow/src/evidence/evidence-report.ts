/**
 * How completion evidence is presented, in one place.
 *
 * Evidence used to reach a ticket the way it left the file system: the raw bytes
 * of one text file dropped into the completion-evidence field, and the
 * screenshots parked as attachments nobody linked to anything. What a reviewer
 * opened was a wall of monospace with no endpoint, no status, no picture — proof
 * that technically existed and practically could not be read (issue: evidencia
 * en texto plano).
 *
 * So the coordinator renders. The same document is produced twice, once as the
 * HTML an Azure work-item field carries and once as the Markdown a GitHub issue
 * carries, from one description of what the evidence is: the identities of the
 * delivery, the validations that ran, every HTTP exchange with its headers, body
 * and response laid out in tables, and every screenshot shown inline. Both
 * renderers are pure — they take files already read and URLs already resolved —
 * so what a ticket displays is decided here and nowhere else.
 */

import type { EvidenceKind } from "../azure/completion-manifest.ts";
import { readHttpCaptures, type HttpCapture, type HttpCaptureHeader } from "./http-capture.ts";

/** One evidence file as the renderer needs it: already read, already resolved. */
export interface EvidenceFile {
  /** What a reader sees: a bare file name on a ticket, a repository-relative path on an issue. */
  name: string;
  /**
   * Where the file lives, when the display name is not that. A capture names its screenshot by
   * bare file name, so pairing the two is a question about locations, not about labels: two
   * repositories of one transversal delivery both call their screenshot `pantalla.png`, and
   * matching on the name alone would show one repository's browser beside the other's request.
   */
  path?: string;
  kind: EvidenceKind;
  /** The decoded text of a `http-json` or `command-output` file. */
  content?: string;
  /** Where a `screen` file can be displayed from, when it has been published. */
  imageUrl?: string | null;
}

const located = (file: EvidenceFile): string => file.path ?? file.name;

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

const directoryOf = (file: EvidenceFile): string => located(file).slice(0, -baseName(located(file)).length);

export interface EvidenceDocumentInput {
  /** What the evidence is about: `Ticket 23575`, `Issue #201`. */
  subject: string;
  /** Identities worth stating once at the top: branch, commit, pull request. */
  facts: Array<{ label: string; value: string }>;
  validation: Array<{ command: string; result: string }>;
  files: EvidenceFile[];
}

interface CaptureSection {
  source: string;
  capture: HttpCapture;
  screenshot: EvidenceFile | null;
}

interface EvidenceDocument {
  subject: string;
  facts: Array<{ label: string; value: string }>;
  validation: Array<{ command: string; result: string }>;
  captures: CaptureSection[];
  /** `http-json` files that carry JSON but not a capture: shown pretty, not parsed. */
  documents: Array<{ source: string; json: string }>;
  outputs: Array<{ source: string; text: string }>;
  /** Screenshots no capture already shows. */
  screens: EvidenceFile[];
}

/**
 * A block long enough to bury the evidence around it is not evidence any more,
 * and a tracker field has a size of its own to respect.
 */
const MAX_BLOCK_CHARACTERS = 8000;
const TRUNCATED = "\n… (contenido truncado)";

function clamp(value: string): string {
  return value.length <= MAX_BLOCK_CHARACTERS ? value : value.slice(0, MAX_BLOCK_CHARACTERS) + TRUNCATED;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A body a session wrote as an escaped JSON string still reads as JSON to a human. */
function renderBody(body: unknown): string {
  if (typeof body === "string") {
    const text = body.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return prettyJson(JSON.parse(text));
      } catch {
        return body;
      }
    }
    return body;
  }
  return prettyJson(body);
}

function statusLabel({ status, statusText }: HttpCapture["response"]): string {
  return statusText ? `${status} ${statusText}` : `${status}`;
}

/** Green for a success, amber for a redirect, red for a failure the reader must notice. */
function statusColor(status: number): string {
  if (status < 300) return "#1a7f37";
  if (status < 400) return "#9a6700";
  return "#d1242f";
}

/** Where the capture came from, named the same way in both renderings. */
const provenance = (capture: HttpCapture, source: string): string =>
  capture.capturedWith ? `Capturado con ${capture.capturedWith} · ${source}` : source;

function endpointPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function buildEvidenceDocument(input: EvidenceDocumentInput): EvidenceDocument {
  const screens = input.files.filter(({ kind }) => kind === "screen");
  const claimed = new Set<string>();
  const captures: CaptureSection[] = [];
  const documents: EvidenceDocument["documents"] = [];
  const outputs: EvidenceDocument["outputs"] = [];

  for (const file of input.files) {
    if (file.kind === "screen") continue;
    const content = file.content ?? "";
    if (!content.trim()) continue;
    if (file.kind === "http-json") {
      const parsed = readHttpCaptures(content);
      if (parsed) {
        for (const capture of parsed) {
          const screenshot = screens.find((screen) =>
            baseName(located(screen)).toLowerCase() === capture.screenshot.toLowerCase()
            && directoryOf(screen) === directoryOf(file)) ?? null;
          if (screenshot) claimed.add(located(screenshot).toLowerCase());
          captures.push({ source: file.name, capture, screenshot });
        }
        continue;
      }
      try {
        documents.push({ source: file.name, json: prettyJson(JSON.parse(content)) });
        continue;
      } catch {
        // A file that is neither a capture nor JSON still has something to say.
      }
    }
    outputs.push({ source: file.name, text: content.replace(/\s+$/, "") });
  }

  return {
    subject: input.subject,
    facts: input.facts.filter(({ value }) => value.trim().length > 0),
    validation: input.validation,
    captures,
    documents,
    outputs,
    screens: screens.filter((screen) => !claimed.has(located(screen).toLowerCase())),
  };
}

// ---------------------------------------------------------------- HTML (Azure)

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const FONT = "font-family:Segoe UI,Helvetica,Arial,sans-serif";
const BORDER = "1px solid #d0d7de";
const MUTED = "#57606a";

const heading = (text: string): string =>
  `<h3 style="${FONT};font-size:14px;margin:16px 0 6px 0;color:#1f2328">${escapeHtml(text)}</h3>`;

const block = (text: string): string =>
  `<pre style="background:#f6f8fa;border:${BORDER};border-radius:6px;padding:10px;margin:4px 0 10px 0;`
  + `white-space:pre-wrap;word-break:break-word;font-family:Consolas,Menlo,monospace;font-size:12px">`
  + `${escapeHtml(clamp(text))}</pre>`;

function table(columns: [string, string], rows: Array<[string, string]>): string {
  if (rows.length === 0) return "";
  const head = columns.map((column) =>
    `<th style="text-align:left;padding:6px 10px;border-bottom:${BORDER};color:${MUTED};font-size:12px">${escapeHtml(column)}</th>`
  ).join("");
  const body = rows.map(([left, right]) =>
    `<tr><td style="padding:6px 10px;border-bottom:${BORDER};font-family:Consolas,Menlo,monospace;font-size:12px;`
    + `white-space:nowrap;vertical-align:top">${escapeHtml(left)}</td>`
    + `<td style="padding:6px 10px;border-bottom:${BORDER};font-size:12px;word-break:break-word">${escapeHtml(clamp(right))}</td></tr>`
  ).join("");
  return `<table style="${FONT};border-collapse:collapse;width:100%;margin:4px 0 10px 0">`
    + `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

const headerRows = (headers: readonly HttpCaptureHeader[]): Array<[string, string]> =>
  headers.map(({ name, value }) => [name, value] as [string, string]);

/**
 * The caption names the file whether or not the image can be shown yet, and nothing else changes.
 *
 * Publication uploads the attachments and only then writes the field, so the same delivery renders
 * this twice: once before its captures exist and once after. A "not attached yet" note would make
 * those two documents differ in their text, and the text is exactly what decides whether a rerun is
 * looking at its own evidence or at somebody else's — a caption that reads the same either way is
 * what keeps a rerun from reporting a conflict against itself.
 */
function image(file: EvidenceFile, caption: string): string {
  const label = `<div style="${FONT};font-size:12px;color:${MUTED};margin:6px 0 4px 0">${escapeHtml(caption)}</div>`;
  if (!file.imageUrl) return label;
  return label
    + `<img src="${escapeHtml(file.imageUrl)}" alt="${escapeHtml(file.name)}" `
    + `style="max-width:100%;border:${BORDER};border-radius:6px" />`;
}

const subheading = (text: string): string =>
  `<div style="${FONT};font-size:12px;font-weight:600;color:${MUTED};margin:8px 0 2px 0">${escapeHtml(text)}</div>`;

function captureHtml({ capture, screenshot, source }: CaptureSection): string {
  const { request, response } = capture;
  const color = statusColor(response.status);
  const header = `<div style="background:#f6f8fa;border-bottom:${BORDER};padding:8px 12px">`
    + `<div style="${FONT};font-size:13px;font-weight:600;color:#1f2328">${escapeHtml(capture.title)}</div>`
    + `<div style="font-family:Consolas,Menlo,monospace;font-size:12px;margin-top:4px;word-break:break-all">`
    + `<b>${escapeHtml(request.method)}</b> ${escapeHtml(request.url)} `
    + `→ <b style="color:${color}">${escapeHtml(statusLabel(response))}</b></div>`
    + `<div style="${FONT};font-size:11px;color:${MUTED};margin-top:4px">${escapeHtml(provenance(capture, source))}</div>`
    + `</div>`;
  const body = [
    table(["Cabecera de la petición", "Valor"], headerRows(request.headers)),
    request.body === undefined ? "" : subheading("Cuerpo de la petición") + block(renderBody(request.body)),
    table(["Cabecera de la respuesta", "Valor"], headerRows(response.headers)),
    response.body === undefined ? "" : subheading("Cuerpo de la respuesta") + block(renderBody(response.body)),
    screenshot ? image(screenshot, `Captura del navegador · ${screenshot.name}`) : "",
  ].join("");
  return `<div style="border:${BORDER};border-radius:6px;margin:10px 0;overflow:hidden">`
    + header + `<div style="padding:10px 12px">${body}</div></div>`;
}

/** The completion-evidence field's whole content, for one delivery. */
export function renderEvidenceHtml(input: EvidenceDocumentInput): string {
  const document = buildEvidenceDocument(input);
  const parts: string[] = [
    `<div style="${FONT};font-size:13px;color:#1f2328">`,
    `<h2 style="${FONT};font-size:16px;margin:0 0 8px 0">Evidencia de completitud — ${escapeHtml(document.subject)}</h2>`,
  ];
  if (document.facts.length > 0) {
    parts.push(table(["Dato", "Valor"], document.facts.map(({ label, value }) => [label, value] as [string, string])));
  }
  if (document.validation.length > 0) {
    parts.push(heading("Validaciones ejecutadas"));
    parts.push(table(["Comando", "Resultado"], document.validation.map(({ command, result }) => [command, result] as [string, string])));
  }
  if (document.captures.length > 0) {
    parts.push(heading("Capturas HTTP"));
    parts.push(...document.captures.map(captureHtml));
  }
  for (const { source, json } of document.documents) {
    parts.push(heading(`JSON · ${source}`));
    parts.push(block(json));
  }
  for (const { source, text } of document.outputs) {
    parts.push(heading(`Salida · ${source}`));
    parts.push(block(text));
  }
  if (document.screens.length > 0) {
    parts.push(heading("Capturas de pantalla"));
    parts.push(...document.screens.map((screen) => image(screen, screen.name)));
  }
  parts.push("</div>");
  return parts.filter(Boolean).join("\n");
}

// ------------------------------------------------------------ Markdown (GitHub)

/** A cell cannot close the row it lives in. */
const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();

/** A fence long enough that nothing inside the block can end it early. */
function fence(content: string, language = ""): string {
  const longest = [...content.matchAll(/`{3,}/g)].reduce((max, [run]) => Math.max(max, run.length), 0);
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${language}\n${clamp(content)}\n${ticks}`;
}

function markdownTable(columns: [string, string], rows: Array<[string, string]>): string[] {
  if (rows.length === 0) return [];
  return [
    `| ${columns[0]} | ${columns[1]} |`,
    "| --- | --- |",
    ...rows.map(([left, right]) => `| ${cell(left)} | ${cell(right)} |`),
    "",
  ];
}

const markdownImage = (file: EvidenceFile, caption: string): string[] =>
  file.imageUrl
    ? [`**${caption}**`, "", `![${file.name}](${file.imageUrl})`, ""]
    : [`**${caption}**`, ""];

function captureMarkdown({ capture, screenshot, source }: CaptureSection): string[] {
  const { request, response } = capture;
  const lines: string[] = [
    `#### ${capture.title}`,
    "",
    `\`${request.method}\` **${endpointPath(request.url)}** → **${statusLabel(response)}**`,
    "",
    `<sub>${request.url} · ${provenance(capture, source)}</sub>`,
    "",
    ...markdownTable(["Cabecera de la petición", "Valor"], headerRows(request.headers)),
  ];
  if (request.body !== undefined) {
    lines.push("**Cuerpo de la petición**", "", fence(renderBody(request.body), "json"), "");
  }
  lines.push(...markdownTable(["Cabecera de la respuesta", "Valor"], headerRows(response.headers)));
  if (response.body !== undefined) {
    lines.push("**Cuerpo de la respuesta**", "", fence(renderBody(response.body), "json"), "");
  }
  if (screenshot) lines.push(...markdownImage(screenshot, `Captura del navegador · ${screenshot.name}`));
  return lines;
}

/** The same document as GitHub Markdown, for an issue comment or a pull-request body. */
export function renderEvidenceMarkdown(input: EvidenceDocumentInput): string {
  const document = buildEvidenceDocument(input);
  const lines: string[] = [`## Evidencia de entrega — ${document.subject}`, ""];
  lines.push(...markdownTable(["Dato", "Valor"], document.facts.map(({ label, value }) => [label, value] as [string, string])));
  if (document.validation.length > 0) {
    lines.push("### Validaciones ejecutadas", "");
    lines.push(...markdownTable(["Comando", "Resultado"], document.validation.map(({ command, result }) => [command, result] as [string, string])));
  }
  if (document.captures.length > 0) {
    lines.push("### Capturas HTTP", "");
    for (const section of document.captures) lines.push(...captureMarkdown(section));
  }
  for (const { source, json } of document.documents) {
    lines.push(`### JSON · \`${source}\``, "", fence(json, "json"), "");
  }
  for (const { source, text } of document.outputs) {
    lines.push(`### Salida · \`${source}\``, "", fence(text), "");
  }
  if (document.screens.length > 0) {
    lines.push("### Capturas de pantalla", "");
    for (const screen of document.screens) lines.push(...markdownImage(screen, screen.name));
  }
  // Collapsing blank runs over the joined text would rewrite the inside of a fenced block, and a
  // command output that no longer matches its own digest is not the evidence the manifest pinned.
  // Every block is one entry here, so the runs to collapse are the empty entries between them.
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n").trim();
}
