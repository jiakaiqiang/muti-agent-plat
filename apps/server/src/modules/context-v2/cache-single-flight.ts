/**
 * Collapses concurrent builds of the same cache key into one, and stops calling
 * an origin that keeps failing.
 *
 * Two separate problems, one place because they share the per-key state:
 *   - A hundred callers arriving on a cold key must not start a hundred builds
 *     (each build is a model call or a full context assembly).
 *   - A build that keeps failing must stop being retried, or a broken origin
 *     turns into an unbounded retry loop that still draws on the requirement
 *     budget.
 *
 * Scope: this is in-process only. It solves the race between callers inside one
 * server, not the race between instances — cross-instance uniqueness is the
 * store's unique-key job, not this class's.
 */

export type SingleFlightResult<T> =
  | { status: 'built'; value: T; owner: boolean }
  | { status: 'failed'; error: unknown; owner: boolean }
  | { status: 'circuit_open' };

type KeyState<T> = {
  inFlight?: Promise<T>;
  consecutiveFailures: number;
};

export type CacheSingleFlightOptions = {
  /**
   * Consecutive failed builds for one key before further builds are refused.
   * Bounded rather than unlimited: the point of a fallback to origin is to
   * survive a cache outage, not to convert it into a retry storm.
   */
  maxConsecutiveFailures?: number;
};

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export class CacheSingleFlight<T> {
  private readonly states = new Map<string, KeyState<T>>();
  private readonly maxConsecutiveFailures: number;

  constructor(options: CacheSingleFlightOptions = {}) {
    this.maxConsecutiveFailures = Math.max(1, options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES);
  }

  /**
   * Runs `build` for `key`, or joins the build already running for it.
   *
   * `owner` tells the caller whether it actually performed the build. Only the
   * owner should write the result back: a joiner's scope was validated at a
   * different moment, so letting it backfill would reintroduce the late-write
   * problem the ownership check exists to prevent.
   */
  async run(key: string, build: () => Promise<T>): Promise<SingleFlightResult<T>> {
    const state = this.states.get(key) ?? { consecutiveFailures: 0 };
    this.states.set(key, state);

    if (state.inFlight) {
      try {
        const value = await state.inFlight;
        return { status: 'built', value, owner: false };
      } catch (error) {
        return { status: 'failed', error, owner: false };
      }
    }

    if (state.consecutiveFailures >= this.maxConsecutiveFailures) {
      return { status: 'circuit_open' };
    }

    const pending = build();
    state.inFlight = pending;

    try {
      const value = await pending;
      state.consecutiveFailures = 0;
      return { status: 'built', value, owner: true };
    } catch (error) {
      state.consecutiveFailures += 1;
      return { status: 'failed', error, owner: true };
    } finally {
      // Always release the slot: a build that failed must leave the key
      // buildable again, and a leaked slot would wedge the key permanently.
      state.inFlight = undefined;
      if (state.consecutiveFailures === 0) this.states.delete(key);
    }
  }

  inFlightCount(): number {
    let count = 0;
    for (const state of this.states.values()) if (state.inFlight) count += 1;
    return count;
  }

  /** Clears the failure budget for a key, e.g. after the origin is known good. */
  reset(key: string): void {
    this.states.delete(key);
  }
}
