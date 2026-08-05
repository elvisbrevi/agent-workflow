# Mixed-provider execution-profile fallback chains

A `issue-killer` execution profile is an indivisible pairing of CLI, model,
command, shell, and adapter options. Each profile may declare an ordered
`fallbacks` list whose entries are themselves complete execution profiles.
A chain may mix Claude, Codex, and OpenCode profiles in any order selected
by the operator.

The runner consumes a fallback entry only when the previous worker's
provider failure is classified as `provider_quota`, `provider_rate_limit`,
or `provider_model_unavailable`. The classification is normalized by the
active runtime adapter; provider-specific event and diagnostic formats
remain inside the adapter. Implementation failures, generic non-zero
exits, malformed output, `BLOCKED`, and `FAILED` never consume a fallback.

Transitions preserve the issue scope, branch, worktree state, and the
ordered chain position. Before the destination CLI runs, the supervisor
persists the failed profile, the next profile, the remaining chain, and
the normalized failure category into the checkpoint, reconciles tracker
and pull-request state against the live tracker, and only then activates
the destination adapter through the shared runtime activation path.

Session ownership is capability-based. A captured session id is recorded
alongside the CLI that captured it. The same adapter on the same CLI may
resume a compatible session. A cross-CLI transition always launches a
fresh destination session constrained to the checkpointed issue and the
existing worktree; the previous native session id is never forwarded to
the destination CLI because each CLI's session format is opaque to the
others.

The public status protocol is unchanged. The orchestrator still consumes
`ISSUE_COMPLETED`, `QUEUE_EMPTY`, `BLOCKED`, `FAILED`, and
`RECOVERY_REQUIRED` and remains tracker-neutral: GitHub and Azure DevOps
keep their independent PR, merge, HU/ticket, and closure rules through
the same normalized tracker adapter interface.

Configuration, checkpoints, lock status, and any retained artifact
exclude credentials, complete prompts, and complete provider commands.
Restart recovery restores the active profile at the persisted chain
position; chain drift, profile drift, branch mismatch, stale base
identity, or ambiguous tracker/PR state retain `RECOVERY_REQUIRED`
without launching unsafe work.
