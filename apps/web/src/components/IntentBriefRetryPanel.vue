<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { briefRecoveryKey, useIntentBriefRetryStore, type BriefRecoveryReference } from '@/stores/intentBriefRetry'
import { useEventStore } from '@/stores/event'
const props = defineProps<{ sessionId: string; descriptor: unknown; disabled?: boolean }>()
const store = useIntentBriefRetryStore(), events = useEventStore(), error = ref(''), loading = ref(false)
const reference = computed<BriefRecoveryReference | null>(() => {
  const row = props.descriptor as Record<string, unknown> | null
  if (!row || !['stepId', 'routingId', 'dataEpoch'].every(key => typeof row[key] === 'string' && row[key])) return null
  return { sessionId: props.sessionId, stepId: row.stepId as string, routingId: row.routingId as string, dataEpoch: row.dataEpoch as string }
})
const key = computed(() => reference.value ? briefRecoveryKey(reference.value) : '')
const view = computed(() => store.views[key.value]), pending = computed(() => store.pending[key.value])
const busy = computed(() => Boolean(store.busy[key.value]))
const review = computed(() => view.value?.action === 'review_brief')
const subject = computed(() => review.value ? '审阅' : '草稿')
const status = computed(() => !view.value || store.stale[key.value] ? `${subject.value}状态待核实` : review.value ?
  view.value.status === 'completed' ? '该 Agent 的审阅已完成；全部意见到齐后才会生成新草稿。' :
    ['queued', 'running'].includes(view.value.status) ? '重新审阅已受理，尚未完成。' : view.value.canRetry ? '该 Agent 的审阅失败，可以单独重试。' : '当前无法重新审阅，请核对成员、任务、暂停或停止状态。' : view.value.status === 'completed' ? '新草稿已生成，请查看待确认草稿。' :
  ['queued', 'running'].includes(view.value.status) ? '重新生成已受理，尚未生成新草稿。' : view.value.canRetry ? '草稿生成失败，可以重新生成。' : '当前无法重新生成，请核对最新任务、暂停或停止状态。')
const lastEvent = computed(() => events.eventsForSession(props.sessionId).filter(event => event.metadata?.payload?.stepId === reference.value?.stepId).at(-1)?.id)
let reader: AbortController | undefined
async function refresh() {
  reader?.abort(); const current = reference.value; if (!current) return
  const controller = new AbortController(); reader = controller; loading.value = true
  try { await store.refresh(current, controller.signal) }
  catch { if (!controller.signal.aborted) error.value = '无法确认草稿状态，请刷新。' }
  finally { if (!controller.signal.aborted) loading.value = false }
}
async function retry() {
  const current = reference.value; if (!current || props.disabled || busy.value) return
  const origin = key.value; error.value = ''
  try { await store.submit(current) }
  catch { if (key.value === origin) error.value = store.pending[origin] ? '受理结果尚未确认，请核对原提交。' : '重新生成未受理，已刷新状态，请核对后操作。' }
}
watch(() => [key.value, lastEvent.value], () => { void refresh() }, { immediate: true })
onBeforeUnmount(() => reader?.abort())
</script>
<template>
  <section v-if="reference" class="intent-brief-retry" :aria-label="review ? '重新审阅任务草稿' : '重新生成任务草稿'" :aria-busy="loading || busy">
    <p v-if="review">审阅 Agent：{{ view?.reviewerName }}。仅重试此 Agent，已完成的其他意见会保留。</p>
    <p>{{ review ? '重新审阅' : '重新生成' }}会调用模型，并保留原计划和失败记录。若连接或配置有误，请先修复。</p>
    <p role="status">{{ status }}</p>
    <button v-if="pending" type="button" :disabled="disabled || busy" @click="retry">核对原{{ subject }}提交</button>
    <button v-else-if="view?.canRetry" type="button" :disabled="disabled || busy || loading || store.stale[key]" @click="retry">{{ review ? '仅重试此 Agent' : '重新生成草稿' }}</button>
    <button type="button" :disabled="disabled || busy || loading" @click="refresh">刷新{{ subject }}状态</button>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.intent-brief-retry { margin-block: 8px; padding: 10px 12px; border: 1px solid var(--el-border-color, #dcdfe6); border-radius: 6px; }
.intent-brief-retry p { margin: 4px 0 8px; }
.intent-brief-retry button { margin: 0 8px 4px 0; padding: 6px 10px; border: 1px solid var(--el-color-primary, #409eff); border-radius: 4px; background: transparent; color: var(--el-color-primary, #409eff); cursor: pointer; }
.intent-brief-retry button:disabled { opacity: .55; cursor: not-allowed; }
.intent-brief-retry button:focus-visible { outline: 2px solid var(--el-color-primary, #409eff); outline-offset: 2px; }
</style>
