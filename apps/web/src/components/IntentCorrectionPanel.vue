<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { ElButton, ElDialog, ElForm, ElFormItem, ElInput, ElOption, ElSelect } from 'element-plus'
import { ApiRequestError } from '@/api/client'
import { correctionKey, useIntentCorrectionStore } from '@/stores/intentCorrection'
import { correctionIsProcessing, correctionStatusCopy, decisionsForCorrection,
  type CorrectionDecision, type CorrectionWork } from '@/utils/intentCorrectionModel'

const props = defineProps<{ sessionId: string; sourceEventId: string; originalContent: string; disabled?: boolean }>()
const store = useIntentCorrectionStore()
const fieldId = useId()
const visible = ref(false)
const loading = ref(false)
const factsReady = ref(false)
const error = ref('')
const notice = ref('')
const routingId = ref('')
const boundSessionId = ref('')
const instruction = ref('')
const targetId = ref('')
const decisionId = ref('')
const submittedSignature = ref('')
const works = ref<CorrectionWork[]>([])
const decisions = ref<CorrectionDecision[]>([])
let controller = new AbortController()
let timer: ReturnType<typeof setTimeout> | undefined
let pollCount = 0
const key = computed(() => correctionKey(boundSessionId.value, routingId.value))
const route = computed(() => store.routes[key.value])
const history = computed(() => store.histories[key.value] ?? [])
const receipt = computed(() => store.receipts[key.value])
const pending = computed(() => store.pending[key.value])
const busy = computed(() => Boolean(store.busy[key.value]))
const latest = computed(() => history.value[0])
const status = computed(() => receipt.value && (receipt.value.pendingIntentRevision > (latest.value?.revision ?? 0) ||
  (receipt.value.pendingIntentRevision === latest.value?.revision && receipt.value.routingRevision > latest.value.routingRevision))
  ? receipt.value.correctionStatus : latest.value?.status ?? receipt.value?.correctionStatus)
const statusText = computed(() => status.value ? correctionStatusCopy(status.value, latest.value?.failureClass) : '')
const blocked = computed(() => correctionIsProcessing(status.value) || status.value === 'reconciliation_required')
const availableDecisions = computed(() => decisionsForCorrection(works.value.find(work => work.id === targetId.value), decisions.value))
const fieldsLocked = computed(() => busy.value || Boolean(pending.value) || blocked.value)
const formSignature = computed(() => JSON.stringify([instruction.value, targetId.value, decisionId.value]))
const canSubmit = computed(() => factsReady.value && !loading.value && !busy.value && !blocked.value &&
  Boolean(targetId.value && works.value.some(work => work.id === targetId.value)) &&
  Boolean(instruction.value.trim()) && instruction.value.length <= 8000 &&
  (!decisionId.value || availableDecisions.value.some(row => row.id === decisionId.value)) &&
  formSignature.value !== submittedSignature.value)
const routeText = computed(() => ({
  RECEIVED: '正在接收消息', SNAPSHOT_READY: '正在准备理解', CLASSIFYING: '正在识别意图',
  VALIDATING: '正在校验理解', APPLYING: '正在应用理解', ROUTED: '已完成消息路由',
  CLARIFICATION_REQUIRED: '需要说明消息与当前任务的关系', PENDING_RETRY: '系统正在重试识别',
  BLOCKED: '识别被系统故障阻塞，请先检查模型连接或配置', REJECTED: '当前理解未获执行许可'
}[route.value?.status ?? ''] ?? ''))

