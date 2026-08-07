# Fallback reuses a resumable OpenCode session

An eligible OpenCode fallback continues the previous worker session when
`session.get()` confirms the same directory, issue, branch, base branch, and
base SHA. The next execution profile supplies its model on the same session;
the session id remains opaque and is validated before lookup.

If the session is missing or cannot be confirmed, the runtime starts a fresh
OpenCode session constrained to the checkpointed issue and branch. The
supervisor persists the failed profile, provider failure category, next
profile, and remaining chain before attempting that fallback. Local
configuration, tracker, branch, or base-identity drift remains
`RECOVERY_REQUIRED` and never selects another issue.
