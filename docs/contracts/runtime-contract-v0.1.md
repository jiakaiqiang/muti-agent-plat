# Runtime Contract v0.1

## 1. 目标

本契约定义 Agent Runtime 的统一输入输出。v1 先实现 `MockRuntime` 和 `GenericLlmRuntime`，后续 `CodexRuntime`、`ClaudeCodeRuntime` 必须兼容本接口。

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
  capabilityIds: string[]
}
```

## 5. ContextPack

```ts
type ContextPack = {
  systemRules: string[]
  sessionGoal: string
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

规则：

- Runtime 不应收到完整群聊历史。
- `taskBrief` 优先级高于长期 Memory 和 RAG。
- `relevantMemories` 必须来自 Memory API 或自动沉淀的可追溯记忆项。
- `constraints` 必须显式传入。
- `ragSnippets` 必须包含来源。

## 6. ExpectedRuntimeOutput

```ts
type ExpectedRuntimeOutput = {
  kind:
    | 'agent_message'
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

### 8.2 TaskBriefOutput

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

### 8.3 TaskExecutionResultOutput

```ts
type TaskExecutionResultOutput = {
  kind: 'task_execution_result'
  status: 'completed' | 'failed' | 'blocked' | 'needs_review'
  summary: string
  completedItems: string[]
  changedArtifacts: RuntimeArtifactOutput[]
  nextSuggestedActions: string[]
  risks: string[]
}
```

### 8.4 PostReviewReportOutput

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

### 8.5 FinalDeliveryOutput

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

### 8.6 UserMessageHandlingPlanOutput

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
  metadata?: Record<string, unknown>
}
```

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
- v1 仅预留 `CodexRuntimeAdapter` 和 `ClaudeCodeRuntimeAdapter` 文件结构，真实执行能力后续版本接入。

## 15. 错误结构

```ts
type RuntimeError = {
  code:
    | 'RUNTIME_TIMEOUT'
    | 'RUNTIME_CANCELLED'
    | 'MODEL_ERROR'
    | 'OUTPUT_SCHEMA_INVALID'
    | 'CAPABILITY_BLOCKED'
    | 'TOKEN_BUDGET_EXCEEDED'
    | 'UNKNOWN_ERROR'
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}
```

## 16. 校验规则

- `runId` 必须全局唯一。
- `status=completed` 时必须有 `output`。
- `status=failed` 时必须有 `error`。
- `ExpectedRuntimeOutput.kind` 与 `RuntimeOutput.kind` 必须一致。
- Runtime 过程事件必须带 `runId`。
- Runtime 不能绕过 Capability Module 直接执行高风险操作。
