<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRaw, watch } from 'vue'
import { parseIntentMultiSegmentReview, type IntentRoutingRecord } from '@agent-cluster/shared'
import { apiGet } from '@/api/client'
import { useEventStore } from '@/stores/event'

const props = defineProps<{ sessionId: string; descriptor: unknown; disconnected?: boolean }>()
const review = computed(() => {
  const row = parseIntentMultiSegmentReview(toRaw(props.descriptor))
  return row?.sessionId === props.sessionId ? row : undefined
})
const events = useEventStore(), state = ref<'loading' | 'pending' | 'changed' | 'blocked' | 'unknown'>('unknown')
let reader: AbortController | undefined
const lastEvent = computed(() => events.eventsForSession(props.sessionId).filter(event => event.metadata?.payload?.routingId === review.value?.routingId).at(-1)?.id)
const actions: Record<string, string> = { answer_in_chat: '回答问题', record_information: '记录信息', record_constraint: '补充约束',
  create_initial_work_item: '建立首个任务', create_related_work_item: '建立相关任务', create_independent_work_item: '建立独立任务',
  enqueue_follow_up: '追加处理', resume: '恢复任务', retry_failed_step: '重试失败步骤', replan: '调整计划', pause: '暂停任务',
  cancel: '取消任务', acknowledge: '确认收到', resolve_confirmation: '回应确认', correct_route: '纠正理解', clarify: '进一步澄清', reject_request: '拒绝请求' }
