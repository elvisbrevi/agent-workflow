/**
 * The silence a coding session is allowed between stream events.
 *
 * A session that stops emitting has stopped working, and an unattended drain
 * cannot tell that from a session still thinking: both look like a process that
 * has not exited. OpenCode used to answer this by nudging the session back to
 * life and resuming it, unlimited times, never failing — which only worked while
 * there was a terminal marker to nudge it toward. With the marker gone the nudge
 * has no destination, so the watchdog kills the process instead and the run
 * descends its fallback chain: a stuck agent and an exhausted quota mean the same
 * thing to the loop, which is that this rung is not producing (ADR-0039).
 *
 * The default is generous on purpose. Silence is measured between events, and a
 * session running a long command emits nothing while it runs: a forty-minute test
 * suite must not read as a hang. Thirty minutes is what fits that without letting
 * a genuinely stuck session eat a night.
 */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;

/** Whole minutes, for the operator line and the run record. */
export const idleTimeoutMinutes = (timeoutMs: number): number =>
  Math.max(1, Math.round(timeoutMs / 60_000));

export const describeIdleTimeout = (cli: string, timeoutMs: number): string =>
  `${cli} estuvo ${idleTimeoutMinutes(timeoutMs)} min sin emitir eventos; se termina la sesión`;

/**
 * A timer every adapter arms the same way: `touch` on each line the agent emits,
 * `disarm` when the stream ends, and `fired` afterwards to tell a killed session
 * from one that exited on its own.
 */
export class IdleWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timedOut = false;

  constructor(
    readonly timeoutMs: number,
    private readonly onIdle: () => void,
  ) {}

  get fired(): boolean {
    return this.timedOut;
  }

  /** Total silence the session sat in, which the coordinator excludes from effort. */
  get idleMs(): number {
    return this.timedOut ? this.timeoutMs : 0;
  }

  touch(): void {
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timedOut = true;
      this.onIdle();
    }, this.timeoutMs);
  }

  disarm(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
