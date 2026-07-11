# Runtime Contract v0.1

## 1. 目标

本契约定义 Agent Runtime 的统一输入输出。v1 先实现 `MockRuntime` 和 `GenericLlmRuntime`，后续 `CodexRuntime`、`ClaudeCodeRuntime` 必须兼容本接口。

当前 TypeScript 合同源以 `packages/shared/src/contracts.ts` 为准；本文档用于解释合同语义，字段变更后必须同步更新。

## 2. Runtime 类型

```ts
type RuntimeType =
  | 'mock'
  | 'generic_llm'
  | 'codex'
  | 'claude_code'
  | 'mcp_tool'
  | 'human'
```

Engineering Runtime 选择记录：

```ts
type RuntimeSelectionSource =
  | 'agent_override'
  | 'session_override'
  | 'project_default'
  | 'global_default'

type EngineeringRuntimeSelection = {
  effectiveRuntimeType: RuntimeType
  source: RuntimeSelectionSource
  agentRuntimeType?: RuntimeType
  sessionRuntimeType?: RuntimeType
  projectRuntimeType?: RuntimeType
  globalRuntimeType: RuntimeType
  reason: string
}
```

选择优先级：

```text
Agent override
  > Session override
  > Project default
  > Global default
```

当前实现中，Agent override 可以来自 session 的 `engineeringRuntime.agentRuntimeOverrides`，也可以来自 Agent 自身显式配置的 `runtimeType`。Session override 来自创建会话时的 `engineeringRuntimeType` 或 `engineeringRuntime.sessionDefaultRuntimeType`。Project default 可来自 session 配置或 `PROJECT_DEFAULT_ENGINEERING_RUNTIME_TYPE`。Global default 可来自 `DEFAULT_ENGINEERING_RUNTIME_TYPE`、`ENGINEERING_RUNTIME_TYPE`，否则回退到默认 Agent runtime。

## 3. 统一 Adapter 接口

```ts
interface AgentRuntimeAdapter {
  type: RuntimeType
  run(input: AgentRunInput, signal?: AbortSignal): Promise<AgentRunResult>
  start?(input: AgentRunInput, signal?: AbortSignal): AgentRuntimeRunHandle
  /** @deprecated v0.2 双轨兼容，优先使用 start().events。 */
  stream?(runId: string): AsyncIterable<AgentRuntimeEvent>
  /** @deprecated v0.2 双轨兼容，优先使用 start().cancel()。 */
  cancel?(runId: string): Promise<void>
}

interface AgentRuntimeRunHandle {
  events: AsyncIterable<AgentRuntimeEvent>
  result: Promise<AgentRunResult>
  cancel(): Promise<void>
}
```

### 3.a 流式语义

v0.2 的首选流式入口是 `start()`。它必须同步返回当前运行独占的 `AgentRuntimeRunHandle`，编排器立即消费 `events`，并发等待 `result`，从而消除按 `runId` 事后查询 handle 的注册竞态。

`stream?(runId)` 仅作为 v0.2 双轨兼容通道保留，其历史语义如下：

- **消费方约定**：orchestrator 对同一 `runId` 只调用 `stream(runId)` 一次；调用后必须持续消费直到 iterator 自然终止（`{done: true}`）。
- **生产方约定**：adapter 保证同 `runId` 的帧按生成顺序推送；不同 `runId` 的帧互相隔离。
- **终止时机**：`run()` 返回后（无论 completed / failed / cancelled），iterator 必须在有限时间内终止；`stream()` 上的最后一帧不得晚于 `run()` 的 result 落地。
- **未消费保护**：如未启动消费者即 `run()` 结束，adapter 可丢弃缓冲帧；orchestrator 不应依赖"事后补看"。
- **帧数上限**：adapter 应在通道内实施有界策略（如队列上限），避免长任务下积压帧撑爆内存；被丢弃的中间帧不影响最终 `AgentRunResult.events`。

### 3.b 帧类型与事件映射

adapter 内部可维护自己的原生 CLI 帧类型（如 stream-json 事件、JSON-RPC notification），但通过 `stream?` 暴露出来的只能是合同 `AgentRuntimeEvent`。映射约定：

| 原生帧类别 | `AgentRuntimeEvent.type` | 备注 |
| --- | --- | --- |
| 助手增量文本 | `runtime_progress` | `metadata.deltaText` 承载增量内容；orchestrator 可自行聚合 |
| 工具调用发起 | `tool_called` | `metadata.toolCallId`、`metadata.tool`、`metadata.input` |
| 工具调用结果 | `tool_completed` | 同上 + `metadata.output`（可截断） |
| 产物创建 | `artifact_created` | `metadata.artifactType` |
| 终止事件 | `runtime_completed` / `runtime_failed` | 与 `AgentRunResult.status` 一致；可省略（`run()` 已表达） |
| 未识别帧 | `runtime_progress` | `metadata.subtype` 保留原始类型；不得抛错 |

