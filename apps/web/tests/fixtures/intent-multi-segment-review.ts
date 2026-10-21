// Isolated browser fixture: real timeline components, local GET fixture, no business mutations.
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { intentUnderstandingExample, type IntentMultiSegmentReview, type ChatMessage } from '@agent-cluster/shared'
import WebTimeline from '../../src/components/ChatTimeline.vue'
import DesktopTimeline from '../../../desktop/renderer/components/ChatTimeline.vue'
import { useEventStore } from '../../src/stores/event'

const desktop = new URLSearchParams(location.search).get('client') === 'desktop'
if (desktop) await import('../../../desktop/renderer/styles.css')
else await import('../../src/styles.css')
const understanding = structuredClone(intentUnderstandingExample), first = structuredClone(understanding.segments[0])
understanding.segments.splice(0, 1, ...Array.from({ length: 8 }, (_, index): typeof first => ({ ...structuredClone(first), localKey: `part-${index}`,
  goal: index === 7 ? '<script>不会执行</script>第八个目标必须可见' : `第 ${index + 1} 项：分析登录失败的原因`,
  prohibitions: [{ effectKind: 'modify_source', object: { kind: 'workspace', refId: 'workspace' }, scope: 'message', evidenceRefs: ['request'] }],
  dependencies: index ? [{ segmentKey: `part-${index - 1}`, condition: 'execution_completed' }] : [] })))
const descriptor: IntentMultiSegmentReview = { contractVersion: 'intent-multi-segment-review-v1', mode: 'clarify_only', sessionId: 'fixture', dataEpoch: 'epoch',
  routingId: 'route', sourceEventId: 'message-1', routingRevision: 4, understanding }
const requests: Array<{ method: string; path: string }> = []
let changed = false
window.fetch = async (input, init) => {
  requests.push({ method: init?.method ?? 'GET', path: String(input) })
  return new Response(JSON.stringify({ data: { id: 'route', sessionId: 'fixture', sourceEventId: 'message-1', semanticIngress: { dataEpoch: 'epoch' },
    routingRevision: changed ? 5 : 4, status: changed ? 'ROUTED' : 'CLARIFICATION_REQUIRED', semanticPlan: { outcome: 'needs_clarification' },
    semanticProposal: { understanding } } }), { headers: { 'content-type': 'application/json' } })
}
const pinia = createPinia()
const message: ChatMessage = { id: 'notice', sessionId: 'fixture', rawEventId: 'notice', senderType: 'system', toAgentIds: [], messageType: 'text',
  content: '请核对全部项目后补充需求。', createdAt: '2026-10-20T00:00:00Z', payload: { multiSegmentReview: descriptor } }
createApp({ render: () => h(desktop ? DesktopTimeline : WebTimeline, { sessionId: 'fixture', messages: [message], readOnly: desktop }) }).use(pinia).mount('#app')
Object.assign(window, { intentReviewFixture: { requests, change: () => { changed = true; useEventStore(pinia).eventsBySessionId.fixture = [
  { id: 'changed', sessionId: 'fixture', type: 'intent_plan_committed', content: '', toAgentIds: [], createdAt: new Date().toISOString(),
    metadata: { schemaVersion: '0.1', renderAs: 'system_notice', payload: { routingId: 'route' } } }] } } })
