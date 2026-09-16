import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defaultAgents } from '@agent-cluster/shared'
import type { AgentCardState, CollaborationEvent } from '@/types/contracts'
import { useAgentStore } from '@/stores/agent'
import CollaborationLogPanel from './CollaborationLogPanel.vue'

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

const coordinator = defaultAgents.find((agent) => agent.key === 'coordinator')!
const architect = defaultAgents.find((agent) => agent.management?.allowedSurfaces.includes('chat'))!

function event(overrides: Partial<CollaborationEvent> = {}): CollaborationEvent {
  return {
    id: `event-${Math.random().toString(16).slice(2)}`,
    sessionId: 'session-1',
    type: 'agent_message',
    toAgentIds: [],
    content: '默认事件内容。',
    metadata: { renderAs: 'agent_message', payload: {} },
    createdAt: '2026-08-23T01:00:00.000Z',
    ...overrides
  } as CollaborationEvent
}

function heartbeat(invocationId: string, elapsedMs: number, createdAt: string): CollaborationEvent {
  return event({
    type: 'runtime_progress',
    actor: { type: 'agent', id: architect.id },
    content: `${architect.name} 的模型调用仍在进行中（已等待 ${Math.round(elapsedMs / 1000)} 秒）。`,
    createdAt,
    metadata: {
      renderAs: 'system_notice',
      payload: {
        runtimeInvocationId: invocationId,
        code: 'RUNTIME_HEARTBEAT',
        elapsedMs
      }
    }
  })
}

function agentCard(overrides: Partial<AgentCardState> = {}): AgentCardState {
  return {
    agentId: architect.id,
    name: architect.name,
    role: architect.role,
    status: 'running',
    recentLogs: [],
    waitingFor: [],
    activeCapabilityNames: [],
    usedRagSnippets: [],
    artifactIds: [],
    updatedAt: '2026-08-23T01:00:00.000Z',
    ...overrides
  }
}

function mountPanel(events: CollaborationEvent[], agents: AgentCardState[] = [agentCard()]) {
  return mount(CollaborationLogPanel, { props: { events, agents } })
}

describe('CollaborationLogPanel Agent name resolution', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const store = useAgentStore()
    store.agents = [...defaultAgents]
  })

  it('resolves a system Agent that is not a session participant to its name instead of a raw UUID', () => {
    // The coordinator is management-surface only, so it never reaches participatingAgentIds
    // and therefore never has an AgentCardState. It must still render as a name.
    const wrapper = mountPanel([
      event({
        type: 'session_status_changed',
        actor: { type: 'agent', id: coordinator.id },
        content: '会话已进入执行阶段。',
        metadata: { renderAs: 'system_notice', payload: {} }
      })
    ])

    const text = wrapper.text()
    expect(text).toContain(coordinator.name)
    expect(text).not.toContain(coordinator.id)
    expect(text).not.toMatch(UUID_PATTERN)
  })

  it('renders no bare UUID even when the Agent is unknown to both the card list and the store', () => {
    const wrapper = mountPanel([
      event({
        actor: { type: 'agent', id: '00000000-0000-0000-0000-0000000000ff' },
        content: '未知 Agent 发言。'
      })
    ])

    expect(wrapper.text()).not.toMatch(UUID_PATTERN)
  })

  it('reads identity from actor rather than the deprecated fromAgentId', () => {
    const wrapper = mountPanel([
      event({
        actor: { type: 'agent', id: architect.id },
        fromAgentId: undefined,
        content: '仅带 actor 的消息应当可见。'
      })
    ])

    expect(wrapper.text()).toContain('仅带 actor 的消息应当可见。')
    expect(wrapper.text()).toContain(architect.name)
  })
})

describe('CollaborationLogPanel heartbeat folding', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const store = useAgentStore()
    store.agents = [...defaultAgents]
  })

  it('folds consecutive heartbeats of one invocation into a single entry showing the longest wait', () => {
    const wrapper = mountPanel([
      heartbeat('invocation-1', 30_000, '2026-08-23T01:00:30.000Z'),
      heartbeat('invocation-1', 60_000, '2026-08-23T01:01:00.000Z'),
      heartbeat('invocation-1', 90_000, '2026-08-23T01:01:30.000Z')
    ])

    const cards = wrapper.findAll('.collaboration-log-card')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.text()).toContain('90')
    expect(cards[0]!.text()).not.toContain('30 秒')
  })

  it('keeps heartbeats of different invocations separate', () => {
    const wrapper = mountPanel([
      heartbeat('invocation-1', 30_000, '2026-08-23T01:00:30.000Z'),
      heartbeat('invocation-2', 30_000, '2026-08-23T01:02:30.000Z')
    ])

    expect(wrapper.findAll('.collaboration-log-card')).toHaveLength(2)
  })

  it('does not fold heartbeats that are interrupted by a real execution event', () => {
    const wrapper = mountPanel([
      heartbeat('invocation-1', 30_000, '2026-08-23T01:00:30.000Z'),
      event({
        type: 'task_completed',
        actor: { type: 'agent', id: architect.id },
        content: '任务已完成。',
        createdAt: '2026-08-23T01:01:00.000Z'
      }),
      heartbeat('invocation-1', 90_000, '2026-08-23T01:01:30.000Z')
    ])

    expect(wrapper.findAll('.collaboration-log-card')).toHaveLength(3)
  })

  it('keeps real execution events visible when many heartbeats arrive', () => {
    const events: CollaborationEvent[] = []
    for (let index = 0; index < 10; index += 1) {
      events.push(heartbeat('invocation-1', (index + 1) * 30_000, `2026-08-23T01:${String(index).padStart(2, '0')}:30.000Z`))
    }
    events.push(
      event({
        type: 'task_completed',
        actor: { type: 'agent', id: architect.id },
        content: '真实执行事件必须留在窗口内。',
        createdAt: '2026-08-23T01:20:00.000Z'
      })
    )

    const wrapper = mountPanel(events)

    expect(wrapper.text()).toContain('真实执行事件必须留在窗口内。')
    expect(wrapper.findAll('.collaboration-log-card').length).toBeLessThanOrEqual(8)
  })
})
