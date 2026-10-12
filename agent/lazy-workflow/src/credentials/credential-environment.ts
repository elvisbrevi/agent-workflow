import { WORKFLOW_ENVIRONMENT } from "../system/workflow-environment.ts";
import { defaultSecretsDirectory, readCredential, validateStoredName, type CredentialValue } from "./credential-store.ts";

type CredentialReader = (directory: string, name: string) => Promise<CredentialValue | null>;

export interface CredentialStatus {
  name: string;
  present: boolean;
  value: string | null;
  source: "environment" | "credentials" | "missing";
}

/** Public values only for catalog-declared non-secrets; arbitrary credential names stay masked. */
export async function credentialStatus(
  names: readonly string[],
  read: CredentialReader = readCredential,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialStatus[]> {
  const directory = defaultSecretsDirectory(env);
  const result: CredentialStatus[] = [];
  for (const name of names) {
    const variable = WORKFLOW_ENVIRONMENT.find((entry) => entry.name === name);
    if (!variable) validateStoredName(name);
    const inherited = env[name];
    const stored = inherited || (variable && !variable.credentialStore)
      ? null : await read(directory, name);
    const value = inherited || stored?.value || null;
    result.push({ name, present: value !== null, value: variable?.secret === false ? value : null,
      source: inherited ? "environment" : value !== null ? "credentials" : "missing" });
  }
  return result;
}

/** Load only lz's declared consumers, preserving values provided by the shell or GUI profile. */
export async function loadWorkflowEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const directory = defaultSecretsDirectory(env);
  for (const variable of WORKFLOW_ENVIRONMENT) {
    if (!variable.credentialStore || env[variable.name]) continue;
    const stored = await readCredential(directory, variable.name);
    if (stored) env[variable.name] = stored.value;
  }
}
