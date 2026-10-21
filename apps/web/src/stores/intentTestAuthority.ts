import { defineStore } from 'pinia'
import { INTENT_TEST_SCRIPTS, type ChangeIntentTestAuthorityInput, type IntentTestAuthorityView, type IntentTestRunnerBinding, type IntentTestScript } from '@agent-cluster/shared'
import { apiGet, apiPost, ApiRequestError } from '@/api/client'

export const testAuthorityKey = (sessionId: string, epoch: string) => JSON.stringify([sessionId, epoch])
const path = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}/intent-test-authority`
const storageKey = (key: string) => `intent-test-request:v1:${key}`
type BoundRequest = { sessionId: string; payload: ChangeIntentTestAuthorityInput }
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const scriptValid = (value: unknown): value is IntentTestScript => INTENT_TEST_SCRIPTS.includes(value as IntentTestScript)
function bindingValid(value: IntentTestRunnerBinding | undefined) {
  return Boolean(value && value.runnerId === 'docker-npm-tests-v1' && hash(value.bindingHash) && hash(value.workspaceBindingHash) &&
    value.resourceId === `test-runner:${value.bindingHash}` && text(value.workspaceId) && /^sha256:[a-f0-9]{64}$/.test(value.imageId) && scriptValid(value.script))
}
const sameBinding = (left: IntentTestRunnerBinding, right: IntentTestRunnerBinding) =>
  (['runnerId', 'resourceId', 'bindingHash', 'workspaceBindingHash', 'workspaceId', 'imageId', 'script'] as const).every(key => left[key] === right[key])

export function normalizeTestAuthority(value: unknown, sessionId: string, epoch: string): IntentTestAuthorityView {
  const row = value as IntentTestAuthorityView | null
  const authority = row?.authority, grant = authority?.grant
  const report = authority?.reportGrant
  if (!row || row.sessionId !== sessionId || row.dataEpoch !== epoch || !Number.isSafeInteger(row.sessionRevision) || row.sessionRevision < 1 ||
    typeof row.enabled !== 'boolean' || !Array.isArray(row.availableBindings) || row.availableBindings.length > 3 || !row.availableBindings.every(bindingValid) ||
    new Set(row.availableBindings.map(binding => binding.script)).size !== row.availableBindings.length ||
    !(authority === null || (bindingValid(authority?.binding) && grant?.id === `isolated-test:${sessionId}:${authority?.binding.bindingHash}` &&
      grant?.effect === 'run_tests' && grant.resource?.kind === 'test_runner' && grant.resource.refId === authority?.binding.resourceId &&
      Number.isSafeInteger(grant.revision) && grant.revision > 0 && text(grant.sourceEventId) && (grant.revokedAt === undefined || text(grant.revokedAt)))) ||
    (report !== undefined && (!authority || !grant || report.id !== `isolated-test-report:${sessionId}:${authority.binding.bindingHash}` ||
      report.effect !== 'write_artifact' || report.resource?.kind !== 'artifact' || report.resource.refId !== `test-report:${authority.binding.bindingHash}` ||
      report.revision !== grant.revision || report.sourceEventId !== grant.sourceEventId || (report.revokedAt !== undefined && !text(report.revokedAt)))) ||
    (row.enabled && (!authority || grant?.revokedAt || !row.availableBindings.some(binding => sameBinding(binding, authority.binding))))) {
    throw new Error('测试授权状态不匹配，请刷新会话后重试。')
  }
  return structuredClone(row)
}

function savePending(key: string, request?: BoundRequest) {
  try { if (request) sessionStorage.setItem(storageKey(key), JSON.stringify(request)); else sessionStorage.removeItem(storageKey(key)) } catch { /* memory retry remains available */ }
}

/** Request identity survives navigation and reload in this tab; retry always needs an explicit click. */
export const useIntentTestAuthorityStore = defineStore('intentTestAuthority', {
  state: () => ({ views: {} as Record<string, IntentTestAuthorityView>, pending: {} as Record<string, BoundRequest>,
    busy: {} as Record<string, boolean>, reads: {} as Record<string, number>, stale: {} as Record<string, boolean> }),
  actions: {
    record(view: IntentTestAuthorityView) {
      const key = testAuthorityKey(view.sessionId, view.dataEpoch), prior = this.views[key]
      if (!prior || view.sessionRevision >= prior.sessionRevision) this.views[key] = view
    },
    restorePending(sessionId: string, epoch: string) {
      const key = testAuthorityKey(sessionId, epoch)
      if (this.pending[key]) return
      try {
        const raw = sessionStorage.getItem(storageKey(key)); if (!raw) return
        const bound = JSON.parse(raw) as BoundRequest, input = bound.payload
        if (bound.sessionId !== sessionId || input?.dataEpoch !== epoch || !['grant', 'revoke'].includes(input.action) || !scriptValid(input.script) ||
          !hash(input.expectedBindingHash) || !Number.isSafeInteger(input.expectedGrantRevision) || input.expectedGrantRevision < 0 || !text(input.idempotencyKey) ||
          (input.writeReport !== undefined && (typeof input.writeReport !== 'boolean' || input.action !== 'grant')) ||
          Object.keys(input).some(key => !['action', 'script', 'writeReport', 'dataEpoch', 'expectedBindingHash', 'expectedGrantRevision', 'idempotencyKey'].includes(key))) {
          savePending(key); return
        }
        this.pending[key] = bound
      } catch { savePending(key) }
    },
    async refresh(sessionId: string, epoch: string, signal?: AbortSignal) {
      this.restorePending(sessionId, epoch)
      const key = testAuthorityKey(sessionId, epoch), read = (this.reads[key] ?? 0) + 1
      this.reads[key] = read; this.stale[key] = true
      try {
        const view = normalizeTestAuthority(await apiGet<unknown>(path(sessionId), { signal }), sessionId, epoch)
        if (!signal?.aborted && this.reads[key] === read) { this.record(view); this.stale[key] = false }
      } catch (error) { if (!signal?.aborted && this.reads[key] === read) this.stale[key] = true; throw error }
    },
    prepare(sessionId: string, epoch: string, action: 'grant' | 'revoke', script: IntentTestScript, writeReport = false) {
      this.restorePending(sessionId, epoch)
      const key = testAuthorityKey(sessionId, epoch), view = this.views[key]
      if (this.pending[key] || this.busy[key]) throw new Error('上一次提交尚未确认，请重试原请求。')
      if (!view || this.stale[key]) throw new Error('请先刷新测试授权状态。')
      const binding = action === 'grant' ? view.availableBindings.find(row => row.script === script) : view.authority?.binding
      if (!binding) throw new Error('当前工作区无法执行此授权操作。')
      const bound: BoundRequest = { sessionId, payload: { action, script: binding.script, dataEpoch: epoch, expectedBindingHash: binding.bindingHash,
        expectedGrantRevision: view.authority?.grant.revision ?? 0, idempotencyKey: crypto.randomUUID(), ...(action === 'grant' && writeReport ? { writeReport: true } : {}) } }
      this.pending[key] = bound; savePending(key, bound)
    },
    async submit(sessionId: string, epoch: string) {
      const key = testAuthorityKey(sessionId, epoch), bound = this.pending[key]
      if (!bound || this.busy[key]) throw new Error('没有可重试的授权请求，或请求正在提交。')
      const payload = { ...bound.payload }
      this.busy[key] = true; this.reads[key] = (this.reads[key] ?? 0) + 1
      try {
        const result = await apiPost<unknown>(path(bound.sessionId), payload, { timeoutMs: 20_000, timeoutMessage: '提交结果尚未确认，请重试原请求。' })
        this.record(normalizeTestAuthority(result, sessionId, epoch)); this.stale[key] = false
        delete this.pending[key]; savePending(key)
      } catch (error) {
        this.stale[key] = true
        if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
          delete this.pending[key]; savePending(key)
          if ([409, 410].includes(error.status)) await this.refresh(sessionId, epoch).catch(() => undefined)
        }
        throw error
      } finally { this.busy[key] = false }
    }
  }
})
