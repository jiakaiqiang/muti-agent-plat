// Deterministic browser fixture. No product/backend state or model connection is used.
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import 'element-plus/dist/index.css'
import IntentCorrectionPanel from '../../../apps/web/src/components/IntentCorrectionPanel.vue'

let correction: Record<string, unknown> | undefined
let requestCount = 0
window.fetch = async (input, init) => {
  const url = String(input)
  const route = { id: 'fixture-route', sessionId: 'fixture-session', sourceEventId: 'fixture-event',
    status: 'ROUTED', routingRevision: correction ? 3 : 1, decision: { selectedWorkItemId: 'fixture-work' } }
  const response = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
  if (init?.method === 'POST' && url.endsWith('/corrections')) {
    const request = JSON.parse(String(init.body))
    requestCount++
    correction = { id: 'fixture-correction', routingId: route.id, sessionId: route.sessionId,
      status: 'accepted', pendingIntentRevision: 2, routingRevision: 2, request, idempotencyKey: request.idempotencyKey, updatedAt: new Date().toISOString() }
    setTimeout(() => { if (correction) { correction.status = 'applied'; correction.routingRevision = 3; correction.updatedAt = new Date().toISOString() } }, 2000)
    return response({ correctionId: correction.id, routingId: route.id, pendingIntentRevision: 2, routingRevision: 2, correctionStatus: 'accepted' })
  }
  if (url.includes('/message-routings?')) return response({ items: [route] })
  if (url.endsWith('/fixture-route')) return response(route)
  if (url.endsWith('/corrections')) return response({ corrections: correction ? [correction] : [] })
  if (url.endsWith('/work-items')) return response({ items: [{ id: 'fixture-work', sessionId: route.sessionId, title: '调整登录验证的超时限制', inheritedDecisionIds: [] }] })
  if (url.endsWith('/decisions')) return response({ items: [{ id: 'fixture-decision', sessionId: route.sessionId,
    workItemId: 'fixture-work', status: 'confirmed', content: '超时为 10 分钟', revision: 1 }] })
  throw new Error(`Unexpected fixture request: ${url}`)
}
Object.defineProperty(window, 'correctionFixtureRequestCount', { get: () => requestCount })
document.body.style.cssText = 'margin:0;background:#f5f7fa;font:14px system-ui;color:#303133;'
const app = createApp({ render: () => h('main', { style: 'max-width:860px;margin:48px auto;padding:24px;background:white;border:1px solid #dcdfe6;border-radius:8px;' }, [
  h('h1', { style: 'font-size:20px' }, '纠错组件验证'),
  h('p', '隔离浏览器 fixture · 验证共享组件显示与交互，不连接真实模型。'),
  h('article', { style: 'border-top:1px solid #ebeef5;margin-top:24px;padding-top:16px;' }, [
    h('strong', '用户'), h('p', '请实现登录功能，超时为 10 分钟。'),
    h(IntentCorrectionPanel, { sessionId: 'fixture-session', sourceEventId: 'fixture-event', originalContent: '请实现登录功能，超时为 10 分钟。' })
  ])
]) })
app.use(createPinia()).mount('#app')
