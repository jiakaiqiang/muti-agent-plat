import type { CollaborationEvent, SessionStatus } from '@/types/contracts'

const activeStatuses = new Set<SessionStatus>([
  'AGENT_DISCUSSING', 'REVISING_BRIEF', 'EXECUTING', 'POST_REVIEW', 'REWORKING', 'APPLYING_CHANGES'
])
const activityTypes = new Set<CollaborationEvent['type']>([
  'runtime_started', 'runtime_progress', 'tool_called', 'tool_completed',
  'task_started', 'workflow_node_started', 'runtime_failed', 'error_reported',
  'runtime_completed', 'task_completed'
])

export type TaskActivity = { tone: 'running' | 'waiting' | 'warning'; text: string }

// A live server alone does not prove that this task is making progress.
export function taskActivity(input: {
  session?: { id: string; status: SessionStatus }
  events: CollaborationEvent[]
  connectedSessionId?: string
  connectionState: string
  unavailable: boolean
  now: number
}): TaskActivity | undefined {
  const { session } = input
  if (!session) return undefined
  const latestState = [...input.events].reverse().find(event => event.sessionId === session.id &&
    (event.metadata?.payload?.stopState || ['runtime_started', 'runtime_failed', 'runtime_completed'].includes(event.type)))
  const stopPayload = latestState?.metadata?.payload
  const stopError = stopPayload?.runtimeError as { details?: { stopUnconfirmed?: boolean } } | undefined
  if (!input.unavailable && input.connectedSessionId === session.id && input.connectionState === 'connected' &&
    (stopPayload?.stopState === 'unconfirmed' || stopError?.details?.stopUnconfirmed)) {
    return { tone: 'warning', text: '正在确认上一次执行是否停止，暂不能重新执行' }
  }
  if (!activeStatuses.has(session.status)) return undefined
  if (input.unavailable) return { tone: 'warning', text: '连接异常，暂时无法确认任务运行状态' }
  if (input.connectedSessionId !== session.id || input.connectionState !== 'connected') {
    return { tone: 'waiting', text: '正在连接，确认任务运行状态…' }
  }
  const relevant = input.events.filter(event => event.sessionId === session.id && activityTypes.has(event.type))
  const issues = new Map<string, { event: CollaborationEvent; submitting: boolean }>()
  const owners = new Map<string, string>()
  for (const event of relevant) {
    const payload = event.metadata?.payload ?? {}
    const invocationId = String(payload.runtimeInvocationId ?? event.fromAgentId ?? 'legacy')
    const owner = event.fromAgentId ?? invocationId
    if (event.type === 'runtime_started') {
      const previous = owners.get(owner)
      if (previous) issues.delete(previous)
      owners.set(owner, invocationId)
      issues.delete(invocationId)
    }
    if (event.type === 'tool_completed' && payload.isError === true) {
      issues.set(invocationId, { event, submitting: false })
    } else if (event.type === 'tool_called' && payload.name === 'StructuredOutput' && issues.has(invocationId)) {
      issues.set(invocationId, { event, submitting: true })
    } else if ((event.type === 'tool_completed' && payload.isError === false &&
        payload.name === issues.get(invocationId)?.event.metadata?.payload?.name) || event.type === 'runtime_completed') {
      issues.delete(invocationId)
    }
  }
  const issue = [...issues.values()].at(-1)
  // Server-generated keepalives cannot prove progress or clear a tool error.
  const latest = [...relevant].reverse().find(event => event.metadata?.payload?.code !== 'RUNTIME_HEARTBEAT')
  const payload = latest?.metadata?.payload ?? {}
  const runtimeError = payload.runtimeError as { details?: { stopUnconfirmed?: boolean; failureClass?: string } } | undefined
  if (runtimeError?.details?.stopUnconfirmed || payload.stopState === 'unconfirmed') {
    return { tone: 'warning', text: '正在确认上一次执行是否停止，暂不能重新执行' }
  }
  if (payload.code === 'RUNTIME_PROVIDER_RETRY_SCHEDULED') {
    return { tone: 'waiting', text: '模型连接暂时不可用，正在等待有限重试' }
  }
  if (payload.code === 'SUBMISSION_REPAIR_STARTED') return { tone: 'waiting', text: '已保存修改，正在修复结果提交格式' }
  if (latest?.type === 'runtime_failed' || latest?.type === 'error_reported') {
    return { tone: 'warning', text: '任务执行遇到异常，请查看群聊中的处理提示' }
  }
  if (issue) {
    const structured = issue.event.metadata?.payload?.name === 'StructuredOutput'
    const stale = input.now - Date.parse(issue.event.createdAt) > 90_000
    return { tone: 'warning', text: issue.submitting ? (stale ? '重新提交结果后暂未收到新的进度' : '正在重新提交结果') : structured
      ? `输出格式校验失败，${stale ? '暂未收到新的纠正进度' : '正在等待自动纠正'}`
      : '工具执行遇到异常，请查看群聊中的处理提示' }
  }
  const age = latest ? input.now - Date.parse(latest.createdAt) : Number.NaN
  if (!Number.isFinite(age) || age < -5000 || age > 90_000 ||
      latest?.type === 'runtime_completed' || latest?.type === 'task_completed') {
    return { tone: 'waiting', text: '正在等待新的执行进度，暂时无法确认任务状态' }
  }
  return { tone: 'running', text: '正在运行你的任务，请稍等' }
}
