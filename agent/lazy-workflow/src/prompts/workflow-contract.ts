/**
 * The coordinator/OpenCode contract vocabulary.
 *
 * These are the only definitions of the terminal protocol markers and of the
 * completion-manifest shape. Prompt assets under `prompts/` reference them
 * through placeholders (see `renderContract`) instead of restating them, so a
 * change to the contract cannot leave a prompt behind. `workflow-prompt.test.ts`
 * fails if a prompt asset hardcodes one of these literals.
 */

export const TICKET_COMPLETED_MARKER = "TICKET_COMPLETED";
export const IMPLEMENTATION_READY_MARKER = "IMPLEMENTATION_READY";
export const QUEUE_EMPTY_MARKER = "QUEUE_EMPTY";
export const QUEUE_BLOCKED_MARKER = "QUEUE_BLOCKED";
export const WORKFLOW_STEP_FINISHED_MARKER = "WORKFLOW_STEP_FINISHED";
export const RECONCILIATION_REQUIRED_MARKER = "RECONCILIATION_REQUIRED";
export const ARCHITECTURE_REVIEW_RESULT_MARKER = "ARCHITECTURE_REVIEW_RESULT";

// Coordinator/manifest contract: validators require `validation` to be an array of
// {command, result} objects (github-delivery-service.ts, ticket-info-service.ts).
export const MANIFEST_VALIDATION_SHAPE =
  'The manifest "validation" field must be a non-empty JSON array of objects, each exactly {"command": "<command you ran>", "result": "<its successful outcome>"} — never plain strings.';

/** Every placeholder a prompt asset may use, and the text it resolves to. */
const CONTRACT_VALUES: Record<string, string> = {
  TICKET_COMPLETED: TICKET_COMPLETED_MARKER,
  IMPLEMENTATION_READY: IMPLEMENTATION_READY_MARKER,
  QUEUE_EMPTY: QUEUE_EMPTY_MARKER,
  QUEUE_BLOCKED: QUEUE_BLOCKED_MARKER,
  WORKFLOW_STEP_FINISHED: WORKFLOW_STEP_FINISHED_MARKER,
  RECONCILIATION_REQUIRED: RECONCILIATION_REQUIRED_MARKER,
  ARCHITECTURE_REVIEW_RESULT: ARCHITECTURE_REVIEW_RESULT_MARKER,
  MANIFEST_VALIDATION_SHAPE,
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
