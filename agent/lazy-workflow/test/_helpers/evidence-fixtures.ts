/**
 * The evidence a delivery produces, as fixtures.
 *
 * Evidence is now a shape rather than free text — an `http-json` file is a browser capture with its
 * endpoint, headers, body and response, and it names the screenshot it was taken from — so the same
 * pair is needed by every test that writes, validates or publishes a manifest. Keeping one copy
 * here is what stops each of them from inventing a capture that drifts from the contract.
 */

export const SCREENSHOT_NAME = "pantalla.png";

/** A real PNG signature: `screen` evidence is judged by its magic bytes, not by its extension. */
export const SCREENSHOT_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

export const HTTP_CAPTURE = {
  title: "Reconciliación de un intento de pago",
  screenshot: SCREENSHOT_NAME,
  capturedWith: "chrome-devtools-mcp",
  request: {
    method: "POST",
    url: "https://api.test/payment-attempts/42/reconcile",
    headers: { "content-type": "application/json", "x-api-key": "[REDACTED - ADMIN_API_TOKEN]" },
    body: { reason: "manual" },
  },
  response: {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: { reconciled: true, attempt: 42 },
  },
};

/** The file as it must reach disk: pretty-printed with the indentation the delivery requires. */
export const HTTP_CAPTURE_BODY = `${JSON.stringify(HTTP_CAPTURE, null, 2)}\n`;
