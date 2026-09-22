# API Contract v0.1

主 Agent 协作扩展见 [阶段 0 冻结合同](./main-agent-collaboration-contract-v1.md)：当前 HTTP 行为不变，生命周期查询、可恢复删除/恢复等入口为后续阶段设计，不是已发布 API。

## 1. 目标

本契约定义 v1 开发所需的最小 REST API 和 SSE API。第一阶段不做多用户权限，但所有接口保留 `ownerId`、`workspaceId`、`projectId` 字段。

## 2. 通用约定

执行可靠性增量（2026-09-14）：`GET /api/runtimes/operations?sessionId=<id>` 返回标准成功封装中的 `data.items: LogicalOperation[]`；sessionId 缺失或空白返回 400，无记录返回空列表。接口只读，不续期、不重试、不解除停止屏障。字段与状态见 [数据合同 §1.3](data-contract-v0.1.md)。Web 与桌面共用服务端会话/事件/操作事实，不分别维护执行状态机；本次不新增用户认证。

Local Runtime WebSocket 可选停止确认协议见 [Runtime 合同 §14](runtime-contract-v0.1.md)：connected 的 stopReceiptProtocol=1、客户端 invocation.stopped、服务端 invocation.stop_ack。必须匹配注册设备及 invocation/workspace/runtime 绑定，不能将迟到回执作为完成任务的 API。未知停止时继续保留既有 pause/resume 冲突行为。

Local Runtime 自动恢复补充（2026-09-14）：`POST /api/local-runtime/device-tokens/resume` 请求为 `{ deviceId: string }`，返回 `LocalRuntimeTokenResponse`（与 refresh 相同）。沿用 `LocalRuntimeAdminGuard`，仅为当前所有者名下已登记且 active 的设备轮换令牌；未知、已撤销或其他所有者的设备返回 401；已有在线连接返回 409。不会创建设备、重新激活撤销设备、改变目录授权或恢复任务。开发启动器仅在同源本机回环地址、非生产且已有管理员授权的环境中自动调用；普通远程设备仍使用原登录流程。

群聊停止补充（2026-09-14）：`POST /sessions/:sessionId/pause` 保留历史与草稿，当前会话的消息意图识别也纳入取消范围。有待处理路由时允许从原等待确认状态暂停，恢复后保留该等待状态，不隐式批准契约或选择流程。请求发送取消不等同于成功；宽限期内未收到执行结束回执时返回 `SESSION_PAUSE_TIMEOUT`，允许重试停止。存在未确认停止时 `resume` 返回冲突，禁止重复启动。Web 与桌面共用上述端点。

Base URL：

```text
/api
```

时间格式：

```text
ISO 8601，例如 2026-05-27T14:30:00.000Z
```

通用响应：

```ts
type ApiResponse<T> = {
  data: T
  requestId: string
}
```

通用错误：

```ts
type ApiError = {
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
  requestId: string
}
```

分页响应：

```ts
type PageResponse<T> = {
  items: T[]
  nextCursor?: string
  hasMore: boolean
}
```

### 2.1 Health 与版本闸门

```text
GET /api/health
```

```ts
type OpsHealth = {
  status: 'ok'
  service: string
  version: string
  buildTime: string
  commit: string
  processId: number
  startedAt: string
  pipelineVersion: 'v2'
  dataSchemaVersion: 3
  dataEpoch: string
  persistenceBackend: 'file' | 'postgres'
  persistenceLocation: string
  maintenanceMode: boolean
  timestamp: string
}
```

`persistenceLocation` 不包含 PostgreSQL 凭据。pipeline/schema 不匹配，或前端配置的预期 commit 不匹配时，客户端不得继续列出、加载、创建或 resume Session。

运维维护接口：

```text
GET  /api/ops/maintenance
POST /api/ops/maintenance/enter
```

`POST` 必须携带 `x-maintenance-token`，body 必须提供 `reason` 与 `requestedBy`。响应包含进程内执行取消数量、超时 Session ID、暂停队列和已注册工作区失效统计，不返回 token。该接口只约束当前副本；跨副本 cutover 仍需由操作者 drain 并停止所有写入者。

## 3. Sessions API

会话列表、详情、创建和 resume 仅对当前 `dataEpoch` 的 v2 数据开放。Web 在调用这些接口前必须通过下方 Health 版本闸门。

`POST /api/sessions` 只接受 `input / agentIds / projectId / tokenBudget / knowledgeBaseIds / workingDirectory / runtimePreference`。创建请求只建立 Workspace Binding，不递归扫描目录、不批量读取正文，也不等待 Provider Index 完成。`workspaceSnapshot` 禁止客户端上传；`runtimeType / modelId / executionTarget / contextAssembly / pipelineVersion` 等旧字段或其他未知字段返回 400，不会被静默忽略。

### 3.1 获取会话列表

```text
GET /api/sessions?status=&cursor=&limit=
```

响应：

