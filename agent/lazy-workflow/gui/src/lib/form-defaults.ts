/**
 * The values a command's form opens with: the active repository in every
 * repository field, then the operator's `flagDefaults`, then that command's
 * own `commandDefaults`. A flag left empty is not sent, so the CLI applies its
 * own default — the one the catalog shows as the field's placeholder.
 */

import type { CatalogCommand, CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import type { FlagDefault, GuiSettings } from "./backend.ts";
import { applicableFlags, type FlagValue, type FlagValues } from "./command-line.ts";

function asFlagValue(value: FlagDefault | undefined, repeatable: boolean): FlagValue {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return repeatable ? value.map(String) : value.join(",");
  if (typeof value === "boolean") return value;
  return repeatable ? [String(value)] : String(value);
}

export function initialValues(
  catalog: CommandCatalog,
  command: CatalogCommand,
  settings: Pick<GuiSettings, "activeRepository" | "flagDefaults" | "commandDefaults">,
): FlagValues {
  const values: FlagValues = {};
  const own = settings.commandDefaults[command.name] ?? {};
  for (const flag of applicableFlags(catalog, command)) {
    if ((flag.kind === "directory" || flag.kind === "directories") && flag.flag === "--working-directory" && settings.activeRepository) {
      values[flag.flag] = settings.activeRepository;
    }
    const configured = own[flag.flag] ?? settings.flagDefaults[flag.flag];
    const value = asFlagValue(configured, flag.repeatable === true);
    if (value !== undefined) values[flag.flag] = value;
  }
  return values;
}
