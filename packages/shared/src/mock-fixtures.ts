import type {
  Agent,
  AgentStatus,
  CollaborationEvent,
  EventMetadata,
  SessionDetail,
  TaskBrief
} from './contracts.js';

export const nowIso = () => new Date().toISOString();

export const defaultAgents: Agent[] = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    key: 'coordinator',
    name: 'Coordinator Agent',
    role: '组织讨论、调度任务、维护任务契约和复盘交付',
    runtimeType: 'mock',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  },
  {
    id: '00000000-0000-0000-0000-000000000002',
    key: 'requirements',
    name: '需求 Agent',
    role: '理解用户目标、澄清范围、提出待确认问题',
    runtimeType: 'mock',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  },
  {
    id: '00000000-0000-0000-0000-000000000003',
    key: 'architect',
    name: '架构 Agent',
    role: '评估技术方案、模块边界和风险',
    runtimeType: 'mock',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  },
  {
    id: '00000000-0000-0000-0000-000000000004',
    key: 'frontend',
    name: '前端 Agent',
    role: '负责前端界面、状态派生和实时事件展示',
    runtimeType: 'mock',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  },
  {
    id: '00000000-0000-0000-0000-000000000005',
    key: 'backend',
    name: '后端 Agent',
    role: '负责后端实现、接口、数据和受控执行',
    runtimeType: 'mock',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  },
  {
    id: '00000000-0000-0000-0000-000000000006',
    key: 'test',
    name: '测试 Agent',
    role: '负责测试策略、回归验证和验收标准检查',
    runtimeType: 'mock',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  },
  {
    id: '00000000-0000-0000-0000-000000000007',
    key: 'review',
    name: 'Review Agent',
    role: '负责一致性检查、风险审查和复盘建议',
    runtimeType: 'mock',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  },
  {
    id: '00000000-0000-0000-0000-000000000008',
    key: 'notification',
    name: '通知 Agent',
    role: '负责交付通知、外部消息草稿和用户确认后的发送流程',
    runtimeType: 'mock',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  }
];

export const createMetadata = <TPayload extends Record<string, unknown>>(
  renderAs: EventMetadata<TPayload>['renderAs'],
  payload: TPayload,
  title?: string
): EventMetadata<TPayload> => ({
  schemaVersion: '0.1',
  renderAs,
  title,
  payload
});

export const createMockSession = (): SessionDetail => ({
  id: '10000000-0000-0000-0000-000000000001',
  title: '登录模块重构',
  originalInput: '帮我重构登录模块，保持旧 token 兼容，完成后生成飞书通知草稿。',
  status: 'WAIT_USER_CONFIRM',
  ownerId: 'local-user',
  workspaceId: 'default-workspace',
  tokenBudget: 100000,
  tokenUsed: 0,
  participatingAgentIds: defaultAgents.map((agent) => agent.id),
  createdAt: nowIso(),
  updatedAt: nowIso()
});

export const createMockBrief = (): TaskBrief => ({
  id: '20000000-0000-0000-0000-000000000001',
  sessionId: '10000000-0000-0000-0000-000000000001',
  version: 1,
  goal: '重构登录模块，并保持旧 token 兼容。',
  scope: ['分析 auth-service 和 token-service', '生成 dry-run 执行计划', '补充测试验收说明'],
  outOfScope: ['不真实修改文件', '不发送真实飞书消息'],
  constraints: ['不修改数据库结构', '不改变 token 返回结构', '高风险操作必须用户确认'],
  acceptanceCriteria: ['旧 token 兼容要求被覆盖', '执行后复盘与任务契约一致'],
  risks: ['真实 Coding Runtime 尚未接入，本阶段只 dry-run'],
  openQuestions: [],
  confirmedByUser: false,
  createdAt: nowIso()
});

export const createMockEvents = (): CollaborationEvent[] => {
  const session = createMockSession();
  const brief = createMockBrief();
  const coordinator = defaultAgents[0];
  const requirements = defaultAgents[1];
  const architect = defaultAgents[2];

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
      content: '我理解目标是重构登录模块，但本阶段应先确认范围和兼容约束。',
      metadata: createMetadata('chat_message', { messageKind: 'discussion' }),
      createdAt: nowIso()
    },
    {
      id: '30000000-0000-0000-0000-000000000003',
      sessionId: session.id,
      type: 'agent_message',
      fromAgentId: architect.id,
      toAgentIds: [coordinator.id],
      content: '建议任务契约中明确不修改数据库结构、不改变 token 返回结构。',
      metadata: createMetadata('chat_message', { messageKind: 'risk' }),
      createdAt: nowIso()
    },
    {
      id: '30000000-0000-0000-0000-000000000004',
      sessionId: session.id,
      type: 'brief_created',
      fromAgentId: coordinator.id,
      toAgentIds: [],
      content: 'Agent 团队已形成任务契约，请确认后执行。',
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
    ...defaultAgents.map((agent, index) => ({
      id: `30000000-0000-0000-0000-00000000010${index}`,
      sessionId: session.id,
      type: 'agent_status_changed' as const,
      fromAgentId: agent.id,
      toAgentIds: [],
      content: `${agent.name} 状态更新`,
      metadata: createMetadata('system_notice', {
        agentId: agent.id,
        status: (index < 3 ? 'completed' : 'idle') as AgentStatus,
        thoughtSummary: index < 3 ? '已参与任务契约讨论。' : '等待用户确认任务契约。',
        actionSummary: index < 3 ? '完成初步意见输出。' : '待命。'
      }),
      createdAt: nowIso()
    }))
  ];
};
