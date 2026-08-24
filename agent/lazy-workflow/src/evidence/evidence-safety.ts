/**
 * What evidence may not carry, wherever it is published.
 *
 * This gate used to belong to the Azure ticket, because the Azure ticket was the only place
 * evidence content ever reached. It is not any more: a GitHub delivery now renders the same files
 * into a pull-request body and into the comment that closes an issue, and a repository is a more
 * public place than a work item. A rule that protects one surface and not the other protects
 * neither, so it lives here and both call it.
 */

/**
 * Evidence for an authenticated endpoint has to name the header it sent, and naming a header is
 * not leaking it. Judging the key alone rejected every value a careful session could write --
 * `"authorization": "[REDACTED - Bearer ADMIN_API_TOKEN]"` included -- which left authenticated
 * HTTP evidence impossible to pass at all, stranding a delivery whose pull request had already
 * merged at its last gate. So the value decides, and placeholders are neutralized before anything
 * is read: whatever a session wrapped in brackets it withheld on purpose, and the scheme arm must
 * not mistake the withheld name for the secret itself.
 */
const PLACEHOLDER = /\[[^\]\n]*\]|<[^>\n]*>/g;
const SECRET_ASSIGNMENT = /["']?(?:authorization|access[_-]?token|token|api[_-]?key|apikey|secret|password|passwd|cookie|set-cookie|pat|AZURE_DEVOPS_EXT_PAT)["']?\s*[:=]\s*("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s,;}\]]+)/gi;
const SECRET_FLAG = /--(?:token|api-key|password)[\s=]+(\S+)/gi;
const SECRET_SCHEME = /\b(?:bearer|basic)\s+(\S+)/gi;

const MASKED = /^(?:\[[^\]]*\]|<[^>]*>|[*x•]{3,}|redacted|omitted|none|null|undefined|true|false|\d+)$/i;
/** `ADMIN_API_TOKEN` names the variable that holds the secret; it is not the secret. */
const ENVIRONMENT_REFERENCE = /^[A-Z][A-Z0-9_]*$/;
const MIN_CREDENTIAL_LENGTH = 8;

/** Whether `value`, read off the right of a secret-shaped key, is a live credential. */
function looksLikeCredential(value: string): boolean {
  let candidate = value.trim().replace(/^["']|["']$/g, "").trim();
  // `Bearer <token>` carries a space the prose test below would forgive, so the scheme is peeled
  // off and the token behind it judged on its own.
  const scheme = /^(?:bearer|basic)\s+/i.exec(candidate);
  if (scheme) candidate = candidate.slice(scheme[0].length).trim();
  if (!candidate || MASKED.test(candidate)) return false;
  // Whitespace means the session described the field instead of quoting its value.
  if (/\s/.test(candidate)) return false;
  if (ENVIRONMENT_REFERENCE.test(candidate)) return false;
  return candidate.length >= MIN_CREDENTIAL_LENGTH;
}

function containsCredential(content: string): boolean {
  const probe = content.replace(PLACEHOLDER, "[REDACTED]");
  return [SECRET_ASSIGNMENT, SECRET_FLAG, SECRET_SCHEME].some((pattern) =>
    [...probe.matchAll(pattern)].some((match) => looksLikeCredential(match[1] ?? ""))
  );
}

export function assertEvidenceIsPublishable(content: string): void {
  if (containsCredential(content)) {
    throw new Error("La evidencia contiene credenciales o secretos");
  }
  if (/<script\b|javascript\s*:|\bon[a-z]+\s*=/i.test(content)) {
    throw new Error("La evidencia contiene contenido ejecutable no permitido");
  }
}
