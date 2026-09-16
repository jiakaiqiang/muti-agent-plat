# Event Contract v0.1

主 Agent 协作的生命周期、讨论/确认事件边界见 [阶段 0 冻结合同](./main-agent-collaboration-contract-v1.md)。本阶段不新增线上事件类型；后续必须携带归属/代次/版本并经 outbox 提交，不能以文案推断授权。

## 1. 目标

协作事件是系统事实源。群聊视图、协作流转图、工作流视图、Agent 状态卡片、测试回放都基于事件流渲染。

本契约定义 v0.1 最小事件结构、事件类型、payload、metadata 和前端渲染规则。

## 2. 基础结构

执行可靠性事件补充（2026-09-14）：Runtime 原始事件 metadata 在 CollaborationEvent 中通过 `metadata.payload` 展示。适用事件可携带 operationId、runtimeInvocationId、policyVersion、activityKind 和 remainingMs；activityKind 区分 transport/model/tool/submission/diagnostic，心跳只代表传输存活。相同 toolCallId 的提交错误不重复消耗额度；调用结果和已流出的事件去重。

- `runtime_progress` 的 `code=RUNTIME_PROVIDER_RETRY_SCHEDULED` 表示等待有界重试；`SUBMISSION_REPAIR_STARTED` 表示候选已保存并开始格式修复，不表示再开发。
- `EXECUTION_CANDIDATE_UNAVAILABLE` 明示候选缺失/失效与节点重试边界。安全修复不支持或额度耗尽返回非重试错误 `operationFailure=OPERATION_SUBMISSION_REPAIR_BLOCKED`，保留候选。
- `runtime_failed` 可携带 runtimeError、stopState。`unconfirmed` 表示尚未确认停止，不能渲染成已结束；可信迟到回执产生 `RUNTIME_STOP_CONFIRMED`，只有其他调用也已确认时才清除会话等待提示。迟到结果不能生成任务成功、产物写回或最终交付。
- Runtime 调用日志的 operationTelemetry 记录耗时及未知量，不要求每条协作事件重复全部指标。无法获取的上游队列、计费量保持 null；不在用户事件中暴露凭据、原始 Provider 响应或候选源码。

群聊运行反馈补充（2026-09-14）：`runtime_progress.payload.code=RUNTIME_HEARTBEAT` 为平台等待心跳，不是有效执行进展。`tool_completed.payload.isError=true` 必须显示异常，不能因后续心跳被清除；按 runtimeInvocationId 隔离纠正状态。StructuredOutput 类型校验可携带 `validationErrors: string[]`，最多 30 项受限字段错误，独立于 200 字 outputPreview；不包含原始提示词、字段值或凭据。历史事件缺少此字段时保持原摘要展示。

```ts
type CollaborationEvent = {
  id: string
  sessionId: string
  type: CollaborationEventType
  userMessageIntent?: UserMessageIntent
  priority?: EventPriority
  fromAgentId?: string
  toAgentIds: string[]
  taskId?: string
  content: string
  metadata: EventMetadata
  createdAt: string
}
```

## 3. 通用枚举

```ts
type EventPriority = 'low' | 'normal' | 'high' | 'critical'

type UserMessageIntent =
  | 'clarification'
  | 'constraint'
  | 'command'
  | 'question'
  | 'correction'
  | 'knowledge_input'
  | 'preference_input'
```

## 4. 事件类型

```ts
type CollaborationEventType =
  | 'user_message'
  | 'agent_message'
  | 'agent_mention'
  | 'session_status_changed'
  | 'agent_status_changed'
  | 'brief_created'
  | 'brief_updated'
  | 'brief_confirmed'
  | 'brief_rejected'
  | 'user_confirmation_requested'
  | 'user_confirmation_resolved'
  | 'task_created'
  | 'task_assigned'
  | 'task_accepted'
  | 'task_claimed'
  | 'task_blocked'
  | 'task_reassigned'
  | 'task_started'
  | 'task_waiting'
  | 'task_completed'
  | 'task_failed'
  | 'task_rejected'
  | 'task_reworked'
  | 'runtime_started'
  | 'runtime_progress'
  | 'runtime_completed'
  | 'runtime_failed'
  | 'tool_called'
  | 'tool_completed'
  | 'tool_failed'
  | 'rag_retrieved'
  | 'memory_used'
  | 'artifact_created'
  | 'post_review_started'
  | 'post_review_completed'
  | 'final_delivery_created'
  | 'error_reported'
```

