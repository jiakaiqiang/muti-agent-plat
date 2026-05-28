import { defineStore } from 'pinia'
import { mockAgents } from '@/mock/mockEvents'
import type { Agent } from '@/types/contracts'

const capabilityNameById: Record<string, string> = {
  'cap-brief': '任务契约生成',
  'cap-router': '消息路由',
  'cap-design-review': '架构评审',
  'cap-dry-run': 'Dry-run 执行',
  'cap-test-report': '测试报告',
  'cap-post-review': '交付复盘'
}

export const useAgentStore = defineStore('agent', {
  state: () => ({
    agents: [] as Agent[]
  }),
  getters: {
    agentById: (state) => (agentId: string) => state.agents.find((agent) => agent.id === agentId),
    agentName: (state) => (agentId?: string) =>
      agentId ? state.agents.find((agent) => agent.id === agentId)?.name ?? agentId : 'System',
    capabilityName: () => (capabilityId: string) => capabilityNameById[capabilityId] ?? capabilityId
  },
  actions: {
    loadAgents() {
      this.agents = mockAgents
    }
  }
})
