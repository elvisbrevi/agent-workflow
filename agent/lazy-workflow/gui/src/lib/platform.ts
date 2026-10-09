/** Native operations describe the device they affect. Browser paths belong to the server. */
export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function ask(message: string, options: { title?: string; kind?: "warning"; okLabel?: string; cancelLabel?: string } = {}): Promise<boolean> {
  if (isDesktop) return (await import("@tauri-apps/plugin-dialog")).ask(message, options);
  return window.confirm(message);
}

export async function open(options: { directory?: boolean; multiple?: boolean }): Promise<string | string[] | null> {
  if (!isDesktop) return null;
  return (await import("@tauri-apps/plugin-dialog")).open(options);
}

export async function openUrl(url: string): Promise<void> {
  const target = new URL(url, window.location.origin);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error("Only HTTP(S) links are supported");
  if (isDesktop) return (await import("@tauri-apps/plugin-opener")).openUrl(target.href);
  window.open(target.href, "_blank", "noopener,noreferrer");
}

export async function revealItemInDir(path: string): Promise<void> {
  if (!isDesktop) throw new Error("This file is on the server. Open it there.");
  return (await import("@tauri-apps/plugin-opener")).revealItemInDir(path);
}
