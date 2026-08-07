import type {
  AgentCatalogSurface,
  AgentEditableField,
  SystemAgentRole,
  UUID
} from './contracts.js';

export type SystemAgentRegistration = {
  role: SystemAgentRole;
  agentId: UUID;
  key: string;
  allowedSurfaces: AgentCatalogSurface[];
  editableFields: AgentEditableField[];
};

export const SYSTEM_AGENT_REGISTRATIONS = [
  {
    role: 'coordinator',
    agentId: '00000000-0000-0000-0000-000000000001',
    key: 'coordinator',
    allowedSurfaces: ['management'],
    editableFields: ['name', 'description', 'profileMarkdown']
  },
  {
    role: 'intent_router',
    agentId: '00000000-0000-0000-0000-000000000011',
    key: 'system-intent-router',
    allowedSurfaces: ['management'],
    editableFields: ['name', 'description', 'profileMarkdown']
  }
] as const satisfies readonly SystemAgentRegistration[];

export const SYSTEM_AGENT_KEYS = new Set(SYSTEM_AGENT_REGISTRATIONS.map((item) => item.key));
export const SYSTEM_AGENT_IDS = new Set(SYSTEM_AGENT_REGISTRATIONS.map((item) => item.agentId));
