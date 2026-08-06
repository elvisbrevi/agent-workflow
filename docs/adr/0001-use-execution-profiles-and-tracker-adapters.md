# Use execution profiles and tracker adapters

`issue-killer` separates autonomous issue orchestration from both the agent runtime and the issue tracker. Operators select a named, validated **execution profile**: an indivisible OpenCode runtime plus provider/model pairing. Tracker adapters provide equivalent lifecycle operations through GitHub `gh` or Azure DevOps `az`. This avoids invalid runtime combinations and keeps provider-specific event, permission, recovery, and tracker semantics out of the orchestration loop.

The only supported agent runtime is OpenCode via `@opencode-ai/sdk`. Claude and Codex adapters are out of scope for V2. An **execution profile** may declare an ordered **fallback chain** of other OpenCode profiles. Automatic fallback is restricted to explicit provider failures such as exhausted quota, persistent rate limiting, or model unavailability; ordinary transport, implementation, and malformed-output failures keep stop/retry behavior and never consume fallback.

Issue identity is **host-owned**: the supervisor selects and pins the tracker item before creating a **worker session**. Queue advance requires **completion verification** against the live tracker for every tracker, not a worker status marker alone. Session identity is an **opaque session id** confirmed through the OpenCode session API; recovery never infers the issue from a branch or filesystem artifact.

Tracker selection remains repository-owned and derived from the Git remote plus `docs/agents/issue-tracker.md`, rather than being coupled to a machine-level execution profile. Configuration stays credential-free.
