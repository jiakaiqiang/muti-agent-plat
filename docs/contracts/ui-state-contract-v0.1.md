# UI State Contract v0.1

## 1. 目标

本契约定义前端 v1 最小状态模型、状态流转和事件到 UI 的派生规则。Frontend Team 可基于本契约使用 mock events 开发三栏群聊页面。

## 2. 页面视图

```ts
type SessionViewMode = 'chat' | 'collaboration_graph' | 'workflow'
```

默认视图：

```text
chat
```

## 3. 会话状态

```ts
type SessionStatus =
  | 'DRAFT_INPUT'
  | 'AGENT_DISCUSSING'
    | 'WAIT_USER_CONFIRM'
    | 'WAIT_WORKFLOW_SELECT'
    | 'WAIT_WORKFLOW_STEP_CONFIRM'
  | 'REVISING_BRIEF'
  | 'EXECUTING'
  | 'POST_REVIEW'
  | 'REWORKING'
  | 'WAIT_USER_DECISION'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
```

状态展示文案：

```ts
const sessionStatusLabel = {
  DRAFT_INPUT: '待理解',
  AGENT_DISCUSSING: 'Agent 讨论中',
    WAIT_USER_CONFIRM: '等待确认',
    WAIT_WORKFLOW_SELECT: '选择工作流',
    WAIT_WORKFLOW_STEP_CONFIRM: '确认工作流环节',
  REVISING_BRIEF: '修订任务契约',
  EXECUTING: '执行中',
  POST_REVIEW: '复盘中',
  REWORKING: '返工中',
  WAIT_USER_DECISION: '等待用户决策',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消'
}
```

用户可操作规则：

- `WAIT_USER_CONFIRM`：展示确认执行、继续沟通。
- `WAIT_WORKFLOW_SELECT`：展示工作流列表和工作流管理入口。
- `WAIT_WORKFLOW_STEP_CONFIRM`：展示当前 Agent 阶段输出、确认继续和要求修改。
- `EXECUTING`：展示暂停、发送消息、@Agent。
- `WAIT_USER_DECISION`：展示决策卡片。
- `COMPLETED`：展示接受结果、查看产物。
- `FAILED`：展示重试、查看错误。

## 4. Agent 状态

```ts
type AgentCardState = {
  agentId: string
  name: string
  role: string
  status: AgentStatus
  currentTaskId?: string
  currentTaskTitle?: string
  thoughtSummary?: string
  actionSummary?: string
  recentLogs: string[]
  waitingFor: string[]
  activeCapabilityNames: string[]
  usedRagSnippets: RagSnippetSummary[]
  artifactIds: string[]
  updatedAt: string
}
```

Agent 状态文案：

```ts
type AgentStatus =
  | 'idle'
  | 'discussing'
  | 'thinking'
  | 'running'
  | 'waiting'
  | 'reviewing'
  | 'reworking'
  | 'completed'
  | 'failed'
  | 'disabled'
```

颜色建议：

- idle：灰色。
- discussing/thinking：蓝色。
- running：绿色。
- waiting：黄色。
- reviewing：紫色。
- reworking：橙色。
- completed：绿色。
- failed：红色。
- disabled：灰色。

## 5. 聊天消息状态

```ts
type ChatMessage = {
  id: string
  sessionId: string
  senderType: 'user' | 'agent' | 'system'
  senderAgentId?: string
  toAgentIds: string[]
  messageType:
    | 'text'
    | 'task'
    | 'brief'
    | 'confirmation'
    | 'tool'
    | 'rag'
    | 'artifact'
    | 'review'
    | 'delivery'
    | 'error'
  content: string
  createdAt: string
  rawEventId: string
  payload?: Record<string, unknown>
}
```

事件到消息映射：

- `user_message` -> `senderType=user`、`messageType=text`
- `agent_message` -> `senderType=agent`、`messageType=text`
- `brief_created` -> `messageType=brief`
- `user_confirmation_requested` -> `messageType=confirmation`
- `task_*` -> `messageType=task`
- `tool_*` -> `messageType=tool`
- `rag_retrieved` -> `messageType=rag`
- `artifact_created` -> `messageType=artifact`
- `post_review_completed` -> `messageType=review`
- `final_delivery_created` -> `messageType=delivery`
- `error_reported` -> `messageType=error`

## 6. 确认卡片状态

