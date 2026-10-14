import {
  normalizeRuntimeHealthSnapshot, runtimeHealthLabel, shouldPublishRuntimeEventToCollaboration,
  type CollaborationEvent, type RuntimeHealthCapability, type RuntimeHealthSnapshot
} from '@agent-cluster/shared'
import { formatDateTime } from './dateTime'

export const runtimePhaseLabel = (phase: string) => ({
  discussion: '群聊讨论', brief_generation: '生成任务方案', brief_revision: '修改任务方案',
  task_brief: '生成任务方案', task_execution: '执行任务', post_review: '检查执行结果',
  final_delivery: '整理交付结果', workspace_analysis: '分析工作目录', user_message_routing: '理解用户消息',
  task_acceptance_decision: '确认任务接单', task_acceptance_blocked: '等待接单条件',
  task_claim_declined: '拒绝接单', agent_runtime_communication: '智能体通信'
}[phase] ?? '其他处理阶段')

export function runtimeTimeLabel(value?: string) {
  return formatDateTime(value, '暂无记录')
}

const capabilityLabel = (value: RuntimeHealthCapability) => ({
  supported: '已支持', unsupported: '当前不支持', unknown: '暂未确认'
}[value])

export type RuntimeHealthDetail = { label: string; value: string; help: string }
export function runtimeHealthDetails(item: RuntimeHealthSnapshot): RuntimeHealthDetail[] {
  const capability = (label: string, value: RuntimeHealthCapability, help: string): RuntimeHealthDetail => ({
    label, value: capabilityLabel(value), help: value === 'unsupported'
      ? `${help}当前运行环境未提供此能力，不代表调用失败。`
      : value === 'unknown' ? `${help}尚未确认是否支持，不能据此判断模型卡住。` : help
  })
  return [
    { label: '运行程序状态', value: { alive: '程序仍在运行', exited: '程序已退出', unknown: '无法确认' }[item.processStatus],
      help: '指执行模型调用的本地或服务端程序。程序存活不等于模型正在思考。' },
    { label: '模型请求状态', value: { pending: '请求已发出，等待响应', receiving: '正在接收响应', ended: '请求已结束', unknown: '无法确认' }[item.requestStatus],
      help: '描述当前请求的响应情况；无法确认时保留原调用，不自动重发。' },
    capability('执行进展反馈', item.capabilities.progressEvents, '接收模型输出、工具执行等进展消息。'),
    capability('思考活动反馈', item.capabilities.reasoningEvents, '只记录是否收到思考活动提示，不展示思考内容；未收到提示不代表模型未工作。'),
    capability('运行程序检测', item.capabilities.processProbe, '检查运行程序是否存活。'),
    capability('请求过程反馈', item.capabilities.requestLifecycle, '接收请求开始、响应与结束的状态。'),
    capability('模型服务状态查询', item.capabilities.providerRequestQuery, '向模型服务方查询该请求是否仍在处理。'),
    { label: '最近执行进展', value: runtimeTimeLabel(item.lastProgressAt), help: '最近一次输出或工具活动的时间；连接心跳不算执行进展。' },
    { label: '最近连接消息', value: runtimeTimeLabel(item.lastTransportAt), help: '仅表示观察通道收到连接消息，不证明模型仍在计算。' },
    { label: '最近程序检测', value: runtimeTimeLabel(item.lastProbeAt), help: '最近一次运行程序检测的时间，不是模型完成时间。' },
    ...(item.failure ? [
      { label: '异常说明', value: runtimeHealthExplanation(item), help: '明确异常与状态未知分别处理；只有匹配的真实恢复证据能解除异常。' },
      { label: '最近异常时间', value: runtimeTimeLabel(item.failureAt), help: '实际收到异常记录的时间；探测或心跳不会将其改成正常。' }
    ] : [])
  ]
}

export const runtimeReasonLabel = (reason: string) => ({
  request_pending: '正在等待模型返回响应。', request_started: '模型请求已开始。',
  request_acknowledged: '已收到请求受理反馈，正在等待后续响应。',
  no_observable_progress: '暂未收到新的执行进展，无法区分慢响应与卡住；原调用仍保留。',
  reasoning_progress: '已收到思考活动提示，仅记录活动，不展示思考内容。',
  text_progress: '正在接收模型输出。', tool_input_progress: '正在准备工具调用。',
  tool_started: '工具已开始执行。', tool_progress: '工具正在执行。', tool_completed: '工具执行已结束。',
  submission_accepted: '结果格式校验已通过，等待调用结束。', tool_error: '工具执行失败，尚未确认恢复。',
  output_contract_error: '结果格式不符合要求，等待已有纠正流程；这不是模型连接故障。',
  transport_alive: '收到连接消息；这不代表模型正在思考。',
  probe_timeout: '运行程序检测未及时返回，当前状态无法确认；不是模型请求已超时。',
  probe_unsupported: '当前运行环境不支持程序检测，无法通过此方式判断请求状态。',
  provider_retry: '已收到模型服务异常重试记录，尚未收到恢复进展。', provider_error: '模型服务返回异常，尚未确认恢复。',
  control_disconnected: '与运行环境的连接中断，正在核实调用状态。',
  stop_requested: '已发送停止请求，等待运行环境确认。', stop_unconfirmed: '尚未确认所有调用已停止。',
  terminal_received: '本次调用已结束。', process_exited: '执行本次调用的程序已退出。',
  historical_observation: '这是历史调用记录，无法用于判断当前模型状态。'
}[reason] ?? '已更新调用状态；没有足够信息说明具体原因。')