```ts
type SessionListItem = {
  id: string
  title: string
  status: SessionStatus
  agentCount: number
  requiresUserAction: boolean
  latestEventSummary?: string
  tokenBudget?: number
  tokenUsed: number
  createdAt: string
  updatedAt: string
}
```

### 3.2 创建会话

```text
POST /api/sessions
```

请求：

```ts
type CreateSessionRequest = {
  input: string
  agentIds?: string[]
  projectId?: string
  tokenBudget?: number
  knowledgeBaseIds?: string[]
  workingDirectory?: {
    kind: 'local_bridge' | 'server_local'
    id: string
    name: string
    path?: string
    selectedAt: string
  }
  runtimePreference?: {
    preferredRuntimeType?: RuntimeType
    preferredModelId?: string
    allowedRuntimeTypes?: RuntimeType[]
  }
}
```

`local_bridge` 不得携带服务器可访问的绝对路径；`server_local` 必须携带通过平台边界校验的绝对路径。响应只保证 Binding 和首条用户事件已建立，不保证 `workspaceSnapshot` 或完整索引存在。后台索引状态不会阻塞 Session 进入讨论。

同一 `workspaceId` 允许创建多个活动 Session。创建阶段只建立独立 Session Binding，不获取目录级独占 Lease。写能力任务必须进入隔离执行目录；真实目录的变更在任务完成后按 Workspace FIFO 写回，并使用 path hash 与三方合并处理并发修改。

响应：

```ts
type CreateSessionResponse = {
  session: SessionDetail
  firstEvent: CollaborationEvent
}
```

### 3.3 获取会话详情

```text
GET /api/sessions/:sessionId
```

响应：

```ts
type SessionDetail = {
  id: string
  title: string
  originalInput: string
  status: SessionStatus
  ownerId: string
  workspaceId: string
  projectId?: string
  origin?: 'user' | 'autopilot'
  autopilotRunId?: string
  currentTaskBriefId?: string
  pendingFollowUpMessages?: Array<{
    id: string
    sourceEventId: string
    content: string
    mentionedAgentIds: string[]
    handlingPlan: UserMessageHandlingPlan
    status: 'queued' | 'planning' | 'executing'
    queuedAt: string
    startedAt?: string
  }>
  activeFollowUpMessageId?: string
  workspaceWritebacks?: WorkspaceWritebackRecord[]
  engineeringRuntime?: {
    sessionDefaultRuntimeType?: RuntimeType
    projectDefaultRuntimeType?: RuntimeType
    agentRuntimeOverrides?: Record<string, RuntimeType>
  }
  tokenBudget?: number
  tokenUsed: number
  participatingAgentIds: string[]
  createdAt: string
  updatedAt: string
}
```

`SessionStatus` 增加 `APPLYING_CHANGES` 与 `WAIT_WORKSPACE_CONFLICT_RESOLUTION`。前者表示隔离执行结果正在串行写回，后者表示自动合并失败或 Provider 写回失败，需要用户处理。

### 3.3.1 处理工作区写回冲突

```text
POST /api/sessions/:sessionId/workspace-writebacks/:writebackId/resolve
```

请求：

```ts
type ResolveWorkspaceWritebackInput = {
  action:
    | 'retry_merge'
    | 'resolve_with_agent'
    | 'keep_workspace'
    | 'use_session'
    | 'abandon_writeback'
  confirmationId?: string
}
```

- `retry_merge`：基于当前工作区重新执行 path hash 校验和三方合并。
- `resolve_with_agent`：保留当前目录内容，把原任务重新置为待执行，让 Agent 生成兼容变更。
- `keep_workspace`：保留当前目录，放弃该隔离结果，并继续后续任务。
- `use_session`：强制使用 Session 版本；必须令 `confirmationId === writebackId`，用于表达覆盖风险的显式确认。
- `abandon_writeback`：明确放弃写回，并继续后续任务。

响应为更新后的 `WorkspaceWritebackRecord`。`conflicted/failed` 状态保持 Session 在 `WAIT_WORKSPACE_CONFLICT_RESOLUTION`；`applied/abandoned` 会完成或重新安排对应任务并恢复执行。

### 3.3.2 删除会话

```text
DELETE /api/sessions/:sessionId
```

删除是会话级终止边界。服务端必须先终止并等待该会话的 Brief 生成、工作流、执行队列以及全部 Agent Runtime invocation；Runtime 终止必须同时覆盖 Codex、Claude Code、Generic LLM 和内部工具收到的 `AbortSignal`。只有关联调用在宽限期内结束后，服务端才清理会话、任务、事件、记忆和隔离工作目录。若终止超时，接口返回 `409 Conflict`，会话数据保持不删除。

响应：

```ts
type DeleteSessionResponse = {
  deleted: true
  sessionId: string
}
```

### 3.4 发送用户消息

```text
POST /api/sessions/:sessionId/messages
```

请求：

```ts
type SendUserMessageRequest = {
  content: string
  mentionedAgentIds?: string[]
  attachments?: AttachmentInput[]
}
```