function stopReading() {
  controller.abort()
  if (timer) clearTimeout(timer)
  timer = undefined
}
function displayError(cause: unknown) {
  if (cause instanceof ApiRequestError && [409, 410].includes(cause.status)) {
    return '这条消息的理解或约束已发生变化。已尝试刷新当前结果，请核对后重新提交。'
  }
  return cause instanceof Error ? cause.message : '读取纠错状态失败，请刷新后重试。'
}
async function loadFacts(signal: AbortSignal) {
  const sessionId = boundSessionId.value, id = routingId.value
  const [, targets] = await Promise.all([store.refresh(sessionId, id, signal), store.loadTargets(sessionId, signal)])
  if (signal.aborted) return
  works.value = targets.workItems
  decisions.value = targets.decisions
  factsReady.value = true
}
function schedulePoll(signal: AbortSignal) {
  if (signal.aborted || !visible.value || !correctionIsProcessing(status.value)) return
  if (pollCount++ >= 120) { notice.value = '处理仍在进行，可稍后刷新核对结果。'; return }
  timer = setTimeout(async () => {
    try {
      await store.refresh(boundSessionId.value, routingId.value, signal)
      if (signal.aborted) return
      if (correctionIsProcessing(status.value)) schedulePoll(signal)
      else await loadFacts(signal)
    } catch (cause) {
      if (!signal.aborted) { error.value = displayError(cause); factsReady.value = false }
    }
  }, 1000)
}
async function open() {
  stopReading()
  controller = new AbortController()
  const signal = controller.signal
  boundSessionId.value = props.sessionId
  const sourceEventId = props.sourceEventId
  visible.value = true
  loading.value = true
  factsReady.value = false
  routingId.value = ''; instruction.value = ''; targetId.value = ''; decisionId.value = ''; submittedSignature.value = ''
  error.value = ''; notice.value = ''; pollCount = 0
  try {
    const routes = await store.findRoutes(boundSessionId.value, sourceEventId, signal)
    if (signal.aborted) return
    if (routes.length !== 1) {
      notice.value = routes.length ? '这条消息关联了多个理解记录，请先核对消息来源。'
        : '这条消息尚无可纠正的路由记录。请等待识别完成后重新打开；历史首轮消息可能没有路由记录。'
      return
    }
    routingId.value = routes[0].correctionTargetRoutingId ?? routes[0].id
    await loadFacts(signal)
    if (signal.aborted) return
    const saved = pending.value?.payload
    targetId.value = saved?.targetWorkItemId ?? route.value?.targetWorkItemId ?? ''
    decisionId.value = saved?.supersedesDecisionId ?? ''
    instruction.value = saved?.instruction ?? ''
    schedulePoll(signal)
  } catch (cause) { if (!signal.aborted) error.value = displayError(cause) }
  finally { if (!signal.aborted) loading.value = false }
}
async function refresh() {
  if (!routingId.value) { await open(); return }
  if (timer) clearTimeout(timer)
  const signal = controller.signal
  loading.value = true; error.value = ''; notice.value = ''; factsReady.value = false; pollCount = 0
  try {
    await loadFacts(signal)
    if (!signal.aborted) schedulePoll(signal)
  } catch (cause) { if (!signal.aborted) error.value = displayError(cause) }
  finally { if (!signal.aborted) loading.value = false }
}
async function submit() {
  if (busy.value || loading.value || (!pending.value && !canSubmit.value)) return
  const sessionId = boundSessionId.value, id = routingId.value, signal = controller.signal
  error.value = ''; notice.value = ''
  try {
    if (!pending.value) {
      const decision = availableDecisions.value.find(row => row.id === decisionId.value)
      store.prepare(sessionId, id, { instruction: instruction.value, targetWorkItemId: targetId.value || null,
        supersedesDecisionId: decision?.id ?? null, expectedDecisionRevision: decision?.revision ?? null })
    }
    await store.submit(sessionId, id)
    if (!signal.aborted) { submittedSignature.value = formSignature.value; await refresh() }
  } catch (cause) {
    if (signal.aborted) return
    // A new request requires current facts; an uncertain request is always retried verbatim.
    if (!pending.value) {
      factsReady.value = false
      try { await loadFacts(signal) } catch { /* Keep submission blocked when refresh fails. */ }
    }
    if (!signal.aborted) error.value = displayError(cause)
  }
}
watch(visible, value => { if (!value) stopReading() })
watch(() => [props.sessionId, props.sourceEventId], () => { visible.value = false; stopReading() })
onBeforeUnmount(stopReading)
</script>

