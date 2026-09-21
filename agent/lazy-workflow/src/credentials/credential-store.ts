/**
 * Credentials kept in the operator's chezmoi-managed env files.
 *
 * Each `~/.config/secrets/<service>.env` holds `export NAME=<shell-quoted
 * value>` lines with 0600 permissions, and the dotfiles repository encrypts them
 * with age at rest. These helpers only read: they answer with names, and with
 * the decoded value for one explicitly named credential. The quoting is the one
 * `shlex.quote` and bash's `printf %q` produce, because that is what the
 * credentials skill writes.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface CredentialEntry {
  name: string;
  file: string;
}

export interface CredentialValue extends CredentialEntry {
  value: string;
}

const ASSIGNMENT = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** `~/.config/secrets`, overridable for tests and for a relocated store. */
export function defaultSecretsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const declared = env.LAZY_WORKFLOW_SECRETS_DIR?.trim();
  if (declared) return declared;
  return join(env.HOME ?? homedir(), ".config", "secrets");
}

async function envFiles(directory: string): Promise<string[]> {
  try {
    const names: string[] = [];
    for await (const name of new Bun.Glob("*.env").scan({ cwd: directory })) names.push(name);
    return names.sort();
  } catch {
    return [];
  }
}

async function readEnvFile(directory: string, file: string): Promise<string> {
  try {
    return await Bun.file(join(directory, file)).text();
  } catch {
    return "";
  }
}

function assignments(content: string): Array<{ name: string; raw: string }> {
  const found: Array<{ name: string; raw: string }> = [];
  for (const line of content.split("\n")) {
    const text = line.trim();
    if (text.startsWith("#")) continue;
    const match = ASSIGNMENT.exec(text);
    if (match) found.push({ name: match[1]!, raw: match[2]! });
  }
  return found;
}

/**
 * The value as the shell would read it: `shlex.quote` single-quoted segments,
 * double quotes, or the backslash escapes `printf %q` leaves on an unquoted
 * value. An undecodable value throws instead of answering half of it.
 */
function decodeShellValue(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) return "";
  if (text.startsWith("'")) {
    let decoded = "";
    let index = 0;
    while (index < text.length) {
      const char = text[index]!;
      if (char === "'") {
        const end = text.indexOf("'", index + 1);
        if (end === -1) throw new Error("comilla simple sin cerrar");
        decoded += text.slice(index + 1, end);
        index = end + 1;
        continue;
      }
      if (char === "\\" && index + 1 < text.length) {
        decoded += text[index + 1];
        index += 2;
        continue;
      }
      throw new Error("caracter inesperado despues de una comilla");
    }
    return decoded;
  }
  if (text.startsWith('"')) {
    const end = text.lastIndexOf('"');
    if (end <= 0) throw new Error("comilla doble sin cerrar");
    return text.slice(1, end).replace(/\\(["\\$`])/g, "$1");
  }
  return text.replace(/\\(.)/g, "$1");
}

/** Every credential the env files declare, sorted by name; the first file wins a duplicate. */
export async function listCredentials(directory: string): Promise<CredentialEntry[]> {
  const found = new Map<string, CredentialEntry>();
  for (const file of await envFiles(directory)) {
    for (const assignment of assignments(await readEnvFile(directory, file))) {
      if (!found.has(assignment.name)) found.set(assignment.name, { name: assignment.name, file });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One named credential with its decoded value, or null when no env file declares it. */
export async function readCredential(directory: string, name: string): Promise<CredentialValue | null> {
  for (const entry of await listCredentials(directory)) {
    if (entry.name !== name) continue;
    const content = await readEnvFile(directory, entry.file);
    for (const assignment of assignments(content)) {
      if (assignment.name === name) return { ...entry, value: decodeShellValue(assignment.raw) };
    }
  }
  return null;
}
