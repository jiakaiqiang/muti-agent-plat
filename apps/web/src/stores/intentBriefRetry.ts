import { defineStore } from 'pinia'
import { isRetryIntentBriefInput, type RetryIntentBriefInput } from '@agent-cluster/shared'
import { apiGet, apiPost, ApiRequestError } from '@/api/client'
export type BriefRecoveryReference = { sessionId: string; stepId: string; routingId: string; dataEpoch: string }
type View = BriefRecoveryReference & { routingRevision: number; intentRevision: number; operationId: string; status: string; canRetry: boolean;
  action?: 'prepare_brief' | 'review_brief'; reviewerId?: string; reviewerName?: string }
export const briefRecoveryKey = (ref: BriefRecoveryReference) => JSON.stringify([ref.sessionId, ref.dataEpoch, ref.routingId, ref.stepId])
const path = (ref: BriefRecoveryReference) => `/sessions/${encodeURIComponent(ref.sessionId)}/intent-plan-steps/${encodeURIComponent(ref.stepId)}`
const storage = (key: string) => `intent-brief-retry:v1:${key}`
const save = (key: string, value?: RetryIntentBriefInput) => { try { if (value) sessionStorage.setItem(storage(key), JSON.stringify(value)); else sessionStorage.removeItem(storage(key)) } catch { /* Memory fallback. */ } }
function validate(ref: BriefRecoveryReference, view: View) {
  if (view?.action !== undefined && (!['prepare_brief', 'review_brief'].includes(view.action) ||
    (view.action === 'review_brief' && (typeof view.reviewerId !== 'string' || !view.reviewerId || typeof view.reviewerName !== 'string' || !view.reviewerName)))) throw new Error('审阅目标与原请求不匹配。')
  if (!view || !(['sessionId', 'stepId', 'routingId', 'dataEpoch'] as const).every(key => view[key] === ref[key]) ||
    ![view.routingRevision, view.intentRevision].every(n => Number.isSafeInteger(n) && n > 0) || typeof view.operationId !== 'string' || !view.operationId ||
    typeof view.canRetry !== 'boolean' || !['queued', 'running', 'completed', 'failed', 'invalidated', 'reconciliation_required'].includes(view.status)) throw new Error('草稿状态与原请求不匹配。')
}
export const useIntentBriefRetryStore = defineStore('intentBriefRetry', {
  state: () => ({ views: {} as Record<string, View>, pending: {} as Record<string, RetryIntentBriefInput>, busy: {} as Record<string, boolean>,
    stale: {} as Record<string, boolean>, reads: {} as Record<string, number> }),
  actions: {
    restore(ref: BriefRecoveryReference) {
      const key = briefRecoveryKey(ref); if (this.pending[key]) return
      try { const value: unknown = JSON.parse(sessionStorage.getItem(storage(key)) ?? 'null');
        if (isRetryIntentBriefInput(value) && value.dataEpoch === ref.dataEpoch) this.pending[key] = value
        else save(key)
      } catch { save(key) }
    },
    record(ref: BriefRecoveryReference, view: View) {
      validate(ref, view); const key = briefRecoveryKey(ref)
      const previous = this.views[key]
      if (previous?.action && view.action && (previous.action !== view.action || previous.reviewerId !== view.reviewerId)) throw new Error('审阅目标与原请求不匹配。')
      if (!this.views[key] || view.routingRevision >= this.views[key].routingRevision) this.views[key] = view
    },
    async refresh(ref: BriefRecoveryReference, signal?: AbortSignal) {
      this.restore(ref); const key = briefRecoveryKey(ref), read = (this.reads[key] ?? 0) + 1
      this.reads[key] = read; this.stale[key] = true
      const view = await apiGet<View>(`${path(ref)}/brief-recovery`, { signal })
      if (!signal?.aborted && read === this.reads[key]) { this.record(ref, view); this.stale[key] = false }
    },
    async submit(ref: BriefRecoveryReference) {
      this.restore(ref); const key = briefRecoveryKey(ref), view = this.views[key]
      if (this.busy[key]) throw new Error('重新生成正在提交。')
      if (!this.pending[key]) {
        if (!view?.canRetry || this.stale[key]) throw new Error('请先刷新草稿状态。')
        this.pending[key] = { contractVersion: 'intent-brief-retry-v1', dataEpoch: ref.dataEpoch, expectedRoutingRevision: view.routingRevision,
          expectedIntentRevision: view.intentRevision, expectedOperationId: view.operationId, idempotencyKey: crypto.randomUUID() }
        save(key, this.pending[key])
      }
      const request = { ...this.pending[key] }; this.busy[key] = true; this.reads[key] = (this.reads[key] ?? 0) + 1
      try {
        const result = await apiPost<any>(`${path(ref)}/retry-brief`, request, { timeoutMs: 20000, timeoutMessage: '受理结果尚未核实，请核对原提交。' })
        const receipt = result?.receipt, step = result?.step
        if (result?.accepted !== true || result.sessionId !== ref.sessionId || result.stepId !== ref.stepId || result.dataEpoch !== ref.dataEpoch ||
          !step || step.id !== ref.stepId || step.sessionId !== ref.sessionId || step.routingId !== ref.routingId || step.dataEpoch !== ref.dataEpoch ||
          !receipt || !isRetryIntentBriefInput(receipt.request) ||
          !(Object.keys(request) as Array<keyof RetryIntentBriefInput>).every(field => receipt.request[field] === request[field]) ||
          !Number.isSafeInteger(receipt.acceptedRoutingRevision) || receipt.acceptedRoutingRevision <= request.expectedRoutingRevision ||
          typeof receipt.operationId !== 'string' || !receipt.operationId ||
          !step.briefRetryReceipts?.some((row: any) => row.id === receipt.id && row.operationId === receipt.operationId)) throw new Error('草稿重试回执不匹配。')
        this.record(ref, { ...view, ...ref, routingRevision: receipt.acceptedRoutingRevision, intentRevision: step.intentRevision,
          operationId: step.briefOperationId, status: step.status, canRetry: false })
        delete this.pending[key]; save(key); this.stale[key] = false
        await this.refresh(ref).catch(() => { this.stale[key] = true })
      } catch (error) {
        this.stale[key] = true
        if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          delete this.pending[key]; save(key); await this.refresh(ref).catch(() => undefined)
        }
        throw error
      } finally { this.busy[key] = false }
    }
  }
})
