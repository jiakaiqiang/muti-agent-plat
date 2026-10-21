<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { canRetryIntentRecognition } from '@agent-cluster/shared'
import { ApiRequestError } from '@/api/client'
import { recognitionRetryKey, useIntentRecognitionRetryStore } from '@/stores/intentRecognitionRetry'
import { useEventStore } from '@/stores/event'
const props = defineProps<{ sessionId: string; descriptor: unknown; disabled?: boolean }>()
const store = useIntentRecognitionRetryStore(), events = useEventStore()
const reference = computed(() => {
  const row = props.descriptor as Record<string, unknown> | null
  if (!row || !['routingId', 'dataEpoch', 'sourceEventId'].every(key => typeof row[key] === 'string' && row[key])) return null
  return { sessionId: props.sessionId, routingId: row.routingId as string, dataEpoch: row.dataEpoch as string, sourceEventId: row.sourceEventId as string }
})
const key = computed(() => reference.value ? recognitionRetryKey(reference.value) : '')
const route = computed(() => store.routes[key.value]), pending = computed(() => store.pending[key.value])
const busy = computed(() => Boolean(store.busy[key.value]))
const canRetry = computed(() => Boolean(route.value && canRetryIntentRecognition(route.value)))
const budgetHold = computed(() => route.value?.blockedReason === 'INTENT_INPUT_BUDGET_EXCEEDED' ? route.value.inputBudgetDecision : undefined)
const loading = ref(false), error = ref('')
let reader: AbortController | undefined
const status = computed(() => !route.value || store.stale[key.value] ? '识别状态待确认' :
  route.value.status === 'ROUTED' ? '原消息已完成识别与路由，实际执行进度请查看会话消息。' :
  route.value.status === 'CLARIFICATION_REQUIRED' ? '原消息需要进一步确认，请查看最新提示。' :
  route.value.status === 'BLOCKED' ? (route.value.blockedReason === 'INTENT_PROVIDER_CIRCUIT_OPEN' ? '模型连接处于故障等待期，请稍后再试。' : '原消息的识别仍受阻。') : route.value.status === 'REJECTED' ? '原消息未通过校验，请查看最新提示。' :
  '重新识别已受理，尚未完成识别与校验。')
const lastEvent = computed(() => events.eventsForSession(props.sessionId).filter(event =>
  event.metadata?.payload?.routingId === reference.value?.routingId &&
  ['intent_recognition_retry_requested', 'intent_plan_blocked', 'intent_plan_committed', 'intent_plan_clarification_required'].includes(event.type)).at(-1)?.id)
async function refresh() {
  reader?.abort(); const current = reference.value; if (!current) return
  const controller = new AbortController(); reader = controller; loading.value = true; error.value = ''
  try { await store.refresh(current, controller.signal) }
  catch { if (!controller.signal.aborted) error.value = '无法确认识别状态，请刷新后重试。' }
  finally { if (!controller.signal.aborted) loading.value = false }
}
async function retry(decision?: 'continue' | 'end') {
  const current = reference.value; if (!current || props.disabled || busy.value) return
  const origin = key.value; error.value = ''
  try {
    if (!store.pending[origin]) store.prepare(current, decision)
    await store.submit(current)
  } catch (cause) {
    if (key.value !== origin) return
    error.value = store.pending[origin] ? '受理结果尚未确认，请核对原提交结果。' :
      cause instanceof ApiRequestError && cause.status === 409 ? '消息状态已变化或停止尚未确认，请核对最新状态。' : '重新识别未被受理，请刷新状态。'
  }
}
watch(() => [key.value, lastEvent.value], () => { void refresh() }, { immediate: true })
onBeforeUnmount(() => reader?.abort())
</script>
<template>
  <section v-if="reference" class="intent-recognition-retry" aria-label="重新识别原消息" :aria-busy="loading || busy">
    <p v-if="budgetHold">输入估算 {{ budgetHold.estimatedInputTokens }}，输出保留 {{ budgetHold.outputReservationTokens }}，有效上限 {{ budgetHold.effectiveMaxInputTokens }} tokens。尚未发出超限请求；继续仅放行本次重跑，结束只拒绝此消息，会话保留。</p>
    <p v-else>请先处理模型连接或配置问题。重新识别会调用模型，保留原消息和此前失败记录。</p>
    <p role="status">{{ status }}</p>
    <button v-if="pending" type="button" :disabled="disabled || busy" @click="retry()">核对原识别提交</button>
    <template v-else-if="canRetry && budgetHold">
      <button type="button" :disabled="disabled || busy || loading || store.stale[key]" @click="retry('continue')">继续（仅本次放行）</button>
      <button type="button" :disabled="disabled || busy || loading || store.stale[key]" @click="retry('end')">结束此消息</button>
    </template>
    <button v-else-if="canRetry" type="button" :disabled="disabled || busy || loading || store.stale[key]" @click="retry()">重新识别原消息</button>
    <button type="button" :disabled="disabled || busy || loading" @click="refresh">刷新识别状态</button>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.intent-recognition-retry { margin-block: 8px; padding: 10px 12px; border: 1px solid var(--el-border-color, #dcdfe6); border-radius: 6px; }
.intent-recognition-retry p { margin: 4px 0 8px; }
.intent-recognition-retry button { margin: 0 8px 4px 0; padding: 6px 10px; border: 1px solid var(--el-color-primary, #409eff); border-radius: 4px; background: transparent; color: var(--el-color-primary, #409eff); cursor: pointer; }
.intent-recognition-retry button:disabled { opacity: .55; cursor: not-allowed; }
.intent-recognition-retry button:focus-visible { outline: 2px solid var(--el-color-primary, #409eff); outline-offset: 2px; }
</style>
