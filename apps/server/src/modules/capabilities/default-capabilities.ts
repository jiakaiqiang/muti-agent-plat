import type { RuntimeCapabilityDefinition } from '@agent-cluster/shared';

export const defaultCapabilities: RuntimeCapabilityDefinition[] = [
  {
    id: 'cap-brief',
    key: 'brief.generate',
    name: 'Generate Task Brief',
    riskLevel: 'low',
    description: 'Create or revise a structured task brief.'
  },
  {
    id: 'cap-router',
    key: 'message.route',
    name: 'Route User Message',
    riskLevel: 'low',
    description: 'Classify and route user messages during a session.'
  },
  {
    id: 'cap-dry-run',
    key: 'runtime.dry_run',
    name: 'Dry-run Runtime',
    riskLevel: 'medium',
    description: 'Execute deterministic non-destructive runtime simulation.'
  },
  {
    id: 'cap-test-report',
    key: 'test.report',
    name: 'Generate Test Report',
    riskLevel: 'medium',
    description: 'Summarize validation output and acceptance evidence.'
  },
  {
    id: 'cap-post-review',
    key: 'review.post',
    name: 'Post Review',
    riskLevel: 'medium',
    description: 'Compare runtime results against the confirmed task brief.'
  },
  {
    id: 'cap-feishu-draft',
    key: 'notification.feishu_draft',
    name: 'Create Feishu Draft',
    riskLevel: 'medium',
    description: 'Create a Feishu notification draft without sending it externally.'
  },
  {
    id: 'cap-file-write',
    key: 'tool.file_write',
    name: 'File Write',
    riskLevel: 'high',
    description: 'Write or modify workspace files. Requires explicit user approval.'
  },
  {
    id: 'cap-command-run',
    key: 'tool.command_run',
    name: 'Command Execution',
    riskLevel: 'high',
    description: 'Run shell commands. Requires explicit user approval.'
  }
];

export const defaultCapabilityIdsByAgentKey: Record<string, string[]> = {
  coordinator: ['cap-brief', 'cap-router'],
  requirements: ['cap-brief'],
  architect: ['cap-brief'],
  frontend: ['cap-dry-run'],
  backend: ['cap-dry-run', 'cap-file-write', 'cap-command-run'],
  test: ['cap-test-report', 'cap-command-run'],
  review: ['cap-post-review'],
  notification: ['cap-feishu-draft']
};
