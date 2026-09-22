# UI State Contract v0.1

主 Agent 协作的新旧状态兼容规则见 [阶段 0 冻结合同](./main-agent-collaboration-contract-v1.md)。未知控制状态不可默认允许执行；本阶段不接入页面或共享 store，Web/桌面布局不变。

## 1. 目标

本契约定义前端 v1 最小状态模型、状态流转和事件到 UI 的派生规则。Frontend Team 可基于本契约使用 mock events 开发三栏群聊页面。

## 2. 页面视图

执行可靠性反馈（2026-09-14）：Web 与桌面共用 `apps/web/src/utils/taskActivity.ts` 和会话事件事实，各自保留页面布局。状态映射必须区分正常执行、模型连接等待有限重试、已保存修改正在修复提交、异常和停止未确认，不能因服务心跳把后四者覆盖成“任务正常”。

停止未确认提示可在 PAUSED/INTERRUPTED 会话中保留，直到服务端可信回执表明所有相关调用停止；断线时不得推断停止已完成。接收 `RUNTIME_STOP_CONFIRMED` 后按实际会话状态恢复展示。点击继续仍由服务端停止屏障和预算校验决定是否执行，客户端提示不能绕过闸口。规则接单也不能在工作流视图中显示 QA 已通过。

阶段信息展示在现有群聊/任务进度区域，不新增第二套工作流或改变所选流程快照；任务记录、滚动、停止控件、文件 Diff 与双端同步继续遵守原合同。

输入区主按钮（2026-09-14）：Web 与桌面共用 `UserInputBox`，发送与停止使用同一个固定尺寸按钮。发送请求进行中或会话可中断时显示停止图标，空草稿仍可停止；停止通过现有会话 pause 链路取消意图识别、Agent 调用及流式执行，不能仅断开页面 SSE 来假装停止。停止中禁用重复点击并显示等待反馈；失败保留错误和重试停止入口。已暂停且无草稿时同一按钮显示继续，有草稿时显示发送（只排队，不隐式恢复）；执行中保留草稿，发送快捷键不绕过停止模式。输入区不再并列展示发送和停止按钮，两端保留各自布局及配色。

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
  | 'PAUSED'
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
  PAUSED: '已停止',
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
- `PAUSED`：展示继续按钮；新消息只进入后续队列，不得重新启动模型或工作流。
- `WAIT_USER_DECISION`：展示决策卡片。
- `COMPLETED`：展示接受结果、查看产物。
- `FAILED`：展示重试、查看错误。

