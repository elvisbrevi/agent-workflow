export interface WebSession { username: string; csrf: string; expiresAt: number }
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

/** Cookies hold only the web session; the local administration/CLI credentials stay on the server. */
export function createHttpTransport(fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, onUnauthorized: () => void) {
  let session: WebSession | null = null;
  async function request<T>(path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    if (!path.startsWith("/api/") || path.startsWith("//") || path.includes("..")) throw new Error("Invalid API path");
    const response = await fetcher(path, {
      method: body === undefined ? "GET" : "POST", credentials: "same-origin", redirect: "error",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", "X-LZ-Web": "1", "X-CSRF-Token": session?.csrf ?? "" }), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result: unknown = response.headers.get("content-type")?.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      if (response.status === 401) { session = null; if (path !== "/api/login" && path !== "/api/session") onUnauthorized(); }
      const message = typeof result === "object" && result !== null && "error" in result ? String(result.error) : String(result);
      throw new HttpError(response.status, message);
    }
    return result as T;
  }
  return {
    request,
    rpc: <T>(operation: string, body: unknown = {}) => request<T>(`/api/rpc/${operation}`, body, operation === "start_run" ? { "X-Request-ID": crypto.randomUUID() } : {}),
    async session(): Promise<WebSession> { session = await request<WebSession>("/api/session"); return session; },
    async login(username: string, password: string): Promise<WebSession> { session = await request<WebSession>("/api/login", { username, password }); return session; },
    async logout(): Promise<void> { await request("/api/logout", {}); session = null; },
  };
}
