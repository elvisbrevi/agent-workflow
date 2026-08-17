/**
 * The completion manifest an Azure delivery leaves behind, as a shape.
 *
 * Everything here is pure: no `az`, no `git`, no session. It exists so the
 * validator the coordinator runs and the tool that writes the file are the same
 * code. A session used to hand-write this JSON from prose, and a hand-written
 * manifest drifts — a ticket as a string, `currentCommit` instead of `commit`,
 * an evidence kind that was never in the enum — and the delivery stops cold with
 * the expensive part already spent (issue: manifest hand-authoring).
 *
 * `AzureTicketInfoService` reads and writes files through this module and
 * re-exports its vocabulary, so nothing importing the service has to move.
 */

export const EVIDENCE_KINDS = ["http-json", "screen", "command-output"] as const;

export type EvidenceKind = typeof EVIDENCE_KINDS[number];

export interface CompletionManifestEvidence {
  path: string;
  kind: EvidenceKind;
  sha256: string;
}

export interface CompletionManifest {
  ticket: number;
  ticketBranch: string;
  commit: string;
  validation: Array<{ command: string; result: string }>;
  evidence: CompletionManifestEvidence[];
}

/**
 * What a caller declares, and only that: the digests are computed from the files
 * and an omitted commit is read from the repository, so neither can be misstated.
 */
export interface CompletionManifestInput {
  ticket: number;
  ticketBranch: string;
  /** Omitted means HEAD, which is what the writer resolves. */
  commit?: string;
  validation: Array<{ command: string; result: string }>;
  evidence: Array<{ path: string; kind: EvidenceKind }>;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const isEvidenceKind = (value: string): value is EvidenceKind =>
  EVIDENCE_KINDS.includes(value as EvidenceKind);

/**
 * The manifest shape, checked once. Both the file the coordinator reads and the
 * object the writing tool assembles pass through here, so "what the tool
 * accepts" cannot drift from "what the validator requires".
 */
export function parseCompletionManifest(value: unknown): CompletionManifest {
  if (typeof value !== "object" || value === null) throw new Error("El manifest de completion debe ser un objeto");
  const manifest = value as Partial<CompletionManifest>;
  const manifestTicket = manifest.ticket;
  if (
    typeof manifestTicket !== "number" || !Number.isInteger(manifestTicket) || manifestTicket <= 0
    || typeof manifest.ticketBranch !== "string" || !manifest.ticketBranch.trim()
    || typeof manifest.commit !== "string" || !/^[0-9a-f]{40,64}$/i.test(manifest.commit)
    || !Array.isArray(manifest.validation) || manifest.validation.length === 0
    || !Array.isArray(manifest.evidence)
  ) throw new Error("El manifest de completion carece de campos requeridos");
  if (manifest.validation.some((entry) =>
    typeof entry !== "object" || entry === null
    || typeof entry.command !== "string" || !entry.command.trim()
    || typeof entry.result !== "string" || !entry.result.trim()
  )) throw new Error("Las validaciones del manifest de completion son inválidas");
  if (manifest.evidence.some((entry) =>
    typeof entry !== "object" || entry === null
    || typeof entry.path !== "string" || !entry.path.trim()
    || typeof entry.kind !== "string" || !isEvidenceKind(entry.kind)
    || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(entry.sha256)
  )) throw new Error("La evidencia del manifest de completion es inválida");
  return manifest as CompletionManifest;
}

/**
 * The manifest for `input`, with every evidence digest read off the file itself.
 * A digest a session declares is a digest a session can get wrong; this one is
 * the file's own, so the coordinator's later comparison can only fail if the
 * file changed after the manifest was written.
 */
export async function buildCompletionManifest(
  input: CompletionManifestInput & { commit: string },
): Promise<CompletionManifest> {
  const evidence: CompletionManifestEvidence[] = [];
  for (const entry of input.evidence) {
    const file = Bun.file(entry.path);
    if (!await file.exists()) throw new Error(`El archivo de evidencia no existe: ${entry.path}`);
    evidence.push({
      path: entry.path,
      kind: entry.kind,
      sha256: await sha256(new Uint8Array(await file.arrayBuffer())),
    });
  }
  return parseCompletionManifest({
    ticket: input.ticket,
    ticketBranch: input.ticketBranch,
    commit: input.commit,
    validation: input.validation,
    evidence,
  });
}
