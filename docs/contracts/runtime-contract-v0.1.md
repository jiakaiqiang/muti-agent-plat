# Runtime Contract：Context v2 + Output Contract 1.0

## 1. 目标

本合同定义 Runtime 的唯一活动输入、路由元数据、执行句柄、输出和审计边界。Runtime 输出的唯一权威源是 `packages/shared/src/runtime-contracts/`；其余 Runtime 类型以 `packages/shared/src/contracts.ts` 为准。

核心约束：

- Agent 身份不包含 Runtime/Model 选择。
- Runtime 只消费不可变 `InvocationPlan`。
- Context 只使用 `ContextEnvelopeV2`。
- Adapter 只暴露 `start()`，事件、结果和取消都属于本次调用句柄。
- Router 只从 Adapter metadata 获取能力，不在 Orchestrator 维护 Runtime 类型矩阵。
- 八类 Runtime 输出统一使用 `schemaVersion: "1.0"`，不兼容、不修复 `0.1` 输出。
- TypeScript 类型、JSON Schema、示例、校验器、版本和 hash 必须来自同一注册项。

## 2. Runtime 输出注册中心

注册中心暴露：

```ts
getRuntimeOutputContract(kind)
listRuntimeOutputContracts()
validateRuntimeOutput(kind, value)
assertRuntimeContractsReady()
```

活动合同固定为：

| kind | contractId | version |
| --- | --- | --- |
| `agent_message` | `runtime.output.agent_message` | `1.0` |
| `task_acceptance_decision` | `runtime.output.task_acceptance_decision` | `1.0` |
| `task_brief` | `runtime.output.task_brief` | `1.0` |
| `task_execution_result` | `runtime.output.task_execution_result` | `1.0` |
| `file_revision_candidate` | `runtime.output.file_revision_candidate` | `1.0` |
| `post_review_report` | `runtime.output.post_review_report` | `1.0` |
| `final_delivery` | `runtime.output.final_delivery` | `1.0` |
| `user_message_handling_plan` | `runtime.output.user_message_handling_plan` | `1.0` |

所有对象节点必须为封闭对象（`additionalProperties: false`），所有属性必须列入 `required`；业务可空值用 `null`，空集合用 `[]`。`const`、`enum` 必须同时声明基础 `type`。Provider 和 Mapper 不得补默认值、转换旧 kind、清洗开放 metadata 或把缺字段响应改造成合法输出。

`file_revision_candidate` 只允许在 `phase='revision_synthesis'` 使用，必须返回完整候选正文，并绑定 `revisionId/chainId/iteration/sourceDraftHash/evidenceHash`。`incorporatedAgentResultIds` 必须覆盖本轮全部成功 Agent Result，存在未解决冲突、证据不完整、Hash 不匹配或输出容量不足时 fail closed。文件修订专业 Agent 和 Receiver 都使用 `proposal_only`；Invocation Resolver 在选择 Runtime 前就把能力要求和工具限制到 `read_file/search_code`，执行前再次移除 `write_file/run_test`、命令、待审批副作用工具，Artifact 后处理也不得写回 Workspace。

Adapter 可以通过 `maxStructuredOutputTokens({ modelId })` 声明当前模型的结构化输出硬上限。文件修订容量预检必须使用 `min(Session budget.maxOutputTokens, Runtime hard limit)`；无法容纳完整候选时返回 `REVISION_MODEL_CAPACITY_INSUFFICIENT`，不得依赖更大的 Session 配额绕过真实 Provider 上限。

启动时 `assertRuntimeContractsReady()` 会执行 Strict Schema Preflight、官方示例校验和重复合同检查。任何失败都会阻止 Runtime 接受任务。

## 3. InvocationPlan

```ts
type InvocationPlan = {
  invocationId: string
  sessionId: string
  taskId?: string
  phase: AgentRunPhase
  agent: CompiledAgentIdentity
  executionTarget: ResolvedExecutionTarget
  toolCatalog: ResolvedToolCatalog
  contextEnvelope: ContextEnvelopeV2
  expectedOutput: ExpectedRuntimeOutput
  budget: RuntimeBudget
  resume?: RuntimeResumeRequest
}
```

`InvocationPlan` 在 Runtime 启动前一次性解析。补充上下文、Profile revision、Tool 授权或 Workspace revision 改变时，必须重新构建整份 Plan。

## 4. 身份与执行目标

`CompiledAgentIdentity` 只记录 Agent、Profile、Skill、Tool 请求、Capability 和知识绑定快照。实际执行位置只记录在 `ResolvedExecutionTarget`：

