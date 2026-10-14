import { expect, it } from 'vitest'
import { unknownRuntimeHealthCapabilities, type CollaborationEvent, type RuntimeHealthSnapshot } from '@agent-cluster/shared'
import { runtimeHealthDetails, runtimeHealthExplanation, runtimeMessages, runtimePhaseLabel, runtimeReasonLabel, runtimeTimeLabel } from './runtimeHealthPresentation'

const snapshot = (patch: Partial<RuntimeHealthSnapshot> = {}): RuntimeHealthSnapshot => ({
  schemaVersion: 1, policyVersion: 'request-health-v1', sessionId: 's', operationId: 'op', invocationId: 'call',
  sessionGeneration: 1, observerEpoch: 'epoch', version: 2, phase: 'discussion', agentId: 'agent', runtimeType: 'claude_code',
  stage: 'unknown_wait', health: 'unknown', reasonCode: 'no_observable_progress', capabilities: unknownRuntimeHealthCapabilities(),
  processStatus: 'unknown', requestStatus: 'unknown', startedAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:30Z',
  observationDue: true, canWait: true, canStop: true, ...patch
})
const event = (patch: Partial<CollaborationEvent> = {}): CollaborationEvent => ({
  id: 'event', sessionId: 's', type: 'tool_called', actor: { type: 'agent', id: 'agent', displayName: '工程师' },
  toAgentIds: [], content: '读取文件', createdAt: '2026-09-29T00:00:00Z',
  metadata: { schemaVersion: '0.1', payload: { phase: 'discussion' } }, ...patch
})

it('uses Chinese labels for unknown, unsupported, supported and request/process statuses', () => {
  const fields = runtimeHealthDetails(snapshot())
  expect(fields).toHaveLength(10)
  expect(fields.find(field => field.label === '运行程序状态')?.value).toBe('无法确认')
  expect(fields.find(field => field.label === '运行程序检测')?.value).toBe('当前不支持')
  expect(fields.find(field => field.label === '思考活动反馈')?.value).toBe('暂未确认')
  const supported = runtimeHealthDetails(snapshot({ processStatus: 'alive', requestStatus: 'receiving',
    capabilities: { ...unknownRuntimeHealthCapabilities(), reasoningEvents: 'supported' } }))
  expect(supported[0].value).toBe('程序仍在运行')
  expect(supported[1].value).toBe('正在接收响应')
  expect(supported[3].value).toBe('已支持')
  expect(runtimeHealthDetails(snapshot({ processStatus: 'exited', requestStatus: 'ended' }))[1].value).toBe('请求已结束')
  expect(JSON.stringify(fields)).not.toMatch(/unknown|unsupported/)
})

it('does not interpret missing reasoning feedback, a heartbeat or a failed probe as model activity/failure', () => {
  expect(runtimeHealthDetails(snapshot())[3].help).toContain('未收到提示不代表模型未工作')
  expect(runtimeReasonLabel('probe_timeout')).toContain('不是模型请求已超时')
  expect(runtimeReasonLabel('transport_alive')).toContain('不代表模型正在思考')
  expect(runtimeReasonLabel('new_reason_code')).not.toContain('new_reason_code')
  expect(runtimePhaseLabel('new_phase')).toBe('其他处理阶段')
  expect(runtimeTimeLabel('invalid')).toBe('暂无记录')
})

it('deduplicates replayed event IDs and snapshot versions without dropping individual messages', () => {
  const health = event({ id: 'health', type: 'runtime_progress', metadata: {
    schemaVersion: '0.1', payload: { code: 'RUNTIME_REQUEST_HEALTH_CHANGED', healthSnapshot: snapshot() }
  } })
  const records = runtimeMessages('s', [event(), event(), health], [snapshot()])
  expect(records).toHaveLength(2)
  expect(records.some(record => record.content === '读取文件')).toBe(true)
  expect(records.some(record => record.content.includes('原调用仍保留'))).toBe(true)
})

it('keeps sessions isolated and omits malformed, hidden reasoning and raw debug notifications', () => {
  const withPayload = (payload: Record<string, unknown>) => event({ metadata: { schemaVersion: '0.1', payload } })
  for (const value of [event({ sessionId: 'other' }), event({ type: 'user_message' }),
    withPayload({ visibility: 'debug' }), withPayload({ internal: true }), withPayload({ type: 'thinking' }),
    withPayload({ method: 'item/reasoning/delta' }), withPayload({ code: 'RUNTIME_REQUEST_HEALTH_CHANGED', healthSnapshot: {} }),
    event({ type: 'runtime_progress', metadata: { schemaVersion: '0.1', payload: { code: 'STREAM_STDERR' } } })]) {
    expect(runtimeMessages('s', [value], [])).toEqual([])
  }
  expect(runtimeMessages('s', [], [snapshot({ sessionId: 'other' })])).toEqual([])
})

it('redacts credentials and local paths without rendering metadata or tool arguments', () => {
  const records = runtimeMessages('s', [event({ content: 'Bearer secret-secret sk-abcdef123 API_KEY=supersecret C:\\Users\\private\\file.txt',
    metadata: { schemaVersion: '0.1', payload: { input: { password: 'hidden', thinking: 'never show' } } } })], [])
  expect(records[0].content).toContain('凭据已隐藏')
  expect(records[0].content).toContain('本地路径已隐藏')
  expect(JSON.stringify(records)).not.toMatch(/secret-secret|abcdef123|supersecret|never show|private/)
})

it('shows text literally and marks heartbeats as observation only', () => {
  expect(runtimeMessages('s', [event({ content: '<script>alert(1)</script>' })], [])[0].content).toContain('<script>')
  const records = runtimeMessages('s', [event({ type: 'runtime_progress', metadata: { schemaVersion: '0.1', payload: { code: 'RUNTIME_HEARTBEAT' } } })], [])
  expect(records[0].title).toBe('连接心跳')
  expect(records[0].content).toContain('不代表模型仍在思考')
})

it('explains known upstream faults and fallback without claiming Runtime crashed or exposing raw errors', () => {
  const fault = snapshot({ stage: 'retrying', health: 'abnormal', reasonCode: 'provider_retry', canWait: false,
    failure: { code: 'rate_limit', httpStatus: 429, retryAttempt: 7 }, failureAt: '2026-09-29T00:02:00Z' })
  expect(runtimeHealthExplanation(fault)).toContain('模型服务限流（429）')
  expect(runtimeHealthExplanation(fault)).toContain('第 7 次重试记录')
  expect(runtimeHealthDetails(fault).find(field => field.label === '最近异常时间')?.value).toMatch(/^2026年09月29日 /)
  expect(runtimeMessages('s', [], [fault])[0].title).toContain('模型服务限流')
  expect(runtimeMessages('s', [], [fault])[0].content).not.toContain('Runtime 异常')
  const stopping = { ...fault, stage: 'stopping' as const, budgetFallbackReason: 'provider_or_tool_error' as const }
  expect(runtimeHealthExplanation(stopping)).toContain('确认结束前不会重跑')
  expect(runtimeHealthExplanation({ ...stopping, stage: 'terminal' })).toContain('已确认结束')
  expect(runtimeHealthExplanation({ ...fault, stage: 'terminal', reasonCode: 'terminal_received' })).toBe('本次调用已结束。')
  expect(runtimeHealthExplanation(snapshot({ reasonCode: 'output_contract_error' }))).toContain('不是模型连接故障')
})
