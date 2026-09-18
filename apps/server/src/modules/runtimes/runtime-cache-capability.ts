import type { RuntimeModelProvider, RuntimeUsage } from '@agent-cluster/shared';
import { normalizeRuntimeUsage } from '@agent-cluster/shared';

/**
 * Prompt caching is a property of one provider/model/endpoint combination, not of
 * a provider. A model name we have not declared, or a declared model reached
 * through someone else's gateway, is `unknown`/`unsupported` rather than assumed
 * to behave like the vendor's own endpoint.
 */
export type DeclaredCacheCapability = {
  capability: 'supported' | 'unsupported' | 'unknown';
  /** Only a declared-supported combination gets cache parameters on the request. */
  sendCacheParameters: boolean;
  /** No cache support is never a reason to refuse a call. */
  blocksExecution: false;
};

type CacheDeclaration = {
  provider: RuntimeModelProvider;
  /** The vendor endpoints whose caching behaviour this declaration describes. */
  hosts: readonly string[];
  models: readonly string[];
};

/**
 * Declared combinations only. Adding an entry means someone checked that
 * provider's documentation and confirmed the behaviour for that model and
 * endpoint; it is deliberately short rather than pattern-matched.
 */
const CACHE_DECLARATIONS: readonly CacheDeclaration[] = [
  {
    provider: 'anthropic-compatible',
    hosts: ['api.anthropic.com'],
    models: ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001']
  },
  {
    provider: 'openai-compatible',
    hosts: ['api.openai.com'],
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o4-mini']
  }
];

function endpointHost(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return undefined;
  }
}

export function declaredCacheCapability(input: {
  provider: RuntimeModelProvider;
  model: string;
  endpoint: string;
}): DeclaredCacheCapability {
  const declaration = CACHE_DECLARATIONS.find(
    (entry) => entry.provider === input.provider && entry.models.includes(input.model)
  );

  // Nothing declared for this model: we do not know, and guessing either way is
  // worse than saying so.
  if (!declaration) {
    return { capability: 'unknown', sendCacheParameters: false, blocksExecution: false };
  }

  // A declared model reached through a different host is a gateway we have not
  // verified. Treat its caching as unsupported rather than sending parameters it
  // may reject or silently ignore.
  const host = endpointHost(input.endpoint);
  if (!host || !declaration.hosts.includes(host)) {
    return { capability: 'unsupported', sendCacheParameters: false, blocksExecution: false };
  }

  return { capability: 'supported', sendCacheParameters: true, blocksExecution: false };
}

export type PromptCacheSplit = {
  /** Reusable across calls: stable rules and schemas, ordered first. */
  stablePrefix: string[];
  /** Changes every call: workspace evidence and the current message. */
  dynamicTail: string[];
  cacheable: boolean;
};

/**
 * Orders the request so the reusable part comes first, which is what makes a
 * provider prefix cacheable at all.
 *
 * Evidence and the user's message stay in the tail as untrusted content. Moving
 * them into the stable prefix would raise workspace text to the same trust level
 * as project rules to win a cache hit — a trust-boundary change, not an
 * optimisation.
 */
export function splitPromptForCache(input: {
  systemPrompt: string;
  toolCatalog: string;
  projectRules: string;
  currentMessage: string;
  evidence: string;
}): PromptCacheSplit {
  const stablePrefix = [input.systemPrompt, input.toolCatalog, input.projectRules].filter(
    (part) => part.length > 0
  );
  const dynamicTail = [input.evidence, input.currentMessage].filter((part) => part.length > 0);

  return {
    stablePrefix,
    dynamicTail,
    // No padding to reach a vendor's minimum: adding filler text to qualify for a
    // cache breakpoint costs real input tokens on every miss.
    cacheable: stablePrefix.length > 0
  };
}

export type RuntimeUsageStreamFrame = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
};

/**
 * Carries the cache counters the stream parsers already produce into settled
 * usage. Before this, `cacheReadInputTokens` was parsed and then dropped, so a
 * fully cached prompt was settled as a full-price read.
 */
export function usageFromStreamFrame(input: {
  provider: RuntimeModelProvider;
  model: string;
  frame: RuntimeUsageStreamFrame;
  priceVersion?: string;
}): RuntimeUsage {
  const reported =
    input.frame.inputTokens !== undefined ||
    input.frame.outputTokens !== undefined ||
    input.frame.cacheReadInputTokens !== undefined ||
    input.frame.cacheWriteInputTokens !== undefined;

  if (!reported) {
    // The legacy numeric fields stay zero so existing consumers keep working,
    // but `measurement` says the numbers are not a measurement.
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      model: input.model,
      measurement: 'unknown'
    };
  }

  const inputTokens = input.frame.inputTokens ?? 0;
  const outputTokens = input.frame.outputTokens ?? 0;
  const normalized = normalizeRuntimeUsage({
    provider: input.provider,
    raw: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, model: input.model },
    cacheReadInputTokens: input.frame.cacheReadInputTokens,
    cacheWriteInputTokens: input.frame.cacheWriteInputTokens,
    cacheCapability: 'supported',
    ...(input.priceVersion ? { priceVersion: input.priceVersion } : {})
  });

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    model: input.model,
    measurement: 'actual',
    ...(normalized.logicalInputTokens === undefined
      ? {}
      : { logicalInputTokens: normalized.logicalInputTokens }),
    ...(normalized.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: normalized.cacheReadInputTokens }),
    ...(normalized.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: normalized.cacheWriteInputTokens }),
    ...(input.priceVersion ? { priceVersion: input.priceVersion } : {})
  };
}