```ts
type ResolvedExecutionTarget = {
  runtimeType: RuntimeType
  modelId?: string
  source: 'task_override' | 'session_preference' | 'project_policy' | 'smart_router' | 'global_default'
  reason: string
  requiredCapabilities: WorkspaceCapabilityKey[]
  requiredToolIds: string[]
  writeMode: 'none' | 'propose_changes' | 'proposal_only' | 'direct_audited'
  workspaceProviderKind: WorkspaceProviderKind
}
```

Agent Profile 不能提供或覆盖 `runtimeType/modelId`。无 eligible Runtime 时 fail closed。

## 5. Adapter metadata

```ts
type RuntimeAdapterMetadata = {
  name: string
  version: string
  category: 'external' | 'internal'
  provider: string
  capabilityIds: readonly string[]
  supportedWorkspaceCapabilities: readonly WorkspaceCapabilityKey[]
  supportedWorkspaceProviderKinds?: readonly WorkspaceProviderKind[]
  supportedToolNames: readonly string[]
}
```

`InvocationResolver` 从 `RuntimeRegistry.listAll()` 读取 metadata 并派生候选。未声明 workspace/tool 支持范围的 Adapter 对需要相应能力的调用不 eligible。

## 6. 单一 Adapter 协议

```ts
interface AgentRuntimeAdapter {
  type: RuntimeType
  metadata?: RuntimeAdapterMetadata
  start(input: InvocationPlan, signal?: AbortSignal): AgentRuntimeRunHandle
  checkAvailability?(): Promise<RuntimeAvailability>
  healthCheck?(): Promise<RuntimeHealthStatus>
}

interface AgentRuntimeRunHandle {
  events: AsyncIterable<AgentRuntimeEvent>
  result: Promise<AgentRunResult>
  cancel(): Promise<void>
}
```

约束：

- `start()` 同步返回本次 invocation 独占的句柄。
- `events` 只能发布本次 `invocationId` 的规范事件。
- `result` 必须有限时间内结束，并与终止事件状态一致。
- `cancel()` 必须幂等；取消后结果不得伪装为 completed。
- `AbortSignal` 与句柄取消作用于同一次 invocation。
- Adapter 本体不提供第二套 run/stream/cancel-by-id 协议。

## 7. ContextEnvelopeV2

Runtime 上下文固定为 L0-L6：

| Layer | 内容 |
| --- | --- |
| L0 | 系统规则、Agent/Profile、Tool Catalog hash、Workspace identity |
| L1 | Session goal、phase、task、bounded navigation |
| L2 | Project Map |
| L3 | 已选源码证据正文 |
| L4 | Tool 调用结果摘要 |
| L5 | Summary Memory bullets |
| L6 | ChangeSet/Report 引用 |

Workspace snapshot、manifest、selected evidence 旧结构和路由选择不得作为并行字段进入 Runtime。

## 8. Tool Authority

`ResolvedToolCatalog` 是以下条件的交集结果：Profile Tool 请求、Agent Capability、阶段策略、Workspace Provider、Adapter metadata 和审批。

```ts
type ResolvedToolCatalog = {
  tools: WorkspaceToolDescriptor[]
  decisions: ToolAuthorityDecision[]
  catalogHash: string
}
```

任何 blocked decision 都会在 Runtime 启动前返回 `CAPABILITY_BLOCKED`。

## 9. 事件与结果

所有事件和结果使用 `invocationId`：

```ts
type AgentRuntimeEvent = {
  invocationId: string
  type:
    | 'runtime_started'
    | 'runtime_progress'
    | 'runtime_completed'
    | 'runtime_failed'
    | 'tool_called'
    | 'tool_completed'
    | 'artifact_created'
  content: string
  visibility: 'user' | 'debug'
  metadata?: Record<string, unknown>
  createdAt: string
}
```

`AgentRunResult` 包含最终 status、结构化 output、events、`artifacts` 模型提案、`systemEvidence` 平台证据、usage、可选 CLI session、stream metrics、runtime diagnostics 和 error。`visibility` 必填；业务事件显式使用 `user`，Provider 内部通知与 stderr 显式使用 `debug`。任务接受输出唯一 kind 为 `task_acceptance_decision`。

Artifact 信任域固定拆分为：

```ts
type RuntimeArtifactProposal = {
  type: ArtifactType
  title: string
  content: string
  uri: string | null
  summary: string | null
  metadata: RuntimeArtifactProposalMetadata
}

type RuntimeArtifactSystemEvidence = {
  workspaceChangeSet: WorkspaceChangeSet | null
  verifiedTestResults: VerifiedTestResult[]
  capturedAt: string
  invocationId: string
}

type Artifact = {
  metadata: ArtifactMetadata
  runtimeProposals: RuntimeArtifactProposal[]
  platformProjections: RuntimeFileChange[]
  systemEvidence: RuntimeArtifactSystemEvidence | null
}
```

