import type { AgentDefinition } from './contracts.js';
import { defaultAgentPresets } from './default-agent-presets.js';
import { SYSTEM_AGENT_REGISTRATIONS } from './system-agents.js';

const defaultAgentTimestamp = '2026-05-28T00:00:00.000Z';

function listMarkdown(title: string, items: string[]) {
  return [`## ${title}`, ...items.map((item) => `- ${item}`)].join('\n');
}

function profileMarkdown(preset: (typeof defaultAgentPresets)[number]) {
  const baseProfile = [
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
  const toolKeys = preset.capabilityIds.flatMap((capabilityId) => {
    if (capabilityId === 'cap-file-write') return ['tool.file_write'];
    if (capabilityId === 'cap-command-run') return ['tool.command_run'];
    return [];
  });
  return toolKeys.length
    ? `${baseProfile}\n\n## Tools\n${toolKeys.map((key) => `\${tool:${key}}`).join('\n')}`
    : baseProfile;
}

export const defaultAgents: AgentDefinition[] = defaultAgentPresets.map((preset) => ({
  id: preset.id,
  key: preset.key,
  name: preset.name,
  role: preset.role,
  description: preset.description,
  profileMarkdown: profileMarkdown(preset),
  tags: preset.tags,
  status: 'active',
  capabilityIds: preset.capabilityIds,
  defaultKnowledgeBaseIds: [],
  profileRevision: 1,
  createdAt: defaultAgentTimestamp,
  updatedAt: defaultAgentTimestamp,
  management: (() => {
    const registration = SYSTEM_AGENT_REGISTRATIONS.find((item) => item.key === preset.key);
    return registration
      ? {
          owner: 'system' as const,
          systemRole: registration.role,
          protected: true,
          allowedSurfaces: [...registration.allowedSurfaces],
          editableFields: [...registration.editableFields]
        }
      : {
          owner: 'user' as const,
          protected: false,
          allowedSurfaces: ['management', 'chat', 'workflow', 'mention'] as const,
          editableFields: ['name', 'description', 'profileMarkdown'] as const
        };
  })()
}));
