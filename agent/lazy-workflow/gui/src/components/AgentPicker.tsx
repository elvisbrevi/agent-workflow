import { useState } from "react";
import type { CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import { cliLabel, cliOf, defaultModelOf, effortChoices, freeEffort, installedClis, modelGroups, providerLabel, type AgentModels } from "../lib/models.ts";

export interface AgentChoice {
  /** Empty means the default: the catalog's CLI, that CLI's model, `--variant`'s default. */
  readonly cli: string;
  readonly model: string;
  readonly variant: string;
}

interface AgentPickerProps {
  readonly catalog: CommandCatalog;
  readonly models: readonly AgentModels[] | null;
  readonly value: AgentChoice;
  readonly onChange: (value: AgentChoice) => void;
  /** Prefix for element ids, so two pickers on one page stay distinct. */
  readonly id?: string;
}

const CUSTOM = "\u0000custom";

export const defaultVariant = (catalog: CommandCatalog): string =>
  String(catalog.groups.find((group) => group.id === "agent")?.flags.find((flag) => flag.flag === "--variant")?.default ?? "high");

export function AgentPicker({ catalog, models, value, onChange, id = "agent" }: AgentPickerProps) {
  const [customModel, setCustomModel] = useState(false);
  const [customEffort, setCustomEffort] = useState(false);
  const cli = cliOf(catalog, value.cli);
  const installed = installedClis(catalog, models);
  const defaultModel = defaultModelOf(catalog, models, cli);
  const groups = modelGroups(catalog, models, cli, value.model);
  const model = value.model || defaultModel;
  const efforts = effortChoices(catalog, models, cli, model);
  const fallbackEffort = defaultVariant(catalog);
  const free = freeEffort(catalog, cli);
  const knownModel = !value.model || groups.some((group) => group.models.some((entry) => entry.id === value.model));
  const knownEffort = !value.variant || efforts.includes(value.variant);
  const listing = models === null;

  const pickModel = (next: string) => {
    const nextEfforts = effortChoices(catalog, models, cli, next || defaultModel);
    const preferred = models?.find((entry) => entry.cli === cli)?.models.find((entry) => entry.id === (next || defaultModel))?.defaultEffort ?? null;
    // An effort the new model does not take would fail at the provider, not here.
    const variant = nextEfforts.includes(value.variant || fallbackEffort) ? value.variant : (preferred ?? nextEfforts.at(-1) ?? "");
    onChange({ ...value, model: next, variant });
  };

  return (
    <div className="agent-picker">
      <div className="field">
        <span className="field-label" id={`${id}-cli-label`}>Agente</span>
        <div className="segmented" role="radiogroup" aria-labelledby={`${id}-cli-label`}>
          {catalog.agents.map((agent) => {
            const available = installed.includes(agent.cli);
            return (
              <button key={agent.cli} type="button" role="radio" aria-checked={cli === agent.cli} disabled={!available} title={available ? undefined : "No está instalado"}
                className={cli === agent.cli ? "selected" : ""}
                onClick={() => { setCustomModel(false); setCustomEffort(false); onChange({ cli: agent.cli === catalog.defaultCli ? "" : agent.cli, model: "", variant: "" }); }}>
                {cliLabel(agent.cli)}
              </button>
            );
          })}
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-model`}>Modelo {listing && <span className="muted small">· cargando lista…</span>}</label>
        <select id={`${id}-model`} className="input" value={customModel || !knownModel ? CUSTOM : value.model} onChange={(event) => {
          if (event.target.value === CUSTOM) { setCustomModel(true); return; }
          setCustomModel(false);
          pickModel(event.target.value);
        }}>
          <option value="">Predeterminado · {defaultModel}</option>
          {groups.map((group) => (
            <optgroup key={group.provider || "otros"} label={providerLabel(group.provider) || cliLabel(cli)}>
              {group.models.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </optgroup>
          ))}
          <option value={CUSTOM}>{knownModel ? "Otro modelo…" : `Otro: ${value.model}`}</option>
        </select>
        {(customModel || !knownModel) && <input className="input mono" aria-label="Modelo personalizado" placeholder={cli === "opencode" ? "proveedor/modelo" : "id del modelo"} value={value.model} onChange={(event) => onChange({ ...value, model: event.target.value.trim() })} />}
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-variant`}>Esfuerzo</label>
        <select id={`${id}-variant`} className="input" value={customEffort || !knownEffort ? CUSTOM : value.variant} onChange={(event) => {
          if (event.target.value === CUSTOM) { setCustomEffort(true); return; }
          setCustomEffort(false);
          onChange({ ...value, variant: event.target.value });
        }}>
          <option value="">Predeterminado · {fallbackEffort}</option>
          {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
          {(free || !knownEffort) && <option value={CUSTOM}>{knownEffort ? "Otro…" : `Otro: ${value.variant}`}</option>}
        </select>
        {free && (customEffort || !knownEffort) && <input className="input mono" aria-label="Esfuerzo personalizado" value={value.variant} onChange={(event) => onChange({ ...value, variant: event.target.value.trim() })} />}
      </div>
    </div>
  );
}