```ts
type ConfirmationCardState = {
  confirmationId: string
  reason:
      | 'confirm_task_brief'
      | 'select_workflow'
      | 'confirm_workflow_step'
    | 'approve_high_risk_capability'
    | 'resolve_contract_conflict'
    | 'confirm_local_report_save'
    | 'continue_after_budget_warning'
  title: string
  description: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  options: ConfirmationOption[]
  relatedBriefId?: string
  relatedTaskId?: string
  relatedCapabilityId?: string
}
```

规则：

- 同一会话可以有多个历史确认卡片，但同时只能有一个 active confirmation。
- `WAIT_USER_CONFIRM` 时 active confirmation 通常关联 Task Brief。
- `WAIT_USER_DECISION` 时 active confirmation 通常关联冲突、预算或高风险能力。
- `confirm_local_report_save` 必须展示完整报告正文和目标路径；只有用户选择“保存到本地”后才能写入工作区。

## 7. Task 状态

```ts
type TaskViewState = {
  taskId: string
  title: string
  status: AgentTaskStatus
  assignedBy?: ActorRef
  assignee?: ActorRef
  routingMode?: 'coordinator_controlled' | 'agent_suggested' | 'agent_delegated'
  autoResolutionAttempted?: boolean
  assignmentReason?: string
  contextRequirements: string[]
  verificationPlan: string[]
  riskNotes: string[]
  requiresUserConfirmation?: boolean
  handoffSuggestion?: {
    targetAgentKey?: string
    targetAgentId?: string
    reason: string
    riskLevel?: 'low' | 'medium' | 'high'
  } | null
  dependsOnTaskIds: string[]
  acceptanceCriteria: string[]
  resultSummary?: string
}
```

工作流视图节点规则：

- `pending`：灰色。
- `assigned`：蓝色，表示 Coordinator 已分配但 Agent 尚未接受。
- `accepted/claimed`：蓝色，表示 Agent 已接受任务；`claimed` 仅为历史兼容命名。
- `running`：绿色。
- `waiting/blocked`：黄色。
- `reviewing`：紫色。
- `rejected/reworking`：橙色。
- `completed`：绿色。
- `failed`：红色。

Coordinator 中心流转展示规则：

- 任务卡片应优先显示“分配者”和“负责 Agent”。
- 任务卡片应尽量显示 `assignmentReason`、`contextRequirements`、`verificationPlan` 和 `riskNotes`，帮助用户理解为什么由该 Agent 执行、执行前需要什么、如何验证、还存在哪些风险。
- `claimed` 不应展示为“已认领”，应展示为“已接受”。
- 子 Agent 的 `handoffSuggestion` 应展示为“建议交接”，不应展示为“已转派”。
- 只有 Coordinator 写入的 `task_reassigned` 才能展示为正式改派。
- `requiresUserConfirmation=true` 时，任务卡片应明确标出“执行前需要用户确认”。

### 7.1 工作流低代码创建页

工作流创建页使用与运行态工作流视图分离的三栏编辑器：

```text
顶部：工作流名称、描述、保存草稿、发布
左侧：Agent / 人工确认 / 机器人确认资源分组
中间：低代码流程画布和画布工具栏
右侧：选中节点详情、配置、输入输出
```

左侧资源面板规则：

- `Agent`、`人工确认`、`机器人确认` 必须作为三个独立分组展示，分组允许折叠。
- Agent 分组支持搜索和分类筛选；搜索不得隐藏两类确认节点入口。
- 三类资源均支持拖拽加入画布和点击插入当前选中节点之后。
- Agent 项展示名称、能力摘要和分类；确认节点展示确认方式和默认行为。

画布规则：

- 开始和结束节点固定存在；V1 只允许线性连接，不允许条件、并行和汇聚。
- 连接线提供 `+` 插入入口，可以插入 Agent、人工确认或机器人确认节点。
- 工具栏至少提供撤销、重做、删除、对齐、放大、缩小、缩放比例和适应画布。
- 画布节点摘要必须随右侧属性变更即时更新；未保存变更需要有明确状态提示。
- 发布前必须在节点和右侧校验区同时标记断链、失效 Agent、缺少评审 Agent 等错误。

右侧属性面板规则：

- Agent 节点展示 `详情 / 配置 / 输入输出`，配置阶段说明和输入输出约定。
- 人工确认节点展示确认说明和允许操作，确认人固定为当前会话发起人。
- 机器人确认节点选择评审 Agent，配置评审提示、通过标准和最大返工次数；默认最大返工次数为 `2`。
- 机器人评审异常、格式错误或重试超限时必须显示“转人工确认”的回退行为。
- 未选中节点时展示工作流摘要和发布前校验结果，不保留上一次节点的可编辑表单。

## 8. Pinia Store 合约