## 5. Metadata 基础结构

```ts
type EventMetadata = {
  schemaVersion: '0.1'
  idempotencyKey?: string
  renderAs?: EventRenderType
  title?: string
  summary?: string
  payload?: Record<string, unknown>
}

type EventRenderType =
  | 'chat_message'
  | 'system_notice'
  | 'task_card'
  | 'brief_card'
  | 'confirmation_card'
  | 'tool_card'
  | 'rag_card'
  | 'artifact_card'
  | 'review_card'
  | 'delivery_card'
  | 'error_card'
```

## 6. 核心事件 Payload

### 6.1 user_message

```ts
type UserMessagePayload = {
  text: string
  attachments?: AttachmentRef[]
  mentionedAgentIds?: string[]
}
```

规则：

- 必须写入事件流后再路由。
- 如果识别出意图，`userMessageIntent` 必填。
- 执行中用户插话如果影响任务契约，`priority` 至少为 `high`。

### 6.2 agent_message

```ts
type AgentMessagePayload = {
  messageKind:
    | 'discussion'
    | 'answer'
    | 'handoff'
    | 'progress'
    | 'risk'
    | 'decision'
    | 'summary'
  mentionedAgentIds?: string[]
  mentionedUser?: boolean
  relatedArtifactIds?: string[]
}
```

规则：

- 群聊视图默认按普通消息展示。
- 如果 `mentionedAgentIds` 非空，协作流转图生成从 `fromAgentId` 到 `toAgentIds` 的信息流边。

### 6.3 brief_created / brief_updated

```ts
type BriefEventPayload = {
  briefId: string
  version: number
  goal: string
  scope: string[]
  outOfScope: string[]
  constraints: string[]
  acceptanceCriteria: string[]
  risks: string[]
  openQuestions: string[]
  requiresUserConfirmation: boolean
}
```

前端渲染：

- `renderAs = 'brief_card'`。
- 如果 `requiresUserConfirmation = true`，同时展示“确认执行”“继续沟通”操作。

### 6.4 user_confirmation_requested

```ts
type ConfirmationRequestedPayload = {
  confirmationId: string
  reason:
    | 'confirm_task_brief'
    | 'approve_high_risk_capability'
    | 'resolve_contract_conflict'
    | 'continue_after_budget_warning'
    | 'confirm_workflow_human_gate'
    | 'workflow_agent_substitution'
    | 'workflow_upstream_rerun'
  title: string
  description: string
  options: ConfirmationOption[]
}

type ConfirmationOption = {
  key: string
  label: string
  style?: 'primary' | 'default' | 'danger'
}
```

### 6.5 task_created / task_assigned / task_accepted / task_started / task_completed / task_failed / task_rejected

```ts
type TaskEventPayload = {
  taskId: string
  title: string
  description?: string
  status: AgentTaskStatus
  assignedBy?: ActorRef
  assignee?: ActorRef
  routingMode?: 'coordinator_controlled' | 'agent_suggested' | 'agent_delegated'
  autoResolutionAttempted?: boolean
  assignmentReason?: string
  contextRequirements?: string[]
  verificationPlan?: string[]
  riskNotes?: string[]
  requiresUserConfirmation?: boolean
  dependsOnTaskIds?: string[]
  acceptanceCriteria?: string[]
  resultSummary?: string
  missingContext?: string[]
  handoffSuggestion?: {
    targetAgentKey?: string
    targetAgentId?: string
    reason: string
    missingContext?: string[]
    riskLevel?: 'low' | 'medium' | 'high'
  } | null
}
```

Coordinator 中心流转规则：

- `task_assigned` 表示 Coordinator 已将任务分配给 `assignee` 指向的 Actor。
- v1 目标语义中，`task_accepted` 表示子 Agent 已接受被分配任务。
- 现有 `task_claimed` 保留兼容，但必须解释为“已接受”，不得解释为子 Agent 自由竞争接活。
- `task_blocked` 表示子 Agent 无法继续，等待 Coordinator 补上下文、改派或请求用户决策。
- `task_reassigned` 必须由 Coordinator 写入；子 Agent 只能通过 `agent_message.metadata.payload.handoffSuggestion` 提出建议。
- 当 Coordinator 已在任务规划阶段确定分配理由、上下文需求、验证方式或风险提示时，应通过 `assignmentReason/contextRequirements/verificationPlan/riskNotes/requiresUserConfirmation` 同步到任务事件 payload，供 UI 解释“为什么这样分配、执行前还缺什么、如何验证、是否要先问用户”。

