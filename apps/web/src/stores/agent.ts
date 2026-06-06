import { defineStore } from 'pinia'
import { apiGet, apiPatch, apiPost } from '@/api/client'
import type { Agent, RuntimeCapabilityDefinition } from '@/types/contracts'

type CreateAgentInput = {
  name: string
  role: string
  tags?: string[]
  capabilityIds?: string[]
  modelId?: string
}

type UpdateAgentInput = Partial<
  Pick<Agent, 'name' | 'role' | 'tags' | 'capabilityIds' | 'status' | 'modelId' | 'profileMarkdown'>
>

const capabilityNameById: Record<string, string> = {
  'cap-brief': '任务契约生成',
  'cap-router': '消息路由',
  'cap-design-review': '架构评审',
  'cap-dry-run': 'Dry-run 执行',
  'cap-test-report': '测试报告',
  'cap-post-review': '交付复盘',
  'cap-feishu-draft': '飞书草稿'
}

export const useAgentStore = defineStore('agent', {
  state: () => ({
    agents: [] as Agent[],
    capabilities: [] as RuntimeCapabilityDefinition[]
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
      this.agents = await apiGet<Agent[]>('/agents')
    },
    async createAgent(input: CreateAgentInput) {
      const agent = await apiPost<Agent>('/agents', input)
      this.agents = [agent, ...this.agents.filter((item) => item.id !== agent.id)]
      return agent
    },
    async updateAgent(agentId: string, input: UpdateAgentInput) {
      const agent = await apiPatch<Agent>(`/agents/${agentId}`, input)
      this.agents = this.agents.map((item) => (item.id === agent.id ? agent : item))
      return agent
    },
    async loadCapabilities() {
      this.capabilities = await apiGet<RuntimeCapabilityDefinition[]>('/capabilities')
    }
  }
})
