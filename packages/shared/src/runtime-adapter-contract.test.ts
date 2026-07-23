import type {
  AgentRunResult,
  AgentRuntimeAdapter,
  InvocationPlan,
  RuntimeAdapterCategory,
  RuntimeAdapterMetadata,
  RuntimeAvailability,
  RuntimeHealthStatus,
  UUID
} from './contracts';
import { createRuntimeArtifactSystemEvidence } from './runtime-contracts/factories.js';

type Assert<T extends true> = T;
type IsExact<T, Expected> = [T] extends [Expected]
  ? [Expected] extends [T]
    ? true
    : false
  : false;

// Test 1: Runtime adapter categories are limited to internal/external.
const internalCategory: RuntimeAdapterCategory = 'internal';
const externalCategory: RuntimeAdapterCategory = 'external';

// Test 2: Runtime metadata exposes stable identity and capability IDs.
const metadata: RuntimeAdapterMetadata = {
  name: 'test-runtime',
  version: '0.1.0',
  category: internalCategory,
  provider: 'self-hosted',
  capabilityIds: ['cap-file-read'],
  supportedWorkspaceCapabilities: ['read'],
  supportedToolNames: ['read_file']
};

// Test 3: availability checks return a boolean and optional reason.
const availability: RuntimeAvailability = {
  available: false,
  reason: 'missing executable'
};

// Test 4: health checks use ISO timestamps and the expected status union.
const health: RuntimeHealthStatus = {
  status: 'degraded',
  latency: 42,
  lastCheckAt: '2026-06-22T00:00:00.000Z',
  message: 'slow dependency'
};

// Test 5: adapters consume the immutable InvocationPlan boundary.
const baseAdapter: AgentRuntimeAdapter = {
  type: 'mock',
  start(input: InvocationPlan, signal?: AbortSignal) {
    void input;
    void signal;
    const result: AgentRunResult = {
      invocationId: 'invocation-1',
      runtimeType: 'mock',
      status: 'completed',
      events: [],
      artifacts: [],
      systemEvidence: createRuntimeArtifactSystemEvidence('invocation-1'),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      output: {
        schemaVersion: '1.0',
        kind: 'agent_message',
        messageKind: 'summary',
        content: 'done',
        targetAgentIds: [],
        targetAgentKeys: [],
        mentionedAgentIds: [],
        relatedTaskIds: []
      }
    };
    return {
      events: (async function* () {})(),
      result: Promise.resolve(result),
      async cancel() {}
    };
  }
};

// Test 6: metadata can be attached to the single start-handle contract.
const metadataAdapter: AgentRuntimeAdapter = {
  ...baseAdapter,
  metadata
};

// Test 7: optional availability and health methods are part of the adapter contract.
const observableAdapter: AgentRuntimeAdapter = {
  ...metadataAdapter,
  async checkAvailability() {
    return availability;
  },
  async healthCheck() {
    return health;
  }
};

// Test 8: streaming and cancellation are scoped to the start() handle.
const streamingAdapter: AgentRuntimeAdapter = {
  ...observableAdapter,
  start(input) {
    return {
      events: (async function* () {
        yield {
          invocationId: input.invocationId,
          type: 'runtime_started' as const,
          visibility: 'user' as const,
          content: 'started',
          createdAt: '2026-06-22T00:00:00.000Z'
        };
      })(),
      result: baseAdapter.start(input).result,
      async cancel() {}
    };
  }
};

type MetadataCapabilityIdsAreReadonlyUuidArray = Assert<
  IsExact<RuntimeAdapterMetadata['capabilityIds'], readonly UUID[]>
>;

void externalCategory;
void streamingAdapter;
