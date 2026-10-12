import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialStatus, loadWorkflowEnvironment } from "../src/credentials/credential-environment.ts";
import { storeCredential } from "../src/credentials/credential-store.ts";

test("estado y carga comparten el almacen, respetan overrides y ocultan secretos", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lz-environment."));
  try {
    await storeCredential(directory, "LAZY_WORKFLOW_AZURE_ORGANIZATION", "azure", "https://dev.azure.com/synthetic");
    await storeCredential(directory, "AZURE_DEVOPS_EXT_PAT", "azure", "synthetic-pat");
    await storeCredential(directory, "CUSTOM_API_KEY", "azure", "synthetic-key");
    const env: NodeJS.ProcessEnv = { LAZY_WORKFLOW_SECRETS_DIR: directory };
    const names = ["LAZY_WORKFLOW_AZURE_ORGANIZATION", "AZURE_DEVOPS_EXT_PAT", "CUSTOM_API_KEY", "MISSING_TOKEN"];
    expect(await credentialStatus(names, undefined, env)).toEqual([
      { name: names[0], present: true, value: "https://dev.azure.com/synthetic", source: "credentials" },
      { name: names[1], present: true, value: null, source: "credentials" },
      { name: names[2], present: true, value: null, source: "credentials" },
      { name: names[3], present: false, value: null, source: "missing" },
    ]);
    env.LAZY_WORKFLOW_AZURE_ORGANIZATION = "https://dev.azure.com/override";
    await loadWorkflowEnvironment(env);
    expect(env.LAZY_WORKFLOW_AZURE_ORGANIZATION).toBe("https://dev.azure.com/override");
    expect(env.AZURE_DEVOPS_EXT_PAT).toBe("synthetic-pat");
    expect(env.CUSTOM_API_KEY).toBeUndefined();
    expect((await credentialStatus(names, undefined, env))[0]?.source).toBe("environment");
    expect(JSON.stringify(await credentialStatus(names, undefined, env))).not.toContain("synthetic-pat");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("el entrypoint carga los valores guardados para el comando y publica solo estado seguro", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lz-entry-environment."));
  try {
    const secrets = join(directory, "secrets");
    await storeCredential(secrets, "LAZY_WORKFLOW_AZURE_ORGANIZATION", "azure", "https://dev.azure.com/synthetic");
    await storeCredential(secrets, "AZURE_DEVOPS_EXT_PAT", "azure", "synthetic-pat");
    await Bun.write(join(directory, "git"), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';
writeFileSync(process.env.SYNTHETIC_CAPTURE, JSON.stringify({organization: process.env.LAZY_WORKFLOW_AZURE_ORGANIZATION, pat: process.env.AZURE_DEVOPS_EXT_PAT}));
if (process.argv.includes('rev-parse')) console.log('true');
else if (process.argv.includes('--show-current')) console.log('main');\n`);
    await chmod(join(directory, "git"), 0o700);
    const invoke = async (args: string[], override?: string) => {
      const child = Bun.spawn([process.execPath, Bun.fileURLToPath(new URL("../main.ts", import.meta.url)), ...args, "--no-log-file", "--no-color"], {
        env: { HOME: directory, PATH: `${directory}:${process.env.PATH ?? ""}`, LAZY_WORKFLOW_SECRETS_DIR: secrets, SYNTHETIC_CAPTURE: join(directory, "captured.json"), ...(override ? { LAZY_WORKFLOW_AZURE_ORGANIZATION: override } : {}) },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(0);
      expect(stdout + stderr).not.toContain("synthetic-pat");
      return JSON.parse(stdout);
    };
    const status = await invoke(["credentials-status"]);
    expect(status.find((entry: { name: string }) => entry.name === "LAZY_WORKFLOW_AZURE_ORGANIZATION").value).toBe("https://dev.azure.com/synthetic");
    expect(status.find((entry: { name: string }) => entry.name === "AZURE_DEVOPS_EXT_PAT").value).toBeNull();
    expect((await invoke(["git-branch-list", "--working-directory", directory])).current).toBe("main");
    expect(await Bun.file(join(directory, "captured.json")).json()).toEqual({ organization: "https://dev.azure.com/synthetic", pat: "synthetic-pat" });
    await invoke(["git-branch-list", "--working-directory", directory], "https://dev.azure.com/override");
    expect((await Bun.file(join(directory, "captured.json")).json()).organization).toBe("https://dev.azure.com/override");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
