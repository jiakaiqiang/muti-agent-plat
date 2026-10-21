import { defineStore } from 'pinia'
import { canRetryIntentRecognition, type IntentRoutingRecord, type RetryIntentRecognitionInput } from '@agent-cluster/shared'
import { apiGet, apiPost, ApiRequestError } from '@/api/client'

export type RecognitionReference = { sessionId: string; routingId: string; dataEpoch: string; sourceEventId: string }
export const recognitionRetryKey = (ref: RecognitionReference) => JSON.stringify([ref.sessionId, ref.dataEpoch, ref.routingId, ref.sourceEventId])
const path = (ref: RecognitionReference) => `/sessions/${encodeURIComponent(ref.sessionId)}/message-routings/${encodeURIComponent(ref.routingId)}`
const storageKey = (key: string) => `intent-recognition-retry:v1:${key}`
function save(key: string, payload?: RetryIntentRecognitionInput) {
  try { if (payload) sessionStorage.setItem(storageKey(key), JSON.stringify(payload)); else sessionStorage.removeItem(storageKey(key)) } catch { /* retain in-memory pending request */ }
}
function normalize(value: unknown, ref: RecognitionReference): IntentRoutingRecord {
  const row = value as IntentRoutingRecord
  if (!row || row.id !== ref.routingId || row.sessionId !== ref.sessionId || row.sourceEventId !== ref.sourceEventId ||
    row.semanticIngress?.dataEpoch !== ref.dataEpoch || !Number.isSafeInteger(row.routingRevision) || row.routingRevision! < 1 ||
    !['RECEIVED', 'SNAPSHOT_READY', 'CLASSIFYING', 'VALIDATING', 'APPLYING', 'PENDING_RETRY', 'ROUTED', 'BLOCKED', 'REJECTED', 'CLARIFICATION_REQUIRED'].includes(row.status)) {
    throw new Error('原消息的识别状态不匹配，请刷新会话。')
  }
  return row
}
export const useIntentRecognitionRetryStore = defineStore('intentRecognitionRetry', {
  state: () => ({ routes: {} as Record<string, IntentRoutingRecord>, pending: {} as Record<string, RetryIntentRecognitionInput>,
    busy: {} as Record<string, boolean>, stale: {} as Record<string, boolean>, reads: {} as Record<string, number> }),
  actions: {
    restore(ref: RecognitionReference) {
      const key = recognitionRetryKey(ref); if (this.pending[key]) return
      try {
        const raw = sessionStorage.getItem(storageKey(key)); if (!raw) return
        const input = JSON.parse(raw) as RetryIntentRecognitionInput
        if (!input || input.contractVersion !== 'intent-recognition-retry-v1' || input.dataEpoch !== ref.dataEpoch ||
          !Number.isSafeInteger(input.expectedRoutingRevision) || input.expectedRoutingRevision < 1 ||
          typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 256 ||
          Object.keys(input).some(key => !['contractVersion', 'dataEpoch', 'expectedRoutingRevision', 'idempotencyKey', 'inputBudget'].includes(key)) ||
          (input.inputBudget !== undefined && (!input.inputBudget || typeof input.inputBudget.decisionId !== 'string' ||
            !['continue', 'end'].includes(input.inputBudget.decision) || Object.keys(input.inputBudget).some(key => !['decisionId', 'decision'].includes(key))))) { save(key); return }
        this.pending[key] = input
      } catch { save(key) }
    },
    record(ref: RecognitionReference, value: unknown) {
      const row = normalize(value, ref), key = recognitionRetryKey(ref)
      if (!this.routes[key] || row.routingRevision! >= this.routes[key].routingRevision!) this.routes[key] = row
    },
    async refresh(ref: RecognitionReference, signal?: AbortSignal) {
      this.restore(ref); const key = recognitionRetryKey(ref), read = (this.reads[key] ?? 0) + 1
      this.reads[key] = read; this.stale[key] = true
      const result = await apiGet<unknown>(path(ref), { signal })
      if (!signal?.aborted && this.reads[key] === read) { this.record(ref, result); this.stale[key] = false }
    },
    prepare(ref: RecognitionReference, decision?: 'continue' | 'end') {
      this.restore(ref); const key = recognitionRetryKey(ref), row = this.routes[key]
      if (this.pending[key] || this.busy[key]) throw new Error('请先核对原提交结果。')
      if (!row || this.stale[key] || !canRetryIntentRecognition(row)) throw new Error('当前消息不能重新识别，请刷新状态。')
      const hold = row.blockedReason === 'INTENT_INPUT_BUDGET_EXCEEDED' ? row.inputBudgetDecision : undefined
      if (hold && !decision) throw new Error('请选择继续或结束。')
      this.pending[key] = { contractVersion: 'intent-recognition-retry-v1', dataEpoch: ref.dataEpoch,
        expectedRoutingRevision: row.routingRevision!, idempotencyKey: crypto.randomUUID(),
        ...(hold ? { inputBudget: { decisionId: hold.id, decision: decision! } } : {}) }
      save(key, this.pending[key])
    },
    async submit(ref: RecognitionReference) {
      const key = recognitionRetryKey(ref), request = this.pending[key]
      if (!request || this.busy[key]) throw new Error('请求正在提交或没有待核对的提交。')
      this.busy[key] = true; this.reads[key] = (this.reads[key] ?? 0) + 1
      try {
        const result = await apiPost<{ routing: unknown; receipt: NonNullable<IntentRoutingRecord['recognitionRetryReceipts']>[number] }>(
          `${path(ref)}/retry-recognition`, { ...request }, { timeoutMs: 20_000, timeoutMessage: '受理结果尚未确认，请核对原提交结果。' })
        const row = normalize(result.routing, ref), receipt = result.receipt
        if (!receipt || !row.recognitionRetryReceipts?.some(item => item.id === receipt.id && item.operationId === receipt.operationId) ||
          typeof receipt.operationId !== 'string' || !receipt.operationId || !Number.isSafeInteger(receipt.acceptedRoutingRevision) ||
          receipt.acceptedRoutingRevision <= request.expectedRoutingRevision || receipt.acceptedRoutingRevision > row.routingRevision! ||
          !(['contractVersion', 'dataEpoch', 'expectedRoutingRevision', 'idempotencyKey'] as const).every(field => receipt.request?.[field] === request[field]) ||
          receipt.request?.inputBudget?.decisionId !== request.inputBudget?.decisionId || receipt.request?.inputBudget?.decision !== request.inputBudget?.decision) {
          throw new Error('识别重试的受理回执不匹配。')
        }
        this.record(ref, row); this.stale[key] = false; delete this.pending[key]; save(key)
      } catch (error) {
        this.stale[key] = true
        if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          delete this.pending[key]; save(key)
          if ([409, 410].includes(error.status)) await this.refresh(ref).catch(() => undefined)
        }
        throw error
      } finally { this.busy[key] = false }
    }
  }
})
