import type {
  RuntimeRoutingInput,
  RuntimeRoutingPhase,
  RuntimeRoutingWriteMode,
  WorkspaceCapabilities
} from './contracts.js';

type Assert<T extends true> = T;
type IsExact<T, Expected> = [T] extends [Expected]
  ? [Expected] extends [T]
    ? true
    : false
  : false;

type WriteModesAreStable = Assert<
  IsExact<RuntimeRoutingWriteMode, 'none' | 'propose_changes' | 'direct_audited'>
>;

type PhasesAreStable = Assert<
  IsExact<
    RuntimeRoutingPhase,
    'discussion' | 'execution' | 'post_review' | 'delivery'
  >
>;

const capabilities: WorkspaceCapabilities = { read: true, write: true, command: false, test: true };

const input: RuntimeRoutingInput = {
  phase: 'execution',
  sessionId: '00000000-0000-4000-8000-000000000081',
  taskKind: 'implementation',
  agentId: 'agent-implementer',
  agentPreferredRuntime: 'claude_code',
  requiredCapabilities: ['read', 'write'],
  writeMode: 'propose_changes',
  workspace: {
    workspaceId: 'ws-81',
    providerKind: 'server_local',
    capabilities
  },
  userOverride: undefined
};

void input;
