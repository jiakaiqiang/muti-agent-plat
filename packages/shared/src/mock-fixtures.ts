import type { Agent, AgentStatus, CollaborationEvent, SessionDetail, TaskBrief } from './contracts.js';
import { defaultAgents } from './default-agents.js';
import { createMetadata } from './metadata.js';
import { nowIso } from './time.js';

export const mockAgents: Agent[] = defaultAgents.map((agent) => {
  const now = nowIso();

  return {
    ...agent,
    runtimeType: 'mock',
    createdAt: now,
    updatedAt: now
  };
});

export const createMockSession = (): SessionDetail => ({
  id: '10000000-0000-0000-0000-000000000001',
  title: 'Login module refactor',
  originalInput:
    'Help me refactor the login module, keep legacy token compatibility, and prepare a delivery notification draft.',
  status: 'WAIT_USER_CONFIRM',
  ownerId: 'local-user',
  workspaceId: 'default-workspace',
  tokenBudget: 100000,
  tokenUsed: 0,
  participatingAgentIds: mockAgents.map((agent) => agent.id),
  createdAt: nowIso(),
  updatedAt: nowIso()
});

export const createMockBrief = (): TaskBrief => ({
  id: '20000000-0000-0000-0000-000000000001',
  sessionId: '10000000-0000-0000-0000-000000000001',
  version: 1,
  goal: 'Refactor the login module while preserving legacy token compatibility.',
  scope: ['Analyze auth-service and token-service', 'Create an execution plan', 'Define regression checks'],
  outOfScope: ['Do not send external notifications from the fixture'],
  constraints: ['Keep the existing token response shape', 'Require user confirmation before high-risk actions'],
  acceptanceCriteria: [
    'Legacy token compatibility is covered',
    'Execution output can be checked against the task brief'
  ],
  risks: ['This is a fixture-only scenario and does not represent a real runtime result'],
  openQuestions: [],
  confirmedByUser: false,
  createdAt: nowIso()
});

export const createMockEvents = (): CollaborationEvent[] => {
  const session = createMockSession();
  const brief = createMockBrief();
  const coordinator = mockAgents[0];
  const requirements = mockAgents[1];
  const architect = mockAgents[2];

  return [
    {
      id: '30000000-0000-0000-0000-000000000001',
      sessionId: session.id,
      type: 'user_message',
      userMessageIntent: 'clarification',
      priority: 'normal',
      toAgentIds: [],
      content: session.originalInput,
      metadata: createMetadata('chat_message', { text: session.originalInput }),
      createdAt: nowIso()
    },
    {
      id: '30000000-0000-0000-0000-000000000002',
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: requirements.id,
      toAgentIds: [coordinator.id],
      content: 'I understand the goal is a login module refactor. Scope and compatibility constraints need confirmation first.',
      metadata: createMetadata('chat_message', { messageKind: 'discussion' }),
      createdAt: nowIso()
    },
    {
      id: '30000000-0000-0000-0000-000000000003',
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: architect.id,
      toAgentIds: [coordinator.id],
      content: 'The task brief should explicitly preserve token response compatibility and identify regression checks.',
      metadata: createMetadata('chat_message', { messageKind: 'risk' }),
      createdAt: nowIso()
    },
    {
      id: '30000000-0000-0000-0000-000000000004',
      sessionId: session.id,
      type: 'brief_created',
      fromAgentId: coordinator.id,
      toAgentIds: [],
      content: 'The mock team has prepared a task brief for user confirmation.',
      metadata: createMetadata('brief_card', {
        briefId: brief.id,
        version: brief.version,
        goal: brief.goal,
        scope: brief.scope,
        outOfScope: brief.outOfScope,
        constraints: brief.constraints,
        acceptanceCriteria: brief.acceptanceCriteria,
        risks: brief.risks,
        openQuestions: brief.openQuestions,
        requiresUserConfirmation: true
      }),
      createdAt: nowIso()
    },
    ...mockAgents.map((agent, index) => ({
      id: `30000000-0000-0000-0000-00000000010${index}`,
      sessionId: session.id,
      type: 'agent_status_changed' as const,
      fromAgentId: agent.id,
      toAgentIds: [],
      content: `${agent.name} status updated`,
      metadata: createMetadata('system_notice', {
        agentId: agent.id,
        status: (index < 3 ? 'completed' : 'idle') as AgentStatus,
        thoughtSummary: index < 3 ? 'Participated in fixture discussion.' : 'Waiting for confirmation.',
        actionSummary: index < 3 ? 'Produced an initial fixture response.' : 'Idle.'
      }),
      createdAt: nowIso()
    }))
  ];
};