响应：

```ts
type SendUserMessageResponse = {
  event: CollaborationEvent
  handlingPlan: UserMessageHandlingPlan
  deferred: boolean
  followUpMessageId: string
}
```

已有会话中的每条消息都必须先经过“接收者”的意图识别，再进入任务拆分。若会话当前有执行中的任务，消息只入持久化后续队列，不中断、不取消、不重调度当前任务；当前任务交付后按 FIFO 顺序处理。没有执行中任务时立即拆分并派发。单个 `@Agent` 将拆分任务限定给该 Agent；多个 `@Agent` 先由被提及 Agent 讨论，再由接收者汇总讨论结果、拆分任务并限定派发到被提及 Agent。接收者只负责意图识别和任务拆分，Agent 拒绝任务时由接收者改派或重新拆分，不由接收者执行专业任务。

接收者还必须输出消息与当前任务契约的关系及失败续接动作：

```ts
type UserMessageHandlingPlan = {
  // 原有 intent / priority / affected* 等字段省略
  requirementRelation: 'continuation' | 'new_requirement'
  failedExecutionAction: 'none' | 'resume' | 'replan'
}
```

- `continuation`：补充、澄清、纠正、追问或继续当前需求；保留当前契约、已完成工作和相关上下文。
- `new_requirement`：独立于当前目标的新需求；必须启动新一轮讨论并生成新的任务契约，不得续接失败任务。
- Session 为 `FAILED` 且关系为 `continuation` 时，`resume` 复用当前 brief 和未完成任务，从失败阶段续接；`replan` 保留失败证据但重新讨论和拆分。
- 语义不明确时接收者应要求用户确认，不得猜测并自动续接；Receiver Runtime 不可用时仅识别显式的新需求/重新讨论表达，其余失败后输入保守按当前需求续接。

### 3.5 暂停、恢复、取消

```text
POST /api/sessions/:sessionId/pause
POST /api/sessions/:sessionId/resume
POST /api/sessions/:sessionId/cancel
```

请求：

```ts
type SessionControlRequest = {
  reason?: string
}
```

响应：

```ts
type SessionControlResponse = {
  session: SessionDetail
  event: CollaborationEvent
}
```

`pause` 是可恢复的会话级停止边界，仅允许从 `AGENT_DISCUSSING`、`REVISING_BRIEF`、`EXECUTING`、`POST_REVIEW` 或 `REWORKING` 进入 `PAUSED`。接口必须在 Brief 生成、工作流执行、执行队列和全部 Agent Runtime invocation 都停止后才返回；Runtime 取消必须覆盖模型输出流、本地 Claude/Codex 子进程及其会话心跳。若任一关联调用未在宽限期内停止，接口返回 `409 Conflict` 和 `SESSION_PAUSE_TIMEOUT`。

暂停必须保留已完成任务、Artifact、工作流检查点和当前未完成节点。`resume` 从 `pauseState.previousStatus` 对应的未完成阶段续接，只重置并调度未完成节点，不得重跑已完成节点。`PAUSED` 期间收到的新消息只能进入持久化后续队列，不能调用 Receiver Runtime 或隐式恢复会话；Receiver 意图识别延后到继续会话且当前节点结束之后。`cancel` 仍是不可恢复的终态操作，语义不得与 `pause` 混用。

### 3.6 处理 Post Review 动作

```text
POST /api/sessions/:sessionId/post-review/actions
```

请求中的 `action` 必须来自指定确认卡片的服务端事件载荷，服务端不会接受客户端伪造的动作详情。

```ts
type ResolvePostReviewActionRequest = {
  confirmationId: string
  action:
    | 'request_workspace_context'
    | 'deliver_with_limitations'
    | 'save_progress'
    | 'cancel'
}
```

动作语义：

- `request_workspace_context`：记录缺失路径并重新进入执行流程。
- `deliver_with_limitations`：携带已确认限制跳过重复 Post Review，进入最终交付。
- `save_progress`：保留当前检查点并继续等待用户决定。
- `cancel`：取消会话和未完成任务。

## 4. Task Brief API

### 4.1 获取任务契约列表

```text
GET /api/sessions/:sessionId/briefs
```

响应：

```ts
type TaskBrief = {
  id: string
  sessionId: string
  version: number
  goal: string
  scope: string[]
  outOfScope: string[]
  constraints: string[]
  acceptanceCriteria: string[]
  risks: string[]
  openQuestions: string[]
  confirmedByUser: boolean
  confirmedAt?: string
  createdAt: string
}
```

### 4.2 确认任务契约

```text
POST /api/sessions/:sessionId/briefs/:briefId/confirm
```

请求：

```ts
type ConfirmBriefRequest = {
  note?: string
}
```

响应：

```ts
type ConfirmBriefResponse = {
  brief: TaskBrief
  event: CollaborationEvent
  createdTasks: AgentTask[]
}
```

### 4.3 拒绝或继续沟通

