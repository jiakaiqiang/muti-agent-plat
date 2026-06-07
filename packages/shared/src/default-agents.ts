import type { Agent } from './contracts.js';
import { defaultAgentPresets } from './default-agent-presets.js';

const defaultAgentTimestamp = '2026-05-28T00:00:00.000Z';

function listMarkdown(title: string, items: string[]) {
  return [`## ${title}`, ...items.map((item) => `- ${item}`)].join('\n');
}

function profileMarkdown(preset: (typeof defaultAgentPresets)[number]) {
  return [
    `# ${preset.name}`,
    '',
    '## 角色定位',
    preset.role,
    '',
    '## 描述',
    preset.description,
    '',
    listMarkdown('能力', preset.abilities),
    '',
    listMarkdown('能力绑定', preset.capabilityIds),
    '',
    listMarkdown('责任', preset.responsibilities),
    '',
    listMarkdown('边界', preset.boundaries),
    '',
    listMarkdown('标签', preset.tags)
  ].join('\n');
}

export const defaultAgents: Agent[] = defaultAgentPresets.map((preset) => ({
  id: preset.id,
  key: preset.key,
  name: preset.name,
  role: preset.role,
  description: preset.description,
  profileMarkdown: profileMarkdown(preset),
  tags: preset.tags,
  runtimeType: 'generic_llm',
  status: 'active',
  capabilityIds: preset.capabilityIds,
  defaultKnowledgeBaseIds: [],
  createdAt: defaultAgentTimestamp,
  updatedAt: defaultAgentTimestamp
}));
