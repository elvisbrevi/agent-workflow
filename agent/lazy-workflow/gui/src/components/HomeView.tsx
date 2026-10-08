import type { CommandCatalog } from "../../../src/cli/command-catalog-schema.ts";
import type { Diagnostics } from "../lib/backend.ts";
import { EffectBadge } from "./EffectBadge.tsx";

const QUICK_ACTIONS = ["plan", "code", "github-issue-list", "hu-info", "ticket-info", "pr-list", "git-branch-list", "credentials-audit"];

/** Tools a run shells out to, and the command families that need each one. */
const NEEDED_BY: Record<string, string> = {
  lz: "todo",
  bun: "lz",
  git: "entregas y ramas",
  gh: "GitHub",
  az: "Azure DevOps",
  opencode: "--cli opencode",
  claude: "--cli claudecode",
  codex: "--cli codex",
  chezmoi: "credenciales publicadas",
};

interface HomeViewProps {
  readonly catalog: CommandCatalog;
  readonly diagnostics: Diagnostics | null;
  readonly repositories: readonly string[];
  readonly activeRepository: string | null;
  readonly onOpenCommand: (name: string) => void;
  readonly onRefreshDiagnostics: () => void;
  readonly onOpenSettings: () => void;
}

export function HomeView({ catalog, diagnostics, repositories, activeRepository, onOpenCommand, onRefreshDiagnostics, onOpenSettings }: HomeViewProps) {
  const actions = QUICK_ACTIONS.map((name) => catalog.commands.find((command) => command.name === name)).filter((command) => command !== undefined);
  return (
    <div className="page">
      <header className="page-header">
        <h1>lz</h1>
        <p className="lead">
          Planifica y entrega un backlog de GitHub o una HU de Azure DevOps con OpenCode, Claude Code o Codex. Cada comando del CLI es un formulario;
          el comando exacto se muestra antes de ejecutarlo.
        </p>
      </header>

      {repositories.length === 0 && (
        <div className="callout">
          Agrega tus repositorios en <button type="button" className="link-button" onClick={onOpenSettings}>Configuracion</button> para elegirlos en cada formulario.
        </div>
      )}
      {activeRepository && <div className="muted small">Repositorio activo: <code className="mono">{activeRepository}</code></div>}

      <section className="quick-grid">
        {actions.map((command) => (
          <button type="button" key={command.name} className="quick-card" onClick={() => onOpenCommand(command.name)}>
            <div className="row baseline">
              <span className="mono strong grow">{command.name}</span>
              <EffectBadge effect={command.effect} />
            </div>
            <div className="small muted">{command.summary}</div>
          </button>
        ))}
      </section>

      <section className="card">
        <div className="row baseline">
          <h2 className="grow">Diagnostico</h2>
          <button type="button" className="button" onClick={onRefreshDiagnostics}>Actualizar</button>
        </div>
        {!diagnostics && <div className="muted">Comprobando…</div>}
        {diagnostics && (
          <div className="diagnostics">
            <div>
              <h3>Herramientas</h3>
              <ul className="checklist">
                {diagnostics.binaries.map((binary) => {
                  // `lz` is whatever `lzCommand` resolves to, which may be a checkout's main.ts rather than a binary on the PATH.
                  const path = binary.name === "lz" ? diagnostics.lzLauncher : binary.path;
                  const missing = binary.name === "lz" ? (diagnostics.lzError ?? "no encontrado") : `no encontrado · ${NEEDED_BY[binary.name] ?? ""}`;
                  return (
                    <li key={binary.name} className={path ? "ok" : "missing"}>
                      <span className="check">{path ? "✓" : "✕"}</span>
                      <span className="mono">{binary.name}</span>
                      <span className="muted small grow ellipsis" title={path ?? missing}>{path ?? missing}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div>
              <h3>Variables</h3>
              <ul className="checklist">
                {diagnostics.variables.map((variable) => (
                  <li key={variable.name} className={variable.present ? "ok" : "missing"}>
                    <span className="check">{variable.present ? "✓" : "–"}</span>
                    <span className="mono small">{variable.name}</span>
                    <span className="muted small grow ellipsis" title={variable.value ?? ""}>{variable.present ? (variable.value ?? variable.source) : "sin definir"}</span>
                  </li>
                ))}
              </ul>
              <div className="muted small">Run log: <code className="mono">{diagnostics.runLogPath}</code></div>
              <div className="muted small">Configuracion: <code className="mono">{diagnostics.settingsPath}</code></div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