```text
POST /api/sessions/:sessionId/briefs/:briefId/reject
```

请求：

```ts
type RejectBriefRequest = {
  reason: string
  userMessage?: string
}
```

响应：

```ts
type RejectBriefResponse = {
  event: CollaborationEvent
  sessionStatus: SessionStatus
}
```

## 5. Events API

### 5.1 查询事件

```text
GET /api/sessions/:sessionId/events?afterEventId=&cursor=&limit=
```

响应：

```ts
type EventsResponse = PageResponse<CollaborationEvent>
```

### 5.2 SSE 事件流

```text
GET /api/sessions/:sessionId/events/stream
```

SSE event：

```text
event: collaboration-event
id: <eventId>
data: <CollaborationEvent JSON>
```

## 6. Agents API

### 6.1 Agent 列表

```text
GET /api/agents
```

响应：

```ts
type Agent = {
  id: string
  key: string
  name: string
  role: string
  description?: string
  runtimeType: RuntimeType
  status: 'active' | 'disabled'
  capabilityIds: string[]
  defaultKnowledgeBaseIds: string[]
  createdAt: string
  updatedAt: string
}
```

### 6.2 创建 Agent

```text
POST /api/agents
```

请求：

```ts
type CreateAgentRequest = {
  name: string
  role: string
  description?: string
  systemPrompt: string
  runtimeType: RuntimeType
  runtimeConfig?: Record<string, unknown>
  capabilityIds?: string[]
  defaultKnowledgeBaseIds?: string[]
}
```

### 6.3 更新 Agent

```text
PATCH /api/agents/:agentId
```

请求：

```ts
type UpdateAgentRequest = Partial<CreateAgentRequest> & {
  status?: 'active' | 'disabled'
}
```

### 6.4 绑定/解绑知识库

```text
POST   /api/agents/:agentId/knowledge-bases/:knowledgeBaseId
DELETE /api/agents/:agentId/knowledge-bases/:knowledgeBaseId
```

请求：

```ts
type BindKnowledgeBaseRequest = {
  accessLevel: 'read'
  retrievalPolicy?: {
    topK?: number
    minScore?: number
  }
}
```

## 7. Tasks API

```text
GET /api/sessions/:sessionId/tasks
```

响应：

```ts
type AgentTask = {
  id: string
  sessionId: string
  title: string
  description: string
  status: AgentTaskStatus
  assignedBy?: ActorRef
  assignee?: ActorRef
  eligibleAgentIds?: string[]
  routingMode?: 'coordinator_controlled' | 'agent_suggested' | 'agent_delegated'
  autoResolutionAttempted?: boolean
  assignmentReason?: string
  contextRequirements: string[]
  verificationPlan: string[]
  riskNotes: string[]
  requiresUserConfirmation?: boolean
  dependsOnTaskIds: string[]
  acceptanceCriteria: string[]
  resultSummary?: string
  createdAt: string
  updatedAt: string
}
```

## 8. Knowledge API

### 8.1 知识库列表

```text
GET /api/knowledge-bases?scope=&agentId=&projectId=&sessionId=
```

响应：

```ts
type KnowledgeBase = {
  id: string
  name: string
  description?: string
  scope: KnowledgeScope
  ownerId?: string
  projectId?: string
  sessionId?: string
  agentId?: string
  roleType?: string
  visibility: 'private' | 'workspace'
  embeddingModel: string
  createdAt: string
  updatedAt: string
}
```

### 8.2 创建知识库

```text
POST /api/knowledge-bases
```

请求：

```ts
type CreateKnowledgeBaseRequest = {
  name: string
  description?: string
  scope: KnowledgeScope
  projectId?: string
  sessionId?: string
  agentId?: string
  roleType?: string
}
```

### 8.3 添加文档

```text
POST /api/knowledge-bases/:knowledgeBaseId/documents
```

请求：

```ts
type CreateKnowledgeDocumentRequest = {
  title: string
  sourceType: 'text' | 'markdown' | 'file' | 'feishu_doc' | 'meeting_note' | 'data_table' | 'external_reference'
  content?: string
  sourceUri?: string
  metadata?: Record<string, unknown>
}
```

响应：

```ts
type KnowledgeDocument = {
  id: string
  knowledgeBaseId: string
  title: string
  sourceType: string
  sourceUri?: string
  status: 'pending' | 'indexing' | 'ready' | 'failed'
  createdAt: string
  updatedAt: string
}
```

### 8.4 检索知识库

```text
POST /api/knowledge-bases/:knowledgeBaseId/search
```

请求：

```ts
type KnowledgeSearchRequest = {
  query: string
  topK?: number
  minScore?: number
}
```

响应：

```ts
type KnowledgeSearchResponse = {
  chunks: RagMatchedChunk[]
}
```

## 9. Artifacts API

```text
GET /api/sessions/:sessionId/artifacts
GET /api/artifacts/:artifactId
```

响应：