内部帧类型（例如 `RuntimeStreamFrame`）**不进合同**。合同只约束消费侧看到的 `AgentRuntimeEvent`。

### 3.c cancel 语义

`AgentRuntimeRunHandle.cancel()` 是首选取消入口；deprecated `cancel?(runId)` 在兼容期保持相同调用契约：

- **幂等**：对同一 `runId` 连续调用不得抛错；重复 cancel 无副作用。
- **终止承诺**：调用后 `run()` 必须在有限时间内以 `status='cancelled'` 结束（不允许仍返回 completed）。
- **不撤回**：已发出的帧不撤回；`cancel` 只影响后续帧的生成。
- **未知 runId**：对未在跑的 `runId` 调用 `cancel` 应静默返回（`Promise<void>`），不抛错。
- **与 AbortSignal**：优先响应 `run(input, signal)` 传入的 `AbortSignal`；`cancel(runId)` 是"从外部取回控制权"的补充路径。

### 3.d 兼容与降级

`start?` / `stream?` / `cancel?` 均为**可选**方法：

- adapter 未实现 `start?` 时，RuntimeService 使用 `run()`；orchestrator 对没有真实 streaming events 的运行发送合成 heartbeat。
- adapter 实现 `start?` 时，RuntimeService 必须返回本次 handle 的 `events/result/cancel`，不得先按 `runId` 查询全局 map。
- handle 未提供独立取消能力时，编排器依赖传入的 `AbortSignal`；metadata 应准确声明 `supportsCancel`。
- `MockRuntime` 和 `GenericLlmRuntime` 继续只实现 `run()`；Codex/Claude 在 streaming 灰度开启时实现 `start()`，在 `off` 模式保留 legacy `run()`。

## 4. AgentRunInput

```ts
type AgentRunInput = {
  runId: string
  sessionId: string
  taskId?: string
  phase: AgentRunPhase
  agent: RuntimeAgentProfile
  contextPack: ContextPack
  expectedOutput: ExpectedRuntimeOutput
  budget: RuntimeBudget
  estimatedInputTokens?: number
  options?: RuntimeOptions
}
```

```ts
type AgentRunPhase =
  | 'discussion'
  | 'brief_generation'
  | 'brief_revision'
  | 'task_acceptance'
  | 'task_execution'
  | 'post_review'
  | 'final_delivery'
  | 'user_message_routing'
```

```ts
type RuntimeAgentProfile = {
  id: string
  key: string
  name: string
  role: string
  systemPrompt: string
  runtimeType: RuntimeType
  configuredRuntimeType?: RuntimeType
  runtimeSelection?: EngineeringRuntimeSelection
  capabilityIds: string[]
}
```

## 5. ContextPack

```ts
type ContextPack = {
  systemRules: string[]
  sessionGoal: string
  taskContext: TaskContext
  summaryMemory: SummaryMemory
  continuationState: TaskContinuationState
  workingDirectory?: SessionWorkingDirectory
  workspaceSnapshot?: WorkspaceSnapshot
  workspaceManifest?: {
    rootName: string
    fileCount: number
    readableFileCount: number
    skippedFileCount: number
    tree: WorkspaceSnapshot['tree']
    files: Array<{
      path: string
      size: number
      readable: boolean
      contentLength?: number
      summary?: string
    }>
    detectedStack: string[]
    entrypoints: string[]
  }
  selectedEvidenceContents?: Array<{
    type: EvidenceSourceType
    label: string
    ref?: string
    source?: string
    content?: string
    summary?: string
    contentLength?: number
    truncated?: boolean
    tokenEstimate?: number
    selectionReason?: string
  }>
  runtimeSelection?: EngineeringRuntimeSelection
  workspaceFocus?: {
    relevantFiles: string[]
    impactedFiles: string[]
    testFiles: string[]
    configFiles: string[]
    possibleEntryPoints: string[]
    detectedStack: string[]
    validationCommands: string[]
    rationale: string
  }
  taskBrief?: RuntimeTaskBrief
  currentTask?: RuntimeAgentTask
  agentProfile: RuntimeAgentProfile
  relevantEvents: RuntimeEventSummary[]
  relevantMemories: RuntimeMemoryItem[]
  ragSnippets: RuntimeRagSnippet[]
  artifacts: RuntimeArtifactSummary[]
  capabilities: RuntimeCapabilityDefinition[]
  constraints: string[]
  budget: RuntimeBudget
}
```

