# OpenCode SDK is the sole issue-killer runtime

V2 of `issue-killer` runs on TypeScript under Bun and uses `@opencode-ai/sdk` as the only agent runtime integration. It does not invoke `opencode run --format json`, and it does not port Claude or Codex adapters. Variety of models comes only from OpenCode **execution profiles** and their **fallback chain**.

This replaces the multi-CLI architecture recorded in older decisions: Claude session persistence defaults and mixed-provider fallback chains are withdrawn so readers cannot treat them as current domain language. Session create/get/delete, event subscription, abort, and server lifecycle go through the SDK; resume requires `session.get()` to confirm directory, issue, branch, and base identity. An eligible fallback may change the profile model on that confirmed session as defined by ADR 0015.

Direct runtime dependencies stay minimal and exact-pinned (`@opencode-ai/sdk`, plus dev-only `typescript` and `@types/bun`). Any additional runtime dependency needs its own ADR. Checkpoint format stays compatible with the existing `key=value` file during cutover so recovery fixtures remain valid.

An **opaque session id** may be persisted only after allowlist validation (`^[A-Za-z0-9_-]+$`, max 128 characters). Invalid ids are never written, resumed, or used to delete resources; recovery fails closed. GitHub and Azure both require live **completion verification** after merge: GitHub issue closed; Azure delivery ticket in its configured completed state (e.g. Done).

After the operator's destructive confirmation, the OpenCode instance uses full autonomous permissions for that run. The supervisor also writes a **harness execution log** from the event pump (commands and file mutations observed), never by asking the model to journal, and never by feeding that log back into the prompt. The log directory is a required credential-free `log_dir` setting in the operator config TOML; startup fails if it is missing or not writable. Each queue run writes one redacted JSONL harness log under that directory; V2 does not auto-rotate logs.
