/**
 * The shape of the document `lz catalog` prints, with no imports: the desktop
 * GUI type-checks against this file without pulling in the CLI's runtime
 * modules. `command-catalog.ts` builds the document; this file is the contract.
 */

/** Bumped whenever a consumer would misread the document, never for an added command or flag. */
export const COMMAND_CATALOG_SCHEMA_VERSION = 1;

/**
 * The value a flag expects, as a form renders it: `directories` is the
 * comma-separated workspace list, `commit` a full object name, and `secret` a
 * value that never belongs on screen or in a shell history.
 */
export type CatalogValueKind =
  | "boolean"
  | "integer"
  | "number"
  | "string"
  | "text"
  | "choice"
  | "file"
  | "directory"
  | "directories"
  | "commit"
  | "secret";

export interface CatalogFlag {
  /** The flag exactly as typed, `--hu`. */
  readonly flag: string;
  readonly kind: CatalogValueKind;
  readonly label: string;
  readonly description: string;
  readonly required?: boolean;
  readonly default?: string | number | boolean;
  readonly choices?: readonly string[];
  /** Declared once per value, in order (`--fallback`, `--field`). */
  readonly repeatable?: boolean;
  /** The flag is meaningful bare as well as with a value (`--off`). */
  readonly valueOptional?: boolean;
  /** Flags, or `--flag=value`, that must be present for this one to apply. */
  readonly requires?: readonly string[];
  /** Flags this one cannot be combined with. */
  readonly conflicts?: readonly string[];
  readonly placeholder?: string;
  /** Flags the installer accepts rather than the parser: only `update` forwards them. */
  readonly forwarded?: boolean;
}

export type CatalogFamilyId =
  | "workflow"
  | "azure-read"
  | "azure-write"
  | "github-queue"
  | "github-delivery"
  | "git"
  | "pull-request"
  | "credentials"
  | "maintenance";

/**
 * What running the command changes: `session` opens a coding-agent session,
 * `write` mutates a tracker, a repository or the secrets files, `read` only
 * answers, and `maintenance` reinstalls the tool itself.
 */
export type CatalogEffect = "read" | "write" | "session" | "maintenance";

/** What stdout carries: one JSON document, one name per line, a raw value, or a run's stream. */
export type CatalogOutput = "json" | "lines" | "value" | "stream";

export type CatalogFlagGroupId = "agent" | "interview" | "reporter" | "shutdown";

export interface CatalogCommand {
  readonly name: string;
  readonly family: CatalogFamilyId;
  readonly summary: string;
  readonly effect: CatalogEffect;
  readonly output: CatalogOutput;
  readonly flags: readonly CatalogFlag[];
  /** Shared flag groups the command also accepts, in display order. */
  readonly groups: readonly CatalogFlagGroupId[];
  readonly notes?: readonly string[];
  /** The flag whose value is read from stdin instead of the command line. */
  readonly stdinFlag?: string;
}

export interface CatalogFamily {
  readonly id: CatalogFamilyId;
  readonly title: string;
  readonly description: string;
}

export interface CatalogFlagGroup {
  readonly id: CatalogFlagGroupId;
  readonly title: string;
  readonly flags: readonly CatalogFlag[];
}

export interface CatalogAgent {
  /** An `--cli` value: `opencode`, `claudecode` or `codex`. */
  readonly cli: string;
  readonly binary: string;
  readonly defaultModel: string;
  /** `null` leaves `--variant` free-form, as OpenCode's is. */
  readonly efforts: readonly string[] | null;
}

export interface CatalogEnvironmentVariable {
  readonly name: string;
  readonly description: string;
  readonly secret: boolean;
}

export interface CommandCatalog {
  readonly schemaVersion: number;
  readonly binary: "lz";
  readonly defaultCli: string;
  readonly agents: readonly CatalogAgent[];
  readonly environment: readonly CatalogEnvironmentVariable[];
  readonly families: readonly CatalogFamily[];
  readonly groups: readonly CatalogFlagGroup[];
  readonly commands: readonly CatalogCommand[];
}
