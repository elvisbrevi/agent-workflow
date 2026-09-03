import { test, expect } from "bun:test";
import { mkdir, mkdtemp, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTHORITY_PROFILES, authorityConfigPath, type AuthorityProfile } from "../src/prompts/authority-profile.ts";
import { assembleCodexAuthorityHome, codexRulesPath } from "../src/prompts/codex-authority-home.ts";

/** The OpenCode spelling of a Codex prefix rule: `git push*` is `["git", "push"]`. */
function opencodePatternAsTokens(pattern: string): string[] {
  return pattern.replace(/\*$/, "").split(" ").filter(Boolean);
}

function forbiddenPrefixes(rulesText: string): string[][] {
  const prefixes: string[][] = [];
  const ruleRegex = /prefix_rule\(pattern=\[(.*?)\],\s*decision="forbidden"\)/g;
  for (const match of rulesText.matchAll(ruleRegex)) {
    prefixes.push([...(match[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? ""));
  }
  return prefixes;
}

test("cada perfil de Codex existe como archivo .rules propio", async () => {
  for (const profile of AUTHORITY_PROFILES) {
    expect(`${profile}: ${await Bun.file(codexRulesPath(profile)).exists()}`).toBe(`${profile}: true`);
  }
});

test("cada perfil de Codex prohibe lo mismo que su gemelo de OpenCode", async () => {
  const opencode = await Bun.file(authorityConfigPath("opencode", "lazy-review")).json();
  for (const profile of AUTHORITY_PROFILES) {
    const rulesText = await Bun.file(codexRulesPath(profile)).text();
    const prefixes = forbiddenPrefixes(rulesText).map((tokens) => tokens.join(" "));
    for (const pattern of Object.keys(opencode.agent[profile].permission.bash)) {
      const expected = opencodePatternAsTokens(pattern).join(" ");
      expect(`${profile} ${expected}: ${prefixes.includes(expected)}`).toBe(`${profile} ${expected}: true`);
    }
  }
});

test("el perfil de revision de Codex tambien prohibe apply_patch", async () => {
  const rulesText = await Bun.file(codexRulesPath("lazy-review")).text();
  const prefixes = forbiddenPrefixes(rulesText).map((tokens) => tokens.join(" "));
  expect(prefixes.includes("apply_patch")).toBe(true);
});

test("los perfiles de entrega de Codex siguen pudiendo commitear", async () => {
  for (const profile of ["lazy-github-code", "lazy-azure-code"] as const) {
    const rulesText = await Bun.file(codexRulesPath(profile)).text();
    const commits = forbiddenPrefixes(rulesText).filter((tokens) => tokens[0] === "git" && tokens[1] === "commit");
    expect(`${profile}: ${commits.length}`).toBe(`${profile}: 0`);
  }
});

test("ningun perfil de Codex prohibe ejecutar lazy-workflow", async () => {
  for (const profile of AUTHORITY_PROFILES) {
    const rulesText = await Bun.file(codexRulesPath(profile)).text();
    const prefixes = forbiddenPrefixes(rulesText).map((tokens) => tokens.join(" "));
    expect(`${profile}: ${prefixes.includes("lazy-workflow")}`).toBe(`${profile}: false`);
  }
});

test("armar el home de autoridad Codex enlaza auth.json y skills del operador y omite config.toml", async () => {
  const operatorHome = await mkdtemp(join(tmpdir(), "codex-operator-"));
  const destination = await mkdtemp(join(tmpdir(), "codex-home-"));
  try {
    await Bun.write(join(operatorHome, "auth.json"), "{}");
    await Bun.write(join(operatorHome, "config.toml"), 'model = "gpt"');
    await mkdir(join(operatorHome, "skills", "grill-with-docs"), { recursive: true });

    const home = await assembleCodexAuthorityHome("lazy-review", operatorHome, destination);

    expect(home).toBe(destination);
    expect(await readdir(join(destination, "rules"))).toEqual(["lazy-review.rules"]);
    expect(await readlink(join(destination, "auth.json"))).toBe(join(operatorHome, "auth.json"));
    expect(await readlink(join(destination, "skills"))).toBe(join(operatorHome, "skills"));
    expect(await Bun.file(join(destination, "config.toml")).exists()).toBe(false);
  } finally {
    await rm(operatorHome, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});

test("el home de autoridad Codex se deriva del perfil ya fijado, no de otro", async () => {
  const operatorHome = await mkdtemp(join(tmpdir(), "codex-operator-"));
  const destination = await mkdtemp(join(tmpdir(), "codex-home-"));
  try {
    await Bun.write(join(operatorHome, "auth.json"), "{}");
    await mkdir(join(operatorHome, "skills"), { recursive: true });

    await assembleCodexAuthorityHome("lazy-github-code", operatorHome, destination);
    const rulesFiles = await readdir(join(destination, "rules"));

    expect(rulesFiles).toEqual(["lazy-github-code.rules"]);
    expect(rulesFiles).not.toContain("lazy-github-plan.rules");
  } finally {
    await rm(operatorHome, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});

/** Runs the provider's own execpolicy evaluator, never a re-implementation of it. */
async function evaluate(rulesPath: string, command: string[]): Promise<string> {
  const proc = Bun.spawn(["codex", "execpolicy", "check", "--rules", rulesPath, "--", ...command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  const result = JSON.parse(output) as { decision?: string };
  return result.decision ?? "allow";
}

const REPRESENTATIVE: Record<AuthorityProfile, { forbidden: string[]; allowed: string[] }> = {
  "lazy-github-plan": { forbidden: ["git", "push"], allowed: ["gh", "issue", "list"] },
  "lazy-github-code": { forbidden: ["gh", "issue", "close", "1"], allowed: ["git", "commit", "-m", "x"] },
  "lazy-azure-plan": { forbidden: ["az", "boards", "query"], allowed: ["git", "commit", "-m", "x"] },
  "lazy-azure-code": { forbidden: ["gh", "pr", "create"], allowed: ["git", "commit", "-m", "x"] },
  "lazy-review": { forbidden: ["apply_patch"], allowed: ["git", "log"] },
};

test.skipIf(!Bun.which("codex"))(
  "cada perfil de Codex reporta forbidden para un comando prohibido y no-forbidden para uno permitido, segun el evaluador del proveedor",
  async () => {
    for (const profile of AUTHORITY_PROFILES) {
      const { forbidden, allowed } = REPRESENTATIVE[profile];
      const rulesPath = codexRulesPath(profile);
      expect(`${profile} forbidden: ${await evaluate(rulesPath, forbidden)}`).toBe(`${profile} forbidden: forbidden`);
      const allowedDecision = await evaluate(rulesPath, allowed);
      expect(`${profile} allowed: ${allowedDecision === "forbidden"}`).toBe(`${profile} allowed: false`);
    }
  },
);
