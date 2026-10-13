import { useRef, useState, useEffect } from "react";
import { backend, errorText, type FolderListing } from "../lib/backend.ts";
import { isDesktop, open } from "../lib/platform.ts";
import { homePath } from "../lib/work.ts";

const FolderIcon = () => <svg className="folder-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" /></svg>;

/** Native filesystem on desktop; in the browser, the server's folders below the roots its owner allows. */
export function DirectoryPicker({ onPick, label = "Buscar carpeta…", confirmLabel = "Agregar repositorio" }: { onPick: (path: string) => void | Promise<void>; label?: string; confirmLabel?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  useEffect(() => { if (visible) dialog.current?.showModal(); }, [visible]);
  const browse = async (target?: string) => {
    setError(null);
    try {
      const next = await backend.listFolders(target);
      setListing(next);
      setPath(homePath(next.path, next.home));
    } catch (error) { setError(errorText(error)); }
  };
  // The field shows `~` for the server account's home; whoever receives the folder gets it whole.
  const absolute = (value: string): string => (listing?.home && (value === "~" || value.startsWith("~/")) ? `${listing.home}${value.slice(1)}` : value);
  const add = async () => {
    setBusy(true); setError(null);
    try { await onPick(absolute(path.trim())); dialog.current?.close(); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  };
  const choose = async () => {
    setError(null);
    if (!isDesktop) { setListing(null); setPath(""); setVisible(true); void browse(); return; }
    try {
      const chosen = await open({ directory: true, multiple: false });
      if (typeof chosen === "string") await onPick(chosen);
    } catch (error) { setError(errorText(error)); }
  };
  return <>
    <button type="button" className="button folder-button" title={label} aria-label={label} onClick={() => void choose()}>{label}</button>
    {error && !visible && <span className="error-text" role="alert">{error}</span>}
    {visible && <dialog ref={dialog} className="folder-dialog" onCancel={() => setVisible(false)} onClose={() => setVisible(false)}>
      <div className="row"><h2 className="grow">Carpetas del servidor</h2><button className="icon-button" type="button" aria-label="Cerrar selector de carpetas" onClick={() => dialog.current?.close()}>✕</button></div>
      <form className="folder-path" onSubmit={(event) => { event.preventDefault(); void browse(path.trim()); }}>
        <input className="input" aria-label="Ruta en el servidor" placeholder="~/" value={path} onChange={(event) => setPath(event.target.value)}
          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} enterKeyHint="go" />
      </form>
      <button type="button" className="button primary folder-add" disabled={busy || !path.trim()} onClick={() => void add()}>{confirmLabel}</button>
      {error && <p className="error-text" role="alert">{error}</p>}
      <p className="muted small folder-heading">Carpetas</p>
      <div className="folder-results" aria-busy={!listing && !error}>
        {listing?.parent && <button type="button" className="folder-entry" aria-label="Carpeta superior" onClick={() => void browse(listing.parent!)}><span className="folder-up" aria-hidden="true">↰</span><span className="grow">..</span></button>}
        {listing?.entries.map((entry) => (
          <button key={entry.path} type="button" className="folder-entry" onClick={() => void browse(entry.path)}>
            <FolderIcon /><span className="grow ellipsis">{entry.name}</span>
            {entry.registered ? <span className="pill">agregado</span> : entry.repository && <span className="pill">git</span>}
          </button>
        ))}
        {listing && !listing.entries.length && <p className="muted small">Sin subcarpetas.</p>}
        {listing?.truncated && <p className="muted small">Hay más carpetas; escribe la ruta para llegar a ellas.</p>}
      </div>
    </dialog>}
  </>;
}