```ts
type TaskContext = {
  domain: 'coding' | 'non_coding' | 'mixed'
  intent:
    | 'inquiry'
    | 'analysis'
    | 'implementation'
    | 'planning'
    | 'troubleshooting'
    | 'review'
    | 'validation'
    | 'delivery'
    | 'qa'
  currentStage: AgentRunPhase
  taskMap: {
    kind: 'project_map' | 'domain_map'
    summary: string
    items: Array<{
      type: 'module' | 'boundary' | 'entrypoint' | 'key_material' | 'validation_path'
      label: string
      ref?: string
      reason?: string
    }>
  }
  stagePlan: {
    phase: AgentRunPhase
    read: Array<{
      action: 'read'
      label: string
      refs?: string[]
      reason?: string
    }>
    do: Array<{
      action: 'do'
      label: string
      refs?: string[]
      reason?: string
    }>
    validate: Array<{
      action: 'validate'
      label: string
      refs?: string[]
      reason?: string
    }>
  }
  executionMode: 'single_agent' | 'multi_agent'
  validationMode: 'runtime_checks' | 'human_review' | 'mixed'
  requiresCodeChanges: boolean
  requiresExternalEvidence: boolean
  validationRules: Array<{ label: string; evidenceRequired: string }>
  agentResponsibilities: Array<{
    role: 'execution' | 'review' | 'validation'
    agentKey: string
    independentFrom?: string[]
  }>
  evidenceSelection: {
    phase: AgentRunPhase
    strategy: 'coding_minimal' | 'non_coding_minimal' | 'mixed_minimal'
    query: string
    maxEvidenceRefs: number
    selectedCount: number
    omittedCount: number
    selectedTypes: EvidenceSourceType[]
    omittedTypes: EvidenceSourceType[]
    selectedRefs: TaskEvidenceRef[]
    omittedRefs: TaskEvidenceRef[]
    rules: string[]
  }
  evidenceRefs: Array<{
    type:
      | 'workspace_snapshot'
      | 'workspace_file'
      | 'workspace_symbol'
      | 'log'
      | 'test'
      | 'diff'
      | 'event_log'
      | 'memory'
      | 'artifact'
      | 'user_input'
      | 'external_reference'
      | 'document_fragment'
      | 'meeting_note'
      | 'data_table'
      | 'historical_decision'
    label: string
    ref?: string
    estimatedTokens?: number
    selectionReason?: string
    omissionReason?: string
  }>
}

type SummaryMemory = {
  goal: string
  currentState: string
  confirmedFacts: string[]
  completed: string[]
  decisions: string[]
  openQuestions: string[]
  risks: string[]
  nextSteps: string[]
  checkpointRefs?: string[]
  sourceEventIds?: string[]
  sourceArtifactIds?: string[]
  sourceMemoryIds?: string[]
}

type SummaryMemoryCheckpoint = {
  kind: 'summary_memory_checkpoint'
  checkpointId: string
  sessionId: string
  phase: AgentRunPhase
  taskId?: string
  agentId?: string
  summaryMemory: SummaryMemory
  sourceEventIds: string[]
  sourceArtifactIds: string[]
  sourceMemoryIds: string[]
  createdAt: string
}

type TaskContinuationState = {
  phase: AgentRunPhase
  sessionStatus: SessionStatus
  activeTaskId?: string
  activeAgentKey?: string
  lastCheckpointRef?: string
  pendingTaskIds: string[]
  runningTaskIds: string[]
  completedTaskIds: string[]
  blockedTaskIds: string[]
  nextAgentKeys: string[]
  handoffRefs: string[]
  sourceEventIds: string[]
  sourceArtifactIds: string[]
  resumeHints: string[]
}
```

Summary memory checkpoint 规则：
- 每个关键阶段完成后应沉淀 `SummaryMemoryCheckpoint`，至少覆盖 brief generation、task execution、post review、final delivery。
- Checkpoint 应同时写入 artifact metadata（`summaryMemoryCheckpoint`）和 Memory（`sourceMemoryIds`），前者用于审计追溯，后者用于后续 Context Pack 检索和长链路续跑。
- 后续 Context Pack 的 `summaryMemory` 应合并最近 checkpoint 的 confirmed facts、completed items、decisions、open questions、risks、next steps，并保留 `checkpointRefs` / `source*Ids`。

规则：