export function runtimeHealthExplanation(item: RuntimeHealthSnapshot) {
  if (item.budgetFallbackReason) return item.stage === 'terminal'
    ? '明确异常未恢复，原时间预算已耗尽，预算兜底已触发；本次调用已确认结束。'
    : '明确异常未恢复，原时间预算已耗尽，已请求停止调用；确认结束前不会重跑任务。';
  if (item.stage === 'terminal') return runtimeReasonLabel(item.reasonCode);
  if (item.reasonCode === 'output_contract_error') return '模型提交的结果格式不符合要求，正在等待已有纠正流程；这不是模型连接故障。';
  if (item.reasonCode === 'submission_accepted') return '结果格式校验已通过，等待调用结束。';
  if (!item.failure) return runtimeReasonLabel(item.reasonCode);
  const cause = {
    rate_limit: '模型服务限流', upstream_error: '模型服务请求失败', stream_interrupted: '模型响应连接提前中断',
    authentication: '模型服务认证失败', provider_error: '模型服务出现异常', tool_error: '工具执行失败',
    output_contract: '结果格式不符合要求', control_disconnected: '与 Runtime 的连接中断', process_exited: '运行程序已退出但尚未收到最终结果'
  }[item.failure.code];
  const status = item.failure.httpStatus === undefined ? '' : `（${item.failure.httpStatus}）`;
  const retry = item.failure.retryAttempt === undefined ? '' : ` 已收到第 ${item.failure.retryAttempt} 次重试记录。`;
  return `${cause}${status}，尚未确认恢复；心跳或程序存活不能清除异常。${retry}`;
}

export type RuntimeMessage = {
  id: string; createdAt: string; title: string; content: string; agentId?: string; agentName?: string;
  phase?: string; invocationId?: string; snapshot?: RuntimeHealthSnapshot
}

// Only display public messages, never stringify provider payloads, prompts or tool arguments.
function publicText(value: string) {
  return value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [凭据已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[凭据已隐藏]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[凭据已隐藏]')
    .replace(/[A-Z]:[\\/][^\s\n"'<>]+/gi, '[本地路径已隐藏]')
    .replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi, '[内部编号]')
}

export function runtimeMessages(sessionId: string, events: CollaborationEvent[], snapshots: RuntimeHealthSnapshot[]): RuntimeMessage[] {
  const messages = new Map<string, RuntimeMessage>()
  const represented = new Set<string>()
  const titles: Record<string, string> = {
    runtime_started: '开始调用模型', runtime_progress: '执行进展', runtime_completed: '模型调用已完成',
    runtime_failed: '模型调用异常', tool_called: '开始执行工具', tool_completed: '工具执行完成', tool_failed: '工具执行失败'
  }
  for (const event of events) {
    if (event.sessionId !== sessionId || messages.has(event.id)) continue
    const payload = event.metadata?.payload ?? {}
    if (payload.code === 'RUNTIME_REQUEST_HEALTH_CHANGED') {
      const snapshot = normalizeRuntimeHealthSnapshot(payload.healthSnapshot)
      if (!snapshot || snapshot.sessionId !== sessionId) continue
      represented.add(`${snapshot.invocationId}:${snapshot.version}`)
      messages.set(event.id, { id: event.id, createdAt: event.createdAt, title: runtimeHealthLabel(snapshot),
        content: runtimeHealthExplanation(snapshot), agentId: snapshot.agentId, phase: snapshot.phase,
        invocationId: snapshot.invocationId, snapshot })
      continue
    }
    if (!titles[event.type] || !shouldPublishRuntimeEventToCollaboration({ type: event.type,
      visibility: (event as CollaborationEvent & { visibility?: unknown }).visibility ?? payload.visibility, code: payload.code })) continue
    // Optional reasoning notifications are activity metadata, not user-visible model reasoning.
    if (payload.internal === true || /reasoning|thinking/i.test([payload.type, payload.kind, payload.method, payload.subtype].join(' '))) continue
    const heartbeat = payload.code === 'RUNTIME_HEARTBEAT'
    messages.set(event.id, {
      id: event.id, createdAt: event.createdAt, title: heartbeat ? '连接心跳' : titles[event.type],
      content: heartbeat ? '平台仍在观察此调用；心跳不代表模型仍在思考或输出。'
        : typeof event.content === 'string' && event.content.trim() ? publicText(event.content) : '暂无可展示的消息内容。',
      agentId: event.actor?.type === 'agent' ? event.actor.id : event.fromAgentId,
      agentName: event.actor?.type === 'agent' ? event.actor.displayName : undefined,
      phase: typeof payload.phase === 'string' ? payload.phase : undefined,
      invocationId: typeof payload.runtimeInvocationId === 'string' ? payload.runtimeInvocationId : undefined
    })
  }
  for (const snapshot of snapshots) {
    if (snapshot.sessionId !== sessionId || represented.has(`${snapshot.invocationId}:${snapshot.version}`)) continue
    const id = `snapshot:${snapshot.invocationId}:${snapshot.version}`
    messages.set(id, { id, createdAt: snapshot.updatedAt, title: runtimeHealthLabel(snapshot),
      content: runtimeHealthExplanation(snapshot), agentId: snapshot.agentId, phase: snapshot.phase,
      invocationId: snapshot.invocationId, snapshot })
  }
  return [...messages.values()].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
}