任务未完成事件必须按阶段分离：

| 事件 | 唯一语义 | Task 状态 | 允许的伴随事件 |
| --- | --- | --- | --- |
| `task_blocked` | 接单阶段缺少必要上下文 | `blocked` | 可进入上下文补充或显式用户决策 |
| `task_rejected` | 接单阶段能力、职责或政策不匹配 | `blocked` | Workflow 场景进入 `workflow_agent_substitution` |
| `task_waiting` | 执行阶段等待上下文、能力授权或外部恢复 | `waiting` | 可与可恢复的 Runtime/能力等待事实关联 |
| `task_failed` | 接单成功后的执行失败 | `failed` | 与同一 invocation 的 `runtime_failed` 关联 |

`task_failed` 不得发送为 `task_rejected`；`task_rejected` 也不得用来表达质量工程师发现了可修复缺陷。机器人质量结果通过 `workflow_gate_decided` 表达，其中 `revise` 进入返工，`reject` 终止 Workflow。

### 6.6 agent_status_changed

```ts
type AgentStatusChangedPayload = {
  agentId: string
  status: AgentStatus
  currentTaskId?: string
  currentTaskTitle?: string
  thoughtSummary?: string
  actionSummary?: string
  waitingFor?: string[]
  activeCapabilityIds?: string[]
  usedKnowledgeBaseIds?: string[]
}
```

### 6.7 runtime_started / runtime_progress / runtime_completed / runtime_failed

```ts
type RuntimeEventPayload = {
  runtimeInvocationId: string
  runtimeType: RuntimeType
  agentId: string
  taskId?: string
  status: RuntimeInvocationStatus
  progressMessage?: string
  tokenInput?: number
  tokenOutput?: number
  cost?: number
  error?: RuntimeError
  requestedContext?: RuntimeContextRequest
}
```

Runtime adapter 内部事件额外带有产品可见性：

```ts
type AgentRuntimeEvent = {
  invocationId: string
  type: 'runtime_progress' | 'tool_called' | 'tool_completed' | /* terminal events */ string
  content: string
  visibility: 'user' | 'debug'
  metadata?: Record<string, unknown>
  createdAt: string
}
```

Provider 原始通知必须先分类，再决定是否生成协作事件：

| 分类 | 例子 | 处理 |
| --- | --- | --- |
| Provider 输出增量 | `item/agentMessage/delta` | 标记为 `debug`，不得生成协作事件或进入用户时间线 |
| 工具事件 | `item/started`、`item/completed` | 生成 `tool_called/tool_completed` |
| 最终结果/usage | `turn/completed`、`thread/tokenUsage/updated` | 结果解析或 usage 聚合，不显示 method 名 |
| Debug only | `thread/started`、Remote Control、成功的 MCP 启动、未知 method | 仅写入 invocation diagnostics |
| Runtime error | MCP 启动失败、已确认的 Provider/CLI 失败 | 生成结构化 `RuntimeError` |

`visibility` 是必填字段。默认分类是 Debug only；只有明确分类为用户业务语义的事件才能使用 `user`。后端不得把 `visibility='debug'`、`metadata.code='STREAM_TEXT'`、`STREAM_SYSTEM` 或 `STREAM_STDERR` 持久化为聊天事件；Web 时间线必须再次过滤这些值。原始通知与未知通知计数仍可通过 Debug Runtime 视图追踪。

When `error.code='CONTEXT_INSUFFICIENT'`, `runtime_failed` should render as a visible waiting/blocking card and include the same `requestedContext` on the payload for debug and retry planning.

For real coding runtimes, `runtime_started` must be emitted only after `cap-file-write` preflight passes. If the preflight blocks `codex` or `claude_code`, emit `task_waiting` with `relatedCapabilityId='cap-file-write'`; no `runtime_started` event should be created for that blocked invocation.