- Runtime 不应收到完整群聊历史。
- `taskBrief` 优先级高于长期 Memory 和 RAG。
- `taskContext` 是当前调用的 Task Context Pack，必须包含任务地图、最小证据、验证规则和 Execution/Validation/Review 分工。
- `taskContext.taskMap.items` 必须包含当前阶段可用的模块/边界/入口/关键资料/验证路径；其中 `key_material` 应优先来自 `taskContext.evidenceSelection.selectedRefs`，避免把整仓或整库资料一次性塞入 runtime。
- 编程任务的 `workspaceFocus` 应区分 `relevantFiles`、`impactedFiles`、`testFiles`、`configFiles`、`possibleEntryPoints` 和 `validationCommands`；Project Map 应把影响文件映射为模块、配置文件映射为关键资料、测试文件和验证命令映射为验证路径。
- `taskContext.stagePlan` 是当前阶段的显式编排计划，必须拆成 `read` / `do` / `validate` 三组；每个 item 应说明动作标签、引用的 map/evidence/artifact refs，以及为什么本阶段需要它。
- `taskContext.evidenceSelection` 记录候选证据如何被裁剪为最小证据集，包括选择策略、query、上限、selected/omitted counts、selected/omitted types、selected refs、少量 omitted refs、选择规则、证据 token 估算和 selected/omitted 原因。
- `taskContext.evidenceRefs` 必须等于 `taskContext.evidenceSelection.selectedRefs`，Runtime 只能把 selected refs 视为当前阶段已注入证据；如果不足，应请求更多证据而不是臆造 omitted 内容。
- `taskContext.evidenceRefs` 必须同步关键 RAG 命中、相关 Memory、artifact fileChanges、错误日志和测试/复盘证据，作为裁剪后仍可追溯的最小证据索引；RAG 命中应按 `sourceType` 映射为 `document_fragment`、`meeting_note`、`data_table` 或 `external_reference`。
- `summaryMemory` 是长链路续跑摘要，只沉淀已确认事实、当前状态、已完成事项、未决问题、风险和下一步。
- `continuationState` 是任务切换/续跑状态，必须包含当前 phase、session status、active task/agent、任务队列状态、最近 checkpoint、handoff refs、source refs 和 resume hints；它用于跨阶段、跨 agent、暂停/恢复后的状态一致性。
- `relevantMemories` 必须来自 Memory API 或自动沉淀的可追溯记忆项。
- `constraints` 必须显式传入。
- `ragSnippets` 必须包含来源。
- `workingDirectory`、`workspaceManifest`、`selectedEvidenceContents`、`workspaceSnapshot` 和 `workspaceFocus` 是工作区感知输入；它们用于约束和解释文件级判断，不等于授权 Runtime 越界写入。
- `workspaceManifest` is the preferred runtime structure input. It may expose tree, paths, sizes, readability, content length, detected stack, and entrypoints, but it must not expose file bodies.
- `selectedEvidenceContents` is the preferred runtime readable-content input. It must be derived from `taskContext.evidenceSelection.selectedRefs`, trimmed by token budget, and auditable by source/ref.
- Runtime-facing `workspaceSnapshot` is retained for compatibility as a manifest-style fallback. New runtimes must not rely on `workspaceSnapshot.files[].content` being present.
- `runtimeSelection` records why the current invocation used its effective adapter. Debug views and runtime invocation summaries must preserve this source/reason so runtime switching remains auditable.

## 6. ExpectedRuntimeOutput

```ts
type ExpectedRuntimeOutput = {
  kind:
    | 'agent_message'
    | 'task_acceptance_decision'
    | 'task_claim_decision'
    | 'task_brief'
    | 'task_execution_result'
    | 'post_review_report'
    | 'final_delivery'
    | 'user_message_handling_plan'
  schemaVersion: '0.1'
  jsonSchema?: Record<string, unknown>
}
```

## 7. AgentRunResult

```ts
type AgentRunResult = {
  runId: string
  runtimeType: RuntimeType
  status: RuntimeInvocationStatus
  output: RuntimeOutput
  events: AgentRuntimeEvent[]
  artifacts: RuntimeArtifactOutput[]
  usage: RuntimeUsage
  runtimeSession?: RuntimeSessionRef
  streamMetrics?: RuntimeStreamMetrics
  error?: RuntimeError
}

type RuntimeSessionRef = {
  cliSessionId?: string
  workDir?: string
}

type RuntimeStreamMetrics = {
  startedAt: ISODateTime
  completedAt: ISODateTime
  durationMs: number
  frameCount: number
  firstFrameAt?: ISODateTime
  firstFrameLatencyMs?: number
  lastActivityAt: ISODateTime
  maxInterFrameGapMs: number
}
```

`runtimeSession` 是 CLI 会话恢复的显式结果字段。RuntimeService 必须优先使用该字段写入 invocation log，不得从普通进度事件 metadata 猜测 session id。

`streamMetrics` 是流式 Runtime 的完成态观测字段。Codex/Claude runner 无论 completed、failed、cancelled 或 timeout 都应返回该字段；RuntimeService 必须把它写入对应 invocation log，供 Watchdog 分位数分析使用。`frameCount=0` 时 `firstFrameAt/firstFrameLatencyMs` 可以省略，`lastActivityAt` 取进程启动时间。

Resume 规则：

