import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { AgentTask, WorkflowRun } from '@agent-cluster/shared'
import type { ChatMessage, CollaborationEvent } from '@/types/contracts'
import { useTaskWorkspaceStore } from '@/stores/taskWorkspace'
import WebChatTimeline from './ChatTimeline.vue'
import DesktopChatTimeline from '../../../desktop/renderer/components/ChatTimeline.vue'
import CollaborationLogPanel from './CollaborationLogPanel.vue'
import CollaborationPlanView from './CollaborationPlanView.vue'
import WorkflowExecutionDetails from '../../../desktop/renderer/components/workspace/WorkflowExecutionDetails.vue'

const date = new Date(2026, 0, 2, 3, 4, 5)
const createdAt = date.toISOString()
const expected = '2026年01月02日 03:04:05'
const message: ChatMessage = {
  id: 'message', sessionId: 'session', senderType: 'user', messageType: 'text',
  content: '测试消息', toAgentIds: [], rawEventId: 'event', createdAt
}
const event: CollaborationEvent = {
  id: 'event', sessionId: 'session', type: 'runtime_progress', content: '已收到执行进展',
  toAgentIds: [], metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: {} }, createdAt
}
const wrappers: VueWrapper[] = []
const chatStubs = { ChatScrollArea: { props: ['messages'], template: '<div><slot :visible-messages="messages" /></div>' }, AgentPortrait: true }

beforeEach(() => { setActivePinia(createPinia()); sessionStorage.clear() })
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()) })

describe('event timestamps across clients', () => {
  it.each([['Web', WebChatTimeline], ['Desktop', DesktopChatTimeline]] as const)('%s formats every sender without modifying message timestamps', async (_client, component) => {
    const messages = (['user', 'agent', 'system'] as const).map(senderType => ({ ...message, id: senderType, senderType }))
    const wrapper = mount(component, { props: { messages }, global: { stubs: chatStubs } })
    wrappers.push(wrapper)
    expect(wrapper.findAll('.message-header span').map(item => item.text())).toEqual([expected, expected, expected])
    expect(messages.map(item => item.createdAt)).toEqual([createdAt, createdAt, createdAt])
    await wrapper.setProps({ messages: [{ ...message, createdAt: 'invalid' }] })
    expect(wrapper.get('.message-header span').text()).toBe('—')
  })

  it('formats folded stop receipts with the same date and seconds', () => {
    const wrapper = mount(WebChatTimeline, {
      props: { messages: [{ ...message, payload: { collapsedStopReceiptCount: 2, collapsedStopReceiptTimes: [createdAt] } }] },
      global: { stubs: chatStubs }
    })
    wrappers.push(wrapper)
    expect(wrapper.get('.stop-receipt-history li').text()).toBe(expected)
  })

  it('uses the same complete timestamp in collaboration logs and plan events', () => {
    const log = mount(CollaborationLogPanel, { props: { events: [event], agents: [] } })
    const plan = mount(CollaborationPlanView, { props: { events: [event], agents: [], tasks: [] } })
    wrappers.push(log, plan)
    expect(log.get('time').text()).toBe(expected)
    expect(plan.get('time').text()).toBe(expected)
    expect(event.createdAt).toBe(createdAt)
  })

  it('formats task dates and implementation events in the desktop workflow inspector', () => {
    const store = useTaskWorkspaceStore()
    store.sessionId = 'session'
    store.select({ runId: 'run', nodeId: 'node', taskId: 'task' })
    store.details.run = { run: { id: 'run', definitionSnapshot: { nodes: [] } } as unknown as WorkflowRun, nodeRuns: [], approvals: [] }
    store.tasks = [{
      id: 'task', sessionId: 'session', workflowRunId: 'run', workflowNodeId: 'node',
      title: '测试任务', description: '', status: 'running', assignee: { type: 'agent', id: 'agent' },
      acceptanceCriteria: [], dependsOnTaskIds: [], createdAt, updatedAt: createdAt
    } as AgentTask]
    const taskEvent = { ...event, metadata: { schemaVersion: '0.1', payload: { taskId: 'task' } } }
    const wrapper = mount(WorkflowExecutionDetails, { props: { events: [taskEvent], inspector: true }, global: { stubs: { ElButton: true } } })
    wrappers.push(wrapper)
    expect(wrapper.findAll('small').map(item => item.text())).toEqual([`${expected} → ${expected}`, expected])
    expect(store.tasks[0].createdAt).toBe(createdAt)
    expect(taskEvent.createdAt).toBe(createdAt)
  })
})