### 6.8 tool_called / tool_completed / tool_failed

```ts
type ToolEventPayload = {
  invocationId: string
  capabilityId: string
  capabilityName: string
  riskLevel: CapabilityRiskLevel
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked'
  inputSummary?: string
  outputSummary?: string
  requiresUserConfirmation?: boolean
  error?: string
}
```

### 6.9 rag_retrieved

```ts
type RagRetrievedPayload = {
  retrievalLogId: string
  agentId: string
  query: string
  matchedChunks: RagMatchedChunk[]
}

type RagMatchedChunk = {
  chunkId: string
  knowledgeBaseId: string
  documentId: string
  title: string
  snippet: string
  score: number
}
```

### 6.10 artifact_created

```ts
type ArtifactEventPayload = {
  artifactId: string
  type: ArtifactType
  title: string
  contentSummary?: string
  runtimeProposals?: RuntimeArtifactProposal[]
  platformProjections?: RuntimeFileChange[]
  systemEvidence?: RuntimeArtifactSystemEvidence | null
}
```

事件 payload 不再使用顶层 `fileChanges`。`platformProjections` 表示平台生成、待写入的文件；只有 `systemEvidence.workspaceChangeSet` 能标记为平台观测变更并进入 diff 证据。

### 6.11 final_delivery_created

```ts
type FinalDeliveryPayload = {
  deliveryId: string
  summary: string
  completedItems: string[]
  incompleteItems: string[]
  outOfScopeChanges: string[]
  testResults: string[]
  risks: string[]
  artifactIds: string[]
  report?: {
    artifactId: string
    title: string
    format: 'markdown'
    content: string
    suggestedPath: string
    requiresUserConfirmation: true
  }
}
```

架构分析交付存在 `report` 时：

- 群聊必须展示完整 `content`，不能只显示 `summary`。
- 后端必须发出 `reason=confirm_local_report_save` 的确认卡。
- `save_local` 之前不得写入 `suggestedPath`。
- 同一时刻只保留该保存确认，不再并行创建飞书发送确认。

## 7. 工作流运行事件

工作流运行时新增以下事实事件，所有事件的 `metadata.payload` 至少携带可用的 `workflowId`、`workflowVersion`、`workflowRunId`；节点事件还携带 `workflowNodeId` 和 `workflowNodeRunId`：

```text
workflow_published
workflow_run_started
workflow_node_started
workflow_node_completed
workflow_gate_requested
workflow_gate_decided
workflow_node_revision_requested
workflow_run_completed
workflow_run_failed
workflow_run_cancelled
```

人工确认继续使用通用 `user_confirmation_requested/resolved`，其中 `reason=confirm_workflow_human_gate`。请求载荷必须包含 `confirmationId`、`workflowRunId`、`workflowNodeRunId` 和 `expectedRunRevision`；机器人确认的决策、原因和证据引用写入 `workflow_gate_decided`，不暴露隐藏推理过程。

Agent 接单拒绝的确认请求使用 `reason=workflow_agent_substitution`，至少携带 `confirmationId/workflowRunId/workflowNodeId/workflowNodeRunId/relatedTaskId/candidateAgentIds`。同一 `workflowRunId + relatedTaskId` 使用固定幂等键；服务重启不得创建第二张 active confirmation。上游输入不足的确认请求使用 `reason=workflow_upstream_rerun`，并携带停车节点、合法上游候选和当前重试选项。

`workflow_gate_decided` 的 `revise` 以及 `workflow_node_revision_requested` 必须携带来源节点、目标节点、attempt 和修改说明；后续 Agent 与质量节点均创建新 attempt。`reject` 必须紧接 `workflow_run_failed`，不得产生上游返工 attempt。非法机器人结果和超限只生成一张人工确认请求。

## 8. SSE 推送格式

```text
event: collaboration-event
id: <eventId>
data: <CollaborationEvent JSON>
```

心跳：

```text
event: heartbeat
data: {"time":"2026-05-27T00:00:00.000Z"}
```

心跳是传输层帧，没有 `id`，不写入事件存储，不推进客户端服务端游标，并跳过请求级持久化提交。默认每 15 秒发送；客户端连续 45 秒未收到任何业务事件或心跳时，应主动关闭半开连接并进入重连。

重连规则：