- prior invocation 必须与当前 `sessionId/agentId/taskId/runtimeType` 匹配且为最近一次 completed 调用。
- `workDir` 必须存在、属于允许的 server-local session root，且与当前 execution workdir 一致。
- Resume 失败或返回不同 `cliSessionId` 时，清除 resume 参数并新建会话重试一次。
- fallback 必须产生 `runtime_progress`，`metadata.code='RESUME_FALLBACK'`；第二次失败直接返回，不递归。

```ts
type RuntimeInvocationStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
```

## 8. RuntimeOutput

```ts
type RuntimeOutput =
  | AgentMessageOutput
  | TaskAcceptanceDecisionOutput
  | TaskClaimDecisionOutput
  | TaskBriefOutput
  | TaskExecutionResultOutput
  | PostReviewReportOutput
  | FinalDeliveryOutput
  | UserMessageHandlingPlanOutput
```

### 8.1 AgentMessageOutput

```ts
type AgentMessageOutput = {
  kind: 'agent_message'
  messageKind:
    | 'discussion'
    | 'answer'
    | 'handoff'
    | 'progress'
    | 'risk'
    | 'decision'
    | 'summary'
  content: string
  mentionedAgentIds?: string[]
  relatedTaskIds?: string[]
}
```

### 8.2 TaskAcceptanceDecisionOutput

`task_acceptance_decision` 是 v1 Coordinator 中心流转的目标合同。子 Agent 只能判断自己是否能执行当前分配任务，并返回阻塞、拒绝原因或建议交接；任务归属变更必须由 Coordinator 写入。

```ts
type HandoffSuggestion = {
  targetAgentKey?: string
  targetAgentId?: string
  reason: string
  missingContext?: string[]
  riskLevel?: 'low' | 'medium' | 'high'
}

type TaskAcceptanceDecisionOutput = {
  kind: 'task_acceptance_decision'
  status: 'accepted' | 'blocked' | 'rejected'
  reason: string
  missingContext?: string[]
  handoffSuggestion?: HandoffSuggestion | null
  confidence?: number
  alternativeAgentIds?: string[]
  alternativeAgentKeys?: string[]
  agentMessages?: AgentMessageOutput[]
}
```

兼容说明：

- `status='accepted'` 后任务进入 `accepted/running`。
- `status='blocked'` 表示缺上下文、权限、依赖或外部条件，Coordinator 可自动处理一次。
- `status='rejected'` 表示当前 Agent 不适合执行，Coordinator 可自动改派一次。
- `handoffSuggestion` 只作为建议展示和 Coordinator 决策输入，不会让子 Agent 自动转派。

### 8.3 TaskClaimDecisionOutput（兼容）

```ts
type TaskClaimDecisionOutput = {
  kind: 'task_claim_decision'
  accepted: boolean
  reason: string
  confidence?: number
  missingContext?: string[]
  handoffSuggestion?: HandoffSuggestion | null
  alternativeAgentIds?: string[]
  alternativeAgentKeys?: string[]
  agentMessages?: AgentMessageOutput[]
}
```

`task_claim_decision` 保留为旧 runtime/stub 兼容输出。运行时适配层和 Orchestrator 必须将其解释为“接受决策”，不得解释为子 Agent 自由竞争认领。

### 8.4 TaskBriefOutput

```ts
type TaskBriefOutput = {
  kind: 'task_brief'
  goal: string
  scope: string[]
  outOfScope: string[]
  constraints: string[]
  acceptanceCriteria: string[]
  risks: string[]
  openQuestions: string[]
  suggestedTasks: SuggestedAgentTask[]
}

type SuggestedAgentTask = {
  title: string
  description: string
  suggestedAgentKey?: string
  routingMode?: 'coordinator_controlled' | 'agent_suggested' | 'agent_delegated'
  assignmentReason?: string
  contextRequirements?: string[]
  verificationPlan?: string[]
  riskNotes?: string[]
  requiresUserConfirmation?: boolean
  dependsOnTaskTitles?: string[]
  acceptanceCriteria: string[]
}
```

### 8.5 TaskExecutionResultOutput

```ts
type TaskExecutionResultOutput = {
  kind: 'task_execution_result'
  status: 'completed' | 'failed' | 'blocked' | 'needs_review'
  summary: string
  completedItems: string[]
  changedArtifacts: RuntimeArtifactOutput[]
  requestedContext?: RuntimeContextRequest
  nextSuggestedActions: string[]
  risks: string[]
}
```

When `status='blocked'` because the selected Context Pack is not enough to produce a grounded answer, Runtime should set `requestedContext` instead of guessing.

### 8.6 PostReviewReportOutput

```ts
type PostReviewReportOutput = {
  kind: 'post_review_report'
  isConsistentWithBrief: boolean
  matchedItems: string[]
  mismatchedItems: string[]
  missingItems: string[]
  outOfScopeChanges: string[]
  testResults: string[]
  recommendation: 'deliver' | 'rework' | 'ask_user'
  actions?: PostReviewAction[]
}

type PostReviewAction =
  | { action: 'request_workspace_context'; reason: string; missingPaths: string[] }
  | { action: 'deliver_with_limitations'; limitations: string[] }
  | { action: 'save_progress'; artifactIds?: string[] }
  | { action: 'cancel'; reason?: string }
```

