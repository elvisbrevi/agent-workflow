import { useRef, useState, useEffect } from "react";
import { isDesktop, open } from "../lib/platform.ts";
import { repositoryName } from "../lib/work.ts";

/** Native filesystem on desktop; only registered server repositories in the browser. */
export function DirectoryPicker({ repositories, onPick, label = "Buscar carpeta…" }: { repositories: readonly string[]; onPick: (path: string) => void; label?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => { if (visible) dialog.current?.showModal(); }, [visible]);
  const choose = async () => {
    setError(null);
    if (!isDesktop) { setQuery(""); setVisible(true); return; }
    try {
      const chosen = await open({ directory: true, multiple: false });
      if (typeof chosen === "string") onPick(chosen);
    } catch (error) { setError(String(error)); }
  };
  return <>
    <button type="button" className="button folder-button" title={label} aria-label={label} onClick={() => void choose()}>{label}</button>
    {error && <span className="error-text" role="alert">{error}</span>}
    {visible && <dialog ref={dialog} className="folder-dialog" onCancel={() => setVisible(false)} onClose={() => setVisible(false)}>
      <div className="row"><h2 className="grow">Carpetas del servidor</h2><button className="icon-button" type="button" aria-label="Cerrar selector de carpetas" onClick={() => dialog.current?.close()}>✕</button></div>
      <p className="muted small">Elige un repositorio registrado en el equipo donde corre lz.</p>
      <input autoFocus className="input" aria-label="Buscar carpeta del servidor" placeholder="Buscar por nombre o ruta…" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="folder-results">
        {repositories.filter((path) => path.toLowerCase().includes(query.trim().toLowerCase())).map((path) => <button key={path} type="button" className="folder-result" onClick={() => { onPick(path); dialog.current?.close(); }}><strong>{repositoryName(path)}</strong><span className="muted small">{path}</span></button>)}
        {!repositories.length && <p className="muted">Todavía no hay carpetas registradas. Agrégalas en la configuración local del servidor.</p>}
        {repositories.length > 0 && !repositories.some((path) => path.toLowerCase().includes(query.trim().toLowerCase())) && <p className="muted">No hay carpetas que coincidan con tu búsqueda.</p>}
      </div>
    </dialog>}
  </>;
}
