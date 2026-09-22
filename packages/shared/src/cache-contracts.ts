import type { RuntimeModelProvider, RuntimeUsage } from './contracts.js';

/**
 * Bumping this invalidates every derived cache key. It is part of the key itself
 * so a change in key shape can never silently reuse entries built under the old
 * shape.
 */
export const CACHE_CONTRACT_POLICY_VERSION = 'cache-contract-v1' as const;

/** The four layers are cached for different reasons and expire on different inputs. */
export type DerivedCacheLayer = 'file_index' | 'summary' | 'context_bundle' | 'role_template';

/**
 * Whether the platform can ask this provider/model/endpoint for prompt caching.
 * `unknown` is a real state: a provider that reports no cache counters has not
 * told us it missed, so it must not be recorded as a zero-token miss.
 */
export type RuntimeCacheCapability = 'supported' | 'unsupported' | 'unknown';

export type UsageAvailability = 'reported' | 'unknown';

/**
 * Private entries belong to one session, requirement, role and lifecycle
 * generation. Shared entries hold no session-derived content at all, which is
 * why they carry a template id instead of an identity.
 */
export type DerivedCacheScope =
  | {
      kind: 'private';
      sessionId: string;
      workItemId: string;
      agentId: string;
      generation: number;
    }
  | { kind: 'shared'; templateId: string };

/**
 * The real business inputs a derived entry depends on. Progress events,
 * heartbeats and streaming deltas are deliberately absent: including them would
 * invalidate every layer on every token of output.
 */
export type CacheDependencyInputs = {
  workItemRevision: number;
  decisionLedgerRevision: number;
  fileHashes: Record<string, string>;
  toolCatalogVersion: string;
  policyVersion: string;
  modelConfigVersion: string;
};

export type NormalizedUsageCost = {
  amount: number;
  priceVersion: string;
  basis: 'actual' | 'estimated';
};

/**
 * One invocation's usage expressed in platform terms rather than provider terms.
 *
 * `logicalInputTokens` is what the model had to read, cached or not. It exists
 * because providers disagree about whether their input counter already contains
 * the cached prefix, and adding the cache counters onto a total that already
 * includes them double-counts the same prompt.
 */
export type NormalizedRuntimeUsage = {
  provider: RuntimeModelProvider;
  availability: UsageAvailability;
  cacheCapability: RuntimeCacheCapability;
  /** True when the provider's own input counter already contains the cache read. */
  inputTokensIncludeCacheRead: boolean;
  logicalInputTokens?: number;
  uncachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  model?: string;
  cost?: NormalizedUsageCost;
};

export type NormalizeRuntimeUsageInput = {
  provider: RuntimeModelProvider;
  raw: RuntimeUsage | undefined;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  cacheCapability?: RuntimeCacheCapability;
  priceVersion?: string;
  costBasis?: 'actual' | 'estimated';
};

/**
 * Whether a provider's input counter is inclusive of the cached prefix.
 *
 * OpenAI-compatible responses report `prompt_tokens` as the whole prompt with
 * `cached_tokens` as a subset of it. Anthropic-compatible responses report
 * `input_tokens` as the uncached remainder, with cache reads and writes as
 * separate counters. Getting this backwards either double-counts or loses the
 * cached prefix, so it is stated per provider rather than guessed.
 */
const INPUT_INCLUDES_CACHE_READ: Readonly<Record<RuntimeModelProvider, boolean>> = {
  'openai-compatible': true,
  'anthropic-compatible': false,
  ollama: false
};

function positiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

export function normalizeRuntimeUsage(input: NormalizeRuntimeUsageInput): NormalizedRuntimeUsage {
  const capability = input.cacheCapability ?? 'unknown';
  const inputTokensIncludeCacheRead = INPUT_INCLUDES_CACHE_READ[input.provider];
  const priceVersion = input.priceVersion ?? input.raw?.priceVersion;

  if (!input.raw) {
    // No usage came back. Reporting zeros here would turn "we do not know what
    // this cost" into "this was free", which is the one thing AC6 forbids.
    return {
      provider: input.provider,
      availability: 'unknown',
      cacheCapability: capability,
      inputTokensIncludeCacheRead
    };
  }

  // The counters are recorded when the provider actually sent them. Absence is
  // left absent rather than filled with 0: a configured cache that reported
  // nothing is unknown, not a proven miss. The capability flag answers a
  // different question (may we ask for caching) and does not fabricate counters.
  const cacheRead = positiveInteger(input.cacheReadInputTokens);
  const cacheWrite = positiveInteger(input.cacheWriteInputTokens);
  const reportedInput = positiveInteger(input.raw.inputTokens) ?? 0;

  const logicalInputTokens = inputTokensIncludeCacheRead ? reportedInput : reportedInput + (cacheRead ?? 0);
  const uncachedInputTokens = inputTokensIncludeCacheRead
    ? Math.max(0, reportedInput - (cacheRead ?? 0))
    : reportedInput;

  return {
    provider: input.provider,
    availability: 'reported',
    cacheCapability: capability,
    inputTokensIncludeCacheRead,
    logicalInputTokens,
    uncachedInputTokens,
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: cacheWrite }),
    outputTokens: positiveInteger(input.raw.outputTokens) ?? 0,
    ...(input.raw.model ? { model: input.raw.model } : {}),
    // An amount without a price version cannot be explained later, so it is not
    // reportable at all. Silence is preferable to an unattributable number.
    ...(typeof input.raw.cost === 'number' && priceVersion
      ? {
          cost: {
            amount: input.raw.cost,
            priceVersion,
            basis: input.costBasis ?? input.raw.costBasis ?? 'actual'
          } satisfies NormalizedUsageCost
        }
      : {})
  };
}

