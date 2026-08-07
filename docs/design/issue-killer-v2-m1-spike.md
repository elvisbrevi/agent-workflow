# Issue-Killer V2 — M1 SDK Spike Report

Status: M1 spike complete (issue #78). This document records the
pinning, contract surface, port strategy, and gap analysis proven by the
minimal `agent/issue-killer` package before any V2 runtime lands.

Authoritative inputs remain the parent spec [issue #76](../../CONTEXT.md
→ issues), the [V2 contract](../design/issue-killer-v2-contract.md), the
[V2 design](../design/issue-killer.md), and the migration plan
[`plan-migracion-issue-killer-typescript-bun-opencode.md`](../../plan-migracion-issue-killer-typescript-bun-opencode.md).

## Pinned runtime / SDK matrix

| Surface                     | Pinned value       | Source                                  |
|-----------------------------|--------------------|-----------------------------------------|
| Bun                         | `1.3.3`            | `bun --version` at spike build          |
| OpenCode CLI                | `1.18.14`          | `opencode --version` at spike build     |
| `@opencode-ai/sdk`          | `1.18.14` (exact)  | `agent/issue-killer/package.json`       |
| `typescript` (dev)          | `5.9.2` (exact)    | `agent/issue-killer/package.json`       |
| `@types/bun` (dev)          | `1.3.3` (exact)    | `agent/issue-killer/package.json`       |
| Lockfile                    | `bun.lock` present | `agent/issue-killer/bun.lock`           |

The agent area has no `^`/`~`/`latest` on the SDK. `bun install --frozen-lockfile`
is reproducible against this matrix. The values will be re-pinned at every V2
milestone that touches the package manifest and the matrix is regenerated.

## Locally observed versions

The spike was verified with the pinned matrix in the operator's local
environment:

- Bun `1.3.3` plus the OpenCode CLI `1.18.14` available on `PATH`.
- The OpenCode server, started through `createOpencode({ hostname:
  "127.0.0.1", port: 0 })`, returned a non-empty `version` field through
  `client.global.health()` (`test/contract/opencode-sdk.test.ts`).

The contract matrix in [`issue-killer-v2-contract.md`](../design/issue-killer-v2-contract.md)
already required health/version gating before a worker prompt. The
`version` field is treated as a non-empty string by the spike; the gating
predicate that compares it to a pinned allowed range is added at the V2
runtime boundary and is intentionally out of scope for M1.

## Port strategy

| Decision                                            | Outcome                                                |
|-----------------------------------------------------|--------------------------------------------------------|
| `127.0.0.1` only (never `0.0.0.0`, never an external hostname) | Validated by every contract and integration test |
| `port: 0` (ephemeral, OS-assigned)                   | Validated; concurrent `createOpencode` calls receive distinct loopback ports (`test/contract/opencode-sdk-port.test.ts`) |
| Reserve-and-retry                                    | Not required against this SDK matrix                   |
| `server.close()` release                            | Validated by repeated `createOpencode` + `server.close()` loops in `test/contract/opencode-sdk.test.ts` |

The SDK exposes `createOpencode({ hostname, port, signal, timeout,
config })` and returns `{ client, server: { url, close() } }`. The
`server.close()` call is synchronous and the loopback port is released
immediately; a subsequent `createOpencode` call binds a fresh ephemeral
port. The spike uses `port: 0` everywhere and does not implement a
reserve-and-retry loop; a later milestone may add bounded retries only if
a future SDK version stops honoring `port: 0` on macOS/Linux or under
tightened container policy.

## Essential SDK operations

The following operations from the [parent spec](../../CONTEXT.md) and the
[V2 contract](../design/issue-killer-v2-contract.md) are exercised by
the spike at the v2 entry point (`@opencode-ai/sdk/v2`) without a model
call. Every item is covered by a smoke test, not a fixture-only check.

| Operation                         | Used by                                                                   | Smoke proof |
|-----------------------------------|---------------------------------------------------------------------------|-------------|
| `createOpencode({ hostname, port })` | One supervisor-scoped server on `127.0.0.1:0`                          | `opencode-sdk.test.ts` |
| `server.close()`                  | Teardown after every test                                                 | `opencode-sdk.test.ts` |
| `client.global.health()`          | Health/version gate before a worker prompt                                | `opencode-sdk.test.ts` |
| `createOpencodeClient({ baseUrl, directory, throwOnError })` | Directory-scoped client for every operation            | `opencode-sdk.test.ts`, `opencode-sdk-session.test.ts` |
| `client.session.create({ directory })` | Begin a session scoped to the pinned directory                       | `opencode-sdk-session.test.ts` |
| `client.session.get({ sessionID, directory })` | Resume / verify session identity                                | `opencode-sdk-session.test.ts` |
| `client.session.abort({ sessionID, directory })` | Stop an in-flight session cleanly                              | `opencode-sdk-session.test.ts` |
| `client.session.delete({ sessionID, directory })` | Remove session after completion or fallback                       | `opencode-sdk-session.test.ts` |
| `client.event.subscribe({ directory })` | Drain ordered events for one session                              | `opencode-sdk-session.test.ts` |
| `client.session.prompt({ sessionID, directory, model, variant, format, parts })` | Worker prompt (live, opt-in only)             | `opencode-sdk-live.test.ts` |
| `PermissionConfig` propagation    | Autonomous permission mode after destructive confirmation                 | `opencode-sdk-live.test.ts`, fixtures `autonomousPermission` |

The `format` parameter is typed as `OutputFormatJsonSchema` (`type`,
`schema`, optional `retryCount`); the `parts` parameter lives on the same
body level as `format`, never inside it. The fixture
`test/fixtures/opencode-sdk-contract.ts` pins both shapes against the
SDK type exports so the next milestone does not memorize guessed
field names.

## SDK gap analysis

The spike ran against the v2 entry point of `@opencode-ai/sdk@1.18.14`.
Every operation listed in the V2 contract is supported. **No essential
gap was found.** The spike did not introduce any undocumented HTTP
wrappers and did not synthesize alternative endpoints.

The following operations were intentionally not exercised by the spike
because they belong to later milestones (the V2 runtime boundary):

- The structured worker outcome validation (object with `status`,
  `issue`, `summary`) is checked at the event pump seam, not the SDK.
- The opaque session id format `^[A-Za-z0-9_-]+$` and the 128-character
  ceiling are enforced at the checkpoint/state seam, not the SDK.
- Provider failure classification (`provider_quota`,
  `provider_rate_limit`, `provider_model_unavailable`) is decided from
  SDK error shapes at the runtime adapter; the spike captures
  `StructuredOutputError`, `ApiError`, and `EventSessionError` into
  fixtures so later milestones reuse the live shapes.

## Live model smoke

`test/integration/opencode-sdk-live.test.ts` documents an opt-in live
smoke. It stays skipped unless **all** of the following hold:

- `ISSUE_KILLER_OPENCODE_LIVE=1`
- `ISSUE_KILLER_OPENCODE_SANDBOX=1`
- `ISSUE_KILLER_OPENCODE_SANDBOX_DIR` resolves outside the repository
- `ISSUE_KILLER_OPENCODE_MODEL` matches `<provider>/<model>`
- `ISSUE_KILLER_OPENCODE_VARIANT` is set when a variant is required

The test refuses to bind the live smoke to the repository root or to
any path nested inside it, refuses an empty sandbox directory name, and
uses `127.0.0.1` + `port: 0` with `autonomousPermission` so the smoke
matches the V2 autonomous permission contract.

The smoke validates that `client.session.prompt` returns an assistant
message with `info.role === "assistant"` and a defined `info.structured`
payload. Running it consumes provider quota; M1 does not enable it by
default and the runner is not permitted to enable it against a
non-sandbox or production-shaped tracker.

## V1 Bash runner status

The V1 Bash runner under `agent/issue-killer/run.sh` and its sources
remain untouched. The suites that exercise the M1 surface on the V1
side stay green:

- `tests/issue_killer_test.sh`
- `tests/issue_killer_migration_test.sh`
- `tests/github_tracker_adapter_test.sh`
- `tests/install_test.sh`

The new TypeScript package is additive: it lives inside
`agent/issue-killer/` but does not shadow any Bash file, does not
publish a `bin`, and is not installed. The M2 milestone is the first
place that may add a V2 entrypoint or any installer change.

## Next milestones

| Milestone | Depends on | Touches the spike? |
|-----------|------------|--------------------|
| M2 (scaffold + pure domain + ports) | M1 | Reuses package layout, tsconfig, and fixtures; adds domain modules |
| M3 (config / state / lock / redaction) | M2 | Adds `CommandRunner`, checkpoint/atomic writer, opaque session id validation |
| M5 (OpenCode runtime + event pump + harness log) | M2/M3 | Wraps `createOpencode` + `createOpencodeClient` behind the OpenCodeRuntime port; persists redacted JSONL harness log |