```ts
type Artifact = {
  id: string
  dataEpoch: string
  sessionId: string
  taskId?: string
  agentId?: string
  type: ArtifactType
  title: string
  uri?: string
  contentSummary?: string
  metadata: ArtifactMetadata
  runtimeProposals: RuntimeArtifactProposal[]
  platformProjections: RuntimeFileChange[]
  systemEvidence: RuntimeArtifactSystemEvidence | null
  createdAt: string
}
```

`ArtifactMetadata` 是共享合约定义的封闭白名单，不包含 `output`、`fileChanges` 或 `validationEvidence`，API 消费方不得追加任意键。模型提议只存在于 `runtimeProposals`；平台阶段生成、尚待写入或确认的文件只存在于 `platformProjections`；平台观测的工作区变更和真实测试只存在于 `systemEvidence`。三者不得互相冒充。

### 9.1 确认保存最终报告

系统架构分析等 Markdown 报告必须先在群聊展示完整正文，再由用户确认是否写入会话绑定的
`server_local` 工作区。客户端不得提交目标路径或正文，后端必须从已确认的 Artifact 中读取，
防止路径或内容被请求篡改。

```text
POST /api/sessions/:sessionId/reports/local-save/decision
```

请求：

```ts
type LocalReportSaveDecisionRequest = {
  confirmationId: string
  artifactId: string
  decision: 'save_local' | 'keep_in_session'
}
```

`save_local` 成功后必须写入 Artifact 指定的 `suggestedPath` 并产生
`user_confirmation_resolved`；`keep_in_session` 不得产生工作区写入。

## 10. Memory API

### 10.1 会话 Memory 列表和检索

```text
GET /api/sessions/:sessionId/memories?q=&agentId=
```

响应：

```ts
type MemoryItem = {
  id: string
  sessionId: string
  agentId?: string
  scope: 'short_term' | 'session' | 'long_term_candidate'
  content: string
  sourceEventId?: string
  confidence: number
  createdAt: string
  updatedAt: string
}
```

### 10.2 创建会话 Memory

```text
POST /api/sessions/:sessionId/memories
```

请求：

```ts
type CreateMemoryRequest = {
  content: string
  scope?: 'short_term' | 'session' | 'long_term_candidate'
  agentId?: string
  sourceEventId?: string
  confidence?: number
}
```

## 11. Debug API

Debug API 仅用于开发态和验收态，生产环境可以通过网关或权限策略限制访问。

```text
GET /api/sessions/:sessionId/debug/context-envelopes
GET /api/sessions/:sessionId/debug/runtime-invocations
GET /api/sessions/:sessionId/debug/rag-retrievals
GET /api/sessions/:sessionId/debug/token-usage
GET /api/sessions/:sessionId/debug/summary-memory
```

规则：

- `context-envelopes` 返回每次 Runtime 调用的权威 `ContextEnvelopeV2` 快照。
- `runtime-invocations` 分栏返回调用状态、`invocationId`、编译后身份快照、执行目标、Tool Catalog、usage、错误和 Envelope 摘要。
- `rag-retrievals` 从 `rag_retrieved` 事件派生可追溯检索记录。
- `token-usage` 汇总 Runtime invocation 的 token usage。
- `summary-memory` 返回关键阶段沉淀的 `summary_memory_checkpoint` artifact，用于长链路续跑和裁剪后追溯。

## 12. Capabilities API

```text
GET  /api/capabilities
POST /api/capabilities/:capabilityId/approve
```

```ts
type Capability = {
  id: string
  key: string
  name: string
  type: 'mcp' | 'tool' | 'skill' | 'connector' | 'runtime'
  riskLevel: CapabilityRiskLevel
  description?: string
  requiresCredential: boolean
  requiresUserConfirmation: boolean
}
```

## 13. Skills API

```text
GET    /api/skills
GET    /api/skills/:skillId
POST   /api/skills
PATCH  /api/skills/:skillId
DELETE /api/skills/:skillId
POST   /api/agents/:agentId/skills/:skillId
DELETE /api/agents/:agentId/skills/:skillId
```

```ts
type SkillInput = {
  name: string
  description?: string
  content: string
  files?: Array<{ path: string; content: string }>
}
```

约束：

- name 最长 100，description 最长 500，content 最长 100000 字符。
- files 最多 20 个，单文件最长 100000，总内容最长 500000 字符。
- file path 必须是规范化相对路径，不允许绝对路径、空段、`.`、`..` 或重复路径。
- Skill 名称大小写不敏感唯一；删除 Skill 时清理所有 Agent 的 `skillIds` 引用。

## 14. Autopilot API

```text
GET    /api/autopilots
GET    /api/autopilots/runs
GET    /api/autopilots/:autopilotId
GET    /api/autopilots/:autopilotId/runs
POST   /api/autopilots
PATCH  /api/autopilots/:autopilotId
DELETE /api/autopilots/:autopilotId
POST   /api/autopilots/:autopilotId/trigger
```