### 8.1 useSessionStore

```ts
type SessionStoreState = {
  sessions: SessionListItem[]
  currentSession?: SessionDetail
  currentViewMode: SessionViewMode
  loading: boolean
}
```

必要 actions：

```ts
loadSessions()
createSession(input)
loadSession(sessionId)
sendMessage(sessionId, content, mentionedAgentIds?)
pauseSession(sessionId)
resumeSession(sessionId)
cancelSession(sessionId)
switchViewMode(mode)
```

### 8.2 useEventStore

```ts
type EventStoreState = {
  eventsBySessionId: Record<string, CollaborationEvent[]>
  connectedSessionId?: string
  sseConnected: boolean
  lastEventIdBySessionId: Record<string, string>
}
```

派生数据：

```ts
chatMessages(sessionId): ChatMessage[]
agentCards(sessionId): AgentCardState[]
taskStates(sessionId): TaskViewState[]
activeConfirmation(sessionId): ConfirmationCardState | undefined
```

### 8.3 useKnowledgeStore

```ts
type KnowledgeStoreState = {
  knowledgeBases: KnowledgeBase[]
  documentsByKnowledgeBaseId: Record<string, KnowledgeDocument[]>
  indexingStatusByDocumentId: Record<string, string>
}
```

### 8.4 useWorkspaceUiStore

工作区中需要跨组件复用、跨路由组件替换后继续保持，或包含异步流程中间态的交互状态，统一由 `useWorkspaceUiStore` 管理，包括：

- 会话列表搜索与筛选；
- 用户消息草稿与工作流阶段选择；
- 新建会话表单、二次确认、Runtime 与工作区选择；
- 需求契约修订、工作流环节修订；
- 文件变更审阅与选择；
- 工作区级消息提示和请求进行中状态。

状态边界：

- URL 可表达的导航状态以 Vue Router 为唯一来源，不在 Pinia 重复维护；
- 后端实体、事件和工作区绑定继续由各领域 Store 管理，`useWorkspaceUiStore` 不复制领域数据；
- `HTMLElement`、文件系统 handle、计时器和画布实例等不可序列化对象不进入公共状态；
- 只影响单个叶子组件渲染、离开组件即可丢弃的临时状态可以保留为组件本地状态；
- 公共状态的成组流转通过 Store action 完成，组件不再创建同一业务含义的第二份 `ref`。

### 8.5 管理页面状态

Agent、Skill、Workflow、Model 管理页面的选中项、搜索筛选、编辑草稿、校验结果、撤销/重做栈、弹窗开关和保存中状态分别归入对应的领域 Store：

- `useAgentStore`：Agent 编辑器、Profile 校验和资源编排状态；
- `useSkillStore`：Skill 选中项、创建/编辑表单、字段错误和删除确认状态；
- `useWorkflowStore`：列表筛选、编辑草稿、节点选中、dirty 标记及撤销/重做状态；
- `useRuntimeModelStore`：模型选中、添加/编辑表单和操作反馈状态。

这些状态在管理路由切换后可以继续复用，不在页面组件内维护副本。输入框等 DOM 引用仍留在组件本地。

### 8.6 调试与运行摘要状态

- `useDebugStore` 统一维护 Runtime 调用审计列表、Token 汇总、选中调用、加载和错误状态；
- Runtime 版本摘要复用 `useSessionStore.runtimeHealth`，不得再次维护一份 `/health` 结果；
- Token 使用指示器从 `useSessionStore.currentSession` 派生，不重复请求或缓存 Session；
- 缩放比例、节点拖拽坐标、DOM 引用和仅控制叶子组件展开/收起的状态仍可留在组件本地。

### 8.7 应用壳层与路由错误状态

- `useAppUiStore` 维护当前路由页面的渲染错误，`AppShell` 负责展示明确的错误结果页和重新加载入口；
- 多个路由即使复用同一个页面组件，也必须以 `route.fullPath` 作为实例 key，禁止跨路由复用残留的组件实例；
- 动态路由模块加载失败时允许执行一次冷恢复，并用 `sessionStorage` 防止无限刷新；
- 一次成功导航必须清除对应恢复标记。

## 9. SSE 客户端规则

