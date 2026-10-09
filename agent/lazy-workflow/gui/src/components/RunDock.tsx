import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl, isDesktop } from "../lib/platform.ts";
import { WebInterview } from "./WebInterview.tsx";
import { finalMarker, interviewUrl, parseStdout, runLogPointer } from "../lib/output.ts";
import { formatDuration } from "../lib/history.ts";
import { isFinished, type RunState, type RunStatus } from "../lib/runs.ts";
import { MASK } from "../lib/command-line.ts";
import { JsonView } from "./JsonView.tsx";

const STATUS: Record<RunStatus, { label: string; icon: string }> = {
  running: { label: "En curso", icon: "●" },
  cancelling: { label: "Interrumpiendo", icon: "◌" },
  success: { label: "Exito", icon: "✓" },
  failure: { label: "Fallo", icon: "✕" },
  interrupted: { label: "Interrumpido", icon: "■" },
  error: { label: "Error", icon: "!" },
};

interface RunDockProps {
  readonly runs: readonly RunState[];
  readonly activeId: number | null;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly onFocus: (id: number) => void;
  readonly onCancel: (id: number) => void;
  readonly onClose: (id: number) => void;
  readonly onRerun: (run: RunState) => void;
  readonly onOpenHistory: (runId: string) => void;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Follows the end of a log while the operator has not scrolled up. */
function AutoScroll({ lines, className }: { lines: readonly string[]; className: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const element = ref.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [lines]);
  return (
    <pre
      ref={ref}
      className={className}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
    >
      {lines.join("\n")}
    </pre>
  );
}

function Stdout({ run }: { run: RunState }) {
  const [raw, setRaw] = useState(false);
  const [reveal, setReveal] = useState(false);
  const parsed = useMemo(() => parseStdout(run.stdout), [run.stdout]);
  if (parsed.kind === "empty") {
    return <div className="empty-output muted">{isFinished(run) ? "Sin salida en stdout." : "Esperando salida…"}</div>;
  }
  if (run.output === "value") {
    const value = run.stdout.join("\n");
    return (
      <div className="secret-output">
        <code className="mono">{reveal ? value : MASK}</code>
        <button type="button" className="button" onClick={() => setReveal(!reveal)}>{reveal ? "Ocultar" : "Mostrar"}</button>
        <button type="button" className="button" onClick={() => navigator.clipboard.writeText(value)}>Copiar</button>
      </div>
    );
  }
  return (
    <div className="stdout">
      {parsed.kind === "json" && (
        <div className="row end tiny-bar">
          <button type="button" className="link-button" onClick={() => setRaw(!raw)}>{raw ? "Ver arbol" : "Ver JSON"}</button>
          <button type="button" className="link-button" onClick={() => navigator.clipboard.writeText(run.stdout.join("\n"))}>Copiar</button>
        </div>
      )}
      {parsed.kind === "json" && !raw ? <JsonView value={parsed.value} /> : <AutoScroll lines={run.stdout} className="log mono" />}
    </div>
  );
}

function InterviewBanner({ url }: { url: string }) {
  const [embedded, setEmbedded] = useState(false);
  return (
    <div className="interview">
      <div className="row">
        <strong className="grow">La planificacion espera tus respuestas.</strong>
        {isDesktop && <button type="button" className="button primary" onClick={() => openUrl(url)}>Abrir en el navegador</button>}
        <button type="button" className="button" onClick={() => setEmbedded(!embedded)}>{embedded ? "Ocultar" : "Responder aqui"}</button>
      </div>
      {embedded && (isDesktop ? <iframe className="interview-frame" src={url} title="Entrevista de planificacion" /> : <WebInterview path={url} />)}
    </div>
  );
}

function RunDetail({ run, onCancel, onRerun, onOpenHistory }: { run: RunState; onCancel: () => void; onRerun: () => void; onOpenHistory: (runId: string) => void }) {
  const finished = isFinished(run);
  const now = useNow(!finished);
  const duration = run.exit ? run.exit.durationMs : now - run.startedAt;
  const interview = !finished ? interviewUrl(run.stderr) : null;
  const pointer = finished ? runLogPointer(run.stderr) : null;
  const marker = finalMarker(run.stdout);
  return (
    <div className="run-detail">
      <div className="run-header">
        <span className={`status status-${run.status}`}>{STATUS[run.status].icon} {STATUS[run.status].label}</span>
        <code className="mono grow ellipsis" title={run.line}>{run.line}</code>
        {marker && <span className="pill">{marker}</span>}
        <span className="muted small">{formatDuration(duration)}{run.exit?.code !== null && run.exit?.code !== undefined ? ` · código ${run.exit.code}` : ""}</span>
        {!finished && (
          <button type="button" className="button warn" onClick={onCancel} title="Primero envia Ctrl-C (SIGINT); un segundo clic fuerza la terminacion">
            {run.status === "cancelling" ? "Forzar" : "Interrumpir"}
          </button>
        )}
        {finished && <button type="button" className="button" onClick={onRerun}>Repetir</button>}
        <button type="button" className="button" onClick={() => navigator.clipboard.writeText(run.line)}>Copiar comando</button>
      </div>
      {run.exit?.error && <div className="callout error">{run.exit.error}</div>}
      {pointer && (
        <div className="callout">
          El CLI registró el detalle del fallo en el run log.{" "}
          <button type="button" className="link-button" onClick={() => onOpenHistory(pointer.runId)}>Ver en el historial</button>
        </div>
      )}
      {interview && <InterviewBanner url={interview} />}
      {run.dropped > 0 && <div className="muted small">Se descartaron {run.dropped} lineas antiguas.</div>}
      <div className="run-streams">
        <div className="stream">
          <div className="stream-title">Operador · stderr</div>
          <AutoScroll lines={run.stderr} className="log mono" />
        </div>
        <div className="stream">
          <div className="stream-title">Resultado · stdout</div>
          <Stdout run={run} />
        </div>
      </div>
    </div>
  );
}

export function RunDock({ runs, activeId, collapsed, onToggle, onFocus, onCancel, onClose, onRerun, onOpenHistory }: RunDockProps) {
  const active = runs.find((run) => run.id === activeId) ?? runs.at(-1);
  if (runs.length === 0) return null;
  return (
    <section className={`dock${collapsed ? " collapsed" : ""}`}>
      <div className="dock-tabs">
        <button type="button" className="icon-button" onClick={onToggle} title={collapsed ? "Expandir" : "Contraer"}>{collapsed ? "▴" : "▾"}</button>
        {runs.map((run) => (
          <div key={run.id} className={`dock-tab${run.id === active?.id ? " active" : ""}`} onClick={() => onFocus(run.id)}>
            <span className={`status-dot status-${run.status}`}>{STATUS[run.status].icon}</span>
            <span className="mono">{run.command}</span>
            {isFinished(run) && (
              <button type="button" className="tab-close" title="Cerrar" onClick={(event) => { event.stopPropagation(); onClose(run.id); }}>✕</button>
            )}
          </div>
        ))}
      </div>
      {!collapsed && active && (
        <RunDetail run={active} onCancel={() => onCancel(active.id)} onRerun={() => onRerun(active)} onOpenHistory={onOpenHistory} />
      )}
    </section>
  );
}