export type UsageBreakdownAttempt = NormalizeRuntimeUsageInput & { attemptId: string };

export type UsageBreakdown = {
  logicalInputTokens: number;
  uncachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reportedAttempts: number;
  /** Attempts whose cost is unmeasured. Kept separate so totals stay honest. */
  unknownAttempts: number;
};

/**
 * Aggregates per-requirement usage. Keyed by `attemptId` so a replayed
 * settlement — a retried delivery, a duplicated event — cannot charge the same
 * call twice.
 */
export function summarizeUsageBreakdown(attempts: readonly UsageBreakdownAttempt[]): UsageBreakdown {
  const seen = new Set<string>();
  const breakdown: UsageBreakdown = {
    logicalInputTokens: 0,
    uncachedInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reportedAttempts: 0,
    unknownAttempts: 0
  };

  for (const attempt of attempts) {
    if (seen.has(attempt.attemptId)) continue;
    seen.add(attempt.attemptId);

    const normalized = normalizeRuntimeUsage(attempt);
    if (normalized.availability === 'unknown') {
      breakdown.unknownAttempts += 1;
      continue;
    }

    breakdown.reportedAttempts += 1;
    breakdown.logicalInputTokens += normalized.logicalInputTokens ?? 0;
    breakdown.uncachedInputTokens += normalized.uncachedInputTokens ?? 0;
    breakdown.cacheReadInputTokens += normalized.cacheReadInputTokens ?? 0;
    breakdown.cacheWriteInputTokens += normalized.cacheWriteInputTokens ?? 0;
    breakdown.outputTokens += normalized.outputTokens ?? 0;
  }

  return breakdown;
}

/**
 * Canonically serialises only the inputs a derived value genuinely depends on.
 * Extra fields on the caller's object are ignored by construction: each
 * dependency is read by name, so an unrelated progress or heartbeat field cannot
 * leak into the fingerprint and invalidate a whole layer.
 *
 * This returns a canonical string rather than a digest because `shared` is also
 * consumed by the browser workspaces, which have no Node crypto. Callers that
 * want a short fixed-width key hash this server-side, where `node:crypto` is
 * available. Equality of this string is the authority either way.
 */
export function cacheDependencyFingerprint(inputs: CacheDependencyInputs): string {
  const fileHashes = Object.entries(inputs.fileHashes)
    .map(([path, hash]) => [path, hash] as const)
    // Object key order is not part of the dependency: two callers that collected
    // the same files in a different order must land on the same fingerprint.
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));

  return JSON.stringify({
    policy: CACHE_CONTRACT_POLICY_VERSION,
    workItemRevision: inputs.workItemRevision,
    decisionLedgerRevision: inputs.decisionLedgerRevision,
    fileHashes,
    toolCatalogVersion: inputs.toolCatalogVersion,
    policyVersion: inputs.policyVersion,
    modelConfigVersion: inputs.modelConfigVersion
  });
}

const KEY_DELIMITER = '|';

function keySegment(value: string): string {
  // A raw delimiter inside an id would let one scope forge another's key.
  return value.replaceAll(KEY_DELIMITER, '%7C');
}

/**
 * Builds the cache key. Identity segments stay readable so a key can be matched
 * against a live session without a lookup table, which is what makes
 * lifecycle checks on read and on backfill cheap enough to always run.
 */
export function derivedCacheKey(input: {
  layer: DerivedCacheLayer;
  scope: DerivedCacheScope;
  dependencyFingerprint: string;
}): string {
  const head = [CACHE_CONTRACT_POLICY_VERSION, input.layer];

  const body =
    input.scope.kind === 'private'
      ? [
          'private',
          keySegment(input.scope.sessionId),
          keySegment(input.scope.workItemId),
          keySegment(input.scope.agentId),
          String(input.scope.generation)
        ]
      : ['shared', keySegment(input.scope.templateId)];

  return [...head, ...body, keySegment(input.dependencyFingerprint)].join(KEY_DELIMITER);
}

/**
 * Whether a key belongs to this session at this generation. Used before serving
 * a hit and again before a backfill lands, so a build that started before a
 * delete or a recovery cannot write into the current state.
 */
export function isCacheKeyScopedTo(key: string, scope: { sessionId: string; generation: number }): boolean {
  const parts = key.split(KEY_DELIMITER);
  const [policy, , kind, sessionId, , , generation] = parts;
  if (policy !== CACHE_CONTRACT_POLICY_VERSION) return false;
  if (kind !== 'private') return false;
  return sessionId === keySegment(scope.sessionId) && generation === String(scope.generation);
}
