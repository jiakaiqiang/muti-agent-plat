import { defineStore } from 'pinia'
import { apiGet } from '@/api/client'
import { mockAgents } from '@/mock/mockEvents'
import type { Agent, RuntimeCapabilityDefinition } from '@/types/contracts'

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
      try {
        this.agents = await apiGet<Agent[]>('/agents')
      } catch {
        this.agents = mockAgents
      }
    },
    async loadCapabilities() {
      try {
        this.capabilities = await apiGet<RuntimeCapabilityDefinition[]>('/capabilities')
      } catch {
        this.capabilities = Object.entries(capabilityNameById).map(([id, name]) => ({
          id,
          key: id,
          name,
          riskLevel: 'medium'
        }))
      }
    }
  }
})