- 进入会话详情页时连接 `/api/sessions/:sessionId/events/stream`。
- 离开会话详情页时关闭连接。
- SSE 是观察通道，不是 Agent、Runtime、MCP/Tool invocation 的生命周期所有者；浏览器断开不得中断活动 Session。
- SSE 出错后客户端主动关闭当前 `EventSource`，前 30 秒按 `1s / 2s / 4s / 8s / 15s`（带抖动）快速重试；超过 30 秒进入 `degraded`，每 30 秒继续重试，不停止后端任务。
- 浏览器恢复在线或页面重新可见时立即发起一次重连；切换 Session 或离开详情页必须清理旧连接、定时器、监听器和补偿请求，旧代回调不得写入当前 Session。
- 重连恢复采用原子补偿：记录服务端游标，先打开 SSE 并缓冲实时事件，再以该游标调用事件列表接口，最后按“REST 补偿顺序 + SSE 到达顺序”去重后一次提交。
- 本地乐观事件不得推进服务端游标；服务端确认事件到达后按确认标识移除对应乐观事件。
- SSE 恢复只允许重放读请求，禁止自动重放发送消息、确认、取消、文件写入等 REST mutation。
- `reconnecting` 显示“实时连接正在恢复”；`degraded` 显示“实时更新暂不可用，后端任务可能仍在运行”。两者都不得禁用消息输入；只有独立后端健康探测失败或 Session 真实中断时才禁用。
- Session 进入 `COMPLETED`、`FAILED`、`CANCELLED` 或 `INTERRUPTED` 后，客户端执行最后一次事件补偿并停止重连；不得自动唤醒或续跑 `INTERRUPTED` Session。
- 收到事件后先写入 `useEventStore`，再派生 UI。

## 10. Mock 数据要求

前端 Milestone 1 必须能用 mock events 渲染以下过程：

```text
用户创建会话
需求 Agent 讨论
架构 Agent 讨论
Coordinator 生成任务契约
用户确认执行
后端 Agent dry-run 执行
测试 Agent dry-run 验证
Review Agent 复盘
最终交付
```

## 11. UI 验收规则

- 会话状态和确认卡片状态一致。
- Agent 卡片状态来自事件派生，不手动伪造。
- 群聊消息刷新后可恢复。
- SSE 断开重连后不重复显示事件。
- RAG 命中来源在 Agent 卡片和聊天消息中至少出现一处。

## 12. 用户原文件修订状态

`useSessionStore` 按 `sessionId` 保存 `FileRevisionState`，按 `sessionId:revisionId` 保存候选和草稿正文，并分别用 state/candidate/draft generation token 忽略迟到响应。它提供 `loadFileRevisions/loadFileRevisionCandidate/loadFileRevisionDraft/saveFileRevisionDraft/reprocessFileRevision/resolveFileRevisionFailure/retryInterruptedFileRevision/decideFileRevision`。切换或删除 Session 时不得串用候选、草稿或加载状态；每个异步操作必须捕获发起时的 `sessionId`，只能刷新该 Session，编辑器 busy/error 也必须按 Session 隔离。SSE 在编辑器忙碌时到达的新候选必须在操作结束后补做一次同步。`useWorkspaceUiStore` 只保存首次启动弹窗的表单状态，不复制版本链领域对象。

交互顺序固定为：捕获 `W0`、用户在原文件形成 `U1`、选择一个或多个专业 Agent、Receiver 生成 `G1`、统一产物编辑器只展示 `G1` 全文。用户点击“继续编辑”后可以保存草稿但不会启动 Agent；只有点击“提交修改”才形成 `U2` 并请求 `Diff(G1,U2)` 的下一轮。页面不得展示原文/候选 Diff、Diff hunk、Prompt 或内容引用。

文件修订确认不在普通 `ConfirmationCard` 重复渲染，只由 `FileRevisionCandidateEditor` 消费。确认/放弃请求必须发送精确的 `confirmationId/candidateHash/expectedStateVersion/decision`；页面不得通过本地事件伪造完成，也不得因 SSE 重连自动重放保存、提交或应用 mutation。处理、失败、`interrupted` 和 `stale` 状态必须有可访问的状态或 `role='alert'` 提示。

`interrupted` 状态必须显示由用户触发的“重试本轮修订”，请求携带新的 `retryKey` 和当前 `expectedStateVersion`。进入编辑后焦点移到候选文本框；放弃编辑后回到“继续编辑”；状态切换到处理中时焦点回到修订区域，新候选到达时移到候选正文，避免异步替换后键盘焦点丢失。

当当前 Run 为 `REVISION_PARTIAL_AGENT_FAILURE` 时，编辑器只显示“重新执行全部 Agent”“使用已成功结果继续”和“放弃”三种明确操作；没有成功结果时禁用继续选项。选择继续后仍只展示 Receiver 生成的最终候选，不展示 Agent 结果之间或候选之间的 Diff。
