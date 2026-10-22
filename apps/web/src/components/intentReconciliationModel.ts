import type { IntentReconciliationAction, IntentReconciliationView } from '@agent-cluster/shared'
import type { ChatMessage, ConfirmationCardState } from '@/types/contracts'

// Version of the explicit user-facing acknowledgement accepted by the R9a API.
export const RECONCILIATION_CLI_RISK_VERSION = 'intent-cli-workspace-responsibility-v1'
export const reconciliationActionLabels: Record<IntentReconciliationAction, string> = {
  redispatch: '确认没有执行，重新派发一次', confirm_completed: '确认已经执行过，按完成处理', abandon: '放弃这个任务'
}
export function reconciliationReadOnly(view: IntentReconciliationView) {
  return view.readOnly || !view.record.binding || !['resume', 'retry', 'runtime_safety'].includes(view.record.source)
}
export function reconciliationNeedsCliConfirmation(view: IntentReconciliationView) {
  const binding = view.record.binding
  const runtimes: unknown[] = binding && 'failure' in binding ? [binding.failure?.runtimeType] : []
  if (Array.isArray(view.evidence.invocations)) {
    for (const row of view.evidence.invocations) if (row && typeof row === 'object') runtimes.push(row.runtimeType)
  }
  return runtimes.some(runtime => runtime === 'codex' || runtime === 'claude_code')
}
export function normalizeReconciliationViews(raw: unknown): IntentReconciliationView[] {
  if (!Array.isArray(raw)) throw new Error('对账事实格式无效，请刷新。')
  return raw.map(view => {
    const row = view?.record
    if (!row || typeof row.id !== 'string' || typeof row.sessionId !== 'string' ||
      !Number.isSafeInteger(row.revision) || row.revision < 1 || !Number.isSafeInteger(view.sessionRevision) || view.sessionRevision < 1 ||
      !['open', 'dispatching', 'resolved'].includes(row.status) || typeof view.readOnly !== 'boolean' ||
      !view.evidence || typeof view.evidence !== 'object' || Array.isArray(view.evidence) || !Array.isArray(view.actions)) {
      throw new Error('对账事实格式无效，请刷新。')
    }
    return { ...view, record: { ...row, decisions: Array.isArray(row.decisions) ? row.decisions : [], attempts: Array.isArray(row.attempts) ? row.attempts : [] },
      actions: view.actions.filter((action: any) => action && Object.hasOwn(reconciliationActionLabels, action.action) && typeof action.enabled === 'boolean') }
  })
}
const evidenceCollections: Record<string, string> = {
  session: 'sessions / sessionLifecyclesBySession', tasks: 'tasksBySession', operations: 'logicalOperationsBySession',
  invocations: 'runtimeInvocationsBySession', writebacks: 'workspaceWritebacks', artifacts: 'artifacts',
  steps: 'intentPlanStepsBySession', corrections: 'intentCorrectionsBySession'
}
const evidenceFields: Record<string, string[]> = {
  source: ['collection', 'id'], session: ['status', 'revision', 'dataEpoch', 'generation'],
  tasks: ['id', 'status', 'updatedAt', 'checkpoint'],
  operations: ['id', 'status', 'stopState', 'activeInvocationId', 'attemptsUsed', 'maxAttempts', 'remainingActiveMs', 'updatedAt'],
  invocations: ['id', 'status', 'runtimeType', 'candidate', 'githubCandidate', 'workspaceExecution', 'systemEvidence', 'updatedAt'],
  writebacks: ['id', 'status', 'updatedAt'], artifacts: ['id', 'status', 'createdAt'],
  steps: ['id', 'status', 'failureCode', 'resumeReceipts', 'retryReceipts', 'updatedAt'],
  corrections: ['id', 'status', 'effectReconciliation', 'updatedAt']
}
export function reconciliationEvidenceRows(view: IntentReconciliationView) {
  const result: Array<{ key: string; value: string; source: string; observedAt: string }> = []
  function visit(key: string, value: unknown, source: string, observedAt: string) {
    if (Array.isArray(value) && value.length) {
      value.forEach((row, index) => visit(`${key}[${index}]`, row, source, observedAt)); return
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
      for (const [field, item] of Object.entries(value)) visit(`${key}.${field}`, item, source, observedAt)
      return
    }
    result.push({ key, value: value === null || value === undefined || value === '' ? '未知'
      : Array.isArray(value) ? '未记录' : typeof value === 'object' ? '未知' : String(value), source, observedAt })
  }
  const knownGroups = Object.fromEntries([...Object.keys(evidenceFields), 'unownedWorkspaceChanges'].map(key => [key, undefined]))
  for (const [key, value] of Object.entries({ ...knownGroups, ...view.evidence })) {
    const collection = evidenceCollections[key] ?? (key === 'source' ? '案件来源记录' : '服务端证据视图')
    const records = Array.isArray(value) && value.length ? value : [value]
    for (const [index, row] of records.entries()) {
      const object = row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : undefined
      const id = object?.id ?? '未知'
      const time = object?.updatedAt ?? object?.createdAt
      const defaults = Object.fromEntries((evidenceFields[key] ?? []).map(field => [field, undefined]))
      visit(Array.isArray(value) && value.length ? `${key} / ${id}${id === '未知' ? ` [${index}]` : ''}` : key,
        object ? { ...defaults, ...object } : row, `${collection} / ${id}`,
        typeof time === 'string' && time ? time : '未知')
    }
  }
  visit('原绑定／授权版本', view.record.binding, `intentReconciliationsBySession / ${view.record.id}`, '未知')
  return result
}
export function reconciliationConfirmation(view: IntentReconciliationView): ConfirmationCardState {
  return { confirmationId: view.record.id, sessionId: view.record.sessionId, reconciliationCaseId: view.record.id,
    reason: 'intent_reconciliation_required', title: '执行结果需要人工对账',
    description: '请核对已有事实；缺失证据显示未知，未记录不代表未执行。',
    status: view.record.status === 'resolved' ? 'approved' : 'pending', options: [], intentReconciliation: view }
}
export function withReconciliationMessages(messages: ChatMessage[], views: IntentReconciliationView[]) {
  if (!views.length) return messages
  const remaining = new Map(views.map(view => [view.record.id, view]))
  const result = messages.flatMap(message => {
    const id = message.payload?.confirmationId
    if (message.payload?.reason !== 'intent_reconciliation_required' || typeof id !== 'string') return [message]
    const view = remaining.get(id)
    if (!view) return views.some(row => row.record.id === id) ? [] : [message]
    remaining.delete(id)
    return [{ ...message, payload: { ...message.payload, ...reconciliationConfirmation(view) } }]
  })
  for (const view of remaining.values()) result.push({ id: `msg-reconciliation-${view.record.id}`, rawEventId: `reconciliation-case:${view.record.id}`, sessionId: view.record.sessionId,
    senderType: 'system', toAgentIds: [], messageType: 'confirmation', content: '执行结果需要人工对账',
    createdAt: view.record.createdAt, payload: { ...reconciliationConfirmation(view) } })
  return result
}
