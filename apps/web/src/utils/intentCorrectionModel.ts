import type { CorrectIntentRoutingInput, IntentCorrectionStatus } from '@agent-cluster/shared'

const statuses: IntentCorrectionStatus[] = ['accepted', 'waiting_for_stop', 'validating',
  'clarification_required', 'applied', 'reconciliation_required', 'rejected']
const routeStatuses = ['RECEIVED', 'SNAPSHOT_READY', 'CLASSIFYING', 'VALIDATING', 'APPLYING', 'ROUTED',
  'CLARIFICATION_REQUIRED', 'BLOCKED', 'REJECTED', 'PENDING_RETRY']
export type CorrectionRoute = {
  id: string; sessionId: string; sourceEventId: string; revision: number; status: string
  targetWorkItemId: string | null; held: boolean
  correctionTargetRoutingId?: string
}
export type CorrectionReceipt = {
  correctionId: string; routingId: string; pendingIntentRevision: number; routingRevision: number
  correctionStatus: IntentCorrectionStatus
}
export type CorrectionSummary = {
  id: string; status: IntentCorrectionStatus; instruction: string; idempotencyKey: string
  revision: number; routingRevision: number; updatedAt: string; failureClass?: string; superseded: boolean
}
export type CorrectionWork = { id: string; title: string; inheritedDecisionIds: string[] }
export type CorrectionDecision = { id: string; workItemId: string; content: string; revision: number; overridesDecisionId?: string }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('纠错数据格式异常，请刷新后重试。')
  return value as Record<string, unknown>
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('纠错数据缺少必要信息，请刷新后重试。')
  return value
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('纠错数据版本异常，请刷新后重试。')
  return value as number
}
function status(value: unknown): IntentCorrectionStatus {
  if (!statuses.includes(value as IntentCorrectionStatus)) throw new Error('纠错状态暂不受支持，请刷新后重试。')
  return value as IntentCorrectionStatus
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('纠错列表格式异常，请刷新后重试。')
  return value
}
export function normalizeCorrectionRoute(value: unknown, sessionId: string, sourceEventId?: string): CorrectionRoute {
  const row = object(value)
  if (row.sessionId !== sessionId || (sourceEventId && row.sourceEventId !== sourceEventId)) {
    throw new Error('消息与会话不匹配，请重新打开原消息。')
  }
  if (!routeStatuses.includes(String(row.status))) throw new Error('消息路由状态暂不受支持。')
  const decision = row.decision ? object(row.decision) : undefined
  return { id: string(row.id), sessionId, sourceEventId: string(row.sourceEventId),
    correctionTargetRoutingId: row.correctionTargetRoutingId === undefined ? undefined : string(row.correctionTargetRoutingId),
    revision: positive(row.routingRevision ?? 1), status: String(row.status), held: Boolean(row.dispatchHold),
    targetWorkItemId: typeof row.forcedWorkItemId === 'string' ? row.forcedWorkItemId
      : typeof decision?.selectedWorkItemId === 'string' ? decision.selectedWorkItemId : null }
}
export function normalizeCorrectionRoutes(value: unknown, sessionId: string, sourceEventId: string) {
  return array(object(value).items).map(row => normalizeCorrectionRoute(row, sessionId, sourceEventId))
}
export function normalizeCorrectionReceipt(value: unknown, routingId: string): CorrectionReceipt {
  const row = object(value)
  if (row.routingId !== routingId) throw new Error('纠错回执与原消息不匹配，请刷新核对。')
  return { correctionId: string(row.correctionId), routingId, pendingIntentRevision: positive(row.pendingIntentRevision),
    routingRevision: positive(row.routingRevision), correctionStatus: status(row.correctionStatus) }
}
export function normalizeCorrectionHistory(value: unknown, sessionId: string, routingId: string): CorrectionSummary[] {
  return array(object(value).corrections).map(value => {
    const row = object(value), request = object(row.request)
    if (row.sessionId !== sessionId || row.routingId !== routingId) throw new Error('纠错记录与原消息不匹配。')
    const updatedAt = string(row.updatedAt)
    if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('纠错记录时间异常。')
    return { id: string(row.id), status: status(row.status), instruction: string(request.instruction),
      idempotencyKey: string(row.idempotencyKey), revision: positive(row.pendingIntentRevision),
      routingRevision: positive(row.routingRevision), updatedAt,
      failureClass: typeof row.failureClass === 'string' ? row.failureClass : undefined,
      superseded: typeof row.supersededByCorrectionId === 'string' }
  }).sort((a, b) => b.revision - a.revision)
}
export function normalizeCorrectionTargets(works: unknown, decisions: unknown, sessionId: string) {
  const workItems: CorrectionWork[] = array(object(works).items).map(value => {
    const row = object(value)
    if (row.sessionId !== sessionId) throw new Error('任务与会话不匹配。')
    return { id: string(row.id), title: string(row.title), inheritedDecisionIds: array(row.inheritedDecisionIds).map(string) }
  })
  const records: CorrectionDecision[] = array(object(decisions).items).flatMap(value => {
    const row = object(value)
    if (row.sessionId !== sessionId) throw new Error('约束与会话不匹配。')
    if (row.status !== 'confirmed') return []
    return [{ id: string(row.id), workItemId: string(row.workItemId), content: string(row.content), revision: positive(row.revision),
      overridesDecisionId: typeof row.overridesDecisionId === 'string' ? row.overridesDecisionId : undefined }]
  })
  return { workItems, decisions: records }
}
export function decisionsForCorrection(work: CorrectionWork | undefined, decisions: CorrectionDecision[]) {
  if (!work) return []
  const overridden = new Set(decisions.filter(row => row.workItemId === work.id).map(row => row.overridesDecisionId))
  return decisions.filter(row => !overridden.has(row.id) &&
    (row.workItemId === work.id || work.inheritedDecisionIds.includes(row.id)))
}
export function correctionIsProcessing(value: IntentCorrectionStatus | undefined) {
  return value !== undefined && ['accepted', 'waiting_for_stop', 'validating'].includes(value)
}
export function correctionStatusCopy(value: IntentCorrectionStatus, failureClass?: string) {
  if (value === 'rejected' && ['auth', 'config'].includes(failureClass ?? '')) {
    return '模型连接或配置异常，尚未生效；旧执行仍被阻止。请修复连接后重新提交。'
  }
  return {
    accepted: '已受理，尚未生效。', waiting_for_stop: '正在停止受影响的旧执行，尚未生效。',
    validating: '正在核对新的理解和约束，尚未生效。',
    clarification_required: '需要进一步说明，请补充纠正内容后重新提交。旧执行仍被阻止。',
    applied: '纠错已生效。暂停的会话仍需单独恢复。',
    reconciliation_required: '需要核对已发生的执行效果。旧执行仍被阻止，请先完成对账。',
    rejected: '纠错未生效，旧执行仍被阻止。请核对目标与内容后重新提交。'
  }[value]
}
export type BoundCorrectionRequest = { sessionId: string; routingId: string; payload: CorrectIntentRoutingInput }