When Post Review cannot verify completion because workspace evidence is missing, it should return
`recommendation='ask_user'` with a `request_workspace_context` action whose non-empty `missingPaths`
records the exact files needed for the next review attempt.

### 8.7 FinalDeliveryOutput

```ts
type FinalDeliveryOutput = {
  kind: 'final_delivery'
  summary: string
  completedItems: string[]
  incompleteItems: string[]
  risks: string[]
  artifactRefs: string[]
}
```

### 8.8 UserMessageHandlingPlanOutput

```ts
type UserMessageHandlingPlanOutput = {
  kind: 'user_message_handling_plan'
  intent:
    | 'clarification'
    | 'constraint'
    | 'command'
    | 'question'
    | 'correction'
    | 'knowledge_input'
    | 'preference_input'
  priority: 'low' | 'normal' | 'high' | 'critical'
  shouldPause: boolean
  affectedTaskIds: string[]
  affectedAgentIds: string[]
  requiresBriefRevision: boolean
  requiresUserConfirmation: boolean
  coordinatorInstruction: string
}
```

## 9. AgentRuntimeEvent

Runtime 过程事件必须可转换为 `collaboration_events`。

```ts
type AgentRuntimeEvent = {
  runId: string
  type:
    | 'runtime_started'
    | 'runtime_progress'
    | 'runtime_completed'
    | 'runtime_failed'
    | 'tool_called'
    | 'tool_completed'
    | 'artifact_created'
  content: string
  metadata?: Record<string, unknown>
  createdAt: string
}
```

## 10. Artifact 输出

```ts
type RuntimeArtifactOutput = {
  type:
    | 'text'
    | 'markdown'
    | 'json'
    | 'code_diff'
    | 'test_report'
    | 'feishu_draft'
    | 'url'
    | 'file'
  title: string
  content: string
  uri?: string
  summary?: string
  metadata?: Record<string, unknown> & {
    fileChanges?: RuntimeFileChange[]
    validationEvidence?: ValidationEvidenceReport
    summaryMemoryCheckpoint?: SummaryMemoryCheckpoint
  }
}

type ValidationEvidenceReport = {
  kind: 'validation_evidence_report'
  domain: 'coding' | 'non_coding' | 'mixed'
  intent: TaskContext['intent']
  stage: AgentRunPhase
  taskTitle?: string
  validatorAgentKey: string
  validatorAgentId?: string
  independentFromAgentKeys: string[]
  rules: TaskValidationRule[]
  evidenceRefs: TaskEvidenceRef[]
  verdicts: Array<{
    ruleLabel: string
    status: 'passed' | 'warning' | 'failed' | 'not_applicable'
    evidenceRefs: TaskEvidenceRef[]
    notes: string[]
    missingEvidence?: string[]
  }>
  overallStatus: 'passed' | 'warning' | 'failed'
}
```

规则：
- Validation Agent 输出 `test_report` 时，应在 `metadata.validationEvidence` 中保存验证 Agent 身份、独立于哪些 Agent、规则、证据引用和 verdict 映射。
- 每个 verdict 必须对应 `taskContext.validationRules` 中的一条规则，并引用 `taskContext.evidenceRefs`、artifact、日志、测试或检索证据。
- 非编程任务的验证报告应覆盖事实一致性、范围一致性、结论可追溯性、交付完整性；编程/混合任务应覆盖 typecheck/test/build/e2e 或等价证据。

## 11. Usage 与预算

```ts
type RuntimeUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cost?: number
  model?: string
}

type RuntimeBudget = {
  maxInputTokens?: number
  maxOutputTokens?: number
  maxTotalTokens?: number
  maxCost?: number
}

type InputTokenEstimationError = {
  estimated: number
  actual: number
  ratio: number
}
```

`type`、`title` 和顶层 `content` 是必填字段；`type` 只能取上述标准枚举，`title` 与 `content` 必须是非空字符串。Runtime 输出 Schema 不接受缺字段、空正文或枚举外类型。`metadata` 不得包含 `content` 键，报告正文只能存在于顶层 `content`。

规则：

- Runtime 必须返回 usage。
- MockRuntime usage 可以返回 0。
- 超预算时 Runtime 应返回 `blocked`，由 Token Budget Module 决定是否继续。
- Orchestrator 应在 `AgentRunInput.estimatedInputTokens` 传入完整输入估算；RuntimeService 在实际 usage 可用时，将 `{ estimated, actual: usage.inputTokens, ratio: actual / estimated }` 写入 Invocation 的 `inputTokenEstimation`，供 debug runtime-invocations 查询。
- GenericLlmRuntime 在 `actual > 0` 且 `abs(actual / estimated - 1) > 0.2` 时必须追加 `runtime_progress` 事件，`metadata.code='TOKEN_ESTIMATION_DRIFT'`，并包含 `model`、`estimated`、`actual`、`ratio`、`relativeError` 和 `threshold`；Orchestrator 应将非流式结果中的该诊断事件写入会话时间线。

