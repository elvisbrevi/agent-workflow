# Record cumulative active agent effort

Azure ticket `Real Effort` records active implementation, testing, review,
correction, and merge-verification time in hours rounded upward to `0.25 h`,
excluding operator waits and provider retry backoff. The duration accumulates in
the drain's own run state across every fallback rung spent on the same ticket,
and is persisted as the `activeMs` field of the minimal checkpoint (ADR-0038) so
a crash does not lose hours already spent. Publication adds it to any
pre-existing field value exactly once rather than overwriting or double-counting
it.

Silence that trips the idle timeout is subtracted before publication: it was
elapsed time but not work. That replaces the per-interval `idleMs` accounting the
idle nudge required, which is gone with the nudge itself (ADR-0035) — a run now
subtracts one trailing silence per killed rung rather than tracking intervals.
