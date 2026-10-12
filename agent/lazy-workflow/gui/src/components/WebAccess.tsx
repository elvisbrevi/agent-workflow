import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { errorText, webTransport } from "../lib/backend.ts";
import { isDesktop } from "../lib/platform.ts";
import { HttpError, type WebAuthentication, type WebSession } from "../lib/http-transport.ts";

/** The signed-in owner of a web installation; absent on the desktop, which has no session. */
interface WebAccount {
  readonly username: string;
  readonly error: string | null;
  readonly logout: () => void;
}

const WebAccountContext = createContext<WebAccount | null>(null);

/** Who is signed in and how to leave: the sidebar shows it on wide screens, Ajustes on phones. */
export function AccountControl({ className }: { className: string }) {
  const account = useContext(WebAccountContext);
  if (!account) return null;
  return (
    <div className={className}>
      <span className="muted ellipsis grow">{account.username}</span>
      <button type="button" className="link-button" onClick={account.logout}>Cerrar sesión</button>
      {account.error && <span role="alert">{account.error}</span>}
    </div>
  );
}

export function WebAccess({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<WebSession | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [authentication, setAuthentication] = useState<WebAuthentication | null>(null);
  useEffect(() => {
    if (isDesktop) return;
    let active = true;
    void (async () => {
      try {
        const auth = await webTransport.authentication();
        if (!active) return;
        setAuthentication(auth);
        let current: WebSession;
        try { current = await webTransport.session(); }
        catch (error) {
          if (auth.mode !== "cloudflareAccess" || !(error instanceof HttpError) || error.status !== 401) throw error;
          current = await webTransport.accessLogin();
        }
        if (active) setSession(current);
      } catch (error) {
        if (active) { setSession(null); if (!(error instanceof HttpError && error.status === 401)) setError(errorText(error)); }
      }
    })();
    const expired = () => { setSession(null); setError("La sesion expiro. Inicia sesion otra vez."); };
    window.addEventListener("lz:unauthorized", expired);
    return () => { active = false; window.removeEventListener("lz:unauthorized", expired); };
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
      {authentication?.mode === "cloudflareAccess" ? <div className="card stack">
        <h1>lz · agent-workflow</h1>
        <p>Accede a tu servidor con GitHub.</p>
        {error && <div className="callout error" role="alert">{error}</div>}
        <a className="button primary" href={authentication.loginUrl}>Continuar con GitHub</a>
        <a className="link-button" href={authentication.logoutUrl}>Cerrar sesion de Cloudflare Access</a>
      </div> : authentication?.mode === "password" ?
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
      : <div className="card stack"><h1>lz · agent-workflow</h1><p role="alert">{error ?? "No se pudo comprobar el acceso al servidor."}</p><button className="button primary" onClick={() => window.location.reload()}>Volver a conectar</button></div>}
    </main>
  );
  const logout = () => {
    void webTransport.logout().then((logoutUrl) => {
      setSession(null);
      if (logoutUrl === "/cdn-cgi/access/logout") window.location.assign(logoutUrl);
    }, (error) => setError(errorText(error)));
  };
  return <WebAccountContext.Provider value={{ username: session.username, error, logout }}>{children}</WebAccountContext.Provider>;
}
