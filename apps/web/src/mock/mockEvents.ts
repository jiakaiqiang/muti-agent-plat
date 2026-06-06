import type {
  Agent,
  CollaborationEvent,
  KnowledgeBase,
  KnowledgeDocument,
  SessionDetail,
  SessionListItem
} from '@/types/contracts'

export const mockSessionId = 'session-demo-001'

export const mockAgents: Agent[] = [
  {
    id: 'agent-coordinator',
    key: 'coordinator',
    name: 'Coordinator',
    role: '协作编排',
    runtimeType: 'mock',
    status: 'active',
    capabilityIds: ['cap-brief', 'cap-router'],
    defaultKnowledgeBaseIds: ['kb-project'],
    createdAt: '2026-05-27T12:00:00.000Z',
    updatedAt: '2026-05-27T12:00:00.000Z'
  },
  {
    id: 'agent-architect',
    key: 'architect',
    name: 'Architect',
    role: '架构方案',
    runtimeType: 'mock',
    status: 'active',
    capabilityIds: ['cap-design-review'],
    defaultKnowledgeBaseIds: ['kb-project'],
    createdAt: '2026-05-27T12:00:00.000Z',
    updatedAt: '2026-05-27T12:00:00.000Z'
  },
  {
    id: 'agent-backend',
    key: 'backend',
    name: 'Backend',
    role: '后端实现',
    runtimeType: 'mock',
    status: 'active',
    capabilityIds: ['cap-dry-run'],
    defaultKnowledgeBaseIds: ['kb-api'],
    createdAt: '2026-05-27T12:00:00.000Z',
    updatedAt: '2026-05-27T12:00:00.000Z'
  },
  {
    id: 'agent-test',
    key: 'test',
    name: 'Test',
    role: '验证与回归',
    runtimeType: 'mock',
    status: 'active',
    capabilityIds: ['cap-test-report'],
    defaultKnowledgeBaseIds: ['kb-api'],
    createdAt: '2026-05-27T12:00:00.000Z',
    updatedAt: '2026-05-27T12:00:00.000Z'
  },
  {
    id: 'agent-review',
    key: 'review',
    name: 'Review',
    role: '最终复盘',
    runtimeType: 'mock',
    status: 'active',
    capabilityIds: ['cap-post-review'],
    defaultKnowledgeBaseIds: ['kb-project'],
    createdAt: '2026-05-27T12:00:00.000Z',
    updatedAt: '2026-05-27T12:00:00.000Z'
  }
]

export const mockSession: SessionDetail = {
  id: mockSessionId,
  title: '合同驱动的群聊协作闭环',
  originalInput: '基于五份 v0.1 契约实现三栏群聊最小骨架。',
  status: 'WAIT_USER_CONFIRM',
  ownerId: 'local-user',
  workspaceId: 'default-workspace',
  currentTaskBriefId: 'brief-001',
  tokenBudget: 30000,
  tokenUsed: 4200,
  participatingAgentIds: mockAgents.map((agent) => agent.id),
  createdAt: '2026-05-27T12:00:00.000Z',
  updatedAt: '2026-05-27T12:09:00.000Z'
}

export const mockSessions: SessionListItem[] = [
  {
    id: mockSession.id,
    title: mockSession.title,
    status: mockSession.status,
    agentCount: mockSession.participatingAgentIds.length,
    requiresUserAction: true,
    latestEventSummary: 'Coordinator 已生成任务契约，等待确认执行。',
    tokenBudget: mockSession.tokenBudget,
    tokenUsed: mockSession.tokenUsed,
    createdAt: mockSession.createdAt,
    updatedAt: mockSession.updatedAt
  }
]

export const mockKnowledgeBases: KnowledgeBase[] = [
  {
    id: 'kb-project',
    name: 'Project Contracts',
    description: 'v0.1 collaboration contracts',
    scope: 'project',
    visibility: 'workspace',
    embeddingModel: 'mock-embedding',
    createdAt: '2026-05-27T12:00:00.000Z',
    updatedAt: '2026-05-27T12:00:00.000Z'
  },
  {
    id: 'kb-api',
    name: 'API and Runtime Notes',
    scope: 'role_type',
    roleType: 'engineering',
    visibility: 'workspace',
    embeddingModel: 'mock-embedding',
    createdAt: '2026-05-27T12:00:00.000Z',
    updatedAt: '2026-05-27T12:00:00.000Z'
  }
]

export const mockDocumentsByKnowledgeBaseId: Record<string, KnowledgeDocument[]> = {
  'kb-project': [
    {
      id: 'doc-ui-state',
      knowledgeBaseId: 'kb-project',
      title: 'UI State Contract v0.1',
      sourceType: 'markdown',
      status: 'ready',
      createdAt: '2026-05-27T12:00:00.000Z',
      updatedAt: '2026-05-27T12:00:00.000Z'
    }
  ],
  'kb-api': [
    {
      id: 'doc-event-contract',
      knowledgeBaseId: 'kb-api',
      title: 'Event Contract v0.1',
      sourceType: 'markdown',
      status: 'ready',
      createdAt: '2026-05-27T12:00:00.000Z',
      updatedAt: '2026-05-27T12:00:00.000Z'
    }
  ]
}

