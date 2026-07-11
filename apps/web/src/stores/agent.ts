import { defineStore } from 'pinia'
import { defaultAgents } from '@agent-cluster/shared'
import { apiGet, apiPatch, apiPost } from '@/api/client'
import type { Agent, CapabilityDefinition, CompiledAgentProfile, RuntimeType } from '@/types/contracts'

type CreateAgentInput = {
  name: string
  role: string
  tags?: string[]
  capabilityIds?: string[]
  profileMarkdown?: string
  modelId?: string
  runtimeType?: RuntimeType
}

type UpdateAgentInput = Partial<
  Pick<Agent, 'name' | 'role' | 'tags' | 'capabilityIds' | 'status' | 'modelId' | 'runtimeType' | 'profileMarkdown'>
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

function mergeWithDefaultAgents(agents: Agent[]) {
  const merged = new Map<string, Agent>()
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
    agents: [] as Agent[],
    capabilities: [] as CapabilityDefinition[]
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
        this.agents = mergeWithDefaultAgents(await apiGet<Agent[]>('/agents'))
      } catch (error) {
        console.warn('Failed to load agents from API; using built-in defaults.', error)
        this.agents = mergeWithDefaultAgents([])
      }
    },
    async createAgent(input: CreateAgentInput) {
      const agent = await apiPost<Agent>('/agents', input)
      this.agents = [agent, ...this.agents.filter((item) => item.id !== agent.id)]
      return agent
    },
    async updateAgent(agentId: string, input: UpdateAgentInput) {
      const agent = await apiPatch<Agent>(`/agents/${agentId}`, input)
      this.applyServerAgent(agent)
      return agent
    },
    applyServerAgent(agent: Agent) {
      const hasAgent = this.agents.some((item) => item.id === agent.id)
      this.agents = hasAgent
        ? this.agents.map((item) => (item.id === agent.id ? agent : item))
        : [agent, ...this.agents]
    },
    removeSkillReference(skillId: string, agentIds?: string[]) {
      const affectedAgentIds = agentIds ? new Set(agentIds) : undefined
      this.agents = this.agents.map((agent) => {
        if (affectedAgentIds && !affectedAgentIds.has(agent.id)) return agent
        if (!(agent.skillIds ?? []).includes(skillId)) return agent
        return {
          ...agent,
          skillIds: (agent.skillIds ?? []).filter((id) => id !== skillId)
        }
      })
    },
    async loadCapabilities() {
      this.capabilities = await apiGet<CapabilityDefinition[]>('/capabilities')
    },
    async validateProfile(input: ValidateProfileInput) {
      return await apiPost<CompiledAgentProfile>('/agents/profile/validate', input)
    }
  }
})
