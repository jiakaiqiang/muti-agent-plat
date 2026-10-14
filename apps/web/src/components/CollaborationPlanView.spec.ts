import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defaultAgents } from '@agent-cluster/shared'
import { useAgentStore } from '@/stores/agent'
import CollaborationPlanView from './CollaborationPlanView.vue'
import type { AgentCardState, BriefEventPayload, CollaborationEvent, TaskViewState } from '@/types/contracts'

const brief: BriefEventPayload = {
  briefId: 'brief-1', version: 2, goal: '完成群聊协作能力', scope: [], outOfScope: [], constraints: [],
  acceptanceCriteria: ['只读展示'], risks: [], openQuestions: [], requiresUserConfirmation: true
}
const tasks: TaskViewState[] = [{
  taskId: 'task-1', title: '实现协作计划', status: 'running', assignee: { type: 'agent', id: 'agent-1' },
  contextRequirements: [], verificationPlan: [], riskNotes: [], dependsOnTaskIds: [], acceptanceCriteria: ['完成视图'],
  resultSummary: '需要用户授权以下能力: tool.file_write (HUMAN_APPROVAL_REQUIRED)', artifacts: []
}]
const agents: AgentCardState[] = [{
  agentId: 'agent-1', name: '前端 Agent', role: '前端', status: 'running', currentTaskTitle: '实现协作计划',
  recentLogs: [], waitingFor: [], activeCapabilityNames: [], usedRagSnippets: [], artifactIds: [], updatedAt: '2026-09-22T00:00:00.000Z'
}]

function event(id: string, type: CollaborationEvent['type'], content: string): CollaborationEvent {
  return {
    id, sessionId: 'session-1', type, content, toAgentIds: [], actor: { type: 'agent', id: 'agent-1' },
    metadata: { schemaVersion: '0.1', payload: {} }, createdAt: '2026-09-22T00:00:00.000Z'
  }
}

describe('CollaborationPlanView', () => {
  beforeEach(() => { setActivePinia(createPinia()) })

  it('shows the system coordinator name even when it is not a session participant', () => {
    const coordinator = defaultAgents.find(agent => agent.key === 'coordinator')!
    const wrapper = mount(CollaborationPlanView, {
      props: { tasks: [], agents, events: [{ ...event('progress', 'runtime_progress', '等待模型响应'),
        actor: { type: 'agent', id: coordinator.id } }] }
    })
    expect(wrapper.get('.collaboration-process-list small').text()).toBe(coordinator.name)
    expect(wrapper.text()).not.toContain(coordinator.id)
  })

  it('uses the configured name and updates it when the Agent directory changes', async () => {
    const coordinator = defaultAgents.find(agent => agent.key === 'coordinator')!
    const store = useAgentStore()
    store.agents = [{ ...coordinator, name: '任务协调员' }]
    const wrapper = mount(CollaborationPlanView, {
      props: { tasks: [{ ...tasks[0], assignee: { type: 'agent', id: coordinator.id } }],
        agents, events: [{ ...event('progress', 'runtime_progress', '等待模型响应'),
          actor: { type: 'agent', id: coordinator.id } }] }
    })
    expect(wrapper.get('.collaboration-process-list small').text()).toBe('任务协调员')
    expect(wrapper.get('.collaboration-plan-task-copy small').text()).toContain('任务协调员')
    store.applyServerAgent({ ...coordinator, name: '主协调 Agent' })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.collaboration-process-list small').text()).toBe('主协调 Agent')
  })

  it('resolves legacy sender IDs and never displays an unknown Agent ID', () => {
    const coordinator = defaultAgents.find(agent => agent.key === 'coordinator')!
    const unknownId = '00000000-0000-0000-0000-0000000000ff'
    const wrapper = mount(CollaborationPlanView, {
      props: { tasks: [{ ...tasks[0], assignee: { type: 'agent', id: unknownId } }], agents,
        events: [{ ...event('legacy', 'artifact_created', '已创建产物'),
          actor: undefined, fromAgentId: coordinator.id },
        { ...event('unknown', 'runtime_progress', '执行中'), actor: { type: 'agent', id: unknownId } }] }
    })
    expect(wrapper.text()).toContain(coordinator.name)
    expect(wrapper.text()).not.toMatch(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i)
  })

  it('shows names instead of Agent keys for suggested tasks', () => {
    const coordinator = defaultAgents.find(agent => agent.key === 'coordinator')!
    const wrapper = mount(CollaborationPlanView, {
      props: { tasks: [], agents, events: [], brief: { ...brief, suggestedTasks: [{
        title: '拆解任务', description: '识别执行步骤', suggestedAgentKey: coordinator.key,
        dependsOnTaskTitles: []
      }] } }
    })
    expect(wrapper.get('.collaboration-plan-task-copy small').text()).toBe(coordinator.name)
  })

  it('renders the plan and collaboration process as a read-only projection', () => {
    const wrapper = mount(CollaborationPlanView, {
      props: {
        brief,
        tasks,
        agents,
        events: [
          event('confirmation', 'user_confirmation_requested', '确认执行任务契约'),
          event('waiting', 'task_waiting', '任务等待用户授权'),
          event('waiting-input', 'task_waiting', '执行已暂停，等待用户输入：当前决策没有用户确认。'),
          event('approved', 'tool_completed', '文件写入 approved for this scope.'),
          event('progress', 'runtime_progress', '前端 Agent 正在实现只读视图')
        ]
      }
    })

    expect(wrapper.text()).toContain('完成群聊协作能力')
    expect(wrapper.text()).toContain('实现协作计划')
    expect(wrapper.text()).toContain('完成视图')
    expect(wrapper.text()).toContain('前端 Agent 正在实现只读视图')
    expect(wrapper.text()).not.toContain('确认执行任务契约')
    expect(wrapper.text()).not.toContain('等待用户授权')
    expect(wrapper.text()).not.toContain('等待用户输入')
    expect(wrapper.text()).not.toContain('用户确认')
    expect(wrapper.text()).not.toContain('approved for this scope')
    expect(wrapper.text()).not.toContain('HUMAN_APPROVAL_REQUIRED')
    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(wrapper.findComponent({ name: 'ConfirmationCard' }).exists()).toBe(false)
    expect(wrapper.emitted()).toEqual({})
  })
})
