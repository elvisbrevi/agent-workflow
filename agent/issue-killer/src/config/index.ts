// Public surface for issue-killer V2 configuration.
//
// This barrel is the single import path for everything the supervisor
// and its adapters need from `config/`. Internal modules (CLI parser,
// control-scalar validator, model splitter, pure validator, filesystem
// loader) are kept private so callers depend only on the typed result.

export type { CliArgs, CliParseError, CliParseResult, SupportedFlag } from "./cli-args"
export { SUPPORTED_FLAGS, parseCliArgs, parsePositiveInteger } from "./cli-args"

export type { ControlScalarIssue, ControlScalarReason } from "./control-scalar"
export { CONTROL_SCALAR_REASONS, collectControlScalarIssues, validateScalarString } from "./control-scalar"

export type { ModelSplit, ModelSplitReason } from "./model-split"
export { MODEL_SPLIT_REASONS, splitModel } from "./model-split"

export type {
  ConfigValidation,
  ParsedConfig,
  ParsedProfileTable,
  ProfileOptions,
  ProfileValidation,
  ValidatedConfig,
} from "./validation"
export {
  KNOWN_OPTION_FIELDS,
  KNOWN_PROFILE_FIELDS,
  KNOWN_TOP_LEVEL_FIELDS,
  RESERVED_FORBIDDEN_FIELDS,
  toIssueKillerError,
  validateConfig,
  validateProfileTable,
} from "./validation"

export type {
  LoadedConfig,
  LoadConfigEnvironment,
  LoadConfigError,
  LoadConfigErrorCode,
  LoadConfigFilesystem,
  LoadConfigResult,
} from "./loader"
export {
  defaultConfigPath,
  expandHomePath,
  loadConfig,
  resolveConfigPath,
} from "./loader"
