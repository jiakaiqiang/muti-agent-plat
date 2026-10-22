<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { ElButton, ElCheckbox } from 'element-plus'
import type { IntentReconciliationAction } from '@agent-cluster/shared'
import type { ConfirmationCardState } from '@/types/contracts'
import { useSessionStore } from '@/stores/session'
import { reconciliationActionLabels, reconciliationEvidenceRows, reconciliationNeedsCliConfirmation, reconciliationReadOnly } from './intentReconciliationModel'

const props = defineProps<{ confirmation: ConfirmationCardState }>()
const emit = defineEmits<{ decided: [sessionId: string] }>()
const store = useSessionStore()
const fieldId = useId()
const sessionId = computed(() => props.confirmation.sessionId ?? props.confirmation.intentReconciliation?.record.sessionId ?? '')
const caseId = computed(() => props.confirmation.reconciliationCaseId ?? props.confirmation.confirmationId)
const view = computed(() => store.intentReconciliationsBySession[sessionId.value]?.find(row => row.record.id === caseId.value) ?? props.confirmation.intentReconciliation)
const sourceWriteback = computed(() => view.value?.record.source === 'source_writeback')
const sourceClaimId = computed(() => {
  const sourceId = view.value?.record.sourceId ?? ''
  return sourceId.startsWith('source-writeback:') ? sourceId.slice('source-writeback:'.length) : sourceId
})
const sourceView = computed(() => store.intentSourceReconciliationsBySession[sessionId.value]?.find(row => row.claim.id === sourceClaimId.value))
const loading = ref(false)
const submitting = ref(false)
const error = ref('')
const notice = ref('')
const accepted = ref(false)
const busy = computed(() => submitting.value || !!store.intentReconciliationBusy[`${sessionId.value}:${caseId.value}`])
const readOnly = computed(() => !view.value || (!sourceWriteback.value && reconciliationReadOnly(view.value)))
const cli = computed(() => !!view.value && reconciliationNeedsCliConfirmation(view.value))
const evidence = computed(() => view.value ? reconciliationEvidenceRows(view.value) : [])
const factsError = computed(() => store.intentReconciliationErrors[sessionId.value])
const ready = computed(() => !loading.value && !factsError.value && !!view.value && (!sourceWriteback.value || !!sourceView.value))
let loadGeneration = 0
async function refresh() {
  const generation = ++loadGeneration, origin = sessionId.value
  if (!origin) { error.value = '对账会话未知，请刷新会话。'; return }
  loading.value = true; error.value = ''
  try {
    await store.loadIntentReconciliations(origin)
    await store.loadIntentSourceReconciliations(origin).catch(() => [])
  }
  catch (cause) { if (generation === loadGeneration) error.value = cause instanceof Error ? cause.message : '加载对账事实失败' }
  finally { if (generation === loadGeneration) loading.value = false }
}
watch(() => [sessionId.value, caseId.value], () => { accepted.value = false; notice.value = ''; void refresh() }, { immediate: true })
watch(() => [view.value?.record.revision, view.value?.record.evidenceHash, view.value?.sessionRevision], () => { accepted.value = false })
function disabledReason(action: IntentReconciliationAction) {
  if (busy.value) return '正在提交决定'
  if (!ready.value) return '请先成功刷新事实'
  if (view.value?.record.status !== 'open') return '案件已处理或正在派发，请查看历史决定。'
  const available = sourceWriteback.value
    ? sourceView.value?.actions.find(row => row.action === action)
    : view.value?.actions.find(row => row.action === action)
  if (!available?.enabled) return available?.reason || '服务端未提供可用动作，原因未知'
  if (action === 'redispatch' && cli.value && !accepted.value) return '请先勾选“工作区改动由我负责”'
  return ''
}
async function decide(action: IntentReconciliationAction) {
  if (readOnly.value || disabledReason(action)) return
  submitting.value = true; error.value = ''; notice.value = ''
  const origin = sessionId.value
  try {
    if (sourceWriteback.value && sourceView.value) await store.decideIntentSourceReconciliation(origin, sourceView.value, action)
    else await store.decideIntentReconciliation(origin, caseId.value, action, accepted.value)
    notice.value = '决定已记录；派发接受不代表执行成功，请以服务端事实为准。'
    emit('decided', origin)
  } catch (cause) {
    error.value = (cause as { status?: number })?.status === 409 ? '事实已变化，已请求刷新；请核对刷新结果后再选择。'
      : `${cause instanceof Error ? cause.message : '提交失败'}；结果可能尚未确认，重试同一决定将沿用原幂等键。`
  } finally { submitting.value = false }
}
</script>