- 前端只保存最后一个已提交的服务端 `event.id`，`evt-local-*` 等乐观事件不得成为游标。
- 重连时先记录该游标并打开 SSE，将新到业务事件暂存到缓冲区；随后请求 `GET /api/sessions/:sessionId/events?afterEventId=<id>` 补齐缺失事件。
- 补偿成功后按 REST 返回顺序追加缓冲区到达顺序，以服务端事件 `id` 去重后原子提交；补偿失败时连接仍处于 `reconnecting` 或 `degraded`，不得宣告 `connected`。
- SSE 断开和恢复不得触发 Session 中断，也不得自动重放任何 REST 写操作。

## 9. 前端渲染规则

- `user_message` 渲染为用户气泡。
- `agent_message` 渲染为 Agent 气泡。
- `brief_created` 和 `brief_updated` 渲染为任务契约卡片。
- `user_confirmation_requested` 渲染为确认卡片。
- `task_*` 渲染为任务状态卡片，同时更新工作流视图。
- `agent_status_changed` 不一定进入聊天主流，但必须更新右侧 Agent 卡片。
- `rag_retrieved` 默认折叠展示，Agent 卡片展示摘要。
- `tool_*` 渲染为工具调用卡片。
- `final_delivery_created` 渲染为最终交付卡片。
- `phase=user_message_routing` 的 `runtime_*` 仅用于 Receiver Runtime 的 Debug/Audit，不进入协作事件 REST/SSE，也不渲染到聊天时间线。

## 10. 校验规则

- 所有事件必须有 `id`、`sessionId`、`type`、`content`、`metadata.schemaVersion`、`createdAt`。
- Agent 发出的事件必须有 `fromAgentId`。
- @ 事件必须有 `toAgentIds`。
- 任务事件必须有 `taskId` 或 `metadata.payload.taskId`。
- 高风险工具事件必须包含 `requiresUserConfirmation`。
- `createdAt` 使用 ISO 8601。

## 11. ActorRef 合约

`ActorRef` 是事件与任务中表达“谁发起、谁负责、谁分配”的权威结构。任务分配字段已经硬切，不双写、不回填，也不读取旧的 Agent id 字段。

### 11.1 类型

```ts
type ActorType = 'user' | 'agent' | 'system'

type ActorRef = {
  type: ActorType
  id: string
  displayName?: string
}
```

### 11.2 事件结构

```ts
type CollaborationEvent = {
  // ...其他字段
  actor?: ActorRef
}
```

事件展示只消费 `actor`；缺失时按系统事件处理，不从旧字段恢复 Agent 身份。

### 11.3 任务结构

```ts
type AgentTask = {
  // ...其他字段
  assignee?: ActorRef
  assignedBy?: ActorRef
}
```

### 11.4 推导规则

`events.create` 内部依据下列规则推导并落盘 `actor`：

| 事件场景 | actor.type | actor.id 来源 |
| --- | --- | --- |
| 用户消息 | `user` | 会话用户 id |
| Agent 输出 | `agent` | `fromAgentId` |
| Coordinator 分派/改派/取消 | `agent` | 会话 Coordinator agent id |
| 系统/编排器自身事件（heartbeat、status 切换） | `system` | 固定 `system` |
| Runtime 侧事件（有 `fromAgentId`） | `agent` | 关联 agent id |
| Runtime 侧事件（无 `fromAgentId`） | `system` | 固定 `system` |

任务的 `assignee` / `assignedBy` 由 Orchestrator 在分派/接受路径上填入。持久化和 API 只接受 `ActorRef` 字段。

### 11.5 前端契约

- 前端时间线组件只读取 `actor`。
- 任务视图只读取 `assignee` 和 `assignedBy`。
- 展示名优先取 `actor.displayName`，否则由前端根据 `actor.type` + id 查会话 agent 名字兜底。

### 11.6 硬切约束

- 旧任务 Agent id 字段是非法输入，不能通过 Mapper、默认值或数据回填恢复。
- 新 data epoch 不加载旧任务数据。
- Harness 必须阻止旧任务字段重新进入 Shared、Server、Web、E2E 和活动合同文档。

### 11.7 变更日志

- 2026-07-16：任务 Actor 合约硬切为 `assignee` / `assignedBy`，删除旧字段双写、回填和前端回退规范。