## 12. MockRuntime 规则

MockRuntime 用于 v1 验证协作闭环。

行为：

- 不调用外部模型。
- 根据 `phase` 返回确定性输出。
- 可以通过 `options.mockScenario` 指定成功、失败、返工、冲突等场景。
- 输出必须符合 `ExpectedRuntimeOutput`。

```ts
type MockRuntimeOptions = {
  mockScenario?: 'happy_path' | 'needs_user_decision' | 'task_failed' | 'brief_conflict'
  delayMs?: number
}
```

## 13. GenericLlmRuntime 规则

GenericLlmRuntime 用于：

- Agent 讨论。
- 任务契约生成。
- 用户消息路由。
- 执行后复盘。
- 最终交付总结。

要求：

- 支持结构化 JSON 输出。
- OpenAI-compatible 远程模型默认以 `LLM_STRUCTURED_OUTPUT_MODE=auto` 请求结构化输出：优先使用 `json_schema`，网关明确返回不支持时按 `baseUrl + model` 缓存并降级为 `json_object`。
- `LLM_STRUCTURED_OUTPUT_MODE=json_schema` 或 `json_object` 可强制指定模式。
- Runtime 必须按 `ExpectedRuntimeOutput.kind` 对归一化后的结果执行运行时 Schema 校验。
- 输出不合法时通过独立的轻量 Schema repair 请求最多修复 `LLM_SCHEMA_REPAIR_ATTEMPTS` 次，默认 1 次；repair 不重复发送完整 Context Pack，也不计入网络重试次数。
- Schema repair 仍失败时返回 `OUTPUT_SCHEMA_INVALID`，`details` 应包含 `parseState`、`detectedKind`、`validationErrors`、`contentLength`、`contentHash`、`sanitizedPreview` 和 `repairAttempts`。
- 不得在事件、日志或持久化状态中保存完整无效模型响应；`sanitizedPreview` 必须脱敏并受 `LLM_DIAGNOSTIC_PREVIEW_CHARS` 限制。
- 不直接调用高风险工具。
- 不直接修改文件。

## 14. Coding Runtime 兼容要求

CodexRuntime 和 ClaudeCodeRuntime 接入时必须遵守：

- 输入只接收 Context Pack，不接收完整事件流。
- 输出必须映射为 RuntimeOutput。
- 文件修改、命令执行必须通过 Capability Module 审计。
- 必须支持 timeout。
- 最好支持 cancel；如果不支持，需要在 Adapter 中标记。
- 必须返回 artifact，包括 diff、测试结果或执行摘要。
- 当前 `CodexRuntimeAdapter` 已实现 Codex app-server JSONL 生命周期，`ClaudeCodeRuntimeAdapter` 已实现 stream-json 生命周期；streaming 默认关闭，真实执行必须显式启用并经过 capability preflight。

Additional real coding runtime rules:

- Orchestrator selects the effective engineering runtime before `task_acceptance` and `task_execution`, then passes that effective runtime through `AgentRunInput.agent.runtimeType`.
- Runtime selection must change only the adapter implementation. It must not bypass task brief confirmation, task state transitions, Context Router, token budget, capability audit, or delivery flow.
- Before launching `codex` or `claude_code` for a source-writing task, Orchestrator must run a `cap-file-write` preflight through Capability Module and record the check in capability audit.
- If the preflight is blocked, Runtime must not be started. The task should move to `waiting`, emit `task_waiting`, and include `relatedCapabilityId='cap-file-write'`.
- A successful preflight does not grant unlimited access. The adapter still receives only the trimmed Context Pack, not the full project or full event stream.
- Runtime filesystem changes must be captured from before/after snapshots and attached as `actual_filesystem_snapshot` fileChanges or equivalent runtime artifacts.
- Runtime command execution and test execution must remain auditable and must not bypass Capability Module policy.

## 15. 错误结构

```ts
type RuntimeError = {
  code:
    | 'RUNTIME_TIMEOUT'
    | 'RUNTIME_CANCELLED'
    | 'MODEL_ERROR'
    | 'OUTPUT_SCHEMA_INVALID'
    | 'CAPABILITY_BLOCKED'
    | 'CONTEXT_INSUFFICIENT'
    | 'TOKEN_BUDGET_EXCEEDED'
    | 'UNKNOWN_ERROR'
  message: string
  retryable: boolean
  requestedContext?: RuntimeContextRequest
  details?: Record<string, unknown>
}
```

