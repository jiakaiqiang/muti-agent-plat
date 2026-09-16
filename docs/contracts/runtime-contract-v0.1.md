# Runtime Contract：Context v2 + Versioned Output Contracts

主 Agent 协作新增身份/策略合同见 [阶段 0 冻结合同](./main-agent-collaboration-contract-v1.md)。ContextEnvelopeV2、InvocationPlan 和 Tool Authority 的现有边界不变；合同资格校验不等于模型调用已获授权。

## 1. 目标

群聊中断与纠正补充（2026-09-14）：本地 invocation.cancel 后以 CLI 子进程结束后发送的 invocation.result 或受支持的 stopped 回执确认停止；平台等待回执，超时或停止期间断线以 `details.stopUnconfirmed=true` 表达未知，不规范化成“已经停止”。未确认调用登记保留至匹配设备/工作区的结束回执，迟到结果不应用业务内容。契约生成/修订默认总时限 1200000ms，覆盖 Provider 重试；新操作的 0 或无效配置采用有限默认值并记录诊断，不关闭操作总预算。StructuredOutput 纠正按 toolCallId 去重，默认纠正时限 300000ms，并受同一 LogicalOperation 的截止、尝试上限及一次纠正额度限制；达到边界取消当前句柄。流式和最终返回事件共用统计；无法观察的 CLI 内部调用次数仍未知。输出合同错误及停止未确认不触发 Provider 自动重试。

本合同定义 Runtime 的唯一活动输入、路由元数据、执行句柄、输出和审计边界。Runtime 输出的唯一权威源是 `packages/shared/src/runtime-contracts/`；其余 Runtime 类型以 `packages/shared/src/contracts.ts` 为准。

核心约束：

- Agent 身份不包含 Runtime/Model 选择。
- Runtime 只消费不可变 `InvocationPlan`。
- Context 只使用 `ContextEnvelopeV2`。
- Adapter 只暴露 `start()`，事件、结果和取消都属于本次调用句柄。
- Router 只从 Adapter metadata 获取能力，不在 Orchestrator 维护 Runtime 类型矩阵。
- 八类领域 Runtime 输出继续使用 `schemaVersion: "1.0"`；新增协商式 `task_execution_result@2.0` 最小提交。两者均严格校验，不兼容、不修复 `0.1` 输出。
- TypeScript 类型、JSON Schema、示例、校验器、版本和 hash 必须来自同一注册项。

## 2. Runtime 输出注册中心

注册中心暴露：

