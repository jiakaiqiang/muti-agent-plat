import { defineStore } from 'pinia'
import { defaultAgents } from '@agent-cluster/shared'
import { apiGet, apiPatch, apiPost } from '@/api/client'
import type {
  AgentDefinition,
  CapabilityDefinition,
  CompiledAgentProfile,
  ProfileDiagnostic,
  RuntimeType,
  SystemAgentRole,
  SystemAgentRuntimePolicy
} from '@/types/contracts'

export type AgentFormState = {
  name: string
  tags: string
  profileMarkdown: string
  capabilityIds: string[]
}

function emptyAgentForm(): AgentFormState {
  return { name: '', tags: '', profileMarkdown: '', capabilityIds: [] }
}

type CreateAgentInput = {
  name: string
  role: string
  tags?: string[]
  capabilityIds?: string[]
  profileMarkdown?: string
}

type UpdateAgentInput = Partial<
  Pick<AgentDefinition, 'name' | 'role' | 'tags' | 'capabilityIds' | 'status' | 'profileMarkdown'>
>

type ValidateProfileInput = {
  profileMarkdown: string
  capabilityIds?: string[]
}

const capabilityNameById: Record<string, string> = {
  'cap-brief': '任务契约生成',
  'cap-router': '消息路由',
  'cap-design-review': '架构评审',
  'cap-dry-run': 'Dry-run 执行',
  'cap-test-report': '测试报告',
  'cap-post-review': '交付复盘',
  'cap-feishu-draft': '飞书草稿'
}

function mergeWithDefaultAgents(agents: AgentDefinition[]) {
  const merged = new Map<string, AgentDefinition>()
  for (const agent of agents) {
    merged.set(agent.id, agent)
  }
  for (const agent of defaultAgents) {
    if (!merged.has(agent.id) && !agents.some((item) => item.key === agent.key)) {
      merged.set(agent.id, agent)
    }
  }
  return [...merged.values()]
}

export const useAgentStore = defineStore('agent', {
  state: () => ({
    agents: [] as AgentDefinition[],
    capabilities: [] as CapabilityDefinition[],
    showCreateForm: false,
    editingAgentId: '',
    savingAgentId: '',
    formError: '',
    resourceSearch: '',
    previewMode: 'source' as 'source' | 'preview',
    diagnostics: [] as ProfileDiagnostic[],
    compiled: null as CompiledAgentProfile | null,
    validating: false,
    selectedAgentId: '',
    agentSearch: '',
    activeTab: 'edit' as 'edit' | 'config' | 'test' | 'logs' | 'versions',
    profilePanelOpen: false,
    canvasLayout: 'linear' as 'linear' | 'branch',
    selectedResourceKey: '',
    libraryCollapsed: { skill: false, tool: false },
    createForm: emptyAgentForm(),
    editForms: {} as Record<string, AgentFormState>,
    systemAgentRuntimePolicies: {} as Partial<Record<SystemAgentRole, SystemAgentRuntimePolicy>>
  }),
  getters: {
    agentById: (state) => (agentId: string) => state.agents.find((agent) => agent.id === agentId),
    agentName: (state) => (agentId?: string) =>
      agentId ? state.agents.find((agent) => agent.id === agentId)?.name ?? agentId : 'System',
    capabilityName: (state) => (capabilityId: string) =>
      state.capabilities.find((capability) => capability.id === capabilityId)?.name ??
      capabilityNameById[capabilityId] ??
      capabilityId
  },
  actions: {
    async loadAgents() {
      try {
        const agents = await apiGet<AgentDefinition[]>('/agents')
        this.agents = mergeWithDefaultAgents(agents)
      } catch (error) {
        console.warn('Failed to load agents from API; using built-in defaults.', error)
        this.agents = mergeWithDefaultAgents([])
      }
      try {
        const policies = await apiGet<SystemAgentRuntimePolicy[]>('/system-agent-runtime-policies')
        this.systemAgentRuntimePolicies = Object.fromEntries(policies.map((policy) => [policy.role, policy]))
      } catch (error) {
        console.warn('Failed to load system Agent Runtime policies.', error)
      }
    },
    async createAgent(input: CreateAgentInput) {
      const agent = await apiPost<AgentDefinition>('/agents', input)
      this.agents = [agent, ...this.agents.filter((item) => item.id !== agent.id)]
      return agent
    },
    async updateAgent(agentId: string, input: UpdateAgentInput) {
      const agent = await apiPatch<AgentDefinition>(`/agents/${agentId}`, input)
      this.applyServerAgent(agent)
      return agent
    },
    applyServerAgent(agent: AgentDefinition) {
      const hasAgent = this.agents.some((item) => item.id === agent.id)
      this.agents = hasAgent
        ? this.agents.map((item) => (item.id === agent.id ? agent : item))
        : [agent, ...this.agents]
    },
    async loadCapabilities() {
      this.capabilities = await apiGet<CapabilityDefinition[]>('/capabilities')
    },
    async validateProfile(input: ValidateProfileInput) {
      return await apiPost<CompiledAgentProfile>('/agents/profile/validate', input)
    },
    async updateSystemAgentRuntimePolicy(
      role: SystemAgentRole,
      input: {
        preferredRuntimeType?: RuntimeType | null
        preferredModelId?: string | null
        allowedRuntimeTypes?: RuntimeType[]
      }
    ) {
      const policy = await apiPatch<SystemAgentRuntimePolicy>(
        `/system-agent-runtime-policies/${role}`,
        input
      )
      this.systemAgentRuntimePolicies[role] = policy
      return policy
    }
  }
})
