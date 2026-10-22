<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElButton, ElCheckbox, ElInput } from 'element-plus'
import type { ConfirmationCardState } from '@/types/contracts'
import { useEventStore } from '@/stores/event'
import { useSessionStore } from '@/stores/session'
import { ApiRequestError } from '@/api/client'

const props = defineProps<{ confirmation: ConfirmationCardState }>()
const emit = defineEmits<{ decided: [sessionId: string] }>()
const sessionStore = useSessionStore()
const eventStore = useEventStore()
const query = ref('')
const candidates = ref<Array<{ ref: string; path: string; size: number; hash: string; suggested: boolean; expiresAt: string }>>([])
const nextCursor = ref<string>()
const total = ref(0)
const truncated = ref(false)
const truncatedReason = ref<string>()
const loading = ref(false)
const submitting = ref(false)
const error = ref('')
const notice = ref('')
const selected = ref<string[]>([...(props.confirmation.sourceAuthorization?.candidateRefs ?? [])])
let generation = 0

const sessionId = computed(() => props.confirmation.sessionId ?? '')
const requestId = computed(() => props.confirmation.confirmationId)
const pending = computed(() => props.confirmation.status === 'pending')
const busy = computed(() => loading.value || submitting.value || Boolean(sessionStore.intentSourceAuthorizationBusy[`${sessionId.value}:${requestId.value}`]))
const originalFollowUp = computed(() => {
  const sourceEventId = props.confirmation.sourceAuthorization?.sourceEventId ?? props.confirmation.sourceEventId
  return eventStore.eventsForSession(sessionId.value).find(event => event.id === sourceEventId)?.content
})
const canApprove = computed(() => selected.value.length > 0 && !busy.value && pending.value && Number.isSafeInteger(props.confirmation.requestRevision) && Number.isSafeInteger(props.confirmation.sessionRevision))

async function load(reset = true) {
  if (!sessionId.value || !requestId.value) return
  const current = ++generation
  loading.value = true; error.value = ''
  try {
    const page = await sessionStore.loadIntentSourceCandidates(sessionId.value, requestId.value, { query: query.value })
    if (current !== generation) return
    candidates.value = reset ? page.candidates : [...candidates.value, ...page.candidates.filter(row => !candidates.value.some(item => item.ref === row.ref))]
    nextCursor.value = page.nextCursor
    total.value = page.total
    truncated.value = page.truncated
    truncatedReason.value = page.truncatedReason
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : '加载候选文件失败'
  } finally { if (current === generation) loading.value = false }
}
function toggle(refId: string, checked: boolean) {
  selected.value = checked ? [...new Set([...selected.value, refId])] : selected.value.filter(row => row !== refId)
}
function idempotencyKey(action: 'approve' | 'reject') {
  return `${requestId.value}:${props.confirmation.requestRevision ?? 0}:${props.confirmation.sessionRevision ?? 0}:${action}:${[...selected.value].sort().join(',')}:no_schema_change`
}
async function decide(action: 'approve' | 'reject') {
  if (action === 'approve' && !canApprove.value) return
  if (action === 'reject' && busy.value) return
  submitting.value = true; error.value = ''; notice.value = ''
  const origin = sessionId.value
  try {
    await sessionStore.decideIntentSourceAuthorization(origin, requestId.value, {
      action,
      expectedRequestRevision: props.confirmation.requestRevision!,
      expectedSessionRevision: props.confirmation.sessionRevision!,
      idempotencyKey: idempotencyKey(action),
      candidateRefs: action === 'approve' ? [...selected.value] : [],
      prohibitions: action === 'approve' ? ['no_schema_change'] : []
    })
    notice.value = action === 'approve' ? '清单已批准，服务端正在重新核验文件身份。' : '已拒绝源码授权。'
    emit('decided', origin)
  } catch (cause) {
    const code = cause instanceof ApiRequestError ? cause.code : undefined
    const stale = code === 'INTENT_SOURCE_CANDIDATE_STALE' || code === 'INTENT_SOURCE_CANDIDATE_REF_INVALID' || (cause instanceof ApiRequestError && cause.status === 409)
    const message = stale
      ? '候选文件已过期或事实已变化，请重新加载并重新选择。'
      : cause instanceof Error ? cause.message : '提交源码授权失败'
    if (stale) { selected.value = []; await load(true); error.value = message } else error.value = message
  } finally { submitting.value = false }
}
watch(() => [sessionId.value, requestId.value, props.confirmation.requestRevision, props.confirmation.sessionRevision] as const, () => {
  selected.value = [...(props.confirmation.sourceAuthorization?.candidateRefs ?? [])]
  query.value = ''; candidates.value = []; nextCursor.value = undefined; truncatedReason.value = undefined
  if (pending.value) void load(true)
}, { immediate: true })
</script>

