import type { ContextL1NavigationManifest, ContextL2ProjectMap } from '@agent-cluster/shared';
import { derivedCacheKey } from '@agent-cluster/shared';
import { workspaceMetrics } from '../../common/workspace-metrics.js';
import { DerivedCache, type DerivedCacheOptions, type DerivedCacheStats } from './derived-cache.js';

/** The only label this cache ever attaches. Session/requirement ids belong in traces. */
const BUNDLE_LAYER = 'file_index' as const;

/**
 * The part of a context envelope that is derived purely from the workspace
 * index and the token budget: the navigation manifest and the project map.
 * Evidence (L3) and summary memory (L5) change per call and are never cached.
 */
export type ContextBundle = {
  navigation: ContextL1NavigationManifest;
  projectMap: ContextL2ProjectMap;
};

export type ContextBundleScope = {
  sessionId: string;
  workItemId: string;
  agentId: string;
  generation: number;
};

/**
 * First real consumer of the derived cache. Keyed per session/requirement/role/
 * generation plus a fingerprint of everything the bundle is built from, so a
 * hit is only ever served back to the scope that built it and only while the
 * workspace it describes is unchanged.
 *
 * Caching happens before the runtime's pre-send budget check, not instead of
 * it: a cached bundle goes through the same `assertWithinInputBudget` as a fresh
 * one, which is what keeps a high hit rate from ever bypassing the 2A cap.
 */
export class ContextBundleCache {
  private readonly cache: DerivedCache<ContextBundle>;

  constructor(options: DerivedCacheOptions) {
    this.cache = new DerivedCache<ContextBundle>({
      ...options,
      // Layer + outcome only. A per-session series would grow with every session
      // ever seen, which is exactly the high-cardinality label the plan forbids.
      onOutcome: (outcome) => {
        workspaceMetrics.increment('context_bundle_cache_total', 1, { layer: BUNDLE_LAYER, outcome });
        options.onOutcome?.(outcome);
      }
    });
  }

  getOrBuild(input: {
    scope: ContextBundleScope;
    dependencyFingerprint: string;
    build: () => ContextBundle;
  }): ContextBundle {
    const key = derivedCacheKey({
      layer: BUNDLE_LAYER,
      scope: { kind: 'private', ...input.scope },
      dependencyFingerprint: input.dependencyFingerprint
    });
    const lifecycle = { sessionId: input.scope.sessionId, generation: input.scope.generation };

    const hit = this.cache.get(key, lifecycle);
    if (hit) return hit;

    const built = input.build();
    // The scope was validated a moment ago and the build is synchronous, so a
    // refused write here means the key itself is malformed rather than late.
    this.cache.set(key, built, lifecycle);
    return built;
  }

  invalidateSession(sessionId: string): number {
    return this.cache.invalidateSession(sessionId);
  }

  stats(): DerivedCacheStats {
    return this.cache.stats();
  }
}
