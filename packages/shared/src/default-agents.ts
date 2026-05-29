import type { Agent } from './contracts.js';

const defaultAgentTimestamp = '2026-05-28T00:00:00.000Z';

export const defaultAgents: Agent[] = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    key: 'coordinator',
    name: 'Coordinator Agent',
    role: 'Orchestrates discussion, task contracts, execution, review, and delivery.',
    runtimeType: 'generic_llm',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: defaultAgentTimestamp,
    updatedAt: defaultAgentTimestamp
  },
  {
    id: '00000000-0000-0000-0000-000000000002',
    key: 'requirements',
    name: 'Requirements Agent',
    role: 'Clarifies user goals, scope, constraints, and open questions.',
    runtimeType: 'generic_llm',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: defaultAgentTimestamp,
    updatedAt: defaultAgentTimestamp
  },
  {
    id: '00000000-0000-0000-0000-000000000003',
    key: 'architect',
    name: 'Architect Agent',
    role: 'Reviews technical design, module boundaries, and implementation risk.',
    runtimeType: 'generic_llm',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: defaultAgentTimestamp,
    updatedAt: defaultAgentTimestamp
  },
  {
    id: '00000000-0000-0000-0000-000000000004',
    key: 'frontend',
    name: 'Frontend Agent',
    role: 'Owns frontend UI, derived state, and realtime event presentation.',
    runtimeType: 'generic_llm',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: defaultAgentTimestamp,
    updatedAt: defaultAgentTimestamp
  },
  {
    id: '00000000-0000-0000-0000-000000000005',
    key: 'backend',
    name: 'Backend Agent',
    role: 'Owns backend APIs, data flow, and controlled runtime execution.',
    runtimeType: 'generic_llm',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: defaultAgentTimestamp,
    updatedAt: defaultAgentTimestamp
  },
  {
    id: '00000000-0000-0000-0000-000000000006',
    key: 'test',
    name: 'Test Agent',
    role: 'Owns test strategy, regression checks, and acceptance verification.',
    runtimeType: 'generic_llm',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: defaultAgentTimestamp,
    updatedAt: defaultAgentTimestamp
  },
  {
    id: '00000000-0000-0000-0000-000000000007',
    key: 'review',
    name: 'Review Agent',
    role: 'Checks consistency, risks, and final delivery readiness.',
    runtimeType: 'generic_llm',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: defaultAgentTimestamp,
    updatedAt: defaultAgentTimestamp
  },
  {
    id: '00000000-0000-0000-0000-000000000008',
    key: 'notification',
    name: 'Notification Agent',
    role: 'Creates delivery notification drafts and waits for explicit send confirmation.',
    runtimeType: 'generic_llm',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: defaultAgentTimestamp,
    updatedAt: defaultAgentTimestamp
  }
];