```ts
type AutopilotInput = {
  name: string
  prompt: string
  schedule?: string
  enabled?: boolean
  agentIds?: string[]
  tokenBudget?: number
}

type TriggerAutopilotRequest = {
  force?: boolean
}
```

- v0.1 服务端强制 `runtimeType='mock'`、`riskLevel='low'`，请求不能提升风险级别。
- disabled Autopilot 的手工触发默认返回校验错误；仅显式 `force=true` 可用于受控手工触发。
- 同一 Autopilot 已有 queued/running run 时，trigger 返回现有 run 和 `duplicate=true`，不重复创建 session。
- `AUTOPILOT_ENABLED=true` 且 `ENABLE_BULLMQ=true` 时启用 BullMQ Job Scheduler；否则不启动定时调度。

## 15. Workflows API

```text
GET    /api/workflows
GET    /api/workflows/:workflowId
GET    /api/workflows/:workflowId/versions
GET    /api/workflows/:workflowId/versions/:version
POST   /api/workflows
PATCH  /api/workflows/:workflowId
PATCH  /api/workflows/:workflowId/draft
POST   /api/workflows/:workflowId/publish
POST   /api/workflows/:workflowId/archive
DELETE /api/workflows/:workflowId

POST /api/sessions/:sessionId/workflow/select
POST /api/sessions/:sessionId/workflow/member-mapping
POST /api/sessions/:sessionId/workflow/agent-substitution
POST /api/sessions/:sessionId/workflow/agent-skip
POST /api/sessions/:sessionId/workflow/upstream-rerun
GET  /api/workflow-runs/:runId
GET  /api/workflow-runs/:runId/nodes
POST /api/workflow-runs/:runId/nodes/:nodeRunId/decision
POST /api/workflow-runs/:runId/cancel
```

```ts
type WorkflowInput = {
  name: string
  description?: string
  status?: 'draft' | 'published' | 'archived'
  expectedDraftRevision?: number
  nodes?: WorkflowNode[]
  edges?: WorkflowEdge[]
}

type SelectWorkflowInput = {
  workflowId: string
  workflowVersion: number
  confirmationId: string
}

type WorkflowHumanDecisionInput = {
  confirmationId: string
  expectedRunRevision?: number
  decision: 'approve' | 'revise' | 'cancel'
  instruction?: string
}

type WorkflowAgentSubstitutionInput = {
  confirmationId: string
  taskId: string
  agentId: string
}

type WorkflowAgentSkipInput = {
  confirmationId: string
  taskId: string
  reason?: string
}

type WorkflowUpstreamRerunInput = {
  confirmationId: string
  decision?: 'rerun_upstream' | 'retry_current'
  nodeId?: string
  instruction?: string
}

type ResolveWorkflowMemberMappingInput = {
  confirmationId: string
  decision: 'approve' | 'decline'
}
```

`workflow/member-mapping` 只处理服务端仍待决的 `confirm_workflow_member_mapping` 卡片。批准时服务端重新校验原选择的 workflow ID/version/definitionHash、需求文档或 Brief 版本绑定、Session generation/停止屏障和全部 Agent 缺口；全部可邀请后写入现有 `participatingAgentIds`，并沿原 `selectionConfirmationId` 的唯一启动路径继续。拒绝只关闭本次映射，不新增成员、不修改已发布图、不启动运行。相同决定重放幂等并返回已记录的 WorkflowRun；批准与拒绝竞争时，先提交的决定为准，另一决定返回冲突。

约束：

- 工作流名称大小写不敏感唯一，最多 100 字符；描述最多 500 字符；节点最多 50 个。
- V1 支持 `agent`、`human_approval`、`robot_approval` 三类线性节点；服务端按 `order` 规范化并重建连线。
- 草稿通过 `draftRevision` 做乐观并发控制；发布产生不可变 `WorkflowVersion`，运行必须绑定精确版本快照。
- Agent 和机器人评审节点必须引用真实且启用的 Agent；确认节点之前必须存在可返工的 Agent 节点。
- 归档工作流、未发布工作流、空工作流不能用于会话执行；已产生发布版本的工作流只能归档，不能物理删除。
- Task Brief 确认后进入 `WAIT_WORKFLOW_SELECT`；选择弹窗不默认选中，只展示已发布工作流。
- Agent 节点完成后自动推进；只有显式 `human_approval` 才进入 `WAIT_WORKFLOW_STEP_CONFIRM`。
- 机器人确认严格消费 JSON 决策；格式错误、执行异常或超过返工上限时转人工确认。
- 人工决策必须携带 `runId`、`nodeRunId`、`confirmationId` 和可选 `expectedRunRevision`，重复或过期命令必须幂等拒绝。
- Agent 接单返回 `blocked/rejected` 后，Session 必须进入 `WAIT_USER_DECISION`，Run 必须进入 `waiting_human`，并产生 `reason='workflow_agent_substitution'` 的 active confirmation。普通 Session continue 不得隐式重试该节点。
- 改派和跳过请求必须同时匹配当前 active confirmation、Workflow Run 和 Task；改派目标还必须在确认卡的 `candidateAgentIds` 中且属于当前 Session。已解决、过期或不匹配的 `confirmationId` 必须 fail closed。
- `workflow/upstream-rerun` 只处理 `reason='workflow_upstream_rerun'` 的 active confirmation。`rerun_upstream` 必须提供候选集合中的 `nodeId`；`retry_current` 不得回放上游节点。两种操作都创建新 attempt。
- 确认卡的 `cancel` 继续使用 Workflow 取消接口；取消后所有显式停车状态进入终态，不允许后续重复决策推进。
- Workflow Robot 决策中，`revise` 表示可恢复质量缺陷并创建上游新 attempt；`reject` 表示不可恢复拒绝并直接令 Run=`failed`，二者不得互换。

