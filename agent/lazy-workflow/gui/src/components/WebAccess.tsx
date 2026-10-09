import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { errorText, webTransport } from "../lib/backend.ts";
import { isDesktop } from "../lib/platform.ts";
import type { WebSession } from "../lib/http-transport.ts";

export function WebAccess({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<WebSession | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (isDesktop) return;
    void webTransport.session().then(setSession, () => setSession(null));
    const expired = () => { setSession(null); setError("La sesion expiro. Inicia sesion otra vez."); };
    window.addEventListener("lz:unauthorized", expired);
    return () => window.removeEventListener("lz:unauthorized", expired);
  }, []);
  if (isDesktop) return children;
  if (session === undefined) return <div className="login">Comprobando sesion…</div>;
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    try { setSession(await webTransport.login(String(data.get("username")), String(data.get("password")))); form.reset(); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }
  if (!session) return (
    <main className="login">
      <form className="card stack" onSubmit={login}>
        <h1>lz · agent-workflow</h1>
        <p>Accede a tu servidor de workflows.</p>
        <label htmlFor="username">Usuario</label>
        <input id="username" className="input" name="username" autoComplete="username" required maxLength={80} />
        <label htmlFor="password">Contraseña</label>
        <input id="password" className="input" name="password" type="password" autoComplete="current-password" required maxLength={1024} />
        {error && <div className="callout error" role="alert">{error}</div>}
        <button className="button primary" type="submit" disabled={busy}>{busy ? "Entrando…" : "Iniciar sesion"}</button>
      </form>
    </main>
  );
  return <><div className="web-session"><span>{session.username}</span><button type="button" className="link-button" onClick={() => { void webTransport.logout().then(() => setSession(null), (error) => setError(errorText(error))); }}>Cerrar sesion</button>{error && <span role="alert">{error}</span>}</div>{children}</>;
}
