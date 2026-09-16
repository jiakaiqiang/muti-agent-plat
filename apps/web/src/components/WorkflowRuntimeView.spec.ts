import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defaultAgents } from '@agent-cluster/shared'
import type { AgentCardState, CollaborationEvent, TaskViewState } from '@/types/contracts'
import { useAgentStore } from '@/stores/agent'
import WorkflowRuntimeView from './WorkflowRuntimeView.vue'

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
    createdAt: '2026-08-27T01:00:00.000Z',
    ...overrides
  } as CollaborationEvent
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
    updatedAt: '2026-08-27T01:00:00.000Z',
    ...overrides
  }
}

function mountView(props: {
  events?: CollaborationEvent[]
  tasks?: TaskViewState[]
  agents?: AgentCardState[]
} = {}) {
  return mount(WorkflowRuntimeView, {
    props: {
      events: props.events ?? [],
      tasks: props.tasks ?? [],
      agents: props.agents ?? [],
      currentMode: 'workflow'
    }
  })
}

describe('WorkflowRuntimeView render safety', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // The workflow view reads management.systemRole, but SessionWorkspace's onMounted only
  // loads the chat surface. Rendering with an unpopulated catalog must not throw, or the
  // whole component tree unmounts into a white screen.
  it('renders with an empty Agent catalog and no session events', () => {
    const store = useAgentStore()
    store.agents = []

    const wrapper = mountView()

    expect(wrapper.find('.workflow-cockpit').exists()).toBe(true)
    expect(wrapper.text()).toContain('本次会话还没有 Agent 讨论内容。')
  })

  it('renders when the catalog lacks management metadata entirely', () => {
    const store = useAgentStore()
    // A chat-surface payload carries no management block, so systemAgentIds is empty and
    // the chain head falls back to a non-system Agent.
    store.agents = [{ ...architect, management: undefined }]

    const wrapper = mountView({
      events: [event({ actor: { type: 'agent', id: architect.id } })],
      agents: [agentCard()]
    })

    expect(wrapper.find('.workflow-cockpit').exists()).toBe(true)
    expect(wrapper.findAll('.workflow-chain-node').length).toBeGreaterThan(0)
  })

  it('renders a system Agent chain head once the management surface is loaded', () => {
    const store = useAgentStore()
    store.agents = [...defaultAgents]

    const wrapper = mountView({
      events: [
        event({ actor: { type: 'agent', id: coordinator.id }, content: '召集讨论。' }),
        event({ actor: { type: 'agent', id: architect.id }, content: '给出方案。' })
      ],
      agents: [agentCard()]
    })

    expect(wrapper.find('.workflow-cockpit').exists()).toBe(true)
    expect(wrapper.find('.workflow-chain-node.is-system').exists()).toBe(true)
  })

  it.each([
    ['workflow_agent_substitution', '等待改派或跳过'],
    ['workflow_upstream_rerun', '等待选择返工节点'],
    ['confirm_workflow_human_gate', '等待人工验收']
  ])('shows the concrete waiting state for %s', (reason, label) => {
    const wrapper = mount(WorkflowRuntimeView, {
      props: {
        events: [],
        tasks: [],
        agents: [],
        currentMode: 'workflow',
        status: 'WAIT_USER_DECISION',
        activeConfirmation: {
          confirmationId: 'confirmation-1',
          reason,
          title: 'Decision',
          description: 'Choose an action.',
          status: 'pending',
          options: []
        }
      }
    });
    expect(wrapper.find('.session-state').text()).toBe(label);
  });

  it('labels intake rejection and execution failure as different facts', async () => {
    const wrapper = mountView({
      events: [
        event({ type: 'task_rejected', content: 'Rejected at intake.' }),
        event({ type: 'task_failed', content: 'Failed during execution.' })
      ]
    });
    const stageButtons = wrapper.findAll('.workflow-stage-chip');
    await stageButtons.find((button) => button.text().includes('分发接受'))?.trigger('click');
    expect(wrapper.text()).toContain('Agent 拒绝接单');
    await stageButtons.find((button) => button.text().includes('执行产出'))?.trigger('click');
    expect(wrapper.text()).toContain('任务执行失败');
  });
})
