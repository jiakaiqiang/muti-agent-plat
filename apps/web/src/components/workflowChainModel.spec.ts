import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentCardState, CollaborationEvent, TaskViewState } from '@/types/contracts'
import {
  buildWorkflowChain,
  discussionRounds,
  workflowChainEdges,
  type WorkflowChainEdgeInput
} from './workflowChainModel'

const COORDINATOR_ID = '00000000-0000-0000-0000-000000000001'
const ARCHITECT_ID = '00000000-0000-0000-0000-0000000000a1'
const FRONTEND_ID = '00000000-0000-0000-0000-0000000000a2'
const TEST_ID = '00000000-0000-0000-0000-0000000000a3'

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

function card(agentId: string, overrides: Partial<AgentCardState> = {}): AgentCardState {
  return {
    agentId,
    name: `Agent ${agentId.slice(-2)}`,
    role: '角色',
    status: 'idle',
    recentLogs: [],
    waitingFor: [],
    activeCapabilityNames: [],
    usedRagSnippets: [],
    artifactIds: [],
    updatedAt: '2026-08-23T01:00:00.000Z',
    ...overrides
  }
}

function task(taskId: string, assigneeId: string, overrides: Partial<TaskViewState> = {}): TaskViewState {
  return {
    taskId,
    title: `任务 ${taskId}`,
    status: 'assigned',
    assignee: { type: 'agent', id: assigneeId },
    contextRequirements: [],
    verificationPlan: [],
    riskNotes: [],
    dependsOnTaskIds: [],
    acceptanceCriteria: [],
    artifacts: [],
    ...overrides
  } as TaskViewState
}

const names = new Map([
  [COORDINATOR_ID, '接收者'],
  [ARCHITECT_ID, '架构师'],
  [FRONTEND_ID, '前端工程师'],
  [TEST_ID, '测试工程师']
])

function resolveName(agentId: string) {
  return names.get(agentId) ?? ''
}

const chainInput = (overrides: Partial<Parameters<typeof buildWorkflowChain>[0]> = {}) => ({
  events: [] as CollaborationEvent[],
  tasks: [] as TaskViewState[],
  agents: [] as AgentCardState[],
  resolveName,
  systemAgentIds: [COORDINATOR_ID],
  ...overrides
})

describe('buildWorkflowChain chain head', () => {
  it('puts the system Agent first and marks it as the system kind', () => {
    const chain = buildWorkflowChain(
      chainInput({
        agents: [card(ARCHITECT_ID), card(FRONTEND_ID)],
        events: [
          event({ actor: { type: 'agent', id: ARCHITECT_ID } }),
          event({ actor: { type: 'agent', id: COORDINATOR_ID }, type: 'session_status_changed' })
        ]
      })
    )

    expect(chain[0]!.agentId).toBe(COORDINATOR_ID)
    expect(chain[0]!.kind).toBe('system')
    expect(chain[0]!.name).toBe('接收者')
    expect(chain.slice(1).every((node) => node.kind === 'agent')).toBe(true)
  })

  it('collects Agents that only ever appear as an event actor, without touching agentCards', () => {
    // TEST_ID has no AgentCardState at all: it is only ever an actor on an event.
    const chain = buildWorkflowChain(
      chainInput({
        agents: [card(ARCHITECT_ID)],
        events: [event({ actor: { type: 'agent', id: TEST_ID }, type: 'task_started' })]
      })
    )

    expect(chain.map((node) => node.agentId)).toContain(TEST_ID)
  })

  it('omits the system head when the system Agent never acted', () => {
    const chain = buildWorkflowChain(
      chainInput({
        agents: [card(ARCHITECT_ID)],
        events: [event({ actor: { type: 'agent', id: ARCHITECT_ID } })]
      })
    )

    expect(chain.map((node) => node.agentId)).not.toContain(COORDINATOR_ID)
  })

  it('never emits a bare UUID as a display name', () => {
    const chain = buildWorkflowChain(
      chainInput({
        agents: [card('00000000-0000-0000-0000-0000000000ff', { name: '' })],
        events: [event({ actor: { type: 'agent', id: '00000000-0000-0000-0000-0000000000ff' } })]
      })
    )

    for (const node of chain) {
      expect(node.name).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i)
      expect(node.name.length).toBeGreaterThan(0)
    }
  })
})

