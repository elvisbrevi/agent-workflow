import type { ReactNode } from "react";
import { DirectoryPicker } from "./DirectoryPicker.tsx";
import { AccountControl } from "./WebAccess.tsx";
import { repositoryName } from "../lib/work.ts";

export type View =
  | { kind: "work" }
  /** `liveId` opens a run of this window; `runId` expands one of the run log. */
  | { kind: "activity"; runId: string | null; liveId: number | null }
  | { kind: "preferences" };

interface SidebarProps {
  readonly view: View;
  readonly running: number;
  /** Configuration problems waiting for the operator; shown on Ajustes. */
  readonly attention: number;
  readonly repositories: readonly string[];
  readonly activeRepository: string | null;
  readonly onNavigate: (view: View) => void;
  readonly onSelectRepository: (repository: string) => void;
  readonly onAddRepository: (repository: string) => Promise<void>;
}

export function Sidebar({ view, running, attention, repositories, activeRepository, onNavigate, onSelectRepository, onAddRepository }: SidebarProps) {
  const item = (target: View, icon: string, label: string, badge?: ReactNode) => (
    <button type="button" aria-label={label} aria-current={view.kind === target.kind ? "page" : undefined} className={`nav-item${view.kind === target.kind ? " active" : ""}`} onClick={() => onNavigate(target)}>
      <span className="nav-icon" aria-hidden="true">{icon}</span><span className="nav-label">{label}</span>{badge}
    </button>
  );
  return (
    <nav className="sidebar">
      <div className="brand"><span className="brand-mark">›lz</span></div>
      <div className="repo-picker">
        <select className="input repo-select" value={activeRepository ?? ""} onChange={(event) => onSelectRepository(event.target.value)} aria-label="Repositorio activo">
          {repositories.length > 0 && !activeRepository && <option value="">Elegir repositorio…</option>}
          {repositories.length === 0 && <option value="">Sin repositorios</option>}
          {repositories.map((repository) => <option key={repository} value={repository}>{repositoryName(repository)}</option>)}
        </select>
        <DirectoryPicker onPick={onAddRepository} label="Agregar repositorio…" />
      </div>
      <div className="nav-items">
        {item({ kind: "work" }, "☰", "Trabajo")}
        {item({ kind: "activity", runId: null, liveId: null }, "◷", "Ejecuciones", running > 0 ? <span className="pill running-count">{running}</span> : null)}
        {item({ kind: "preferences" }, "⚙", "Ajustes", attention > 0 ? <span className="pill attention-count" title="Configuración pendiente">{attention}</span> : null)}
      </div>
      <AccountControl className="sidebar-account" />
    </nav>
  );
}