### 11.8 Runtime 恢复审计事件

CLI Resume 失败或 session id 不一致并触发单次 fresh-session fallback 时，必须写入：

```ts
{
  type: 'runtime_progress',
  metadata: {
    code: 'RESUME_FALLBACK',
    runtimeType: 'codex' | 'claude_code',
    priorCliSessionId?: string
  }
}
```

该事件只表达恢复路径切换，不等于运行失败；最终状态仍由后续 `runtime_completed/runtime_failed` 决定。

## 12. 用户原文件修订事件

```ts
type FileRevisionEventType =
  | 'file_revision_baseline_captured'
  | 'file_revision_chain_created'
  | 'file_revision_iteration_submitted'
  | 'file_revision_dispatched'
  | 'file_revision_agent_completed'
  | 'file_revision_synthesis_started'
  | 'file_revision_candidate_generated'
  | 'file_revision_draft_saved'
  | 'file_revision_candidate_superseded'
  | 'file_revision_failure_decision_requested'
  | 'file_revision_failure_resolved'
  | 'file_revision_apply_started'
  | 'file_revision_applied'
  | 'file_revision_stale'
  | 'file_revision_failed'
```

事件 payload 只允许保存 `baselineId/chainId/revisionId/parentRevisionId/iteration/filePath`、Hash、Agent/Task/Invocation ID、状态和统计；不得内联基线、用户稿、草稿、完整 Diff、Agent 提案或 Receiver 候选正文，也不得公开 Content Reference。文件修订 Agent 的通用 `artifact_created` 事件只发布 Artifact 身份、类型和标题，不发布 `contentSummary`，也不得附带 `runtimeProposals/systemEvidence/workspaceExecution`；任务、Runtime 和失败事件不得发布内部 Prompt、验收条件、模型摘要、风险、handoff 或 Provider 原始错误。非文件修订事件维持原合同。`file_revision_candidate_generated` 之后发出 `reason='confirm_file_revision_apply'` 的确认卡，payload 必须携带 `confirmationId/revisionId/chainId/iteration/candidateHash/stateVersion`。只有这些字段与当前链头全部匹配的用户决策可以应用或放弃候选。

草稿保存只产生 `file_revision_draft_saved`，不产生任务派发事件。提交下一轮时先产生 `file_revision_candidate_superseded` 和 `file_revision_iteration_submitted`；SSE 重连只补读这些事实，客户端不得据此重放 mutation。

当部分 Agent 失败时，服务端在保存全部 Agent 终态后产生 `file_revision_failure_decision_requested`，payload 只包含成功/失败数量、允许的决策和版本标识。用户选择 `retry_agents/continue_with_successful/abandon_revision` 后产生一次 `file_revision_failure_resolved`；前两种决策分别重新派发目标 Agent 或仅派发 Receiver，放弃决策不再派发。SSE 回补这些事件不得自动重放决策。

进程重启产生的 `interrupted` 状态不会自动派发。用户调用显式重试接口后以 `retryKey` 去重产生一次 `file_revision_dispatched`，metadata 中的 `retryMode` 明确区分 `run_agents/receiver_only/apply_reconcile`；`apply_reconcile` 只发布对账结果，不得伪装成 Agent 重新处理。

## 13. Runtime 停止状态事件

停止聚合每次持久化推进生成一个 `type='runtime_progress'` 的 `CollaborationEvent`，其 `metadata.payload.code` 固定为 `RUNTIME_STOP_STATE_CHANGED`，`metadata.payload.stopSummary` 为该版本的完整 `RuntimeStopSummary`。事件、停止状态和 outbox 必须在同一事务内提交。

事件 ID 和聚合幂等键固定为 `runtime-stop:<stopRequestId>:<version>`；outbox 记录使用同一事件身份。相同回执、发布补偿或 ACK 前崩溃不得产生第二个相同版本事件。客户端按 `stopRequestId/version` 收敛，同轮旧版本不得覆盖新版本，新轮则以 `updatedAt` 判定先后。

该事件驱动实时停止摘要，不进入聊天时间线。历史兼容事件 `RUNTIME_STOP_CONFIRMED` 仍可显示，但只能折叠连续、同 invocation、同状态的通知，并保留次数与每条时间；业务消息、不同 invocation 或不同状态都会截断分组。
