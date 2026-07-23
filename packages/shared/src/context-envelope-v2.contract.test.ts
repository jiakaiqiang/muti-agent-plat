import type {
  ContextEnvelopeV2,
  ContextEnvelopeV2Layer,
  ContextL0Authority,
  ContextL1Invocation,
  ContextL2ProjectMap,
  ContextL3SelectedEvidence,
  ContextL4ToolResults,
  ContextL5SummaryMemory,
  ContextL6DeliveryArtifacts
} from './contracts.js';

type Assert<T extends true> = T;
type IsExact<T, Expected> = [T] extends [Expected]
  ? [Expected] extends [T]
    ? true
    : false
  : false;

type LayersAreStable = Assert<
  IsExact<
    ContextEnvelopeV2Layer,
    'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6'
  >
>;

type VersionIsFixed = Assert<IsExact<ContextEnvelopeV2['version'], 'v2'>>;

const l0: ContextL0Authority = {
  systemRules: ['Stay grounded.'],
  agentId: 'agent-1',
  profileHash: 'profile-hash',
  profileRevision: 1,
  toolCatalogHash: 'catalog-hash',
  workspace: {
    workspaceId: 'ws-1',
    rootName: 'demo',
    providerKind: 'server_local',
    revision: { id: 'rev-69', observedAt: '2026-07-11T00:00:00.000Z' }
  }
};

const l1: ContextL1Invocation = {
  sessionGoal: 'Add auth',
  phase: 'task_execution',
  navigation: {
    entries: [
      { path: 'src', kind: 'directory', generated: false, sensitive: false },
      { path: 'src/index.ts', kind: 'file', generated: false, sensitive: false, size: 100 }
    ],
    truncated: false
  }
};

const l2: ContextL2ProjectMap = {
  source: 'generated',
  modules: [{ name: 'core', path: 'src', responsibility: 'core logic' }]
};

const l3: ContextL3SelectedEvidence = {
  files: [
    { path: 'src/index.ts', content: 'export const a = 1;', byteLength: 20 }
  ],
  totalByteLength: 20,
  truncated: false
};

const l4: ContextL4ToolResults = {
  calls: [
    { tool: 'listDirectory', arguments: { path: 'src' }, resultSummary: '2 entries' }
  ]
};

const l5: ContextL5SummaryMemory = {
  bullets: ['user asked to add auth', 'server uses NestJS'],
  turnCount: 3
};

const l6: ContextL6DeliveryArtifacts = {
  changeSetIds: ['00000000-0000-4000-8000-000000000069'],
  reportIds: []
};

const envelope: ContextEnvelopeV2 = {
  version: 'v2',
  createdAt: '2026-07-11T00:00:00.000Z',
  workspaceId: 'ws-1',
  sessionId: 'session-1',
  L0: l0,
  L1: l1,
  L2: l2,
  L3: l3,
  L4: l4,
  L5: l5,
  L6: l6,
  budget: {
    inputTokens: 8000,
    navigationTokens: 800,
    projectMapTokens: 500,
    evidenceTokens: 3600
  }
};

void envelope;
