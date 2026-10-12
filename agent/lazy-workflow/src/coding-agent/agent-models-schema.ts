/**
 * The shape of the document `lz agent-models` prints, with no imports, so the
 * desktop GUI type-checks against it without pulling in the CLI's runtime — the
 * same split as `command-catalog-schema.ts`.
 */

export interface AgentModel {
  /** The value `--model` takes. */
  readonly id: string;
  /** What a person reads; the id when the CLI names nothing better. */
  readonly name: string;
  /** The provider an OpenCode model is routed through; the CLI's own vendor otherwise. */
  readonly provider: string;
  /** The `--variant` values this model accepts that lz also accepts; null leaves the CLI's own set. */
  readonly efforts: readonly string[] | null;
  readonly defaultEffort: string | null;
}

export interface AgentModels {
  /** An `--cli` value. */
  readonly cli: string;
  readonly installed: boolean;
  /** The model a run uses when `--model` is not declared. */
  readonly defaultModel: string;
  readonly models: readonly AgentModel[];
  /** Why the list could not be read; the default model is still usable. */
  readonly error: string | null;
}
