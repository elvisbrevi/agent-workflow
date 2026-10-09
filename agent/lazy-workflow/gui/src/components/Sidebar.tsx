import { useState } from "react";
import type { CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";

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
}

export function Sidebar({ catalog, view, running, repositories, activeRepository, onNavigate, onSelectRepository }: SidebarProps) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const needle = query.trim().toLowerCase();

  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="brand-mark">›lz</span>
        <span className="muted small">agent-workflow</span>
      </div>

      <select className="input repo-select" value={activeRepository ?? ""} onChange={(event) => onSelectRepository(event.target.value)} title="Repositorio activo">
        {repositories.length === 0 && <option value="">Sin repositorios guardados</option>}
        {repositories.map((repository) => <option key={repository} value={repository}>{repository.split(/[\\/]/).filter(Boolean).at(-1) ?? repository}</option>)}
      </select>

      <button type="button" className={`nav-item${view.kind === "home" ? " active" : ""}`} onClick={() => onNavigate({ kind: "home" })}>Inicio</button>

      <input className="input search" placeholder="Buscar comando…" value={query} onChange={(event) => setQuery(event.target.value)} />

      <div className="nav-families">
        {catalog?.families.map((family) => {
          const commands = catalog.commands.filter((command) => command.family === family.id && command.name !== "gui"
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

      <div className="nav-bottom">
        <button type="button" className={`nav-item${view.kind === "history" ? " active" : ""}`} onClick={() => onNavigate({ kind: "history", runId: null })}>
          Historial {running > 0 && <span className="pill">{running} en curso</span>}
        </button>
        <button type="button" className={`nav-item${view.kind === "settings" ? " active" : ""}`} onClick={() => onNavigate({ kind: "settings" })}>Configuracion</button>
      </div>
    </nav>
  );
}
