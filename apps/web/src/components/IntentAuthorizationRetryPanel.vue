<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { canRetryIntentAuthorization } from '@agent-cluster/shared'
import { ApiRequestError } from '@/api/client'
import { authorizationRetryKey, useIntentAuthorizationRetryStore } from '@/stores/intentAuthorizationRetry'

const props = defineProps<{ sessionId: string; descriptor: unknown; disabled?: boolean }>()
const store = useIntentAuthorizationRetryStore()
const reference = computed(() => {
  const row = props.descriptor as Record<string, unknown> | null
  if (!row || !['routingId', 'dataEpoch', 'sourceEventId'].every(key => typeof row[key] === 'string' && row[key])) return null
  return { sessionId: props.sessionId, routingId: row.routingId as string, dataEpoch: row.dataEpoch as string, sourceEventId: row.sourceEventId as string }
})
const key = computed(() => reference.value ? authorizationRetryKey(reference.value) : '')
const pending = computed(() => store.pending[key.value]), route = computed(() => store.routes[key.value])
const busy = computed(() => Boolean(store.busy[key.value]))
const canRetry = computed(() => Boolean(route.value && canRetryIntentAuthorization(route.value)))
const loading = ref(false), error = ref(''), notice = ref('')
let reader: AbortController | undefined
async function refresh() {
  reader?.abort(); const current = reference.value; if (!current) return
  const controller = new AbortController(); reader = controller; loading.value = true; error.value = ''
  try { await store.refresh(current, controller.signal) }
  catch { if (!controller.signal.aborted) error.value = '无法核对原请求，请刷新状态。' }
  finally { if (!controller.signal.aborted) loading.value = false }
}
async function retry() {
  const current = reference.value; if (!current || props.disabled || busy.value) return
  const origin = key.value; error.value = ''; notice.value = ''
  try {
    if (!store.pending[origin]) store.prepare(current)
    await store.submit(current)
    if (key.value === origin) notice.value = '已重新校验原请求，执行进度请查看会话消息。'
  } catch (cause) {
    if (key.value !== origin) return
    error.value = store.pending[origin] ? '提交结果尚未确认，请核对原提交结果。' :
      cause instanceof ApiRequestError && cause.status === 409 ? '当前条件不满足或请求已变化。请核对授权和最新状态后操作。' : '操作未完成，请刷新状态。'
  }
}
watch(key, () => { notice.value = ''; error.value = ''; void refresh() }, { immediate: true })
onBeforeUnmount(() => reader?.abort())
</script>

<template>
  <section v-if="reference" class="intent-authorization-retry" aria-label="重新校验原请求" :aria-busy="loading || busy">
    <p>完成所需授权后，可重新校验这条原请求。系统会保留原意图，校验通过后才执行。</p>
    <button v-if="pending" type="button" :disabled="disabled || busy" @click="retry">核对原提交结果</button>
    <button v-else-if="canRetry" type="button" :disabled="disabled || busy || loading || store.stale[key]" @click="retry">授权后重新校验原请求</button>
    <span v-else-if="route && !loading && !store.stale[key]" role="status">此请求已处理或需要其他操作，请查看最新消息。</span>
    <button type="button" :disabled="disabled || busy || loading" @click="refresh">刷新请求状态</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="notice" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.intent-authorization-retry { margin-block: 8px; padding: 10px 12px; border: 1px solid var(--el-border-color, #dcdfe6); border-radius: 6px; }
.intent-authorization-retry p { margin: 4px 0 8px; }
.intent-authorization-retry button { margin: 0 8px 4px 0; padding: 6px 10px; border: 1px solid var(--el-color-primary, #409eff); border-radius: 4px; background: transparent; color: var(--el-color-primary, #409eff); cursor: pointer; }
.intent-authorization-retry button:disabled { opacity: .55; cursor: not-allowed; }
.intent-authorization-retry button:focus-visible { outline: 2px solid var(--el-color-primary, #409eff); outline-offset: 2px; }
</style>
