import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { AgentDefinition, CollaborationEvent } from '@/types/contracts'
import { useAgentStore } from '@/stores/agent'
import { useEventStore } from '@/stores/event'
import AgentStatusPanel from './AgentStatusPanel.vue'
import CollaborationLogPanel from './CollaborationLogPanel.vue'

/**
 * 群聊回归基线（Task T0）。
 *
 * 工作流视图改造会碰 CollaborationLogPanel、styles.css 和共享的 agent-tone-* 配色，
 * 这里把群聊侧的现状固定下来，改动后复跑即可发现越界。
 */

const SESSION_ID = 'session-baseline'

function agent(id: string, name: string, role: string): AgentDefinition {
  return {
    id,
    key: name,
    name,
    role,
    profileMarkdown: '',
    tags: [],
    status: 'active',
    capabilityIds: [],
    defaultKnowledgeBaseIds: [],
    profileRevision: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z'
  }
}

function agentMessage(id: string, agentId: string, content: string): CollaborationEvent {
  return {
    id,
    sessionId: SESSION_ID,
    type: 'agent_message',
    actor: { type: 'agent', id: agentId },
    fromAgentId: agentId,
    toAgentIds: [],
    content,
    metadata: { payload: { round: 1 } },
    createdAt: '2026-08-01T00:01:00.000Z'
  }
}

const AGENTS = [
  agent('agent-a', '架构师', '设计'),
  agent('agent-b', '开发', '实现'),
  agent('agent-c', '测试', '验证')
]

function seedStores() {
  const agentStore = useAgentStore()
  agentStore.agents = AGENTS
  agentStore.agentsBySurface = { chat: AGENTS }

  const eventStore = useEventStore()
  eventStore.eventsBySessionId = {
    [SESSION_ID]: [
      agentMessage('event-1', 'agent-a', '先确认边界。'),
      agentMessage('event-2', 'agent-b', '我来实现。')
    ]
  }
  return { agentStore, eventStore }
}

describe('群聊基线：agentCards 契约', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('保持签名与返回结构，参与者过滤仍生效', () => {
    const { eventStore } = seedStores()

    const all = eventStore.agentCards(SESSION_ID)
    expect(all.map((card) => card.agentId)).toEqual(['agent-a', 'agent-b', 'agent-c'])

    const scoped = eventStore.agentCards(SESSION_ID, ['agent-a', 'agent-b'])
    expect(scoped.map((card) => card.agentId)).toEqual(['agent-a', 'agent-b'])

    expect(Object.keys(scoped[0]).sort()).toEqual(
      [
        'actionSummary',
        'activeCapabilityNames',
        'agentId',
        'artifactIds',
        'currentTaskId',
        'currentTaskTitle',
        'name',
        'recentLogs',
        'role',
        'status',
        'updatedAt',
        'usedRagSnippets',
        'waitingFor'
      ].filter((key) => key in scoped[0]).sort()
    )
    expect(scoped[0]).toMatchObject({ agentId: 'agent-a', name: '架构师', role: '设计' })
    expect(Array.isArray(scoped[0].recentLogs)).toBe(true)
    expect(Array.isArray(scoped[0].waitingFor)).toBe(true)
    expect(Array.isArray(scoped[0].activeCapabilityNames)).toBe(true)
    expect(Array.isArray(scoped[0].usedRagSnippets)).toBe(true)
    expect(Array.isArray(scoped[0].artifactIds)).toBe(true)
  })

  it('不把系统 Agent 混进会话卡片', () => {
    const { eventStore } = seedStores()
    const cards = eventStore.agentCards(SESSION_ID)
    expect(cards.some((card) => card.agentId === '00000000-0000-0000-0000-000000000001')).toBe(false)
    expect(cards.some((card) => card.agentId === '00000000-0000-0000-0000-000000000011')).toBe(false)
  })
})

describe('群聊基线：右侧面板挂载归属', () => {
  const source = SessionWorkspaceSource()

  it('Web 工作流辅助视图保持原有执行日志', () => {
    expect(source).toContain(
      '<CollaborationLogPanel'
    )
  })

  it('Web 中央群聊右侧保留 Agent 进度', () => {
    const logPanelAt = source.indexOf('<CollaborationLogPanel')
    const statusPanelAt = source.indexOf('<AgentStatusPanel')
    expect(logPanelAt).toBeGreaterThan(-1)
    expect(statusPanelAt).toBeGreaterThan(logPanelAt)
    expect(source.slice(logPanelAt, statusPanelAt + 200)).toMatch(/<AgentStatusPanel\s+v-else/)
  })

  it('Web 保持原有群聊与工作流视图，不挂载桌面工作区', () => {
    expect(source).toContain("<div v-if=\"currentMode === 'chat'\" class=\"chat-pane\">")
    expect(source).toContain('<ChatTimeline')
    expect(source).toContain('<WorkflowRuntimeView')
    expect(source).not.toContain('task-workspace')
  })
})

describe('群聊基线：头像身份配色', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('AgentStatusPanel 头像按列表下标轮转 agent-tone-1..5，不随执行状态变色', () => {
    const cards = [
      { agentId: 'agent-a', name: '架构师', role: '设计', status: 'idle' as const },
      { agentId: 'agent-b', name: '开发', role: '实现', status: 'running' as const },
      { agentId: 'agent-c', name: '测试', role: '验证', status: 'completed' as const }
    ].map((card) => ({
      ...card,
      recentLogs: [],
      waitingFor: [],
      activeCapabilityNames: [],
      usedRagSnippets: [],
      artifactIds: [],
      updatedAt: '2026-08-01T00:00:00.000Z'
    }))

    const wrapper = mount(AgentStatusPanel, {
      props: {
        agents: cards,
        availableAgents: AGENTS,
        capabilities: [],
        tasks: [],
        connected: true
      }
    })

    const portraits = wrapper.findAll('.agent-card .agent-portrait')
    expect(portraits).toHaveLength(3)
    expect(portraits[0].classes()).toContain('agent-tone-1')
    expect(portraits[1].classes()).toContain('agent-tone-2')
    expect(portraits[2].classes()).toContain('agent-tone-3')

    // 状态色走独立的 .agent-status 类，与身份配色互不干扰。
    expect(wrapper.find('.agent-status.running').exists()).toBe(true)
    expect(wrapper.find('.agent-status.completed').exists()).toBe(true)
  })

  it('CollaborationLogPanel 复用同一套 agent-tone-* 身份配色', () => {
    const cards = AGENTS.map((item) => ({
      agentId: item.id,
      name: item.name,
      role: item.role,
      status: 'idle' as const,
      recentLogs: [],
      waitingFor: [],
      activeCapabilityNames: [],
      usedRagSnippets: [],
      artifactIds: [],
      updatedAt: '2026-08-01T00:00:00.000Z'
    }))

    const wrapper = mount(CollaborationLogPanel, {
      props: {
        events: [agentMessage('event-1', 'agent-b', '我来实现。')],
        agents: cards
      }
    })

    const card = wrapper.find('.collaboration-log-card')
    expect(card.exists()).toBe(true)
    expect(card.classes()).toContain('agent-tone-2')
  })
})

function SessionWorkspaceSource() {
  // 读源码而非挂载：SessionWorkspace 依赖路由、SSE 和多个 store，挂载成本远高于断言收益。
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const { resolve } = require('node:path') as typeof import('node:path')
  return readFileSync(resolve(process.cwd(), 'src/components/SessionWorkspace.vue'), 'utf8')
}
