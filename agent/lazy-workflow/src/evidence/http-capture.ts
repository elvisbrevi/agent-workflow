/**
 * The shape of an HTTP capture, as a contract.
 *
 * A backend delivery proves itself with the request it sent and the response it
 * got back, and for a long time that proof was whatever JSON a session felt like
 * writing: a `curl` transcript pasted into a file, a body without its endpoint,
 * an endpoint without its status. Prose evidence cannot be rendered — you cannot
 * put headers in one table and the body in another if nothing says which is
 * which — so the ticket ended up carrying a wall of unreadable text (issue:
 * evidencia en texto plano).
 *
 * This module is the single definition of what an `http-json` evidence file
 * holds. The tool that writes the completion manifest and the renderer that
 * publishes the evidence both parse through here, so "what a session may write"
 * and "what the ticket can display" cannot drift apart.
 *
 * A capture also names the browser screenshot it came from. The requirement is
 * not decoration: evidence for an endpoint is only trustworthy if a human can
 * see the exchange in the browser the run drove, so a capture without its
 * screenshot is refused while the session is still alive to take one.
 */

/** One header, kept as a pair so its declared order survives into the rendered table. */
export interface HttpCaptureHeader {
  name: string;
  value: string;
}

export interface HttpCapture {
  title: string;
  /** File name of the `screen` evidence showing this exchange in the browser. */
  screenshot: string;
  /** How the exchange was observed, shown as provenance when a session declares it. */
  capturedWith?: string;
  request: {
    method: string;
    url: string;
    headers: HttpCaptureHeader[];
    /** Absent when the request carried no body, which is not the same as an empty one. */
    body?: unknown;
  };
  response: {
    status: number;
    statusText?: string;
    headers: HttpCaptureHeader[];
    body?: unknown;
  };
}

const SCREENSHOT_NAME = /\.(?:png|jpe?g|webp)$/i;

export const HTTP_CAPTURE_REQUIRED = [
  "Una evidencia http-json debe ser una captura del navegador con",
  "title, screenshot, request.method, request.url y response.status",
].join(" ");

function fail(message: string): never {
  throw new Error(`${HTTP_CAPTURE_REQUIRED}: ${message}`);
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${field} debe ser un texto no vacío`);
  return (value as string).trim();
}

/** Headers as the object map a browser devtools panel copies out, kept in declared order. */
function parseHeaders(value: unknown, field: string): HttpCaptureHeader[] {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) fail(`${field} debe ser un objeto de cabeceras`);
  return Object.entries(value as Record<string, unknown>).map(([name, headerValue]) => ({
    name,
    value: String(headerValue ?? ""),
  }));
}

function parseRequest(value: unknown): HttpCapture["request"] {
  if (typeof value !== "object" || value === null) fail("request debe ser un objeto");
  const request = value as { method?: unknown; url?: unknown; headers?: unknown; body?: unknown };
  const url = requireText(request.url, "request.url");
  if (!/^https?:\/\/\S+$/i.test(url)) fail("request.url debe ser una URL http o https completa");
  return {
    method: requireText(request.method, "request.method").toUpperCase(),
    url,
    headers: parseHeaders(request.headers, "request.headers"),
    ...("body" in request && request.body !== undefined ? { body: request.body } : {}),
  };
}

function parseResponse(value: unknown): HttpCapture["response"] {
  if (typeof value !== "object" || value === null) fail("response debe ser un objeto");
  const response = value as { status?: unknown; statusText?: unknown; headers?: unknown; body?: unknown };
  const status = response.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
    fail("response.status debe ser un código HTTP entre 100 y 599");
  }
  return {
    status,
    ...(response.statusText === undefined ? {} : { statusText: requireText(response.statusText, "response.statusText") }),
    headers: parseHeaders(response.headers, "response.headers"),
    ...("body" in response && response.body !== undefined ? { body: response.body } : {}),
  };
}

function parseCapture(value: unknown, index: number, total: number): HttpCapture {
  const at = total > 1 ? ` (captura ${index + 1})` : "";
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`cada captura debe ser un objeto${at}`);
  const capture = value as Record<string, unknown>;
  const screenshot = requireText(capture.screenshot, `screenshot${at}`);
  if (screenshot.includes("/") || screenshot.includes("\\")) {
    fail(`screenshot${at} debe nombrar el archivo de la captura, sin ruta`);
  }
  if (!SCREENSHOT_NAME.test(screenshot)) fail(`screenshot${at} debe ser un .png, .jpg o .webp`);
  return {
    title: requireText(capture.title, `title${at}`),
    screenshot,
    ...(capture.capturedWith === undefined ? {} : { capturedWith: requireText(capture.capturedWith, `capturedWith${at}`) }),
    request: parseRequest(capture.request),
    response: parseResponse(capture.response),
  };
}

/** The captures inside one parsed `http-json` document, in the order they were written. */
export function parseHttpCaptures(value: unknown): HttpCapture[] {
  const captures = (value as { captures?: unknown } | null)?.captures;
  const declared = Array.isArray(captures) ? captures : [value];
  if (declared.length === 0) fail("el archivo no declara ninguna captura");
  return declared.map((capture, index) => parseCapture(capture, index, declared.length));
}

/** The captures inside an `http-json` evidence file, or `null` when it is not one. */
export function readHttpCaptures(content: string): HttpCapture[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  try {
    return parseHttpCaptures(parsed);
  } catch {
    return null;
  }
}
