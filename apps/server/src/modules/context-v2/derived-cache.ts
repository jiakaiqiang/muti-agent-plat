import { isCacheKeyScopedTo } from '@agent-cluster/shared';

export type DerivedCacheScopeCheck = {
  sessionId: string;
  generation: number;
};

/**
 * One outcome per operation, mutually exclusive, so a hit rate can be computed
 * as hit / (hit + miss + expired) without double counting.
 */
export type DerivedCacheOutcome = 'hit' | 'miss' | 'expired' | 'evicted' | 'rejected_backfill';

export type DerivedCacheOptions = {
  maxEntries: number;
  ttlMs: number;
  now?: () => number;
  /**
   * Observability hook. The cache itself stays free of any metrics dependency;
   * the owner decides what to record and, crucially, which labels to attach.
   */
  onOutcome?: (outcome: DerivedCacheOutcome) => void;
};

export type DerivedCacheStats = {
  size: number;
  maxEntries: number;
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
  /** Builds that finished after their scope stopped being current. */
  rejectedBackfills: number;
};

type Entry<T> = {
  value: T;
  expiresAt: number;
};

/**
 * Bounded store for values the platform can rebuild. Two properties matter more
 * than hit rate:
 *
 * - The key is not authority. Every read and every write re-checks the caller's
 *   session and lifecycle generation against the key, so a stale build cannot
 *   serve or resurrect content for a session that was deleted or recovered
 *   while the build was in flight.
 * - Capacity is fixed. Entries are derived, so dropping one costs a rebuild;
 *   keeping an unbounded number costs memory that grows with session count.
 *
 * Insertion order of a `Map` is the LRU order here: a hit deletes and reinserts
 * the key to move it to the newest position, and eviction takes the oldest.
 */
export class DerivedCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onOutcome: (outcome: DerivedCacheOutcome) => void;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;
  private rejectedBackfills = 0;

  constructor(options: DerivedCacheOptions) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries));
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs));
    this.now = options.now ?? (() => Date.now());
    this.onOutcome = options.onOutcome ?? (() => undefined);
  }

  get(key: string, scope: DerivedCacheScopeCheck): T | undefined {
    if (!isCacheKeyScopedTo(key, scope)) {
      this.misses += 1;
      this.onOutcome('miss');
      return undefined;
    }

    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      this.onOutcome('miss');
      return undefined;
    }

    if (entry.expiresAt <= this.now()) {
      // Drop it here rather than waiting for a sweep: an expired entry that keeps
      // its slot would shrink usable capacity for no benefit.
      this.entries.delete(key);
      this.expirations += 1;
      this.misses += 1;
      this.onOutcome('expired');
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    this.onOutcome('hit');
    return entry.value;
  }

  /**
   * Returns false when the write was refused because the key no longer belongs
   * to the caller's scope. Callers treat that as "the build is obsolete", not as
   * an error to retry.
   */
  set(key: string, value: T, scope: DerivedCacheScopeCheck): boolean {
    if (!isCacheKeyScopedTo(key, scope)) {
      this.rejectedBackfills += 1;
      this.onOutcome('rejected_backfill');
      return false;
    }

    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
      this.onOutcome('evicted');
    }

    return true;
  }

  /**
   * Removes one session's entries, leaving every sibling session intact. Called
   * on delete and on recovery, where the session's derived state must stop being
   * visible immediately rather than at the next TTL.
   */
  invalidateSession(sessionId: string): number {
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      // Generation is irrelevant here: every generation of this session goes.
      if (this.keySessionId(key) === sessionId) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Drops entries whose dependency fingerprint is no longer current. */
  invalidateFingerprint(fingerprint: string): number {
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (key.endsWith(`|${fingerprint}`)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
  }

  /** Counters only — never keys or values, which would put private text in logs. */
  stats(): DerivedCacheStats {
    return {
      size: this.entries.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
      rejectedBackfills: this.rejectedBackfills
    };
  }

  private keySessionId(key: string): string | undefined {
    const parts = key.split('|');
    return parts[2] === 'private' ? parts[3] : undefined;
  }
}
