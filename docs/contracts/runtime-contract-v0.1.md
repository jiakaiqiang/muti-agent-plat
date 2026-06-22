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
  run(input: AgentRunInput): Promise<AgentRunResult>
  stream?(runId: string): AsyncIterable<AgentRuntimeEvent>
  cancel?(runId: string): Promise<void>
}
```

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
  error?: RuntimeError
}
```

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

### 8.2 TaskClaimDecisionOutput

```ts
type TaskClaimDecisionOutput = {
  kind: 'task_claim_decision'
  accepted: boolean
  reason: string
  confidence: number
  alternativeAgentIds?: string[]
  alternativeAgentKeys?: string[]
  agentMessages?: AgentMessageOutput[]
}
```

### 8.3 TaskBriefOutput

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
  dependsOnTaskTitles?: string[]
  acceptanceCriteria: string[]
}
```

### 8.4 TaskExecutionResultOutput

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

### 8.5 PostReviewReportOutput

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
}
```

### 8.6 FinalDeliveryOutput

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

### 8.7 UserMessageHandlingPlanOutput

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
  content?: string
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
```

规则：

- Runtime 必须返回 usage。
- MockRuntime usage 可以返回 0。
- 超预算时 Runtime 应返回 `blocked`，由 Token Budget Module 决定是否继续。

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
- 输出不合法时最多重试 1 次。
- 不直接调用高风险工具。
- 不直接修改文件。

## 14. 后续 Coding Runtime 兼容要求

CodexRuntime 和 ClaudeCodeRuntime 接入时必须遵守：

- 输入只接收 Context Pack，不接收完整事件流。
- 输出必须映射为 RuntimeOutput。
- 文件修改、命令执行必须通过 Capability Module 审计。
- 必须支持 timeout。
- 最好支持 cancel；如果不支持，需要在 Adapter 中标记。
- 必须返回 artifact，包括 diff、测试结果或执行摘要。
- 当前已有 `CodexRuntimeAdapter` 和 `ClaudeCodeRuntimeAdapter` 的受控本地 CLI 接入骨架，默认关闭；真实执行必须显式启用并经过 capability preflight。

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