const effects: Record<string, string> = { answer: '回答', read_workspace: '读取工作区', write_artifact: '保存产物', modify_source: '修改源码', run_tests: '运行测试', run_command: '运行命令', external_write: '外部写入' }
const policies: Record<string, string> = { inherit_confirmed: '沿用已确认约束', inherit_selected: '只继承列出的内容', clean_task_context: '不继承旧任务专属上下文', ask_user: '继承范围待确认' }
const resources: Record<string, string> = { workspace: '工作区', source: '源码', artifact: '产物', test_runner: '测试范围', command: '命令范围', external: '外部对象', unresolved: '对象待确认' }
const scopes: Record<string, string> = { message: '本条消息', work_item: '当前任务', subsequent: '后续处理' }
function referenceLabel(id: string) { return review.value?.referenceLabels?.find(row => row.id === id)?.label ?? `未定位名称的对象（${id}）` }
function objectLabel(target: { kind: string; refId: string | null }) {
  if (target.kind === 'workspace') return '当前工作区'
  return `${resources[target.kind] ?? target.kind}${target.refId ? `：${referenceLabel(target.refId)}` : ''}`
}
function dependencyLabel(key: string) {
  const index = review.value?.understanding.segments.findIndex(segment => segment.localKey === key) ?? -1
  return index >= 0 ? `第 ${index + 1} 项` : '未定位的项目'
}
async function refresh() {
  reader?.abort(); const current = review.value
  if (!current || props.disconnected) { state.value = 'unknown'; return }
  const controller = new AbortController(); reader = controller; state.value = 'loading'
  try {
    const route = await apiGet<IntentRoutingRecord>(`/sessions/${encodeURIComponent(current.sessionId)}/message-routings/${encodeURIComponent(current.routingId)}`, { signal: controller.signal })
    if (controller.signal.aborted) return
    if (route.id !== current.routingId || route.sessionId !== current.sessionId || route.sourceEventId !== current.sourceEventId ||
      route.semanticIngress?.dataEpoch !== current.dataEpoch || !Number.isSafeInteger(route.routingRevision) || route.routingRevision! < current.routingRevision) {
      state.value = 'unknown'; return
    }
    if (route.routingRevision === current.routingRevision && ['BLOCKED', 'REJECTED'].includes(route.status)) { state.value = 'blocked'; return }
    state.value = route.routingRevision === current.routingRevision && route.status === 'CLARIFICATION_REQUIRED' &&
      route.semanticPlan?.outcome === 'needs_clarification' && !route.effectiveIntentRevision && !route.dispatchHold &&
      JSON.stringify(route.semanticProposal?.understanding) === JSON.stringify(current.understanding) ? 'pending' : 'changed'
  } catch { if (!controller.signal.aborted) state.value = 'unknown' }
}
watch(() => [review.value, lastEvent.value, props.disconnected], () => { void refresh() }, { immediate: true })
onBeforeUnmount(() => reader?.abort())
</script>
<template>
  <section v-if="review" class="intent-segments" aria-label="多项意图待澄清" :aria-busy="state === 'loading'">
    <strong>识别到 {{ review.understanding.segments.length }} 项意图</strong>
    <p role="status">{{ state === 'pending' ? '整组等待澄清，未执行其中任何一项。' : state === 'blocked' ? '这组请求未获执行许可，请核对目标、限制和最新提示。' : state === 'changed' ? '路由状态已变化。以下是当时的理解，请结合最新消息核对。' : state === 'loading' ? '正在核对当前处理状态。' : '当前状态尚未确认。以下为历史理解，不能据此判断执行结果。' }}</p>
    <p>以下是模型提出的理解，不代表已获授权。自动多项执行尚未启用；请在输入框说明需要调整的项目、先后顺序和限制，必要时逐项发送明确请求。原消息不会因此自动执行。</p>
    <ol>
      <li v-for="(segment, index) in review.understanding.segments" :key="segment.localKey">
        <strong>第 {{ index + 1 }} 项：{{ segment.goal }}</strong>
        <p>拟处理方式：{{ actions[segment.suggestedAction] }}；{{ policies[segment.contextPolicy] }}</p>
        <p>任务目标：{{ segment.target.workItemId ? referenceLabel(segment.target.workItemId) : '尚未绑定具体任务' }}</p>
        <p v-if="segment.target.agentIds.length">指定成员：{{ segment.target.agentIds.map(referenceLabel).join('、') }}</p>
        <p v-if="segment.target.decisionIds.length">引用的已确认决定：{{ segment.target.decisionIds.map(referenceLabel).join('、') }}</p>
        <p v-if="segment.target.artifactIds.length">引用产物：{{ segment.target.artifactIds.map(referenceLabel).join('、') }}</p>
        <p v-if="segment.target.confirmationId">待确认事项：{{ segment.target.confirmationId }}（尚未批准）</p>
        <p v-if="segment.target.correctionOfRoutingId">纠正的原消息路由：{{ segment.target.correctionOfRoutingId }}</p>
        <ul v-if="segment.requestedEffects.length" aria-label="请求的操作">
          <li v-for="(effect, effectIndex) in segment.requestedEffects" :key="effectIndex">请求{{ effects[effect.kind] }} · {{ objectLabel(effect.target) }}</li>
        </ul>
        <ul v-if="segment.prohibitions.length" aria-label="禁止事项">
          <li v-for="(prohibition, prohibitionIndex) in segment.prohibitions" :key="prohibitionIndex">禁止{{ effects[prohibition.effectKind] }} · {{ objectLabel(prohibition.object) }} · {{ scopes[prohibition.scope] }}</li>
        </ul>
        <ul v-if="segment.dependencies.length" aria-label="先后条件">
          <li v-for="dependency in segment.dependencies" :key="dependency.segmentKey">须等{{ dependencyLabel(dependency.segmentKey) }}{{ dependency.condition === 'execution_completed' ? '执行完成' : '处理计划确认' }}后处理。</li>
        </ul>
        <p v-if="segment.correction">拟替换原决定“{{ referenceLabel(segment.correction.supersedesDecisionId) }}”（版本 {{ segment.correction.expectedDecisionRevision }}）：{{ segment.correction.replacementText }}</p>
        <details><summary>查看该项引用的原文</summary><blockquote v-for="evidence in segment.evidence" :key="evidence.refId">{{ evidence.quote }}</blockquote><p v-if="!segment.evidence.length">未提供原文引用，仍需核对。</p></details>
      </li>
    </ol>
    <ul v-if="review.understanding.missingFields.length" aria-label="尚缺信息"><li v-for="field in review.understanding.missingFields" :key="field">{{ field }}</li></ul>
    <ul v-if="review.understanding.ambiguityReasons.length" aria-label="需要澄清"><li v-for="reason in review.understanding.ambiguityReasons" :key="reason">{{ reason }}</li></ul>
    <button type="button" :disabled="disconnected || state === 'loading'" @click="refresh">核对当前状态</button>
  </section>
</template>
<style scoped>
.intent-segments { margin-block: 8px; padding: 12px; border: 1px solid var(--el-border-color, #dcdfe6); border-radius: 6px; overflow-wrap: anywhere; }
.intent-segments p { margin: 6px 0; }
.intent-segments ol { padding-left: 24px; }
.intent-segments ol > li { margin-block: 12px; }
.intent-segments ul { padding-left: 20px; }
.intent-segments blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid var(--el-border-color, #dcdfe6); white-space: pre-wrap; }
.intent-segments button { padding: 6px 10px; background: transparent; color: var(--el-color-primary, #409eff); border: 1px solid currentColor; border-radius: 4px; cursor: pointer; }
.intent-segments button:disabled { opacity: .55; cursor: not-allowed; }
.intent-segments :is(button, summary):focus-visible { outline: 2px solid var(--el-color-primary, #409eff); outline-offset: 2px; }
</style>
