import { useState } from "react";
import type { CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import { DirectoryPicker } from "./DirectoryPicker.tsx";

export type View =
  | { kind: "home" }
  | { kind: "command"; name: string }
  | { kind: "history"; runId: string | null }
  | { kind: "settings" };

interface SidebarProps {
  readonly catalog: CommandCatalog | null;
  readonly view: View;
  readonly running: number;
  readonly repositories: readonly string[];
  readonly activeRepository: string | null;
  readonly onNavigate: (view: View) => void;
  readonly onSelectRepository: (repository: string) => void;
  readonly onAddRepository: (repository: string) => void;
}

export function Sidebar({ catalog, view, running, repositories, activeRepository, onNavigate, onSelectRepository, onAddRepository }: SidebarProps) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const needle = query.trim().toLowerCase();

  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="brand-mark">›lz</span>
        <span className="muted small">agent-workflow</span>
      </div>

      <select className="input repo-select" value={activeRepository ?? ""} onChange={(event) => onSelectRepository(event.target.value)} aria-label="Repositorio activo">
        {repositories.length > 0 && !activeRepository && <option value="">Elegir repositorio…</option>}
        {repositories.length === 0 && <option value="">Sin repositorios guardados</option>}
        {repositories.map((repository) => <option key={repository} value={repository}>{repository.split(/[\\/]/).filter(Boolean).at(-1) ?? repository}</option>)}
      </select>
      <DirectoryPicker repositories={repositories} onPick={onAddRepository} label="Buscar carpeta…" />

      <div className="main-navigation">
      <button type="button" aria-label="Inicio" className={`nav-item${view.kind === "home" ? " active" : ""}`} onClick={() => onNavigate({ kind: "home" })}><span className="mobile-nav-icon" aria-hidden="true">⌂</span><span>Inicio</span></button>

      {catalog?.commands.filter((command) => command.name === "plan" || command.name === "code").map((command) => <button key={command.name} type="button" aria-label={command.name === "plan" ? "Planificar" : "Implementar"} className={`nav-item${view.kind === "command" && view.name === command.name ? " active" : ""}`} onClick={() => onNavigate({ kind: "command", name: command.name })}><span className="mobile-nav-icon" aria-hidden="true">{command.name === "plan" ? "↗" : "⌘"}</span><span className="desktop-nav-label">{command.name === "plan" ? "Planificar" : "Implementar"}</span><span className="mobile-nav-label">{command.name === "plan" ? "Plan" : "Code"}</span></button>)}
      </div>

      <details className="tools-navigation">
      <summary>Herramientas avanzadas</summary>
      <input className="input search" aria-label="Buscar herramienta" placeholder="Buscar herramienta…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="nav-families">
        {catalog?.families.map((family) => {
          const commands = catalog.commands.filter((command) => command.family === family.id && !["gui", "plan", "code"].includes(command.name)
            && (needle === "" || command.name.includes(needle) || command.summary.toLowerCase().includes(needle)));
          if (commands.length === 0) return null;
          const closed = needle === "" && collapsed[family.id] === true;
          return (
            <div className="nav-family" key={family.id}>
              <button type="button" className="nav-family-title" title={family.description} onClick={() => setCollapsed({ ...collapsed, [family.id]: !closed })}>
                <span>{closed ? "▸" : "▾"} {family.title}</span>
                <span className="muted small">{commands.length}</span>
              </button>
              {!closed && commands.map((command) => (
                <button
                  type="button"
                  key={command.name}
                  className={`nav-item command effect-${command.effect}${view.kind === "command" && view.name === command.name ? " active" : ""}`}
                  title={command.summary}
                  onClick={() => onNavigate({ kind: "command", name: command.name })}
                >
                  {command.name}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      </details>

      <div className="nav-bottom">
        <button type="button" aria-label="Historial" className={`nav-item${view.kind === "history" ? " active" : ""}`} onClick={() => onNavigate({ kind: "history", runId: null })}>
          <span className="mobile-nav-icon" aria-hidden="true">↶</span><span>Historial</span> {running > 0 && <span className="pill running-count">{running} en curso</span>}
        </button>
        <button type="button" aria-label="Configuracion" className={`nav-item${view.kind === "settings" ? " active" : ""}`} onClick={() => onNavigate({ kind: "settings" })}><span className="mobile-nav-icon" aria-hidden="true">⚙</span><span className="desktop-nav-label">Configuracion</span><span className="mobile-nav-label">Ajustes</span></button>
      </div>
    </nav>
  );
}