## 15.1 用户原文件修订 API

```text
GET  /api/sessions/:sessionId/file-revisions
POST /api/sessions/:sessionId/file-revisions/baselines
POST /api/sessions/:sessionId/file-revisions
GET  /api/sessions/:sessionId/file-revisions/:revisionId/candidate
GET  /api/sessions/:sessionId/file-revisions/:revisionId/draft
PUT  /api/sessions/:sessionId/file-revisions/:revisionId/draft
POST /api/sessions/:sessionId/file-revisions/:revisionId/reprocess
POST /api/sessions/:sessionId/file-revisions/:revisionId/failure-decision
POST /api/sessions/:sessionId/file-revisions/:revisionId/retry
POST /api/sessions/:sessionId/file-revisions/:revisionId/decision
```

```ts
type CaptureFileRevisionBaselineInput = {
  filePath: string
}

type CreateFileRevisionRunInput = {
  baselineId: string
  targetAgentIds: string[]
  instruction?: string
}

type SaveFileRevisionDraftInput = {
  expectedCandidateHash: FileHash
  content: string
}

type ReprocessFileRevisionInput = {
  draftHash: FileHash
  expectedCandidateHash: FileHash
  expectedStateVersion: number
  targetAgentIds?: string[]
  instruction?: string
}

type ResolveFileRevisionFailureInput = {
  expectedStateVersion: number
  decision: 'retry_agents' | 'continue_with_successful' | 'abandon_revision'
  instruction?: string
}

type RetryInterruptedFileRevisionInput = {
  expectedStateVersion: number
  retryKey: string
}

type DecideFileRevisionInput = {
  confirmationId: string
  candidateHash: FileHash
  expectedStateVersion: number
  decision: 'apply_candidate' | 'abandon_revision'
}
```

- 基线必须在用户编辑前捕获；第一轮使用 `Diff(W0,U1)`，后续轮使用 `Diff(G(n-1),Un)`。
- `targetAgentIds` 只能包含当前 Session 中启用的非 Receiver Agent，且至少一个。
- 同一版本链只有一个活动链头；重复的同参数 `reprocess` 请求返回同一个子 revision，并且后台编排只派发一次。跨服务实例发生持久化 CAS 竞争时，失败方必须刷新持久快照并返回已提交的获胜子 revision，而不是把同一幂等请求暴露为 `409`。
- 保存草稿只持久化编辑内容，不启动 Agent；只有 `reprocess` 创建下一轮。
- 单 Agent 和多 Agent 都由系统级、启用状态的默认 `coordinator` Receiver 基于本轮完整证据生成唯一候选；Receiver 不可用时必须在创建 Run 前 fail closed，不得回退到目标 Agent 或其他参与者。专业 Agent 和 Receiver 均为 `proposal_only`，确认前不得写 Workspace。
- 部分 Agent 失败时当前轮进入 `REVISION_PARTIAL_AGENT_FAILURE`，不得自动汇总；用户只能显式选择重新执行全部 Agent、使用已成功结果继续交给 Receiver，或放弃版本链。使用成功结果继续时，失败清单仍进入 Receiver 证据。
- `interrupted` Run 只能通过 `/retry` 显式恢复。`retryKey` 是幂等键；Agent 结果不完整时重新执行全部目标 Agent，结果完整时只重新执行 Receiver；若中断原因是写回结果未知，只执行 Workspace Hash 对账，不派发 Agent。
- Candidate/Draft GET 返回完整正文并设置 `Cache-Control: no-store`；revision 存在但没有当前草稿时 Draft GET 返回 `200 + null`，避免提交下一轮删除草稿与并发读取之间产生预期 404；revision 本身不存在仍返回 404。正文不得进入事件 payload 或日志。
- `apply_candidate` 同时校验 `confirmationId/revisionId/candidateHash/expectedStateVersion/workspaceExpectedHash`；Workspace 不一致返回 stale 且不覆盖文件。
- `abandon_revision` 关闭当前版本链，不写入候选。
- Hash 必须是 64 位小写 SHA-256；未知字段或未知 decision 返回 `INVALID_FILE_REVISION_REQUEST` 或 `INVALID_FILE_REVISION_DECISION`。

