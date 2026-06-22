import type {
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeAdapter,
  RuntimeAdapterCategory,
  RuntimeAdapterMetadata,
  RuntimeAvailability,
  RuntimeHealthStatus,
  UUID
} from './contracts';

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
  capabilityIds: ['cap-file-read']
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

// Test 5: existing run(input, signal?) signature remains compatible.
const runAdapter: AgentRuntimeAdapter = {
  type: 'mock',
  async run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunResult> {
    void input;
    void signal;
    return {
      runId: 'run-1',
      runtimeType: 'mock',
      status: 'completed',
      events: [],
      artifacts: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      output: { kind: 'agent_message', messageKind: 'summary', content: 'done' }
    };
  }
};

// Test 6: metadata can be attached without forcing old adapters to change.
const metadataAdapter: AgentRuntimeAdapter = {
  ...runAdapter,
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

// Test 8: stream and cancel remain available for adapters that support them.
const streamingAdapter: AgentRuntimeAdapter = {
  ...observableAdapter,
  async *stream(runId: UUID) {
    yield {
      runId,
      type: 'runtime_started',
      content: 'started',
      createdAt: '2026-06-22T00:00:00.000Z'
    };
  },
  async cancel(runId: UUID) {
    void runId;
  }
};

type MetadataCapabilityIdsAreReadonlyUuidArray = Assert<
  IsExact<RuntimeAdapterMetadata['capabilityIds'], readonly UUID[]>
>;

void externalCategory;
void streamingAdapter;