模型只能写严格白名单的 proposal metadata。执行阶段的 proposal 只能持久化到顶层 `runtimeProposals`。平台阶段生成、尚待写入或确认的文件只能写入 `platformProjections`，它不是模型 proposal，也不是已观测 evidence。真实文件扫描与真实测试结果只能由平台写入 `systemEvidence`，不得追加到 `output.changedArtifacts` 或伪装成模型 proposal。`ArtifactMetadata` 不包含 `output`、`fileChanges` 或 `validationEvidence`。

### 9.1 Codex app-server v2 输出组装边界

Codex app-server v2 的最终结构化内容以 `item/completed` 中 `type='agentMessage'` 的完成项为权威来源；`turn/completed` 只提供 Turn 终态、错误、`threadId` 和 `turnId`，不能假设其 `turn.items` 一定重复完整消息体。

Adapter 必须先按 Provider 协议把这两个事实组装成内部结果，再交给共享 Runtime 输出 validator。该步骤只组装传输层事实，不得补字段、转换旧 kind、包裹纯文本或修复不合法 JSON。完成的 Provider 输出帧及其 `item/agentMessage/delta` 增量不得进入用户聊天时间线；这些增量可能包含输出合同字段，只能保留在 Runtime Debug/Audit 边界。

Provider 内容字段必须是一个可直接 `JSON.parse` 的完整 JSON 对象。不得剥离 Markdown fence、截取首尾花括号、转义字符串中的裸控制字符，或接受 `result` / `output` / `final_output` 等非该 Provider 官方传输协议的本地包装别名。Generic LLM 可以在第一次结果被拒绝后发起一次新的、受审计的模型重生成请求，但不得修复并接收原始非法文本。

Codex Stub 必须模拟这一真实顺序：先发送包含最终 `agentMessage` 的 `item/completed`，再发送允许 `items: []` 的 `turn/completed`。只在 `turn.items` 中伪造完整结果会掩盖真实协议回归。

## 10. Resume

Resume 只允许通过 Plan 中的窄合同表达：

```ts
type RuntimeResumeRequest = {
  cliSessionId: string
  workDir?: string
}
```

仅同 Runtime、同 Workspace 绑定允许 resume。失败或 session mismatch 时最多执行一次 fresh fallback，并记录 `RESUME_FALLBACK`。

## 11. Debug 审计

`GET /api/sessions/:sessionId/debug/runtime-invocations` 分开返回：

- `invocationId`
- identity snapshot 与 Skill revisions
- `executionTarget`
- `toolCatalog` 与 decisions
- `contextEnvelope`
- `outputContract.contractId / contractVersion / schemaHash`
- `runtimeDiagnostics.providerNotifications / unknownNotificationCount / stderrTail`
- `dataEpoch`
- `systemEvidence.workspaceChangeSet / verifiedTestResults`
- usage、error、stream metrics 与 CLI session

内部 Provider 通知默认 `visibility='debug'`，只进入 Debug/Audit；用户时间线只接收平台明确生成的安全进度、工具事件和结构化错误。Provider 最终回答的原始文本增量不属于安全进度。

持久化 RuntimeInvocation 在启动时必须用 `expectedOutput.kind` 查询当前注册中心，并逐项比较 `contractId`、`contractVersion` 和 `schemaHash`。任一字段缺失或不一致都返回 `CUTOVER_REQUIRED`，不得只检查版本号后继续加载。运行失败从 Adapter、Orchestrator、ExecutionService 到 Session 事件必须保留完整 `RuntimeError.code / retryable / requestedContext / details`；前端错误卡不得只剩 `message` 和 `stack`。

CLI Provider 必须以 `shell: false` 和独立参数数组启动。`RUNTIME_INVOCATION_ERROR` 表示 executable 解析、进程启动或 CLI 参数校验阶段的确定性失败，默认 `retryable=false`；它不属于模型错误。用户时间线只能展示安全消息、阶段、错误码和 `diagnosticRef`，不得展示完整命令、JSON Schema、本机绝对路径或进程堆栈。原始 stderr 只能进入受控的 Runtime Debug/Audit 边界。

Provider 已启动后返回的 HTTP/网关错误不得归入 `RUNTIME_INVOCATION_ERROR`。HTTP 408、504、524 统一映射为可重试的 `RUNTIME_TIMEOUT`；HTTP 429 和 5xx 映射为可重试的 `MODEL_ERROR`；401/403 为不可重试的 `MODEL_ERROR`。结构化 `details` 至少保留 `providerFailure=true`、`stage='provider_response'`、`httpStatus` 和 `diagnosticRef`，存在安全的 `Retry-After`、网关 zone 或关联 ID 时分别写入 `retryAfterMs`、`gatewayZone`、`rayId`。原始 HTML、凭据和完整 Provider 响应不得进入用户错误消息。

