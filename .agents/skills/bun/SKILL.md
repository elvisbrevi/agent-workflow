---
name: Bun
description: Use when building, testing, and deploying JavaScript/TypeScript applications. Reach for Bun when you need to run scripts, manage dependencies, bundle code, or test applications with a single unified toolkit.
metadata:
    mintlify-proj: bun
    version: "1.0"
---

# Bun Skill Reference

## Product Summary

Bun is an all-in-one JavaScript/TypeScript toolkit that replaces Node.js, npm, and bundlers. It includes a fast runtime (powered by JavaScriptCore), a package manager, a test runner, and a bundler—all in a single executable. Bun starts 4x faster than Node.js and installs packages up to 25x faster than npm.

**Key files and commands:**
- Configuration: `bunfig.toml` (optional, for Bun-specific settings)
- Package management: `bun install`, `bun add`, `bun remove`
- Runtime: `bun run <file>` or `bun <file>` (supports `.ts`, `.tsx`, `.js`, `.jsx`)
- Testing: `bun test` (Jest-compatible)
- Bundling: `bun build <entry> --outdir ./out`
- Script execution: `bun run <script>` from `package.json`

**Primary docs:** https://bun.com/docs

## When to Use

Reach for Bun when:
- Running TypeScript/JSX files directly without a build step
- Installing or managing npm dependencies (faster than npm/yarn/pnpm)
- Writing and running tests (Jest-compatible API)
- Bundling JavaScript/TypeScript for browsers or servers
- Executing package.json scripts (28x faster than npm run)
- Building full-stack applications with server and client code
- Setting up a new project with `bun init`
- Deploying to production with `bun build --compile` for single-file executables

## Quick Reference

### Essential Commands

| Task | Command |
|------|---------|
| Initialize project | `bun init` |
| Run TypeScript file | `bun run index.ts` or `bun index.ts` |
| Run package.json script | `bun run <script>` |
| Install dependencies | `bun install` |
| Add a package | `bun add <package>` |
| Add dev dependency | `bun add -d <package>` |
| Remove a package | `bun remove <package>` |
| Run tests | `bun test` |
| Watch tests | `bun test --watch` |
| Bundle code | `bun build ./index.ts --outdir ./out` |
| Watch bundler | `bun build ./index.ts --outdir ./out --watch` |
| Execute npm package | `bunx <package>` |

### File Conventions

- Test files: `*.test.ts`, `*.test.js`, `*_test.ts`, `*.spec.ts`, `*_spec.js`
- Configuration: `bunfig.toml` (project root or `~/.bunfig.toml` for global)
- Package metadata: `package.json` (standard npm format)
- TypeScript config: `tsconfig.json` (standard TypeScript)
- Lockfile: `bun.lock` (text-based, committed to version control)

### Configuration Sections in bunfig.toml

```toml
# Runtime behavior
[serve]
port = 3000

# Package manager
[install]
optional = true
dev = true
peer = true
production = false
linker = "hoisted"  # or "isolated"

# Test runner
[test]
root = "."
coverage = false
timeout = 5000

# Script execution
[run]
shell = "system"  # or "bun"
bun = true        # alias node to bun
silent = false
```

## Decision Guidance

### When to Use Hoisted vs. Isolated Installs

| Aspect | Hoisted (`hoisted`) | Isolated (`isolated`) |
|--------|-------------------|----------------------|
| **Use when** | Traditional npm behavior needed; single-package projects | Monorepos; preventing phantom dependencies |
| **node_modules layout** | Flat, shared directory | Nested with `.bun/` virtual store |
| **Phantom dependencies** | Allowed (can import undeclared packages) | Prevented (strict isolation) |
| **Disk space** | Higher (duplication) | Lower (shared store with symlinks) |
| **Default for** | Existing projects; new single-package projects | New workspaces/monorepos |

### When to Use bun build vs. bun run

| Scenario | Use |
|----------|-----|
| Development, running scripts, testing | `bun run` or `bun <file>` |
| Production bundles for browsers | `bun build --target browser` |
| Server code bundling | `bun build --target bun` |
| Node.js compatibility needed | `bun build --target node --format cjs` |
| Single-file executable | `bun build --compile` |

### When to Use --watch vs. --hot

| Flag | Use |
|------|-----|
| `--watch` | Restart process on file changes (runtime, tests, bundler) |
| `--hot` | Hot module replacement for dev servers (bundler only) |

## Workflow

### 1. Set Up a New Project

```bash
bun init my-app
cd my-app
```