## 16. 错误码

```text
SESSION_NOT_FOUND
INVALID_SESSION_STATUS
BRIEF_NOT_FOUND
BRIEF_ALREADY_CONFIRMED
EVENT_NOT_FOUND
AGENT_NOT_FOUND
KNOWLEDGE_BASE_NOT_FOUND
KNOWLEDGE_DOCUMENT_INDEXING
CAPABILITY_REQUIRES_CONFIRMATION
TOKEN_BUDGET_EXCEEDED
RUNTIME_INVOCATION_ERROR
VALIDATION_ERROR
```

## Codex 式任务工作区读取接口（2026-09-11）

以下结构均指成功响应中的 `data`。

| 请求 | data | 边界 |
| --- | --- | --- |
| `GET /api/workflows/catalog/published` | `{items: WorkflowVersion[], hasMore:false}` | 全部当前已发布且未归档流程的当前发布快照，不返回可变 draft；现阶段没有租户分发过滤 |
| `GET /api/workflow-runs/session/:sessionId` | `{items: WorkflowRun[], hasMore:false}` | 当前 Session 的历史运行，最新优先 |
| `GET /api/workflow-runs/:runId` | `{run,nodeRuns,approvals}` | 使用 run.definitionSnapshot；不能拿目录最新版覆盖 |
| `GET /api/workflow-runs/:runId/file-diff` | `WorkflowDeliveryFileDiff` | 完成运行的证据累计差异；不完整返回 `status:unavailable,reason,files:[]`，不回读当前文件 |
| `GET /api/sessions/:sessionId/tasks` | `AgentTask[]` | 数组，不是分页对象；界面需按 workflowRunId/nodeId/NodeRun 关联过滤 |
| `GET /api/sessions/:sessionId/artifacts` | `{items:Artifact[],hasMore:false}` | 按 taskId/sessionId 关联本轮不可变内容 |

`POST /api/sessions/:sessionId/workflow/select` 继续接收 `confirmationId,workflowId,workflowVersion`；必须存在当前已确认 Brief。相同 confirmation 已启动相同版本时返回既有运行；换版本复用确认被拒绝，重复选择不能重跑任务。

流程定义写端点（create/update/draft/publish/archive/delete）统一检查 `assertWorkflowAuthoring`。共享客户端部署须配置 `WORKFLOW_AUTHORING_MODE=token` 和非空 `WORKFLOW_AUTHORING_TOKEN`，作者维护请求携带 `x-workflow-author-token`；客户端目录不发送此头。`read_only` 禁止所有定义写入；token 模式缺令牌配置时拒绝写入。未配置 mode/token 时兼容既有本地 Web 作者部署，**默认不构成客户端权限隔离**。这是部署能力校验，不是完整用户/租户认证，也不能信任客户端传入的 role。Web 作者令牌仅在页面内存保存。

## 执行停止状态查询（2026-09-15）

`GET /api/sessions/:sessionId/stop-state` 返回标准成功封装中的 `data: RuntimeStopSummary`，并设置 `Cache-Control: no-store`。该接口读取服务端权威停止轮次、监督句柄、待同步记录和 Local Runtime 未确认回执；查询不会重试、恢复或启动 Runtime。

`RuntimeStopSummary.status` 为 `idle/requested/waiting/confirmed/unknown`，`canResume` 是客户端唯一可用于展示“已可继续”的聚合判断。`blockers` 必须保留稳定原因码；客户端不得根据 HTTP 成功、连接在线或本地计时器自行推断停止完成。查询或状态合并失败时必须 fail closed，返回/展示 unknown，而不是放行新的执行。

## 群聊方案文档 API（2026-09-21）

会话绑定工作区后，可通过以下会话级资源接口发布和读取版本化方案文档：

```text
POST /api/sessions/:sessionId/discussion-documents
GET  /api/sessions/:sessionId/discussion-documents
GET  /api/sessions/:sessionId/discussion-documents/active
GET  /api/sessions/:sessionId/discussion-documents/:documentId
GET  /api/sessions/:sessionId/discussion-documents/:documentId/content
```

创建请求使用 `{ title, content, clientMessageId?, parentDocumentId?, workItemId?, createdBy? }`；`clientMessageId` 可由 `Idempotency-Key` 请求头提供。响应包含 `documentId/revision/relativePath/contentUrl/uiUrl/contentHash/sizeBytes/status` 等元数据，正文不进入元数据事件。正文接口返回 `text/markdown; charset=utf-8`、`Cache-Control: no-store` 和 `"sha256-<contentHash>"` ETag，并且只能读取 URL 所属 Session 的文档。

服务端按活动文档 parent 执行 CAS；相同幂等键与内容返回同一文档，不同内容产生不可覆盖的新版本。内容上限为 200,000 bytes，写入、Provider 回读或哈希校验失败时不发布 active 文档。