工作流成员缺口卡由同一服务端事件派生，Web 与桌面必须展示流程名/版本、缺少的 Agent、所有关联执行或机器人审核节点、已配置的职责/输入/输出/审核标准和结构性影响。`disabled/unknown` 或混合缺口禁用批准，不能部分邀请。批准/拒绝均调用真实 `workflow/member-mapping` 接口；拒绝后显示“选择其他已发布流程”和“前往 Web 创建新流程”，关闭结果对话框不得自动重开选择器。桌面目录保持只读，Web 管理入口也不自动选择或启动新流程。

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
      | 'confirm_workflow_human_gate'
      | 'workflow_agent_substitution'
      | 'workflow_upstream_rerun'
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
  workflowRunId?: string
  workflowNodeId?: string
  workflowNodeRunId?: string
  candidateAgentIds?: string[]
  expectedRunRevision?: number
}
```

规则：

- 同一会话可以有多个历史确认卡片，但同时只能有一个 active confirmation。
- `WAIT_USER_CONFIRM` 时 active confirmation 通常关联 Task Brief。
- `WAIT_USER_DECISION` 时 active confirmation 通常关联冲突、预算或高风险能力。
- `confirm_local_report_save` 必须展示完整报告正文和目标路径；只有用户选择“保存到本地”后才能写入工作区。
- `workflow_agent_substitution` 显示“等待改派或跳过”，提供候选 Agent、`skip_agent` 和取消操作；不得提供普通继续。
- `workflow_upstream_rerun` 显示“等待选择返工节点”，提供合法上游节点、`retry_current` 和取消操作。
- `confirm_workflow_human_gate` 显示“等待人工验收”，不得与接单拒绝或输入不足共用文案。
- 所有卡片 mutation 必须发送卡片携带的 `confirmationId`，处理中禁用重复提交；SSE 重连只恢复事实，不自动重放决策。

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

任务事件文案必须区分来源：`task_rejected` 显示“Agent 拒绝接单”，`task_failed` 显示“任务执行失败”，`task_blocked` 表示接单前缺少上下文，`task_waiting` 表示执行中等待上下文、能力批准或恢复。不得把执行失败渲染成质量不通过或接单拒绝。

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
- Agent 节点配置必须说明它不具备自动质量返工语义；需要自动验收时使用机器人确认节点。机器人确认帮助文案必须说明 `revise` 会带修改要求返回上游并保留历史 attempt，`reject` 会终止整个 Workflow。
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

## 13. Codex 式任务工作区

本节约束只读执行回看，不改变第 12 节可写文件修订编辑器。工作区新主模式为 `chat/workflow/workflow_details`，由真实运行历史决定三 Tab 是否出现，完成/失败/取消不移除。旧 `collaboration_graph/debug` 保留在“更多视图”，不能当作所选流程图。

`taskWorkspace` 按 sessionId 载入运行、详情、tasks 数组及 artifacts 页，用请求 generation 忽略其他任务的迟到响应。选择 `{runId,nodeId,taskId,nodeRunId}` 按 sessionId 存入 sessionStorage；任务草稿亦按 sessionId 在 sessionStorage 恢复。存储不可用时退化为内存状态。当前 Tab 使用 URL query，同页任务切换恢复各自选择。ChatTimeline 按 sessionId 与中央/右侧区域保存 messageId/offset/top/following 阅读锚点，首次可见时恢复；新消息只在 following=true 时跟随，隐藏区域不覆盖已保存位置。

图使用固定版本节点/边，返工路径只叠加真实 NodeRun 记录；点击节点打开右侧任务列表，再点击任务展开详情，关闭恢复同源只读 ChatTimeline。右侧不挂载 ConfirmationCard/CapabilityApprovalCard 写动作，统一“去处理”导航中央对应 confirmationId。中央计划摘要不再重复挂载需求确认卡。

`historyDiff` 是全局只读查看状态，保存文件内容副本、来源和 sessionId。手动切任务或关闭弹窗递增请求代次，迟到的产物响应不能重新打开。新通知不改 Tab/历史选择、不关闭 Diff。待处理数按未解决 confirmationId 去重，阅读不消除 pending。群聊、Agent/节点任务、产物文件入口复用同一弹窗；支持 split/unified、文件切换与 Esc/焦点恢复。二进制、缺两端和超限按明确说明降级，不读取当前工作目录冒充历史。

## 14. 执行停止摘要

Web 与 Electron desktop 共用 `useSessionStore` 中按 sessionId 隔离的权威 `RuntimeStopSummary`，并在会话工作区渲染同一个 `RuntimeStopStatePanel`。切换会话时先读取 `GET /sessions/:sessionId/stop-state`；读取失败显示 unknown/阻塞状态，不能沿用其他 Session 的摘要或显示可继续。

SSE `RUNTIME_STOP_STATE_CHANGED` 与快照按停止轮次收敛：同 `stopRequestId` 只接受更大 `version`，不同轮次按 `updatedAt` 选择较新事实。`waiting/unknown` 展示确认计数和 blocker；只有 `canResume=true` 才显示停止已确认。详情可展开查看目标，但诊断不得包含凭据、完整业务正文或本地绝对路径。

实时停止状态不堆入 ChatTimeline。历史 `RUNTIME_STOP_CONFIRMED` 的连续折叠只是一种展示压缩，不能改变事件数组、服务端状态、通知次数或恢复判断；展开后必须能看到原始次数和时间。

## 15. 群聊方案文档状态

`discussion_document_published` 投影为独立的 `discussion_document` 时间线消息。Web 与 Electron renderer 使用同一 `documentId/revision/relativePath/contentUrl/contentHash/readStatus` 语义，并通过 `contentUrl` 拉取完整 Markdown；各端保留独立样式，桌面端不新增流程编辑或文档写入入口。

正文加载状态按消息和 Session 隔离为 `loading/loaded/failed`。切换 Session 时递增 generation 并清理旧映射，迟到响应不得写入新会话；加载完成后在客户端复算 SHA-256，不匹配时显示错误且不渲染为可信正文。正文使用文本节点/`pre` 展示，不使用未经消毒的 `v-html`。刷新和 SSE 重连只能恢复事件与正文读请求，不能重新发布文档。

方案消息展示标题、版本、工作区相对路径、内容 URL、哈希、完整 Markdown 和 Agent 读取状态。`discussion_document_read` 只更新同一 documentId 的读取投影；失败状态必须展示可访问错误提示。