describe('buildWorkflowChain three-state derivation', () => {
  it('marks an Agent done when it completed work and nothing newer reactivated it', () => {
    const chain = buildWorkflowChain(
      chainInput({
        agents: [card(ARCHITECT_ID, { status: 'completed' })],
        events: [
          event({ actor: { type: 'agent', id: ARCHITECT_ID }, type: 'task_started', createdAt: '2026-08-23T01:00:00.000Z' }),
          event({ actor: { type: 'agent', id: ARCHITECT_ID }, type: 'task_completed', createdAt: '2026-08-23T01:05:00.000Z' })
        ]
      })
    )

    expect(chain.find((node) => node.agentId === ARCHITECT_ID)!.state).toBe('done')
  })

  it('marks an Agent active when a later event reopened work after a completion', () => {
    const chain = buildWorkflowChain(
      chainInput({
        agents: [card(ARCHITECT_ID, { status: 'running' })],
        events: [
          event({ actor: { type: 'agent', id: ARCHITECT_ID }, type: 'task_completed', createdAt: '2026-08-23T01:00:00.000Z' }),
          event({ actor: { type: 'agent', id: ARCHITECT_ID }, type: 'task_reworked', createdAt: '2026-08-23T01:05:00.000Z' })
        ]
      })
    )

    expect(chain.find((node) => node.agentId === ARCHITECT_ID)!.state).toBe('active')
  })

  it('treats running, thinking, discussing, reviewing, reworking and failed as active', () => {
    for (const status of ['running', 'thinking', 'discussing', 'reviewing', 'reworking', 'failed'] as const) {
      const chain = buildWorkflowChain(
        chainInput({
          agents: [card(ARCHITECT_ID, { status })],
          events: [event({ actor: { type: 'agent', id: ARCHITECT_ID } })]
        })
      )
      expect(chain.find((node) => node.agentId === ARCHITECT_ID)!.state, status).toBe('active')
    }
  })

  it('marks an Agent active while it holds an unfinished task even with an idle card', () => {
    const chain = buildWorkflowChain(
      chainInput({
        agents: [card(ARCHITECT_ID, { status: 'idle', currentTaskId: 'task-1' })],
        tasks: [task('task-1', ARCHITECT_ID, { status: 'running' })],
        events: [event({ actor: { type: 'agent', id: ARCHITECT_ID } })]
      })
    )

    expect(chain.find((node) => node.agentId === ARCHITECT_ID)!.state).toBe('active')
  })

  it('marks an Agent pending when the session holds no event for it', () => {
    const chain = buildWorkflowChain(
      chainInput({
        agents: [card(ARCHITECT_ID), card(FRONTEND_ID)],
        events: [event({ actor: { type: 'agent', id: ARCHITECT_ID } })]
      })
    )

    expect(chain.find((node) => node.agentId === FRONTEND_ID)!.state).toBe('pending')
  })

  it('returns exactly one state per node so the three states stay mutually exclusive', () => {
    const chain = buildWorkflowChain(
      chainInput({
        agents: [
          card(ARCHITECT_ID, { status: 'completed' }),
          card(FRONTEND_ID, { status: 'running' }),
          card(TEST_ID, { status: 'idle' })
        ],
        events: [
          event({ actor: { type: 'agent', id: ARCHITECT_ID }, type: 'task_completed' }),
          event({ actor: { type: 'agent', id: FRONTEND_ID }, type: 'task_started' })
        ]
      })
    )

    expect(chain.map((node) => node.state)).toEqual(['done', 'active', 'pending'])
  })

  it('exposes the per-Agent output without leaking it into the node label', () => {
    const chain = buildWorkflowChain(
      chainInput({
        agents: [
          card(ARCHITECT_ID, {
            status: 'running',
            currentTaskTitle: '梳理系统边界',
            actionSummary: '这是一段非常长的执行输出，绝不能出现在画布节点标签里。',
            recentLogs: ['第一条日志', '第二条日志'],
            activeCapabilityNames: ['架构评审']
          })
        ],
        events: [event({ actor: { type: 'agent', id: ARCHITECT_ID }, type: 'task_started' })]
      })
    )

    const node = chain.find((item) => item.agentId === ARCHITECT_ID)!
    expect(node.name).toBe('架构师')
    expect(node.name).not.toContain('执行输出')
    expect(node.output.actionSummary).toContain('执行输出')
    expect(node.output.capabilityNames).toEqual(['架构评审'])
    expect(node.output.recentLogs).toEqual(['第一条日志', '第二条日志'])
  })
})

describe('workflowChainEdges pulse eligibility', () => {
  const chain = buildWorkflowChain(
    chainInput({
      agents: [card(ARCHITECT_ID, { status: 'completed' }), card(FRONTEND_ID, { status: 'running' }), card(TEST_ID)],
      events: [
        event({ actor: { type: 'agent', id: ARCHITECT_ID }, type: 'task_completed' }),
        event({ actor: { type: 'agent', id: FRONTEND_ID }, type: 'task_started' })
      ]
    })
  )

  function edges(input: WorkflowChainEdgeInput[]) {
    return workflowChainEdges(chain, input)
  }

  it('pulses an edge that runs from a done Agent into an active Agent', () => {
    const [edge] = edges([{ id: 'e1', fromAgentId: ARCHITECT_ID, toAgentId: FRONTEND_ID, kind: 'message' }])
    expect(edge!.pulsing).toBe(true)
  })

  it('never pulses a fallback edge even when its endpoints qualify', () => {
    const [edge] = edges([{ id: 'e1', fromAgentId: ARCHITECT_ID, toAgentId: FRONTEND_ID, kind: 'fallback' }])
    expect(edge!.pulsing).toBe(false)
  })

  it('does not pulse an edge whose downstream Agent has not started', () => {
    const [edge] = edges([{ id: 'e1', fromAgentId: ARCHITECT_ID, toAgentId: TEST_ID, kind: 'task' }])
    expect(edge!.pulsing).toBe(false)
  })

  it('does not pulse an edge whose upstream Agent is not finished', () => {
    const [edge] = edges([{ id: 'e1', fromAgentId: FRONTEND_ID, toAgentId: ARCHITECT_ID, kind: 'task' }])
    expect(edge!.pulsing).toBe(false)
  })

  it('drops edges that point at an Agent outside the chain', () => {
    expect(edges([{ id: 'e1', fromAgentId: ARCHITECT_ID, toAgentId: 'missing-agent', kind: 'task' }])).toEqual([])
  })
})

