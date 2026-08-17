/**
 * The coordinator/OpenCode contract vocabulary.
 *
 * These are the only definitions of the terminal protocol markers and of the
 * completion-manifest shape. Prompt assets under `prompts/` reference them
 * through placeholders (see `renderContract`) instead of restating them, so a
 * change to the contract cannot leave a prompt behind. `workflow-prompt.test.ts`
 * fails if a prompt asset hardcodes one of these literals.
 */

import { AZURE_TOOL_COMMANDS, GITHUB_TOOL_COMMANDS } from "../cli/tool-commands.ts";

export const TICKET_COMPLETED_MARKER = "TICKET_COMPLETED";
export const IMPLEMENTATION_READY_MARKER = "IMPLEMENTATION_READY";
export const QUEUE_EMPTY_MARKER = "QUEUE_EMPTY";
export const QUEUE_BLOCKED_MARKER = "QUEUE_BLOCKED";
export const WORKFLOW_STEP_FINISHED_MARKER = "WORKFLOW_STEP_FINISHED";
export const RECONCILIATION_REQUIRED_MARKER = "RECONCILIATION_REQUIRED";
export const ARCHITECTURE_REVIEW_RESULT_MARKER = "ARCHITECTURE_REVIEW_RESULT";
export const PLAN_READY_MARKER = "PLAN_READY";
/** A planning session pauses here and hands its open decisions to the coordinator. */
export const QUESTIONS_PENDING_MARKER = "QUESTIONS_PENDING";
/** The coordinator hands the operator's answers back when it resumes that session. */
export const QUESTIONS_ANSWERED_MARKER = "QUESTIONS_ANSWERED";

/**
 * What the coordinator says when it resumes a session it still expects a terminal marker from.
 *
 * A bare "continue" invites a resumed session that already finished its work to answer
 * conversationally — asking the coordinator what else it should do — and a conversational answer
 * carries no marker, so the run fails and the next attempt resumes into the same dead end. The
 * marker is only recognised alone on its own line (`containsMarker`), so the instruction has to say
 * exactly that.
 */
export const markerResumePrompt = (marker: string): string => [
  "Continúa donde quedaste.",
  `Si el trabajo ya está completo, no preguntes nada y no repitas el trabajo: vuelve a emitir ${marker} como única línea de tu respuesta final.`,
  `Si queda trabajo por hacer, termínalo y cierra con ${marker} en su propia línea.`,
].join(" ");

/**
 * The manifest is written by a tool, never by the session.
 *
 * A prompt that described the JSON shape is what produced manifests with the
 * ticket as a string, `currentCommit` instead of `commit`, and evidence kinds
 * that were never in the enum: a description invites reproduction, and a
 * reproduction drifts. So the prompts name the command instead of the shape, and
 * the command names come from `tool-commands.ts` — the annotations below fail to
 * compile if either tool is renamed, and `CONTRACT_LITERALS` makes a prompt asset
 * that spells one out by hand fail its test.
 */
export const AZURE_MANIFEST_COMMAND: typeof AZURE_TOOL_COMMANDS[number] = "ticket-manifest-set";
export const GITHUB_MANIFEST_COMMAND: typeof GITHUB_TOOL_COMMANDS[number] = "github-manifest-set";

const VALIDATION_FLAGS =
  'one --validation "<command you ran>" with its --validation-result "<the outcome>" per validation, paired in the order you pass them';

export const AZURE_MANIFEST_TOOL_INSTRUCTION = [
  `Create the completion manifest only by running \`lazy-workflow ${AZURE_MANIFEST_COMMAND}\`; never write, edit, or repair that JSON file yourself.`,
  `It takes --ticket, --branch, --manifest, ${VALIDATION_FLAGS}, and one --evidence <kind>:<path> per evidence file, where <kind> is exactly http-json, screen, or command-output.`,
  "It resolves the commit from HEAD and computes every SHA-256 digest itself, and it refuses to write a manifest the coordinator would reject.",
  "If it fails, fix exactly what its message names and run it again.",
].join(" ");