<template>
  <section class="intent-source-authorization" :aria-busy="busy">
    <p class="intent-source-authorization__warning">批准的文件可能被自动修改并写回；只会使用你从服务端候选中勾选的精确清单。</p>
    <p v-if="originalFollowUp" class="intent-source-authorization__original"><strong>原追加需求：</strong>{{ originalFollowUp }}</p>
    <p v-else-if="confirmation.description">{{ confirmation.description }}</p>
    <p v-if="confirmation.explanation">{{ confirmation.explanation }}</p>
    <p class="intent-source-authorization__meta">已选 {{ selected.length }} 个文件 · 服务端候选 {{ total }} 个</p>
    <p v-if="truncated" class="intent-source-authorization__truncated" role="status">结果不完整，请输入更具体的路径后搜索。{{ truncatedReason ? `（${truncatedReason}）` : '' }}</p>
    <ElInput v-model="query" clearable placeholder="按相对路径筛选候选文件" aria-label="筛选候选文件" @keyup.enter="load(true)" @clear="load(true)">
      <template #append><ElButton :disabled="busy" @click="load(true)">搜索</ElButton></template>
    </ElInput>
    <p v-if="loading" role="status">正在读取服务端候选…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <ul v-if="candidates.length" class="intent-source-authorization__candidates">
      <li v-for="candidate in candidates" :key="candidate.ref">
        <ElCheckbox :model-value="selected.includes(candidate.ref)" :disabled="busy || !pending" @change="value => toggle(candidate.ref, Boolean(value))">
          <span class="intent-source-authorization__path">{{ candidate.path }}</span>
          <small>{{ candidate.size }} bytes · {{ candidate.hash.slice(0, 12) }}</small>
          <em v-if="candidate.suggested">建议（仍需手动勾选）</em>
        </ElCheckbox>
      </li>
    </ul>
    <p v-else-if="!loading && !error">没有匹配的服务端候选文件。</p>
    <ElButton v-if="nextCursor" :disabled="busy" @click="sessionStore.loadIntentSourceCandidates(sessionId, requestId, { query, cursor: nextCursor }).then(page => { candidates = [...candidates, ...page.candidates.filter(row => !candidates.some(item => item.ref === row.ref))]; nextCursor = page.nextCursor; total = page.total; truncated = page.truncated; truncatedReason = page.truncatedReason }).catch(cause => { error = cause instanceof Error ? cause.message : '加载更多候选失败' })">加载更多</ElButton>
    <p v-if="notice" role="status">{{ notice }}</p>
    <footer class="intent-source-authorization__actions">
      <ElButton type="danger" :disabled="busy || !pending" @click="decide('reject')">拒绝授权</ElButton>
      <ElButton type="primary" :disabled="!canApprove" @click="decide('approve')">批准所选清单</ElButton>
    </footer>
  </section>
</template>

<style scoped>
.intent-source-authorization { display: grid; gap: 10px; min-width: 0; }
.intent-source-authorization p { margin: 0; overflow-wrap: anywhere; }
.intent-source-authorization__warning { padding: 10px; border: 1px solid var(--el-color-warning-light-5); border-radius: 8px; }
.intent-source-authorization__meta { color: var(--el-text-color-secondary); font-size: 12px; }
.intent-source-authorization__candidates { list-style: none; padding: 0; margin: 0; max-height: 280px; overflow: auto; border: 1px solid var(--el-border-color); border-radius: 8px; }
.intent-source-authorization__candidates li { padding: 8px 10px; border-bottom: 1px solid var(--el-border-color-lighter); }
.intent-source-authorization__candidates li:last-child { border-bottom: 0; }
.intent-source-authorization__path { overflow-wrap: anywhere; }
.intent-source-authorization__candidates small, .intent-source-authorization__candidates em { display: block; margin-left: 24px; color: var(--el-text-color-secondary); font-size: 11px; }
.intent-source-authorization__candidates em { color: var(--el-color-primary); font-style: normal; }
.intent-source-authorization__actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