讨论阶段遇到不可重试的 `RUNTIME_INVOCATION_ERROR`、`RUNTIME_OUTPUT_CONTRACT_VIOLATION` 或 `CAPABILITY_BLOCKED` 时必须 fail closed，停止剩余讨论和 Brief 生成；超时或明确可重试的模型错误可以按编排策略降级继续。

每轮 discussion 在 Agent fan-out 前必须统一刷新一次已配置 Runtime 的 availability，不能让每个 Agent 分别执行相同 preflight。不可用 Adapter 从本轮候选注册表移除，后续轮次检查恢复后可以重新注册。Generic LLM preflight 至少校验当前模型、endpoint 和凭据配置，并可调用非生成式 `/models` 探针确认网络、认证和限流状态；preflight 不应通过额外的计费生成请求验证模型。不支持 `/models`、返回 404/405 的兼容网关不得因此被误判为不可用。

真实调用确认是可重试的 provider 级故障（包括网络/网关失败、限流或服务端错误）时，Orchestrator 默认对同一 Runtime 重试一次，并尊重有上限的 `retryAfterMs`。再次失败后打开 Runtime circuit；只有 Session 的 `allowedRuntimeTypes` 显式列出备用 Runtime 时，才按 allowlist 顺序执行一次 fallback。未授权 Runtime、认证失败和合同错误不得自动降级。默认总 attempt 上限为 3，可通过受控环境变量调节，但不能突破 Session allowlist。

每次 retry/fallback 必须使用新的 `invocationId`，并在 RuntimeInvocation 审计记录中保存共同的 `attemptGroupId`、递增的 `attempt`、`retryOfInvocationId`、`fallbackFromRuntimeType` 和 `fallbackReason`。写能力调用必须继续使用按 invocation 隔离的工作区，不能复用失败 attempt 的部分输出。平台必须分别记录 retry、circuit 和 fallback 事件，使 UI 能展示真实阶段与尝试链路，而不是只显示最终错误。

不得把身份、目标和工具授权合并成可互相覆盖的 Runtime Profile。

## 12. Managed Workspace Execution

### 12.1 Server-local Git worktree

For a write-capable `task_execution` invocation using Codex or Claude Code against a `server_local` workspace, RuntimeService delegates workspace preparation and capture to `apps/server/src/modules/worktree-execution/`.

The adapter still owns the CLI process and uses the invocation-bound work directory. The worktree module owns only:

- isolated `sessionId/taskId` worktree creation or restore;
- dirty source baseline materialization without changing the source branch or index;
- platform-authoritative `WorkspaceChangeSet` calculation from real file changes;
- proposal metadata and source working-tree conflict hashes.

Managed results include `workspaceExecution` with `mode: 'git_worktree'` and `requiresUserConfirmation: true`. Orchestrator must not automatically apply their source changes. See `docs/design/managed-worktree-execution-v1.md` for lifecycle and limits.

## 13. Structured Termination

`AgentRunResult.termination` is the authoritative reason for an interrupted or timed-out invocation. The supported kinds are `user_cancelled`, `frontend_disconnected`, `runtime_disconnected`, `phase_timeout`, `runtime_timeout`, `service_shutdown`, `superseded`, and `maintenance`. `frontend_disconnected` is deprecated and retained only to decode historical persisted results; current browser SSE disconnects never produce this termination. A Local Runtime transport disconnect remains `runtime_disconnected` and interrupts its invocation.

Server Codex and Claude Code invocations have lifecycle limits independent of SSE in both streaming and buffered modes: the default absolute deadline is 30 minutes and Worker concurrency defaults to 4. Each isolated platform Worker has a default V8 old-space ceiling of 512 MB; that ceiling does not constrain the RSS or heap of the CLI process spawned by the Worker. Production deployments that require a hard process-tree memory ceiling must add an OS job object, cgroup, or container limit. Deployments may tune the documented limits but must not make browser presence their resource-control mechanism.

Adapters must not infer user intent from native exception text. Upstream cancellation is carried in `AbortSignal.reason`; Runtime-owned watchdogs produce `runtime_timeout`. During compatibility migration, `RuntimeError.termination` is dual-written and existing `RUNTIME_CANCELLED` / `RUNTIME_TIMEOUT` codes remain available.

User-visible event content must use the safe termination message. Native process, provider, or AbortError details belong only in sanitized Debug/Audit data. See `docs/design/execution-termination-model-v1.md`.
