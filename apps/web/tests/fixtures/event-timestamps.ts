// Isolated visual fixture. No backend, Runtime or real model is contacted.
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import { unknownRuntimeHealthCapabilities, type RuntimeHealthSnapshot } from '@agent-cluster/shared'
import type { ChatMessage, CollaborationEvent } from '../../src/types/contracts'
import WebChatTimeline from '../../src/components/ChatTimeline.vue'
import DesktopChatTimeline from '../../../desktop/renderer/components/ChatTimeline.vue'
import CollaborationLogPanel from '../../src/components/CollaborationLogPanel.vue'
import RuntimeRequestHealthPanel from '../../src/components/RuntimeRequestHealthPanel.vue'
import { useEventStore } from '../../src/stores/event'

const desktop = new URLSearchParams(location.search).get('client') === 'desktop'
if (desktop) await import('../../../desktop/renderer/styles.css')
else await import('../../src/styles.css')
const createdAt = new Date(2026, 8, 29, 15, 4, 5).toISOString()
const event: CollaborationEvent = {
  id: 'fixture-event', sessionId: 'fixture', type: 'runtime_progress', content: '收到模型执行进展。',
  actor: { type: 'system', id: 'fixture', displayName: '系统' }, toAgentIds: [], createdAt,
  metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: {} }
}
const messages: ChatMessage[] = (['user', 'system'] as const).map(senderType => ({
  id: senderType, sessionId: 'fixture', senderType, messageType: 'text', toAgentIds: [],
  rawEventId: `fixture-${senderType}`, createdAt, content: '完整事件时间应显示年月日和两位数时分秒。'
}))
const snapshot: RuntimeHealthSnapshot = {
  schemaVersion: 1, policyVersion: 'request-health-v1', sessionId: 'fixture', operationId: 'fixture-operation',
  invocationId: 'fixture-invocation', sessionGeneration: 1, observerEpoch: 'fixture', version: 1,
  phase: 'discussion', agentId: 'fixture-agent', runtimeType: 'codex', stage: 'terminal', health: 'terminal',
  reasonCode: 'terminal_received', capabilities: unknownRuntimeHealthCapabilities(), processStatus: 'exited', requestStatus: 'ended',
  startedAt: createdAt, updatedAt: createdAt, lastProgressAt: createdAt, observationDue: false, canWait: false, canStop: false
}
const requests: Array<{ path: string; method: string }> = []
window.fetch = async (input, init) => {
  requests.push({ path: String(input), method: init?.method ?? 'GET' })
  return new Response(JSON.stringify({ data: { items: [snapshot] }, requestId: 'timestamp-fixture' }), { headers: { 'content-type': 'application/json' } })
}
const pinia = createPinia()
useEventStore(pinia).eventsBySessionId.fixture = [event]
createApp({ render: () => h('main', { style: 'max-width:900px;margin:auto;padding:16px' }, [
  h('h1', { style: 'font-size:20px;margin:0 0 16px' }, `${desktop ? '客户端' : 'Web'} · 事件时间验收`),
  h('section', { style: 'height:300px;display:flex;flex-direction:column;overflow:hidden' }, [
    h(desktop ? DesktopChatTimeline : WebChatTimeline, { messages, sessionId: 'fixture' })
  ]),
  h('section', { style: 'margin-top:16px;background:#020817' }, [h(CollaborationLogPanel, { events: [event], agents: [] })]),
  h('section', { style: 'margin-top:16px' }, [h(RuntimeRequestHealthPanel, { sessionId: 'fixture' })])
]) }).use(pinia).use(ElementPlus, { locale: zhCn }).mount('#app')
Object.assign(window, { timestampFixtureRequests: requests })
