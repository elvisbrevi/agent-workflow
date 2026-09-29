/** Legacy macOS Keychain access. Values stay in memory and never reach output. */
import { userInfo } from "node:os";
import { validateCredentialName } from "./credential-store.ts";

export type KeychainPresence = "present" | "missing" | "n/a";

function securityArgs(name: string): string[] {
  return ["find-generic-password", "-a", process.env.USER || userInfo().username, "-s", name, "-w"];
}

export async function keychainPresence(name: string, binary: string | null = Bun.which("security")): Promise<KeychainPresence> {
  if (binary === null) return "n/a";
  const child = Bun.spawn([binary, ...securityArgs(name)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return (await child.exited) === 0 ? "present" : "missing";
}

export async function readKeychainCredential(name: string, binary: string | null = Bun.which("security")): Promise<string> {
  validateCredentialName(name);
  if (binary === null) throw new Error("Keychain no esta disponible en este equipo");
  const child = Bun.spawn([binary, ...securityArgs(name)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const value = (await new Response(child.stdout).text()).replace(/\n$/, "");
  if ((await child.exited) !== 0) throw new Error(`${name} no esta en Keychain`);
  if (value.length === 0) throw new Error(`${name} tiene un valor vacio en Keychain`);
  return value;
}