<template>
  <section class="intent-reconciliation" :aria-busy="busy || loading">
    <p>仅展示服务端已有事实；未记录不代表未执行，历史工作区快照不能证明当前改动归属。</p>
    <p v-if="loading" role="status">正在读取对账事实…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="factsError && factsError !== error" role="alert">{{ factsError }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <ElButton size="small" :disabled="busy || loading" @click="refresh">刷新事实</ElButton>
    <template v-if="view">
      <p>案件：{{ view.record.id }} · 来源：{{ view.record.source }} / {{ view.record.sourceId }} · 状态：{{ view.record.status }}</p>
      <p>证据版本：{{ view.record.revision }} · 会话版本：{{ view.sessionRevision }}</p>
      <details open>
        <summary>对账证据（含来源与观测时间）</summary>
        <div class="intent-reconciliation__evidence" tabindex="0" aria-label="对账证据，可滚动查看">
          <table>
            <caption class="sr-only">服务端事实、来源和观测时间，缺失值为未知</caption>
            <thead><tr><th scope="col">证据项</th><th scope="col">值</th><th scope="col">记录来源</th><th scope="col">观测时间</th></tr></thead>
            <tbody><tr v-for="row in evidence" :key="row.key"><th scope="row">{{ row.key }}</th><td>{{ row.value }}</td><td>{{ row.source }}</td><td>观测时间：{{ row.observedAt }}</td></tr></tbody>
          </table>
        </div>
      </details>
      <template v-if="sourceWriteback">
        <p>源码写回事实：{{ sourceView?.evidence.note || '只展示服务端当前文件哈希，不推断写入结果。' }}</p>
        <div v-if="sourceView" class="intent-reconciliation__evidence" tabindex="0" aria-label="源码写回文件事实">
          <table><caption class="sr-only">源码写回文件的基线、目标和当前哈希</caption><thead><tr><th>文件</th><th>基线哈希</th><th>目标哈希</th><th>当前哈希</th></tr></thead>
            <tbody><tr v-for="file in sourceView.evidence.files" :key="file.path"><th>{{ file.path }}</th><td>{{ file.baseHash }}</td><td>{{ file.targetHash }}</td><td>{{ file.currentHash }}</td></tr></tbody>
          </table>
        </div>
        <ul class="intent-reconciliation__actions">
          <li v-for="(label, action) in reconciliationActionLabels" :key="action"><ElButton :data-reconciliation-action="action" :type="action === 'redispatch' ? 'primary' : action === 'abandon' ? 'danger' : 'default'" :disabled="!!disabledReason(action)" @click="decide(action)">{{ label }}</ElButton><p>{{ disabledReason(action) || '服务端当前允许选择；提交时仍会复核文件事实。' }}</p></li>
        </ul>
      </template>
      <div v-else-if="readOnly" class="intent-reconciliation__handler">
        <p>此来源只读；原处理入口：{{ view.handler || '未知' }}</p>
        <p v-if="view.record.source === 'correction'">请返回原消息的“纠正意图”入口核验纠错证据。</p>
        <p v-else-if="view.record.source === 'isolated_test'">请使用原隔离测试恢复／清理处理器，核对停止与清理结果。</p>
        <p v-else>请使用原计划步骤处理器；此卡片不替代原处理流程。</p>
      </div>
      <template v-else>
        <div v-if="cli && view.record.status === 'open'" class="intent-reconciliation__risk">
          <p :id="`${fieldId}-risk`">CLI 可能直接改动工作区，缺少写回记录也不能证明没有执行。当前新链路还不支持在该运行时上执行，选择后可能仍被阻止。此确认只用于本案件这一次重新派发。</p>
          <ElCheckbox v-model="accepted" :disabled="busy || !ready" :aria-describedby="`${fieldId}-risk`" aria-required="true">工作区改动由我负责</ElCheckbox>
        </div>
        <ul class="intent-reconciliation__actions">
          <li v-for="(label, action) in reconciliationActionLabels" :key="action">
            <ElButton :data-reconciliation-action="action" :type="action === 'redispatch' ? 'primary' : action === 'abandon' ? 'danger' : 'default'"
              :disabled="!!disabledReason(action)" :aria-describedby="`${fieldId}-${action}-reason`" @click="decide(action)">{{ label }}</ElButton>
            <p :id="`${fieldId}-${action}-reason`">{{ disabledReason(action) || '服务端当前允许选择；提交时仍会复核全部守卫。' }}</p>
          </li>
        </ul>
      </template>
      <details :open="view.record.decisions.length > 0">
        <summary>历史决定（{{ view.record.decisions.length }}）</summary>
        <p v-if="!view.record.decisions.length">未记录</p>
        <ul v-else><li v-for="(decision, index) in view.record.decisions" :key="`${decision.idempotencyKey}-${index}`">
          {{ reconciliationActionLabels[decision.action] || '未知' }} · 决定人：{{ decision.actorId || '未知' }} · {{ decision.decidedAt || '未知' }} · 证据：{{ decision.evidenceHash || '未知' }}
        </li></ul>
      </details>
    </template>
    <p v-else-if="!loading">案件事实未知，请刷新后核对。</p>
  </section>
</template>

<style scoped>
.intent-reconciliation { display: grid; gap: 12px; min-width: 0; color: var(--el-text-color-primary); }
.intent-reconciliation p { margin: 0; overflow-wrap: anywhere; }
.intent-reconciliation summary { cursor: pointer; padding-block: 8px; }
.intent-reconciliation__evidence { max-height: 360px; overflow: auto; border: 1px solid var(--el-border-color); border-radius: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 8px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--el-border-color-lighter); overflow-wrap: anywhere; min-width: 110px; }
thead th { background: var(--el-fill-color-light); }
.intent-reconciliation__risk { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--el-color-warning-light-5); border-radius: 8px; }
.intent-reconciliation__actions { display: grid; gap: 12px; list-style: none; padding: 0; margin: 0; }
.intent-reconciliation__actions li { display: grid; gap: 6px; justify-items: start; }
.intent-reconciliation__actions p { color: var(--el-text-color-secondary); font-size: 12px; }
.intent-reconciliation__actions :deep(button) { max-width: 100%; height: auto; min-height: 32px; white-space: normal; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
