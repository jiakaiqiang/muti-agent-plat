import { defaultAgentPresets, type RuntimeCapabilityDefinition } from '@agent-cluster/shared';

export const defaultCapabilities: RuntimeCapabilityDefinition[] = [
  {
    id: 'cap-brief',
    key: 'brief.generate',
    name: '任务契约生成',
    riskLevel: 'low',
    description: '创建或修订结构化任务契约。'
  },
  {
    id: 'cap-router',
    key: 'message.route',
    name: '消息路由',
    riskLevel: 'low',
    description: '在会话中识别并路由用户消息。'
  },
  {
    id: 'cap-dry-run',
    key: 'runtime.dry_run',
    name: 'Dry-run 执行',
    riskLevel: 'medium',
    description: '执行确定性的非破坏性运行模拟。'
  },
  {
    id: 'cap-test-report',
    key: 'test.report',
    name: '测试报告',
    riskLevel: 'medium',
    description: '汇总验证输出和验收证据。'
  },
  {
    id: 'cap-post-review',
    key: 'review.post',
    name: '交付复盘',
    riskLevel: 'medium',
    description: '根据已确认的任务契约复盘运行结果。'
  },
  {
    id: 'cap-feishu-draft',
    key: 'notification.feishu_draft',
    name: '飞书草稿',
    riskLevel: 'medium',
    description: '创建飞书通知草稿，不直接对外发送。'
  },
  {
    id: 'cap-file-write',
    key: 'tool.file_write',
    name: '文件写入',
    riskLevel: 'high',
    description: '写入或修改工作区文件，需要用户明确确认。'
  },
  {
    id: 'cap-command-run',
    key: 'tool.command_run',
    name: '命令执行',
    riskLevel: 'high',
    description: '运行 shell 命令，需要用户明确确认。'
  }
];

export const defaultCapabilityIdsByAgentKey: Record<string, string[]> = Object.fromEntries(
  defaultAgentPresets.map((preset) => [preset.key, preset.capabilityIds])
);
