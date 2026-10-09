export interface WebSession { username: string; csrf: string; expiresAt: number }
export type WebAuthentication = { mode: "password" } | { mode: "cloudflareAccess"; loginUrl: string; logoutUrl: string };
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

/** Cookies hold only the web session; the local administration/CLI credentials stay on the server. */
export function createHttpTransport(fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, onUnauthorized: () => void) {
  let session: WebSession | null = null;
  let authentication: WebAuthentication | null = null;
  async function request<T>(path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    if (!path.startsWith("/api/") || path.startsWith("//") || path.includes("..")) throw new Error("Invalid API path");
    let response: Response;
    try { response = await fetcher(path, {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin", redirect: "error",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", "X-LZ-Web": "1", "X-CSRF-Token": session?.csrf ?? "" }), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }); } catch (error) {
      // Access can redirect an expired fetch to its login page. Re-enter through a full navigation.
      if (authentication?.mode === "cloudflareAccess") { session = null; onUnauthorized(); }
      throw error;
    }
    const result: unknown = response.headers.get("content-type")?.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      if (response.status === 401 || (response.status === 403 && authentication?.mode === "cloudflareAccess")) { session = null; if (!["/api/login", "/api/session", "/api/access-session"].includes(path)) onUnauthorized(); }
      const message = typeof result === "object" && result !== null && "error" in result ? String(result.error) : String(result);
      throw new HttpError(response.status, message);
    }
    return result as T;
  }
  return {
    request,
    async authentication(): Promise<WebAuthentication> { authentication = await request<WebAuthentication>("/api/auth"); return authentication; },
    rpc: <T>(operation: string, body: unknown = {}) => request<T>(`/api/rpc/${operation}`, body, operation === "start_run" ? { "X-Request-ID": crypto.randomUUID() } : {}),
    async session(): Promise<WebSession> { session = await request<WebSession>("/api/session"); return session; },
    async login(username: string, password: string): Promise<WebSession> { session = await request<WebSession>("/api/login", { username, password }); return session; },
    async accessLogin(): Promise<WebSession> { session = await request<WebSession>("/api/access-session", {}); return session; },
    async logout(): Promise<string | null> { const result = await request<{ logoutUrl?: string | null }>("/api/logout", {}); session = null; return result.logoutUrl ?? null; },
  };
}