describe('discussionRounds grouping', () => {
  it('groups discussion messages by round when phase is absent', () => {
    // The orchestrator emits discussion agent_message with round but no phase.
    const rounds = discussionRounds(
      [
        event({
          actor: { type: 'agent', id: ARCHITECT_ID },
          content: '第一轮观点。',
          metadata: { renderAs: 'agent_message', payload: { round: 1 } }
        }),
        event({
          actor: { type: 'agent', id: FRONTEND_ID },
          content: '第一轮回应。',
          metadata: { renderAs: 'agent_message', payload: { round: 1 } }
        }),
        event({
          actor: { type: 'agent', id: ARCHITECT_ID },
          content: '第二轮结论。',
          metadata: { renderAs: 'agent_message', payload: { round: 2 } }
        })
      ],
      resolveName
    )

    expect(rounds.map((round) => round.round)).toEqual([1, 2])
    expect(rounds[0]!.messages).toHaveLength(2)
    expect(rounds[0]!.messages[0]!.agentName).toBe('架构师')
    expect(rounds[1]!.messages[0]!.content).toBe('第二轮结论。')
  })

  it('keeps discussion messages that carry a discussion phase but no round', () => {
    const rounds = discussionRounds(
      [
        event({
          actor: { type: 'agent', id: ARCHITECT_ID },
          content: '无轮次的讨论。',
          metadata: { renderAs: 'agent_message', payload: { phase: 'discussion' } }
        })
      ],
      resolveName
    )

    expect(rounds).toHaveLength(1)
    expect(rounds[0]!.messages[0]!.content).toBe('无轮次的讨论。')
  })

  it('excludes non-discussion traffic such as routing and runtime notices', () => {
    const rounds = discussionRounds(
      [
        event({ type: 'runtime_progress', actor: { type: 'agent', id: ARCHITECT_ID }, content: '心跳。' }),
        event({
          actor: { type: 'agent', id: ARCHITECT_ID },
          content: '路由消息。',
          metadata: { renderAs: 'agent_message', payload: { phase: 'user_message_routing' } }
        })
      ],
      resolveName
    )

    expect(rounds).toEqual([])
  })

  it('orders rounds ascending and preserves arrival order inside a round', () => {
    const rounds = discussionRounds(
      [
        event({
          actor: { type: 'agent', id: ARCHITECT_ID },
          content: '晚到的第二轮。',
          createdAt: '2026-08-23T01:10:00.000Z',
          metadata: { renderAs: 'agent_message', payload: { round: 2 } }
        }),
        event({
          actor: { type: 'agent', id: FRONTEND_ID },
          content: '较早的第一轮。',
          createdAt: '2026-08-23T01:00:00.000Z',
          metadata: { renderAs: 'agent_message', payload: { round: 1 } }
        }),
        event({
          actor: { type: 'agent', id: TEST_ID },
          content: '第一轮的第二条。',
          createdAt: '2026-08-23T01:02:00.000Z',
          metadata: { renderAs: 'agent_message', payload: { round: 1 } }
        })
      ],
      resolveName
    )

    expect(rounds.map((round) => round.round)).toEqual([1, 2])
    expect(rounds[0]!.messages.map((message) => message.content)).toEqual(['较早的第一轮。', '第一轮的第二条。'])
  })
})

describe('workflowChainModel purity', () => {
  it('does not import Vue, Pinia or any store', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/workflowChainModel.ts'), 'utf8')

    expect(source).not.toMatch(/from 'vue'/)
    expect(source).not.toMatch(/from 'pinia'/)
    expect(source).not.toMatch(/@\/stores\//)
    expect(source).not.toMatch(/@\/composables\//)
  })

  it('leaves its inputs untouched', () => {
    const agents = [card(ARCHITECT_ID, { status: 'completed' })]
    const events = [event({ actor: { type: 'agent', id: ARCHITECT_ID }, type: 'task_completed' })]
    const snapshot = JSON.stringify({ agents, events })

    buildWorkflowChain(chainInput({ agents, events }))
    discussionRounds(events, resolveName)

    expect(JSON.stringify({ agents, events })).toBe(snapshot)
  })
})