export const GITHUB_MANIFEST_TOOL_INSTRUCTION = [
  `Create the manifest only by running \`lazy-workflow ${GITHUB_MANIFEST_COMMAND}\`; never write, edit, or repair that JSON file yourself.`,
  `It takes --issue, --branch, --manifest, --summary, ${VALIDATION_FLAGS}, and one --evidence <path> per in-repository evidence file.`,
  "It resolves the commit from HEAD, verifies the worktree is clean, and computes every SHA-256 digest itself.",
  "If it fails, fix exactly what its message names and run it again.",
].join(" ");

/** The exact invocation for one coordinator-fixed unit, with its identities already filled in. */
export function azureManifestCommandLine(fixed: {
  ticket: number | null;
  ticketBranch: string | null;
  manifestPath: string | null;
  workingDirectory: string;
}): string | null {
  if (fixed.ticket === null || !fixed.ticketBranch || !fixed.manifestPath) return null;
  return `lazy-workflow ${AZURE_MANIFEST_COMMAND} --ticket ${fixed.ticket} --branch ${fixed.ticketBranch}`
    + ` --manifest ${fixed.manifestPath} --working-directory ${fixed.workingDirectory}`
    + ` --validation "<command>" --validation-result "<outcome>" --evidence <kind>:<path>`;
}

export function githubManifestCommandLine(fixed: {
  issue: number;
  branch: string;
  manifestPath: string;
  workingDirectory: string;
}): string {
  return `lazy-workflow ${GITHUB_MANIFEST_COMMAND} --issue ${fixed.issue} --branch ${fixed.branch}`
    + ` --manifest ${fixed.manifestPath} --working-directory ${fixed.workingDirectory}`
    + ` --summary "<what changed>" --validation "<command>" --validation-result "<outcome>"`;
}

/** Every placeholder a prompt asset may use, and the text it resolves to. */
const CONTRACT_VALUES: Record<string, string> = {
  TICKET_COMPLETED: TICKET_COMPLETED_MARKER,
  IMPLEMENTATION_READY: IMPLEMENTATION_READY_MARKER,
  QUEUE_EMPTY: QUEUE_EMPTY_MARKER,
  QUEUE_BLOCKED: QUEUE_BLOCKED_MARKER,
  WORKFLOW_STEP_FINISHED: WORKFLOW_STEP_FINISHED_MARKER,
  RECONCILIATION_REQUIRED: RECONCILIATION_REQUIRED_MARKER,
  ARCHITECTURE_REVIEW_RESULT: ARCHITECTURE_REVIEW_RESULT_MARKER,
  PLAN_READY: PLAN_READY_MARKER,
  QUESTIONS_PENDING: QUESTIONS_PENDING_MARKER,
  QUESTIONS_ANSWERED: QUESTIONS_ANSWERED_MARKER,
  AZURE_MANIFEST_COMMAND,
  GITHUB_MANIFEST_COMMAND,
  AZURE_MANIFEST_TOOL: AZURE_MANIFEST_TOOL_INSTRUCTION,
  GITHUB_MANIFEST_TOOL: GITHUB_MANIFEST_TOOL_INSTRUCTION,
};

/** Marker literals that must never appear hardcoded in a prompt asset. */
export const CONTRACT_LITERALS: readonly string[] = Object.values(CONTRACT_VALUES);

const PLACEHOLDER = /\{\{([A-Z_]+)\}\}/g;

export class UnknownContractPlaceholderError extends Error {
  constructor(readonly placeholder: string) {
    super(`El asset de prompt usa un placeholder desconocido: {{${placeholder}}}`);
    this.name = "UnknownContractPlaceholderError";
  }
}

/** Resolve every `{{PLACEHOLDER}}` in a prompt asset. Unknown names fail closed. */
export function renderContract(asset: string): string {
  return asset.replace(PLACEHOLDER, (_match, name: string) => {
    const value = CONTRACT_VALUES[name];
    if (value === undefined) throw new UnknownContractPlaceholderError(name);
    return value;
  });
}