export const mockEvents: CollaborationEvent[] = [
  {
    id: 'evt-001',
    sessionId: mockSessionId,
    type: 'user_message',
    userMessageIntent: 'command',
    priority: 'normal',
    toAgentIds: ['agent-coordinator', 'agent-architect'],
    content: '请基于 v0.1 契约做一个三栏群聊最小骨架。',
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'chat_message',
      payload: {
        text: '请基于 v0.1 契约做一个三栏群聊最小骨架。',
        mentionedAgentIds: ['agent-coordinator', 'agent-architect']
      }
    },
    createdAt: '2026-05-27T12:01:00.000Z'
  },
  {
    id: 'evt-002',
    sessionId: mockSessionId,
    type: 'session_status_changed',
    toAgentIds: [],
    content: '会话进入 Agent 讨论阶段。',
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'system_notice',
      payload: { status: 'AGENT_DISCUSSING' }
    },
    createdAt: '2026-05-27T12:01:20.000Z'
  },
  {
    id: 'evt-003',
    sessionId: mockSessionId,
    type: 'agent_status_changed',
    fromAgentId: 'agent-coordinator',
    toAgentIds: [],
    content: 'Coordinator 正在拆解需求。',
    metadata: {
      schemaVersion: '0.1',
      payload: {
        agentId: 'agent-coordinator',
        status: 'thinking',
        thoughtSummary: '识别三栏群聊、事件派生、确认卡和 mock 闭环。',
        actionSummary: '准备生成任务契约。',
        activeCapabilityIds: ['cap-brief'],
        usedKnowledgeBaseIds: ['kb-project']
      }
    },
    createdAt: '2026-05-27T12:02:00.000Z'
  },
  {
    id: 'evt-004',
    sessionId: mockSessionId,
    type: 'agent_message',
    fromAgentId: 'agent-architect',
    toAgentIds: ['agent-coordinator'],
    content: '建议先以 CollaborationEvent 为唯一事实源，UI store 只做派生。',
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'chat_message',
      payload: {
        messageKind: 'decision',
        mentionedAgentIds: ['agent-coordinator']
      }
    },
    createdAt: '2026-05-27T12:03:00.000Z'
  },
  {
    id: 'evt-005',
    sessionId: mockSessionId,
    type: 'rag_retrieved',
    fromAgentId: 'agent-coordinator',
    toAgentIds: [],
    content: '命中 UI 状态契约中的 mock 数据要求。',
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'rag_card',
      payload: {
        retrievalLogId: 'rag-001',
        agentId: 'agent-coordinator',
        query: 'frontend milestone mock events',
        matchedChunks: [
          {
            chunkId: 'chunk-ui-010',
            knowledgeBaseId: 'kb-project',
            documentId: 'doc-ui-state',
            title: 'UI State Contract v0.1',
            snippet: 'Milestone 1 必须能用 mock events 渲染创建、讨论、契约、确认、执行、验证、复盘和交付流程。',
            score: 0.91
          }
        ]
      }
    },
    createdAt: '2026-05-27T12:03:30.000Z'
  },
  {
    id: 'evt-006',
    sessionId: mockSessionId,
    type: 'brief_created',
    fromAgentId: 'agent-coordinator',
    toAgentIds: [],
    content: '已生成任务契约 v1。',
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'brief_card',
      title: '任务契约 v1',
      payload: {
        briefId: 'brief-001',
        version: 1,
        goal: '实现 Vue3 + TypeScript 三栏群聊前端骨架。',
        scope: ['三栏布局', '契约类型', 'Pinia stores', 'mock events 闭环', '确认卡交互'],
        outOfScope: ['后端接口实现', '根工作区依赖管理', '生产级视觉设计'],
        constraints: ['只写 apps/web/**', '不修改契约文档', '不修改 apps/server', '不修改根 package.json'],
        acceptanceCriteria: ['能从事件派生聊天消息', '能从事件派生 Agent 状态', '能展示 active confirmation', '能展示最终交付事件'],
        risks: ['后端 API 尚未接入，当前仅 mock'],
        openQuestions: [],
        requiresUserConfirmation: true
      }
    },
    createdAt: '2026-05-27T12:04:00.000Z'
  },
  {
    id: 'evt-007',
    sessionId: mockSessionId,
    type: 'user_confirmation_requested',
    fromAgentId: 'agent-coordinator',
    toAgentIds: [],
    content: '请确认是否按任务契约执行。',
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'confirmation_card',
      payload: {
        confirmationId: 'confirm-001',
        reason: 'confirm_task_brief',
        title: '确认执行任务契约',
        description: '确认后将进入 dry-run 执行、测试验证、复盘和最终交付。',
        options: [
          { key: 'approve', label: '确认执行', style: 'primary' },
          { key: 'revise', label: '继续沟通', style: 'default' }
        ],
        relatedBriefId: 'brief-001'
      }
    },
    createdAt: '2026-05-27T12:04:15.000Z'
  },
  {
    id: 'evt-008',
    sessionId: mockSessionId,
    type: 'user_confirmation_resolved',
    toAgentIds: ['agent-coordinator'],
    content: '用户已确认执行。',
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'system_notice',
      payload: {
        confirmationId: 'confirm-001',
        status: 'approved',
        selectedOptionKey: 'approve'
      }
    },
    createdAt: '2026-05-27T12:05:00.000Z'
  },
  {
    id: 'evt-009',
    sessionId: mockSessionId,
    type: 'session_status_changed',
    toAgentIds: [],
    content: '会话进入执行阶段。',
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'system_notice',
      payload: { status: 'EXECUTING' }
    },
    createdAt: '2026-05-27T12:05:10.000Z'
  },
  {
    id: 'evt-010',
    sessionId: mockSessionId,
    type: 'task_started',
    fromAgentId: 'agent-backend',
    toAgentIds: [],
    taskId: 'task-dry-run',
    content: 'Backend Agent dry-run 执行中。',
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'task_card',
      payload: {
        taskId: 'task-dry-run',
        title: '后端 Agent dry-run 执行',
        status: 'running',
        assigneeAgentId: 'agent-backend',
        acceptanceCriteria: ['产出 dry-run 摘要', '不修改前端文件']
      }
    },
    createdAt: '2026-05-27T12:06:00.000Z'
  },
  {
    id: 'evt-011',
    sessionId: mockSessionId,
    type: 'runtime_progress',
    fromAgentId: 'agent-backend',
    toAgentIds: [],
    taskId: 'task-dry-run',
    content: 'MockRuntime dry-run 已完成 70%。',
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'tool_card',
      payload: {
        runtimeInvocationId: 'run-backend-001',
        runtimeType: 'mock',
        agentId: 'agent-backend',
        taskId: 'task-dry-run',
        status: 'running',
        progressMessage: '模拟执行服务端契约检查。',
        tokenInput: 0,
        tokenOutput: 0,
        cost: 0
      }
    },
    createdAt: '2026-05-27T12:06:30.000Z'
  },
  {
    id: 'evt-012',
    sessionId: mockSessionId,
    type: 'task_completed',
    fromAgentId: 'agent-backend',
    toAgentIds: ['agent-test'],
    taskId: 'task-dry-run',
    content: 'Backend Agent dry-run 完成，交给 Test Agent 验证。',
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'task_card',
      payload: {
        taskId: 'task-dry-run',
        title: '后端 Agent dry-run 执行',
        status: 'completed',
        assigneeAgentId: 'agent-backend',
        resultSummary: 'dry-run 通过，未发现阻塞问题。'
      }
    },
    createdAt: '2026-05-27T12:07:00.000Z'
  },
  {
    id: 'evt-013',
    sessionId: mockSessionId,
    type: 'task_completed',
    fromAgentId: 'agent-test',
    toAgentIds: ['agent-review'],
    taskId: 'task-verify',
    content: 'Test Agent dry-run 验证通过。',
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'task_card',
      payload: {
        taskId: 'task-verify',
        title: '测试 Agent dry-run 验证',
        status: 'completed',
        assigneeAgentId: 'agent-test',
        resultSummary: 'mock 流程覆盖创建、讨论、确认、执行、验证、复盘与交付。'
      }
    },
    createdAt: '2026-05-27T12:07:30.000Z'
  },
  {
    id: 'evt-014',
    sessionId: mockSessionId,
    type: 'post_review_completed',
    fromAgentId: 'agent-review',
    toAgentIds: [],
    content: 'Review Agent 复盘通过，建议交付。',
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'review_card',
      payload: {
        isConsistentWithBrief: true,
        matchedItems: ['三栏布局', 'store 派生', '确认卡', 'mock 闭环'],
        mismatchedItems: [],
        missingItems: [],
        outOfScopeChanges: [],
        testResults: ['mock 验证通过'],
        recommendation: 'deliver'
      }
    },
    createdAt: '2026-05-27T12:08:00.000Z'
  },
  {
    id: 'evt-015',
    sessionId: mockSessionId,
    type: 'final_delivery_created',
    fromAgentId: 'agent-coordinator',
    toAgentIds: [],
    content: '最终交付已生成。',
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'delivery_card',
      payload: {
        deliveryId: 'delivery-001',
        summary: '前端可以用契约事件渲染完整协作闭环。',
        completedItems: ['SessionWorkspace', 'SessionSidebar', 'ChatTimeline', 'AgentStatusPanel', 'ConfirmationCard'],
        incompleteItems: ['真实 SSE 接入'],
        outOfScopeChanges: [],
        testResults: ['mock event projection passed by inspection'],
        risks: ['仍需后端联调'],
        artifactIds: ['artifact-web-skeleton']
      }
    },
    createdAt: '2026-05-27T12:09:00.000Z'
  },
  {
    id: 'evt-016',
    sessionId: mockSessionId,
    type: 'session_status_changed',
    toAgentIds: [],
    content: '会话已完成。',
    metadata: {
      schemaVersion: '0.1',
      renderAs: 'system_notice',
      payload: { status: 'COMPLETED' }
    },
    createdAt: '2026-05-27T12:09:10.000Z'
  }
]
