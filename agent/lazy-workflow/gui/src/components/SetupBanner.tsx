import { useState } from "react";
import { isDesktop } from "../lib/platform.ts";
import type { SetupProblem } from "../lib/setup-check.ts";

export interface SetupState {
  readonly problems: readonly SetupProblem[];
  /** An installed agent and an `lz setup` this window may run. */
  readonly canRepair: boolean;
  readonly repairing: boolean;
  readonly onRepair: () => void;
}

/** One line when everything is in order is noise: the banner exists only while something is missing. */
export function SetupBanner({ setup, expanded = false }: { setup: SetupState; expanded?: boolean }) {
  const [open, setOpen] = useState(expanded);
  const { problems, canRepair, repairing, onRepair } = setup;
  if (problems.length === 0) return null;
  const fixable = problems.some((problem) => problem.fixable);
  const single = problems.length === 1 ? problems[0]! : null;
  return (
    <section className="setup-banner" role="status" aria-label="Configuración pendiente">
      <div className="setup-summary">
        <span className="setup-icon" aria-hidden="true">!</span>
        <div className="setup-text">
          <strong>{single ? single.title : `Faltan ${problems.length} cosas por configurar`}</strong>
          {single && open && <span className="muted">{single.detail}</span>}
          {!single && !open && <span className="muted small">{problems.map((problem) => problem.title).join(" · ")}</span>}
        </div>
        <div className="setup-actions">
          <button type="button" className="link-button" onClick={() => setOpen(!open)}>{open ? "Ocultar" : "Ver detalle"}</button>
          {fixable && canRepair && <button type="button" className="button primary" disabled={repairing} onClick={onRepair}>{repairing ? "Reparando…" : "Reparar con agente"}</button>}
        </div>
      </div>
      {open && !single && (
        <ul className="setup-list">
          {problems.map((problem) => <li key={problem.id}><strong>{problem.title}</strong><span className="muted">{problem.detail}</span></li>)}
        </ul>
      )}
      {fixable && !canRepair && <p className="muted small">{isDesktop
        ? "La reparación automática necesita un agente de código instalado y un lz actualizado (lz update)."
        : "Este servidor no habilita la reparación automática: agrega setup a allowedCommands o configúralo en el servidor con lz setup."}</p>}
    </section>
  );
}
