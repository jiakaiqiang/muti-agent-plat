import { defineStore } from 'pinia'
import type { ChangeIntentWorkspaceReadAuthorityInput, IntentWorkspaceReadAuthorityView } from '@agent-cluster/shared'
import { apiGet, apiPost, ApiRequestError } from '@/api/client'

export const authorityKey = (sessionId: string, epoch: string) => JSON.stringify([sessionId, epoch])
const path = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}/intent-workspace-read-authority`
type BoundRequest = { sessionId: string; payload: ChangeIntentWorkspaceReadAuthorityInput }

export function normalizeAuthority(value: unknown, sessionId: string, epoch: string): IntentWorkspaceReadAuthorityView {
  const row = value as IntentWorkspaceReadAuthorityView | null
  const validText = (text: unknown): text is string => typeof text === 'string' && text.length > 0
  if (!row || row.sessionId !== sessionId || row.dataEpoch !== epoch || !Number.isSafeInteger(row.sessionRevision) || row.sessionRevision < 1 ||
    typeof row.enabled !== 'boolean' || !(row.bindingHash === null || validText(row.bindingHash)) ||
    !(row.authority === null || (validText(row.authority?.bindingHash) && validText(row.authority.grant?.id) &&
      row.authority.grant.effect === 'read_workspace' && row.authority.grant.resource?.kind === 'workspace' && validText(row.authority.grant.resource.refId) &&
      Number.isSafeInteger(row.authority.grant.revision) && row.authority.grant.revision > 0 && validText(row.authority.grant.sourceEventId) &&
      (row.authority.grant.revokedAt === undefined || validText(row.authority.grant.revokedAt)))) ||
    (row.enabled && (!row.bindingHash || row.authority?.bindingHash !== row.bindingHash || row.authority.grant.revokedAt))) {
    throw new Error('读取授权状态不匹配，请刷新会话后重试。')
  }
  return structuredClone(row)
}

/** One bound request identity per Session/epoch; navigation never retargets a retry. */
export const useIntentWorkspaceAuthorityStore = defineStore('intentWorkspaceAuthority', {
  state: () => ({
    views: {} as Record<string, IntentWorkspaceReadAuthorityView>,
    pending: {} as Record<string, BoundRequest>, busy: {} as Record<string, boolean>,
    reads: {} as Record<string, number>, stale: {} as Record<string, boolean>
  }),
  actions: {
    record(view: IntentWorkspaceReadAuthorityView) {
      const key = authorityKey(view.sessionId, view.dataEpoch), prior = this.views[key]
      if (!prior || view.sessionRevision >= prior.sessionRevision) this.views[key] = view
    },
    async refresh(sessionId: string, epoch: string, signal?: AbortSignal) {
      const key = authorityKey(sessionId, epoch), read = (this.reads[key] ?? 0) + 1
      this.reads[key] = read
      this.stale[key] = true
      try {
        const view = normalizeAuthority(await apiGet<unknown>(path(sessionId), { signal }), sessionId, epoch)
        if (!signal?.aborted && this.reads[key] === read) { this.record(view); this.stale[key] = false }
      } catch (error) { if (!signal?.aborted && this.reads[key] === read) this.stale[key] = true; throw error }
    },
    prepare(sessionId: string, epoch: string, action: 'grant' | 'revoke') {
      const key = authorityKey(sessionId, epoch), view = this.views[key]
      if (this.pending[key] || this.busy[key]) throw new Error('上一次提交尚未确认，请重试原请求。')
      if (!view || this.stale[key]) throw new Error('请先刷新读取授权状态。')
      const bindingHash = action === 'grant' ? view.bindingHash : view.authority?.bindingHash
      if (!bindingHash || (action === 'revoke' && !view.authority)) throw new Error('当前工作区无法执行此授权操作。')
      this.pending[key] = { sessionId, payload: { action, dataEpoch: epoch, expectedBindingHash: bindingHash,
        expectedGrantRevision: view.authority?.grant.revision ?? 0, idempotencyKey: crypto.randomUUID() } }
    },
    async submit(sessionId: string, epoch: string) {
      const key = authorityKey(sessionId, epoch), bound = this.pending[key]
      if (!bound || this.busy[key]) throw new Error('没有可重试的授权请求，或请求正在提交。')
      const payload = { ...bound.payload }
      this.busy[key] = true
      this.reads[key] = (this.reads[key] ?? 0) + 1
      try {
        const data = await apiPost<unknown>(path(bound.sessionId), payload, { timeoutMs: 20_000,
          timeoutMessage: '提交结果尚未确认，请重试原请求。' })
        this.record(normalizeAuthority(data, sessionId, epoch))
        this.stale[key] = false
        delete this.pending[key]
      } catch (error) {
        this.stale[key] = true
        if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          delete this.pending[key]
          if ([409, 410].includes(error.status)) await this.refresh(sessionId, epoch).catch(() => undefined)
        }
        throw error
      } finally { this.busy[key] = false }
    }
  }
})
