/**
 * Credentials kept in the operator's chezmoi-managed env files.
 *
 * Each `~/.config/secrets/<service>.env` holds `export NAME=<shell-quoted
 * value>` lines with 0600 permissions, and the dotfiles repository encrypts them
 * with age at rest. These helpers answer with names, decode the value for one
 * explicitly named credential, and store a value the operator just supplied —
 * in memory and on disk, never in a command line or a log. The quoting is the
 * one `shlex.quote` and bash's `printf %q` produce, because both the
 * credentials skill and this module write these files.
 */
import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export interface CredentialEntry {
  name: string;
  file: string;
}

export interface CredentialValue extends CredentialEntry {
  value: string;
}

/** A stored credential plus whether the encrypted chezmoi source was refreshed. */
export interface StoredCredential extends CredentialEntry {
  chezmoiSourceUpdated: boolean;
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
      // `shlex.quote` cierra una comilla simple, abre una doble para el caracter
      // citado y vuelve a abrir la simple: `'it'"'"'s ok'`. El segmento doble se
      // decodifica en el lugar, o un valor que el skill escribio no se leeria.
      if (char === '"') {
        const end = text.indexOf('"', index + 1);
        if (end === -1) throw new Error("comilla doble sin cerrar");
        decoded += text.slice(index + 1, end).replace(/\\(["\\$`])/g, "$1");
        index = end + 1;
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

/** The default file for a credential no env file declares yet. */
const DEFAULT_SERVICE = "other";
const CREDENTIAL_NAME = /^[A-Z_][A-Z0-9_]*$/;
/** The same names the credentials skill accepts: storing `PATH` is a mistake, not a credential. */
const CREDENTIAL_MARKER = /(?:^|_)(?:TOKEN|PASSWORD|PASSWD|PASSPHRASE|SECRET|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|AUTH|PAT|KEY)(?:_|$)/;
const SERVICE = /^[a-z0-9][a-z0-9._-]*$/;

export function validateCredentialName(name: string): string {
  const text = name.trim();
  if (!CREDENTIAL_NAME.test(text) || !CREDENTIAL_MARKER.test(text)) {
    throw new Error(
      "El nombre de credencial debe ser un identificador en mayusculas con TOKEN, PASSWORD, PASSPHRASE, SECRET, API_KEY, ACCESS_KEY, PRIVATE_KEY, CREDENTIAL, AUTH, PAT o KEY",
    );
  }
  return text;
}

export function normalizeService(service: string): string {
  const stem = service.trim().replace(/\.env$/, "");
  if (!SERVICE.test(stem)) {
    throw new Error("El servicio debe estar en minusculas y contener solo [a-z0-9._-]");
  }
  return stem;
}

/**
 * The value as a single shell-safe word: bare when every character is one the
 * shell reads literally, single-quoted otherwise, with the `'\''` escape the
 * decoder above understands and bash applies verbatim.
 */
export function quoteShellValue(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function validateValue(name: string, value: string): string {
  if (value.length === 0) throw new Error(`El valor de ${name} no puede estar vacio`);
  if (/[\r\n]/.test(value)) throw new Error(`El valor de ${name} debe ser de una sola linea`);
  return value;
}

/**
 * Every file that declares the name. Not `listCredentials`, which keeps the
 * first declaration of a duplicate: writing needs to see all of them to refuse
 * an ambiguity instead of silently updating one file and leaving the other stale.
 */
async function declaringFiles(directory: string, name: string): Promise<string[]> {
  const files: string[] = [];
  for (const file of await envFiles(directory)) {
    if (assignments(await readEnvFile(directory, file)).some((assignment) => assignment.name === name)) {
      files.push(file);
    }
  }
  return files;
}

/**
 * The file the credential belongs to: the one that already declares it — and an
 * ambiguity is an error rather than a silent pick, because writing the wrong
 * file would leave a stale value behind — then `--service`, then `other.env`.
 */
async function credentialFile(directory: string, name: string, service: string | null): Promise<string> {
  const matches = await declaringFiles(directory, name);
  if (matches.length > 1) {
    throw new Error(`${name} esta en varios archivos (${matches.join(", ")}); declara --service`);
  }
  if (matches[0]) return matches[0];
  return `${service ? normalizeService(service) : DEFAULT_SERVICE}.env`;
}

/** Creates the file with header, 0600 and its directory 0700, or replaces it atomically. */
async function writeEnvFile(path: string, lines: string[]): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (((await stat(directory)).mode & 0o077) !== 0) await chmod(directory, 0o700);
  const temporary = join(directory, `.${basename(path)}.tmp-${process.pid}`);
  await writeFile(temporary, lines.join("\n").replace(/\s+$/, "") + "\n", { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/**
 * Stores one credential in its env file, replacing its declaration in place and
 * preserving every comment and every other assignment. An absent file is created
 * with the header the credentials skill writes, so both writers agree.
 */
export async function storeCredential(
  directory: string,
  name: string,
  service: string | null,
  value: string,
): Promise<CredentialEntry> {
  const credential = validateCredentialName(name);
  const secret = validateValue(credential, value);
  const file = await credentialFile(directory, credential, service);
  const content = await readEnvFile(directory, file);
  const lines = content.length > 0
    ? content.split("\n")
    : [`# ${file} - managed by chezmoi; load with: load-env ${file.replace(/\.env$/, "")}`, ""];

  const output: string[] = [];
  let replaced = false;
  for (const line of lines) {
    const text = line.trim();
    const match = text.startsWith("#") ? null : ASSIGNMENT.exec(text);
    if (match && match[1] === credential) {
      if (!replaced) {
        output.push(`export ${credential}=${quoteShellValue(secret)}`);
        replaced = true;
      }
      continue;
    }
    output.push(line);
  }
  if (!replaced) {
    if (output.length > 0 && output[output.length - 1]!.trim() !== "") output.push("");
    output.push(`export ${credential}=${quoteShellValue(secret)}`);
  }

  await writeEnvFile(join(directory, file), output);
  return { name: credential, file };
}
