// Isolated browser fixture. No backend, CLI, provider or real model is contacted.
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { unknownRuntimeHealthCapabilities, type RuntimeHealthSnapshot } from '@agent-cluster/shared'
import RuntimeRequestHealthPanel from '../../src/components/RuntimeRequestHealthPanel.vue'
import { useRuntimeRequestHealthStore } from '../../src/stores/runtimeRequestHealth'
import { useEventStore } from '../../src/stores/event'

const desktop = new URLSearchParams(location.search).get('client') === 'desktop'
if (desktop) await import('../../../desktop/renderer/styles.css')
else await import('../../src/styles.css')
let snapshot: RuntimeHealthSnapshot = {
  schemaVersion: 1, policyVersion: 'request-health-v1', sessionId: 'fixture', operationId: 'original-operation',
  invocationId: 'original-invocation', sessionGeneration: 1, observerEpoch: 'fixture-epoch', version: 2,
  phase: 'discussion', agentId: '群聊 Agent', runtimeType: 'codex', stage: 'unknown_wait', health: 'unknown',
  reasonCode: 'no_observable_progress', capabilities: unknownRuntimeHealthCapabilities(), processStatus: 'alive', requestStatus: 'unknown',
  startedAt: new Date(Date.now() - 31 * 60000).toISOString(), updatedAt: new Date().toISOString(),
  deadlineAt: new Date(Date.now() - 60000).toISOString(), observationDue: true, canWait: true, canStop: true
}
const calls: Array<{ path: string; method: string; body?: unknown }> = []
let queryFailed = false
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.origin).pathname
  const method = init?.method ?? 'GET'
  calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
  if (queryFailed && method === 'GET') return new Response(JSON.stringify({ error: { message: 'Fixture observation unavailable' } }), { status: 503 })
  if (method === 'POST' && path.endsWith('/wait')) snapshot = {
    ...snapshot, version: snapshot.version + 1, lastWaitAcknowledgedAt: new Date().toISOString()
  }
  return new Response(JSON.stringify({ data: method === 'GET' ? { items: [snapshot] } : snapshot, requestId: 'fixture' }),
    { headers: { 'content-type': 'application/json' } })
}
const pinia = createPinia()
useEventStore(pinia).eventsBySessionId.fixture = [
  { id: 'fixture-request', sessionId: 'fixture', type: 'runtime_started', toAgentIds: [], content: '已发起模型调用，等待响应。',
    actor: { type: 'agent', id: 'fixture-agent', displayName: '前端开发工程师' }, createdAt: new Date(Date.now() - 120000).toISOString(),
    metadata: { schemaVersion: '0.1', payload: { phase: 'discussion' } } },
  { id: 'fixture-tool', sessionId: 'fixture', type: 'tool_called', toAgentIds: [], content: '调用读取工具，检查项目文件。',
    actor: { type: 'agent', id: 'fixture-agent', displayName: '前端开发工程师' }, createdAt: new Date(Date.now() - 60000).toISOString(),
    metadata: { schemaVersion: '0.1', payload: { phase: 'discussion' } } }
]
const app = createApp({ render: () => h('main', { class: 'workspace-main' }, [
  h('header', { class: 'workspace-header' }, `${desktop ? '桌面端' : 'Web'} · 请求观测验收`),
  h(RuntimeRequestHealthPanel, { sessionId: 'fixture', canStop: true, onStop: () => {
    calls.push({ path: '/fixture/session-stop', method: 'STOP' })
    fixture.update({ stage: 'stopping', health: 'unknown', canWait: false, canStop: false })
  } }),
  h('div', { style: 'padding:16px;overflow:auto' }, '业务状态：EXECUTING。浏览器仅观察，不接管模型调用。')
] ) })
app.use(pinia).use(ElementPlus, { locale: zhCn }).mount('#app')
const fixture = {
  calls,
  get snapshot() { return snapshot },
  failQuery() { queryFailed = true },
  update(patch: Partial<RuntimeHealthSnapshot>) {
    snapshot = { ...snapshot, ...patch, version: snapshot.version + 1 }
    useRuntimeRequestHealthStore(pinia).merge('fixture', snapshot)
  }
}
Object.assign(window, { runtimeHealthFixture: fixture })