```ts
getRuntimeOutputContract(kind)
getVersionedRuntimeOutputContract(kind, version)
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
| `task_execution_result`（协商式最小提交） | `runtime.output.task_execution_result` | `2.0` |
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
- 上游 `AbortSignal` 中止时，RuntimeService 必须调用本次句柄的 `cancel()`；Local Runtime 必须继续向桥接 CLI 传播取消并终止对应模型进程树，随后在有限时间内结束 `result` 和事件流。
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

### 9.2 Workflow 接单与质量决策语义

`task_acceptance_decision@1.0` 的 Schema 保持不变，但所有 Runtime adapter 必须使用同一提示语义：

- Agent 已具备执行当前任务的职责和上下文时必须返回 `accepted`。质量工程师能够执行验收时同样必须先接单，不能用 `rejected` 表达上游成果存在缺陷。
- `blocked` 只表示接单前缺少完成任务所必需的上下文；`missingContext/requestedContext` 必须描述缺少什么。
- `rejected` 只表示能力、职责或政策与任务不匹配；它会进入显式改派、跳过或取消决策点。
- Agent 接单后的运行错误或不完整输出属于执行阶段，不得伪装成接单拒绝。

`robot_approval` 仍通过既有 `task_execution_result@1.0` 返回结果，但 `summary` 必须是一个不带 Markdown 包装的严格 JSON 对象，且只能包含以下四个字段：

```ts
type WorkflowRobotDecision = {
  decision: 'approve' | 'revise' | 'reject'
  reason: string
  revisionInstruction: string | null
  evidenceRefs: string[]
}
```

四个字段全部必填，不接受额外字段。`revise` 必须携带非空 `revisionInstruction`，表示普通、可修复的质量问题；`approve/reject` 的 `revisionInstruction` 必须为 `null`。`reject` 仅用于不可恢复或政策性拒绝，并会终止整个 Workflow。非法 JSON、错误字段、机器人运行异常或超过返工上限统一转人工确认，不允许 Adapter 或编排器猜测、补写或修复模型决策。

## 10. Resume

Resume 只允许通过 Plan 中的窄合同表达：

```ts
type RuntimeResumeRequest = {
  cliSessionId: string
  workDir?: string
}
```

仅同 Runtime、同 Workspace 绑定允许 resume。失败或 session mismatch 时最多执行一次 fresh fallback，并记录 `RESUME_FALLBACK`。

Workflow 处于 `pendingAgentSubstitution` 或 `pendingUpstreamRerun` 时不属于 Runtime resume：普通 continue 和服务启动恢复都不得启动新 invocation。只有携带当前 `confirmationId` 的显式改派、跳过、上游重跑、重试当前或取消操作可以解除停车状态。

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

真实调用确认是可重试的 provider 级故障（包括网络/网关失败、限流或临时服务端错误）时，Orchestrator 默认对同一 Runtime 重试一次。`retryAfterMs` 必须落在剩余操作时间内，否则停止自动尝试。熔断按连接/模型/协议隔离；只有 Session 的 `allowedRuntimeTypes` 显式列出备用 Runtime 时，才允许 fallback。未授权 Runtime、认证失败和合同错误不得自动降级；HTTP 424 仅在已识别结构化故障码下重试。长操作总平台 attempt 上限为 3、短控制操作为 2，环境重试设置不能突破操作预算或 Session allowlist。

每次 retry/fallback 必须使用新的 `invocationId`，并在 RuntimeInvocation 审计记录中保存共同的 `attemptGroupId`、递增的 `attempt`、`retryOfInvocationId`、`fallbackFromRuntimeType` 和 `fallbackReason`。写能力调用继续使用按 invocation 隔离的工作区；失败产物仅可经下述可信候选协议恢复，不能直接复用未验证输出。平台分别记录 retry、circuit 和 fallback 事件，使 UI 能展示真实阶段与尝试链路。

不得把身份、目标和工具授权合并成可互相覆盖的 Runtime Profile。

## 12. Managed Workspace Execution

### 12.1 Server-local isolated execution

For a write-capable `task_execution` invocation using Codex or Claude Code against a `server_local` workspace, RuntimeService delegates workspace preparation and capture to `apps/server/src/modules/worktree-execution/`.

The adapter still owns the CLI process and uses the invocation-bound work directory. The worktree module owns only:

- isolated `sessionId/taskId` worktree creation or restore;
- dirty source baseline materialization without changing the source branch or index;
- platform-authoritative `WorkspaceChangeSet` calculation from real file changes;
- proposal metadata and source working-tree conflict hashes.

Git repositories use `mode: 'git_worktree'`. The selected directory may be the repository root or a nested directory; captured paths remain relative to the selected directory and changes outside that scope fail closed.

Non-Git directories use `mode: 'staging_copy'`. Read-only tasks may run concurrently, while write-capable task execution is serialized per normalized source directory across staging, Runtime execution, capture, and writeback.

Completed write-capable results default to `requiresUserConfirmation: false`. Orchestrator enqueues their `WorkspaceChangeSet` into the per-workspace FIFO writeback service. `proposal_only` remains confirmation-gated and is not automatically written back.

### 12.2 Local bridge isolated execution

Codex and Claude Code in Local Runtime execute against a Local Runtime-owned staging copy, never directly in the registered source directory. The CLI returns `workspaceExecution.mode: 'staging_copy'` and a bounded UTF-8 `WorkspaceChangeSet`; the platform sends that ChangeSet back through the registered Workspace Provider for the same FIFO writeback and conflict workflow used by `server_local`.

### 12.3 Merge and recovery

Every update/delete carries the captured base hash; text updates may also carry `baseContent`. If the current file changed, Provider apply attempts a conservative three-way merge (`base`, current workspace, Session candidate). Non-overlapping edits merge automatically. Overlapping edits return `WORKSPACE_MERGE_CONFLICT` without partial writes. Each apply batch snapshots touched paths and restores the whole batch if an apply-time race or filesystem error occurs.

Persisted writebacks in `queued/merging/applying` become retryable failures after backend restart. The corresponding Session is restored to `WAIT_WORKSPACE_CONFLICT_RESOLUTION`; Runtime commands are not replayed automatically.

Parallel task writebacks form a Session-level barrier: any `conflicted/failed` record keeps the Session waiting; otherwise any `queued/merging/applying` record keeps it applying; execution resumes only after every record is terminal. Resolution actions are accepted only from blocking states; replayed or competing terminal actions fail closed. PostgreSQL deployments persist the complete writeback record in schema migration V4. Rollback compares the current path with the batch's last written value and never overwrites a later user edit. A Local Runtime one-time `workspace_delete` grant is scoped by Workspace, ChangeSet ID, and canonical full-ChangeSet digest, survives WebSocket reconnects in the running bridge, is consumed after successful apply, and expires after 30 minutes.

See `docs/design/managed-worktree-execution-v1.md` for lifecycle and limits.

## 13. Structured Termination

`AgentRunResult.termination` is the authoritative reason for an interrupted or timed-out invocation. The supported kinds are `user_cancelled`, `user_paused`, `frontend_disconnected`, `runtime_disconnected`, `phase_timeout`, `runtime_timeout`, `service_shutdown`, `superseded`, `maintenance`, and `output_contract_failure`. `user_paused` is resumable and must preserve the Session workflow checkpoint. `frontend_disconnected` is deprecated and retained only to decode historical persisted results; current browser SSE disconnects never produce this termination. A Local Runtime transport disconnect remains `runtime_disconnected` and interrupts its invocation.

Server Codex and Claude Code invocations have lifecycle limits independent of SSE in both streaming and buffered modes: the default absolute deadline is 30 minutes and Worker concurrency defaults to 4. Each isolated platform Worker has a default V8 old-space ceiling of 512 MB; that ceiling does not constrain the RSS or heap of the CLI process spawned by the Worker. Production deployments that require a hard process-tree memory ceiling must add an OS job object, cgroup, or container limit. Deployments may tune the documented limits but must not make browser presence their resource-control mechanism.

Adapters must not infer user intent from native exception text. Upstream cancellation is carried in `AbortSignal.reason`; Runtime-owned watchdogs produce `runtime_timeout`. During compatibility migration, `RuntimeError.termination` is dual-written and existing `RUNTIME_CANCELLED` / `RUNTIME_TIMEOUT` codes remain available.

User-visible event content must use the safe termination message. Native process, provider, or AbortError details belong only in sanitized Debug/Audit data. See `docs/design/execution-termination-model-v1.md`.

## 14. 执行可靠性协议（2026-09-14）

`InvocationPlan.operation` 携带持久化操作的 id、deadlineAt、policyVersion、maxAttempts。系统 RuntimeInvocation 和 Orchestrator 共用 RuntimeService 监督入口，启动前原子预留额度；路由重建、上下文补充、Provider 重试和提交修复不能重置截止。短控制操作 120 秒/2 次，长阶段使用有效配置/3 次，暂停后显式恢复仅使用剩余额度。停止请求后最多等待 15 秒确认；未知停止保留屏障，匹配回执只能清屏障，不能提交迟到业务成功。进程内 mock 的恢复豁免不适用于工程 CLI。

`task_execution_result@2.0` 的严格字段为 kind、schemaVersion、status、summary、artifactRefs、blockers、nextActions。仅支持此版本的 Local Runtime 写任务默认协商启用，`proposal_only` 保持原合同。操作冻结 `outputContractKey`。平台根据实际捕获 ChangeSet 的路径白名单生成领域 v1 结果，不接受伪造产物或测试通过；completed 且存在 blockers 为非法。

共享合同模块导入不得立即触发 Ajv 动态代码编译：最小提交校验器在首次 validate 时初始化并缓存，服务端启动 preflight 仍调用 validate 严格校验。桌面仅导入共享类型/数据时不执行该编译，继续保留 `script-src 'self'`、sandbox 和 contextIsolation；不能通过增加 unsafe-eval 修复白屏。真实 Electron CSP 渲染验证入口为 `npm run test:e2e:desktop-render`。

`recoveryCandidate` 保存进程结束后的 ChangeSet，最大 1 MB、7 天有效，原提交最大 256 KB。恢复前验证 session/workItem/task、授权的 recoveryOriginTaskId、权限 hash、manifest hash、基线及输出版本。`submissionRepair` 只允许已有候选的格式修复；Claude 禁工具和副作用权限，启用 `--safe-mode`，不允许自定义 CLI 参数，并核对修复前后文件 hash；Codex 当前不支持自动格式修复。安全能力缺失或纠正额度耗尽时保留候选并停车，不回退普通开发。候选失效必须明确告知原因。

可观察 StructuredOutput 错误与平台修复共享一次纠正额度；流事件与最终事件去重。调用结果必须等待已知额度记账完成，但不能无限等待已结束进程的损坏事件迭代器。监督读写失败请求取消并返回非重试错误，禁止以成功推进。

Local Runtime 可选握手 `stopReceiptProtocol: 1`：客户端在真实进程结束后持久化 `local_runtime.invocation.stopped`，断线重连/心跳重传，服务端匹配 invocation/device/workspace/runtime 并持久化后返回 `local_runtime.invocation.stop_ack`。回执不含业务产物；客户端最多保留 256 个待确认回执，满额阻止新调用。旧客户端保留 invocation.result 路径，未核实的历史进程不得自动重放。

结束事实与停止通知分离：回执在最新的逻辑操作事务内校验绑定并结束 activeInvocation；只有该操作原先存在 `unconfirmed` / `pauseRequested`，或连接层存在精确匹配的未确认停止，才发布停止确认通知。正常完成只落库与 ack；重复回执保持幂等，不重复提示用户继续，也不能结束后续的新调用。

失败恢复的 HTTP `/sessions/:id/resume` 与明确的“继续”命令使用相同入口。契约生成/修订失败恢复到 AGENT_DISCUSSING；任务执行失败且已有契约时恢复执行。旧版缺失契约后误入用户决策的会话按状态事件证据回到生成阶段。停止未确认时仍拒绝重试；重复已批准的 resume 确认不重复启动，旧确认不能处理当前新的恢复检查点。工作流改派、返工选择和危险动作批准仍必须使用各自的明确操作。

`operationTelemetry` 记录平台准备、首次有效输出时间、可观察工具区间和未分类耗时；queueWaitMs、upstreamWaitMs、billableTokens 无可信来源时为 null。reported_cumulative 用量不等于计费量；未知连接/模型不得推断。规则接单只确认任务可执行，不代表 QA approve。实现及验收边界见 [可靠性计划](../design/agent-execution-reliability-plan-v1.md)。

## 15. 停止状态一致性（2026-09-15）

Runtime 结束路径无条件清理监督句柄、计时器和 Abort 监听器。逻辑操作 `settle` 失败时，原业务结果不得作为成功交付；服务返回 `STOP_STATE_PERSISTENCE_FAILED` 诊断并登记内存待同步屏障。同步按 1/2/5/10/30 秒最多五轮有限退避，耗尽后保持 `stop_state_sync_exhausted`，只有显式核对成功才能解除。

Session 停止先在事务中冻结目标，再向当时监督中的 invocation 发送取消。`result` 与 `local_runtime.invocation.stopped` 共享可信结束入口：必须精确匹配 invocation、device、workspace 和 runtime；先到的 stopped 可以结束 handle 并 ACK，但不应用业务结果或 ChangeSet，后到的 result 只能用于幂等核对，不能翻转终态或更新 workspace revision。

重复回执只返回 ACK。停止通知仅在目标状态实际推进时生成，正常完成保持静默；服务端不得因为发布失败、ACK 丢失或客户端重传而产生第二次用户通知。