Choose a template (Blank, React, or Library). Bun creates `package.json`, `tsconfig.json`, and a sample file.

### 2. Install Dependencies

```bash
bun install
# or add specific packages
bun add react
bun add -d typescript
```

Bun reads `package.json`, resolves dependencies, and writes `bun.lock`. No `node_modules` folder is created by default if using isolated installs.

### 3. Write and Run Code

Create a TypeScript file (no transpilation step needed):

```typescript
// index.ts
const server = Bun.serve({
  port: 3000,
  fetch(req) {
    return new Response("Hello!");
  },
});
console.log(`Listening on ${server.url}`);
```

Run it:

```bash
bun run index.ts
# or
bun index.ts
```

### 4. Add Scripts to package.json

```json
{
  "scripts": {
    "dev": "bun run index.ts",
    "build": "bun build ./index.ts --outdir ./dist",
    "test": "bun test"
  }
}
```

Run with:

```bash
bun run dev
bun run build
bun run test
```

### 5. Write Tests

Create a test file:

```typescript
// math.test.ts
import { test, expect } from "bun:test";

test("2 + 2 = 4", () => {
  expect(2 + 2).toBe(4);
});
```

Run tests:

```bash
bun test
bun test --watch
bun test --coverage
```

### 6. Bundle for Production

```bash
bun build ./index.ts --outdir ./dist --minify
```

For a single-file executable:

```bash
bun build ./index.ts --compile --outdir ./dist
```

### 7. Configure bunfig.toml (Optional)

```toml
[serve]
port = 3000

[install]
linker = "isolated"

[test]
coverage = true
timeout = 10000
```

## Common Gotchas

- **Lifecycle scripts disabled by default**: Bun doesn't run `postinstall` scripts for security. Add packages to `trustedDependencies` in `package.json` to allow them.

- **Flag placement matters**: Use `bun --watch run dev`, not `bun run dev --watch`. Flags after the script name are passed to the script itself.

- **TypeScript errors on Bun global**: Install `@types/bun` and add `"types": ["bun"]` to `tsconfig.json` compilerOptions (required for TypeScript 6+).

- **Auto-install disabled in CI**: Set `[install] auto = "disable"` in `bunfig.toml` or use `bun ci` (equivalent to `bun install --frozen-lockfile`) in CI/CD pipelines.

- **Lockfile format changed**: Bun v1.2+ uses text-based `bun.lock` by default. Old projects have binary `bun.lockb`; migrate with `bun install --save-text-lockfile --frozen-lockfile --lockfile-only`.

- **Node.js compatibility is not 100%**: Some Node.js APIs are not fully implemented. Check the [Node.js compatibility matrix](https://bun.com/docs/runtime/nodejs-compat) before relying on specific modules.

- **Bundler doesn't replace tsc**: Use `bun build` for bundling, not for type checking. Run `tsc --noEmit` separately if you need type checking.

- **Test files must match patterns**: Bun only discovers `*.test.ts`, `*_test.ts`, `*.spec.ts`, `*_spec.ts` files. Ensure test files follow these conventions.

- **Workspaces require glob patterns**: Use `"workspaces": ["packages/*"]` in root `package.json`, not individual paths.

## Verification Checklist

Before submitting work with Bun:

- [ ] Run `bun install` to ensure dependencies are locked in `bun.lock`
- [ ] Run `bun test` and verify all tests pass
- [ ] Run `bun run build` (or your build script) and verify output is generated
- [ ] Check `bunfig.toml` for any environment-specific settings that should be committed
- [ ] Verify `bun.lock` is committed to version control (not `.gitignore`d)
- [ ] Test with `bun run <script>` to ensure scripts execute correctly
- [ ] For production builds, run `bun build --minify` and verify output size
- [ ] Check that TypeScript files have no type errors (run `tsc --noEmit` if needed)
- [ ] Verify `package.json` has correct `"type": "module"` or `"type": "commonjs"` if needed
- [ ] For deployments, test with `bun ci` to simulate CI/CD behavior

## Resources

**Comprehensive navigation:** https://bun.com/docs/llms.txt

**Critical documentation pages:**
1. [Bun Runtime](https://bun.com/docs/runtime) — Running files and scripts
2. [Package Manager](https://bun.com/docs/pm/cli/install) — Installing and managing dependencies
3. [Bundler](https://bun.com/docs/bundler) — Bundling and building for production
4. [Test Runner](https://bun.com/docs/test) — Writing and running tests

---

> For additional documentation and navigation, see: https://bun.com/docs/llms.txt