`RUNTIME_TIMEOUT` 的 `details` 必须使用以下字段，且同一份脱敏字段应写入对应 `runtime_failed` 事件 metadata：

```ts
type RuntimeTimeoutDetails = {
  watchdog: 'first_frame' | 'idle' | 'absolute'
  runtimeType: RuntimeType
  runId: string
  phase: AgentRunPhase
  thresholdMs: number
  startedAt: ISODateTime
  lastActivityAt: ISODateTime
  timedOutAt: ISODateTime
  elapsedMs: number
  idleForMs: number
  firstFrameSeen: boolean
  stderrTailSummary?: string
}
```

- `stderrTailSummary` 必须去除 ANSI 和控制字符，并限制在 1,000 字符内；不得持久化完整 stderr、凭据或完整模型输出。
- first-frame 默认 30 秒，idle 默认 10 分钟；两者必须在 Node 定时器支持的 1～2,147,483,647 ms 范围内，非法值回退到默认值。
- absolute 默认关闭；未设置、空值、`0` 或负数均表示关闭。
- 对应环境变量为 `CODEX_RUNTIME_FIRST_FRAME_TIMEOUT_MS`、`CODEX_RUNTIME_IDLE_TIMEOUT_MS`、`CODEX_RUNTIME_ABSOLUTE_TIMEOUT_MS`、`CLAUDE_CODE_FIRST_FRAME_TIMEOUT_MS`、`CLAUDE_CODE_IDLE_TIMEOUT_MS`、`CLAUDE_CODE_ABSOLUTE_TIMEOUT_MS`。
- 连续产生真实帧会刷新 idle watchdog；任务总时长超过 120 秒本身不构成 timeout。

```ts
type RuntimeContextRequest = {
  reason: string
  requestedRefs: TaskEvidenceRef[]
  requestedPaths?: string[]
  requestedCommands?: string[]
  followUpInstruction?: string
}
```

`CONTEXT_INSUFFICIENT` means Runtime could identify the missing evidence and should be retried after Context Router / Evidence Selector rebuild a smaller supplemental Context Pack. The Orchestrator should surface this as a visible waiting/blocking card, not as an opaque model failure.

Supplemental context retry rules:

- Orchestrator must persist each `requestedContext` on the session as a supplemental context request for the affected task.
- Context Router must convert requested refs, paths, and commands into high-priority candidate evidence for the retry.
- Evidence Selector must keep those requested refs selected before ordinary workspace focus candidates when retrying the same task.
- Context Pack Builder must inject readable content for selected requested workspace files through `selectedEvidenceContents`, while keeping `workspaceManifest` metadata-only.
- The visible chat timeline should keep a `context_supplement` event so users can see why the task was retried.

## 16. 校验规则

- `runId` 必须全局唯一。
- `status=completed` 时必须有 `output`。
- `status=failed` 时必须有 `error`。
- `ExpectedRuntimeOutput.kind` 与 `RuntimeOutput.kind` 必须一致。
- Runtime 过程事件必须带 `runId`。
- Runtime 不能绕过 Capability Module 直接执行高风险操作。

## 17. 变更日志

- **2026-07-10（PR-05）**：新增 `AgentRunResult.streamMetrics` 和 invocation 持久化语义；补齐 Watchdog timeout 的 runtime/run/phase/阈值/活动时间/脱敏 stderr 诊断合同；Codex/Claude 支持独立 first-frame、idle 和默认关闭的 absolute 配置。
- **2026-07-10（R1/R2/R4/R5/R6）**：`AgentRuntimeRunHandle/start()` 成为流式主合同；`AgentRunResult.runtimeSession` 显式承载 CLI session/workdir；Codex app-server 与 Claude stream-json 接入完成；Resume 增加 workdir/runtime 校验和单次 `RESUME_FALLBACK`；CLI adapter 接入可恢复 Workdir Brief，Skill 通过 `systemRules` 和 brief 注入。
- **2026-07-09（M2-06）**：Engineering Runtime 灰度开关 `ENGINEERING_RUNTIME_STREAMING` 语义补齐为 `off | codex | all`。`codex` 仅 CodexAdapter 走 `startCodexStreaming`；`all` CodexAdapter 与 ClaudeCodeAdapter 同时启用流式 (`--output-format stream-json`) 生命周期；默认 `off` 走旧 execFile 路径。相关 adapter 通过 `pickCodexRunMode` / `pickClaudeRunMode` 判定，`stream?/cancel?` 只在流式模式下有非空实现。
- **2026-07-08（M1-14 ~ M2-05）**：引入 §3.a/3.b/3.c/3.d 流式语义、内部帧类型不进合同、cancel 幂等 + 有限时间承诺、可选 `stream?/cancel?` 与合成心跳降级。