<template>
  <ElButton link type="primary" size="small" :disabled="disabled" @click="open">纠正理解</ElButton>
  <ElDialog v-model="visible" title="纠正这条消息的理解" width="min(640px, 94vw)" append-to-body>
    <div class="intent-correction-panel" :aria-busy="loading || busy">
      <p class="intent-correction-original">{{ originalContent }}</p>
      <p v-if="loading" role="status">正在读取当前理解…</p>
      <p v-if="routeText">{{ routeText }}</p>
      <p v-if="statusText" role="status" aria-live="polite">{{ statusText }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="error" class="intent-correction-error" role="alert">{{ error }}</p>
      <p v-if="pending" role="status">上一次提交的结果尚未确认。刷新可核对结果，重试将发送完全相同的请求。</p>
      <ElForm v-if="routingId" label-position="top" @submit.prevent="submit">
        <ElFormItem label="要纠正的任务" :for="`${fieldId}-target`">
          <ElSelect :id="`${fieldId}-target`" v-model="targetId" :disabled="fieldsLocked || loading" placeholder="选择任务" @change="decisionId = ''">
            <ElOption v-for="work in works" :key="work.id" :label="work.title" :value="work.id" />
          </ElSelect>
        </ElFormItem>
        <ElFormItem label="需要替换的已确认约束（可选）" :for="`${fieldId}-decision`">
          <ElSelect :id="`${fieldId}-decision`" v-model="decisionId" clearable :disabled="fieldsLocked || loading || !targetId" placeholder="仅纠正理解，不替换指定约束">
            <ElOption v-for="decision in availableDecisions" :key="decision.id" :label="decision.content" :value="decision.id" />
          </ElSelect>
        </ElFormItem>
        <ElFormItem label="正确的理解应该是什么" :for="`${fieldId}-instruction`">
          <ElInput :id="`${fieldId}-instruction`" v-model="instruction" type="textarea" :rows="4" :maxlength="8000" show-word-limit
            :disabled="fieldsLocked || loading" placeholder="例如：超时应改为 30 分钟；请只解释原因，先不要修改代码。" />
        </ElFormItem>
        <p>提交后将暂停受影响的旧执行，待核对后再生效。已经发生的外部操作需要单独核对。</p>
      </ElForm>
      <details v-if="history.length" class="intent-correction-history">
        <summary>查看纠错记录（{{ history.length }}）</summary>
        <ol><li v-for="item in history" :key="item.id">
          <p>{{ item.instruction }}</p>
          <p>{{ item.superseded ? '已由后续纠错接替。' : correctionStatusCopy(item.status, item.failureClass) }}</p>
        </li></ol>
      </details>
    </div>
    <template #footer>
      <ElButton :disabled="loading || busy" @click="refresh">刷新结果</ElButton>
      <ElButton @click="visible = false">关闭</ElButton>
      <ElButton v-if="routingId" type="primary" :loading="busy"
        :disabled="pending ? busy || loading : !canSubmit" @click="submit">
        {{ pending ? '重试原请求' : '提交纠正' }}
      </ElButton>
    </template>
  </ElDialog>
</template>

<style scoped>
.intent-correction-panel { display: grid; gap: 12px; color: var(--el-text-color-primary); }
.intent-correction-panel p { margin: 0; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.intent-correction-original { max-height: 140px; overflow: auto; padding: 12px; border-radius: 4px; background: var(--el-fill-color-light); }
.intent-correction-panel :deep(.el-select) { width: 100%; }
.intent-correction-error { color: var(--el-color-danger); }
.intent-correction-history { max-height: 240px; overflow: auto; }
.intent-correction-history li { margin-block: 12px; }
</style>
