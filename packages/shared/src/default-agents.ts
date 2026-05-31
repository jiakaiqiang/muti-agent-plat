import type { Agent } from './contracts.js';

const defaultAgentTimestamp = '2026-05-28T00:00:00.000Z';

export const defaultAgents: Agent[] = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    key: 'coordinator',
    name: '协调者',
    role: '负责组织讨论、拟定任务契约、推进执行、复盘与交付。',
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
    name: '需求分析师',
    role: '负责澄清用户目标、范围、约束与待解问题。',
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
    name: '架构师',
    role: '负责评估技术方案、模块边界与实现风险。',
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
    name: '前端工程师',
    role: '负责前端界面、派生状态与实时事件呈现。',
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
    name: '后端工程师',
    role: '负责后端接口、数据流与受控的运行时执行。',
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
    name: '测试工程师',
    role: '负责测试策略、回归检查与验收验证。',
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
    name: '评审员',
    role: '负责一致性、风险与最终交付就绪度检查。',
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
    name: '通知助手',
    role: '负责生成交付通知草稿，并等待用户显式确认后发送。',
    runtimeType: 'generic_llm',
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    createdAt: defaultAgentTimestamp,
    updatedAt: defaultAgentTimestamp
  }
];
