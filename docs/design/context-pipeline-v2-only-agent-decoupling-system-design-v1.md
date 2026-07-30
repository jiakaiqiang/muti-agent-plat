# Context Pipeline v2 单轨与 Agent 解耦系统设计 v1

> 日期：2026-07-12
> 状态：设计基线已实现；空 v2 全链路验收已完成，真实数据切换待独立授权
> 上游需求：[`../product/context-pipeline-v2-only-session-requirements-v1.md`](../product/context-pipeline-v2-only-session-requirements-v1.md)
> 下游开发：[`../implementation/context-pipeline-v2-only-agent-decoupling-development-v1.md`](../implementation/context-pipeline-v2-only-agent-decoupling-development-v1.md)
> 覆盖范围：本设计覆盖旧设计中关于 v1/v2 并存、Session 固化 Runtime/Model、Agent Runtime override 和历史兼容迁移的描述

## 1. 设计目标

系统只保留一条 v2 执行链路，并在结构上分离以下四类职责：

1. Agent Identity：Agent 是谁、遵循什么规则、引用哪些 Skill 和 Tool、拥有哪些 Capability。
2. Invocation Context：当前任务、阶段、证据、Workspace、状态和预算。
3. Execution Target：本次调用实际使用哪个 Runtime/Model，以及选择原因。
4. Tool Authority：本次调用真实允许使用哪些工具，以及每项允许或拒绝的依据。

完成后，切换 Runtime 只改变 Invocation 的执行目标和适配器，不改变 Agent 身份、Skill、Tool 意图、Capability 或知识绑定。

## 2. 架构约束

### 2.1 不变量

- Agent 持久化合同不包含实际执行用的 `runtimeType`、`modelId` 或 `runtimeSelection`。
- Runtime/Model 只存在于 `ResolvedExecutionTarget` 和 Invocation 审计中。
- Profile Markdown 是 Skill/Tool 引用的事实来源；Tool 引用不授予权限。
- `ContextEnvelopeV2` 是 Runtime 唯一权威上下文载荷。
- 无 eligible Runtime、无有效 Tool 权限或无必要 Evidence 时 fail closed。
- 不存在 v1 feature flag、v1 Orchestrator 分支或历史数据 fallback。
- 切换前的产品业务数据从活动数据集全部删除，不迁移、不提供在线归档或导出；替换前生成外部加密只读审计归档且不可恢复。

### 2.2 允许保留的运维配置

历史业务数据删除不等于清空部署环境。以下内容不属于历史 Session 数据，可以保留：

- Runtime endpoint、模型连接和加密凭据。
- 环境变量、Redis/PostgreSQL 连接和队列前缀。
- 代码内置 Runtime Adapter、Tool Adapter 和系统默认策略。
- 部署日志中不含业务正文的最小切换审计摘要。

Agent、Skill、Capability、Knowledge、Autopilot 等产品业务配置在切换时重置为 v2 基线；系统默认 Agent 和 Capability 由新代码重新 seed。

## 3. 当前问题映射

| 当前问题 | 目标修正 |
| --- | --- |
| `Agent` 和 `RuntimeAgentProfile` 仍携带 Runtime/Model 字段 | 拆为 `AgentDefinition` 与 `CompiledAgentIdentity`，不含执行目标 |
| `selectEngineeringRuntime()` 仍读取 Agent/Session override | 删除旧选择器，由单一 `InvocationResolver` 解析目标 |
| 动态路由发生在部分事件和 preflight 之后 | 先解析完整 `InvocationPlan`，再发出 runtime_started 和执行审批 |
| `${tool:key}` 主要展开说明文字 | 编译结果进入 `ResolvedToolCatalog` 并驱动真实 Adapter 工具绑定 |
| `availableTools` 只覆盖 Generic LLM 单个读取工具 | 建立跨 Runtime 的规范化 Tool Catalog 和 Adapter 翻译层 |
| ContextPack 同时携带 Envelope 和旧 Workspace 字段 | Runtime 输入只保留 `ContextEnvelopeV2` |
| 历史数据分散在多个 collection 和队列 | 专用 cutover 命令执行 dry-run、停写、终止、重置和审计 |

## 4. 目标架构

```text
AgentDefinition
  -> AgentProfileCompiler
  -> CompiledAgentIdentity
       + requested Skill bindings
       + requested Tool bindings
       + Capability grants

Session + Task + Phase + Workspace
  -> InvocationRequirementResolver
  -> RuntimeRouter
  -> ResolvedExecutionTarget
  -> ToolAuthorityResolver
  -> ResolvedToolCatalog
  -> ContextEnvelopeV2 Builder
  -> InvocationPlan
  -> RuntimeAdapter
  -> InvocationAudit
```

主要模块边界：

| 模块 | 职责 | 禁止职责 |
| --- | --- | --- |
| Agents | 保存和管理 Agent Definition | 选择 Runtime/Model |
| Agent Profile | 解析 Markdown、Skill、Tool 引用 | 授予 Tool 权限、启动 Runtime |
| Runtime Routing | 计算 eligible Runtime 和实际目标 | 修改 Agent 身份 |
| Tool Authority | 计算真实 Tool Catalog | 从 Markdown 自动扩权 |
| Context v2 | 组装 L0-L6 Envelope 和证据门禁 | 决定 Agent 或 Runtime 身份 |
| Workspaces | 提供文件、搜索、ChangeSet 和能力声明 | 绕过 Capability/审批 |
| Runtimes | 翻译并执行统一 Invocation Plan | 自行重选 Agent、Tool 或 Runtime |
| Persistence Maintenance | dry-run 和执行切换重置 | 在普通启动路径自动删除数据 |

## 5. 核心合同

### 5.1 Agent Definition

```ts
type AgentDefinition = {
  id: UUID
  key: string
  name: string
  role: string
  description?: string
  profileMarkdown: string
  tags: string[]
  status: 'active' | 'disabled'
  capabilityIds: UUID[]
  defaultKnowledgeBaseIds: UUID[]
  profileRevision: number
  createdAt: ISODateTime
  updatedAt: ISODateTime
}
```

删除字段：`runtimeType`、`modelId`、持久化 `skillIds` 和任何 Agent 级 Runtime override。

`skillIds` 不再作为第二事实来源。列表和详情需要 Skill 绑定时，由 Profile Compiler 解析结果派生。

### 5.2 Compiled Agent Identity

```ts
type CompiledAgentIdentity = {
  agentId: UUID
  key: string
  name: string
  role: string
  systemPrompt: string
  profileHash: string
  profileRevision: number
  skillBindings: Array<{
    id: UUID
    key: string
    revision: number
    contentHash: string
  }>
  requestedToolIds: UUID[]
  requestedToolKeys: string[]
  capabilityIds: UUID[]
  knowledgeBaseIds: UUID[]
}
```

该合同表达 Agent 身份快照，不包含 Runtime/Model。

### 5.3 Session Runtime Preference

系统只有 v2，因此 `SessionDetail` 不再需要 `contextPipelineVersion` 参与行为分流。Health 可以继续报告产品级 `pipelineVersion: 'v2'`。

```ts
type RuntimePreference = {
  preferredRuntimeType?: RuntimeType
  preferredModelId?: string
  allowedRuntimeTypes?: RuntimeType[]
}

type SessionDetail = {
  // existing v2 session fields
  runtimePreference?: RuntimePreference
}
```

`runtimePreference` 只是路由输入。它不能绕过 Runtime 可用性、Task 能力、Workspace 能力、Tool Authority 或人工审批。

删除 `executionTarget` 固化语义、`engineeringRuntime.agentRuntimeOverrides`、`engineeringRuntime.sessionDefaultRuntimeType` 和 `contextPipelineVersion` 的运行时分流语义。

### 5.4 Resolved Execution Target

```ts
type ResolvedExecutionTarget = {
  runtimeType: RuntimeType
  modelId?: string
  source: 'task_override' | 'session_preference' | 'project_policy' | 'smart_router' | 'global_default'
  reason: string
  requiredCapabilities: WorkspaceCapabilityKey[]
  requiredToolIds: UUID[]
  writeMode: 'none' | 'propose_changes' | 'direct_audited'
  workspaceProviderKind: WorkspaceProviderKind
}
```

路由优先级：

```text
eligible task override
  > eligible session preference
  > eligible project policy
  > smart router
  > eligible global default
  > CAPABILITY_BLOCKED
```

任何候选都必须先进入 eligible 集合。Agent 不提供候选优先级。

### 5.5 Resolved Tool Catalog

```ts
type ToolAuthorityDecision = {
  toolId: UUID
  toolKey: string
  status: 'allowed' | 'blocked'
  reasons: string[]
  approvalId?: UUID
}

type ResolvedToolCatalog = {
  tools: WorkspaceToolDescriptor[]
  decisions: ToolAuthorityDecision[]
  catalogHash: string
}
```

真实工具集合：

```text
Profile requested tools
  INTERSECT Agent capability grants
  INTERSECT phase policy
  INTERSECT Workspace Provider capabilities
  INTERSECT Runtime Adapter supported tools
  INTERSECT human approval result
```

Tool 未被 Agent Profile 引用时，默认不进入 Catalog。系统内部必需且不对模型暴露的控制能力不使用 `${tool:key}`，由 Orchestrator 自己执行。

### 5.6 Invocation Plan

```ts
type InvocationPlan = {
  invocationId: UUID
  sessionId: UUID
  taskId?: UUID
  phase: AgentRunPhase
  agent: CompiledAgentIdentity
  executionTarget: ResolvedExecutionTarget
  toolCatalog: ResolvedToolCatalog
  contextEnvelope: ContextEnvelopeV2
  expectedOutput: RuntimeOutputContract
  budget: RuntimeBudget
  resume?: {
    cliSessionId: string
    workDir?: string
  }
}
```

Runtime Adapter 只消费 `InvocationPlan`，不再消费带旧 Workspace 字段和 Runtime Agent 字段的混合 `ContextPack`。

## 6. Agent Profile、Skill 和 Tool 编译

### 6.1 引用语法

```markdown
${skill:element-plus-ui}
${tool:tool.file_write}
```

- stable key 大小写规则由资源合同统一定义。
- 转义 `\${skill:key}` 保留原文。
- fenced code 和 inline code 内不解析。
- 重复引用、未知引用、禁用资源、未配置 Tool 和缺失 Capability 都是保存阻断错误。

### 6.2 编译时机

- Agent 创建和更新时编译，保存前阻断错误。
- 每次 Invocation 再编译一次，捕获 Skill revision 或 Tool 状态变化。
- 编译结果按 `profileRevision + resource revisions + capability hash` 缓存。
- Invocation 使用不可变快照，不在运行中热替换 Skill 或 Tool。

### 6.3 Skill 注入

- Skill 正文和文件只进入编译后的 `systemPrompt` 一次。
- `ContextEnvelopeV2` 只引用 Skill 快照元数据，不重复注入正文。
- Invocation Audit 记录 Skill ID、revision 和 contentHash。

### 6.4 Tool 执行

- Compiler 输出 requested Tool，不输出最终权限。
- Tool Authority Resolver 输出 Catalog 和拒绝原因。
- Generic LLM 将 Catalog 转为模型 tool schema，并执行工具循环。
- Codex/Claude Adapter 将 Catalog 转为其可执行工具、sandbox 和审批配置。
- Adapter 无法强制 Catalog 边界时，该 Runtime 对本次 Invocation 不 eligible。

## 7. Invocation 解析与执行时序

```text
1. Load Session / Task / AgentDefinition
2. Compile Agent Profile
3. Build task + phase + workspace requirements
4. Resolve eligible Runtime candidates
5. Select ResolvedExecutionTarget
6. Resolve Tool Authority and approvals
7. Build budgeted ContextEnvelopeV2
8. Apply grounded evidence gate
9. Persist InvocationPlan snapshot
10. Emit runtime_started
11. Start selected Runtime Adapter
12. Stream events and tool audit
13. Persist result and final audit
```

关键要求：

- `runtime_started` 中的 Runtime 必须与最终 Adapter 一致。
- 高风险 Tool preflight 必须针对最终 target/catalog 执行。
- Route、Tool、Context 任一阶段失败，都不得启动 Runtime。
- `CONTEXT_INSUFFICIENT` 补读后从第 3 步重新解析，避免使用过期 Workspace 能力或 Tool Catalog。
- `requestedContext` 必须通过严格 normalizer；非法 type、空 reason 和非结构化字段不得进入重试链。
- 每轮最多接受 32 个去重路径、实际读取前 8 个，其余进入 `deferredPaths`；读取结果记录 `hydratedPaths / failedPaths / deferredPaths / contentBytes`。
- 只有 hydrate 成功的路径才进入下一轮 Evidence 和 seen 集合；失败路径可按错误码重试，command 在真正执行前不能当作已提供上下文。

## 8. Context Pipeline v2

`ContextEnvelopeV2` 必填，L0-L6 语义保持：

| Layer | 内容 |
| --- | --- |
| L0 | System policy、Agent identity/profile hash、Tool catalog hash、Workspace identity |
| L1 | Session goal、Task、阶段和 Workspace navigation |
| L2 | Project/Domain Map |
| L3 | Grounded Evidence 内容 |
| L4 | 已执行 Tool 调用结果 |
| L5 | 有界 Summary Memory |
| L6 | ChangeSet、Report 和 Delivery refs |

Runtime 边界不再发送 `workspaceSnapshot`、`workspaceManifest`、`selectedEvidenceContents`、`projectMap` 或 `runtimeSelection`。这些结构可以在服务端组装阶段存在，但不得进入 Adapter 输入。

架构分析使用专用 Evidence 排序：优先实际入口、package/config、model/chain/RAG/memory/tool、服务/路由/合同和前端入口；嵌套 demo 的通用 `index.ts` 不得挤掉真实数据流模块。AGENTS、README 和设计文档只作为导航声明，必须与当前源码正文交叉核验。grounded evidence gate 要求架构分析在每个 Runtime 阶段至少拥有一份可读 L3 正文，否则 fail closed 并补读。

## 9. Runtime Adapter

所有 Adapter 实现统一接口：

```ts
type RuntimeAdapter = {
  metadata: {
    runtimeType: RuntimeType
    supportedWorkspaceCapabilities: WorkspaceCapabilityKey[]
    supportedToolNames: string[]
  }
  checkAvailability(planRequirements): Promise<RuntimeAvailability>
  start(plan: InvocationPlan, signal?: AbortSignal): AgentRuntimeRunHandle
}
```

`AgentRuntimeRunHandle` 统一提供 `events`、`result` 和 `cancel()`；Adapter 不再并存 `run/stream` 两套协议。

`RuntimeAdapterMetadata.supportedWorkspaceCapabilities` 与 `supportedToolNames` 是路由能力的唯一声明来源。`InvocationResolver` 从 `RuntimeRegistry` 派生候选；Orchestrator 不维护 Runtime 类型 switch 或工具白名单。

Adapter 禁止从 Agent Definition 读取 Runtime/Model、自行添加 Catalog 外工具、静默降级或以 mock 结果冒充真实 Runtime 成功。

## 10. API 与前端

### 10.1 Agent API

创建和更新请求移除 `runtimeType`、`modelId` 和客户端权威 `skillIds`。Profile 校验响应返回编译摘要、Skill bindings、requested Tools 和 diagnostics。

### 10.2 Session API

创建请求允许可选 `runtimePreference`，不接受旧 `engineeringRuntimeType`、`engineeringRuntime` 或 `executionTarget`。历史 Session 不存在于新数据集，因此列表和详情不实现旧数据分支。

### 10.3 Debug 与 Health

- Health 报告 `pipelineVersion: 'v2'`、`dataSchemaVersion: 3`、`dataEpoch`、`processId`、`startedAt`、`commit`、`persistenceBackend` 和不含凭据的 `persistenceLocation`。
- Debug 分开显示 Agent Profile、Skill snapshot、Tool Authority、Execution Target 和 Context Envelope 摘要。
- Debug 不显示 Agent override 或旧 Runtime selection source。

### 10.4 前端职责

- Agent 管理：Profile Markdown、Skill/Tool 引用、Capability 和诊断。
- Runtime Model 管理：模型连接、可用性和项目/全局策略，不编辑 Agent。
- Session 创建：任务、Workspace、Agent 和可选 Runtime preference。
- Runtime 视图：展示实际 `ResolvedExecutionTarget` 和 Tool Authority，不把它显示为 Agent 固有属性。
- 前端启动先读取 Health；pipeline/schema 不匹配，或配置了 `VITE_AGENT_CLUSTER_COMMIT` 且 commit 不匹配时，禁止列出、加载、创建和 resume Session。

## 11. 持久化和切换

### 11.1 数据 Epoch

```ts
type SystemDataMetadata = {
  dataSchemaVersion: 3
  dataEpoch: UUID
  pipelineVersion: 'v2'
  cutoverAt: ISODateTime
  cutoverAuditId: UUID
}
```

服务启动时如果缺失该元数据或版本不匹配，返回 `CUTOVER_REQUIRED` 并拒绝加载业务模块；不得自动 backfill 或自动删除。

### 11.2 删除范围

切换重置以下产品业务数据：

- `sessions`
- `eventsBySession`
- `tasksBySession`
- `briefsBySession`
- `suggestedTasksByBriefId`
- `artifacts`
- `memoriesBySession`
- `runtimeInvocationsBySession`
- `autopilotRuns` 和关联队列 Job
- `agents`、`skills`、`capabilities`、`knowledge`、`autopilots`

随后用 v2 新合同重新 seed 系统默认 Agent 和 Capability。自定义 Agent、Skill、Tool/Capability、Knowledge 和 Autopilot 不迁移。

保留 Runtime 模型连接和加密凭据等运维配置；它们不属于 Agent/Profile 或历史 Session 业务数据。

平台生成的 Artifact 文件只有位于平台数据根目录内才允许删除。任何 Workspace、用户源码目录或外部 URI 都不得跟随删除。

### 11.3 Cutover 命令

```text
node scripts/cutover-context-v2.mjs --dry-run
node scripts/cutover-context-v2.mjs --apply --confirm <dry-run-token>
```

dry-run 输出 backend、数据位置和 schema、每个集合数量和关联完整性、活动执行/Queue 数量、可删除 Artifact 数量、外部归档目录、计划 dataEpoch 和一次性 confirm token。

apply 前置条件：服务进入维护模式并停止创建新 Session；执行和队列已暂停；confirm token 与最新 dry-run、数据 revision 和环境一致；获得单独的高风险操作确认。

### 11.4 加密只读归档

- apply 在替换活动 state 前，把当前完整 state 以 AES-256-GCM + scrypt 写入 `AGENT_CLUSTER_CUTOVER_ARCHIVE_DIR`；目录必须位于活动数据根之外。
- 密钥使用 `AGENT_CLUSTER_CUTOVER_ARCHIVE_KEY`，未单独配置时沿用 cutover token secret；密钥强度、原子写入、只读权限和密文 SHA-256 均为 apply 前置门禁。
- manifest 只包含 archive id、environment、createdAt、source revision、集合计数、密文 hash/bytes 和算法，不包含 Session 标题、消息或文件正文。
- 归档没有在线读取、导入或 Resume API；如需离线审计，必须走独立授权流程。

### 11.5 File backend

- 在同目录生成完整的新 v2 state 临时文件。
- 外部加密归档 `fsync` 成功后，原子替换旧 state；不在活动数据目录创建明文备份。
- 替换失败时旧 state 保持不变，服务仍处于维护模式。
- 禁止使用“先删旧文件、再写新文件”的窗口。

### 11.6 PostgreSQL backend

- 锁定 collection 表并在单事务中校验 dry-run revision。
- 删除/重置目标 collection rows，写入 v2 seed 和 `SystemDataMetadata`。
- 替换事务前完成外部加密归档；任一步失败则不进入替换或 transaction rollback，不创建额外历史表。

### 11.7 最小审计

审计只记录环境标识、操作者、commit、时间、旧/新 schema、集合名、删除数量、归档密文 hash/bytes、结果和 dataEpoch。不得记录 Session 标题、输入、事件正文、Artifact 内容、Memory 或密钥。

## 12. 启动与恢复

- Cutover 完成前，v2-only build 不加载旧业务数据。
- Cutover 完成后，Recovery 只扫描当前 `dataEpoch` 的 v2 Session。
- Cutover 前或不同 `dataEpoch` 的旧 Runtime session id、Workdir Brief、BullMQ Job 和 supplemental request 不允许恢复。
- 当前 `dataEpoch` 内只允许从同一 `sessionId/agentId/taskId/runtimeType` 的最近 completed invocation 恢复 CLI session；`workDir` 必须与当前 Workspace binding 一致。
- Browser Broker 连接不跨 dataEpoch 复用。
- Runtime credential 和模型连接可以继续使用，但必须重新通过可用性检查。

## 13. 安全

- Tool Catalog 是权限快照，不是提示词建议。
- 高风险 Tool 必须保留 Capability check 和人工审批。
- Workspace path、sensitive path、symlink、lease、base hash 和 write lock 继续强制执行。
- Skill 内容视为高信任提示资源，保存和 revision 变化需要审计。
- Profile 展开受 token/字符预算约束。
- Cutover 命令默认 dry-run，`--apply` 必须绑定一次性 token 和明确环境。
- 历史删除不得递归进入 Workspace 或任意 Artifact 外部 URI。

## 14. 可观测性

每次 Invocation 至少记录 invocation/session/task/agent ID、profile hash/revision、Skill ID/revision/contentHash、requested/allowed/blocked Tool、Capability/approval refs、ResolvedExecutionTarget、Workspace revision、Context token 统计和 Runtime 结果。

## 15. 失败语义

| 场景 | 错误 | 行为 |
| --- | --- | --- |
| 未执行 cutover | `CUTOVER_REQUIRED` | 拒绝业务启动 |
| Profile 引用非法 | `AGENT_PROFILE_INVALID` | 拒绝保存或 Invocation |
| Tool 权限不足 | `CAPABILITY_BLOCKED` | 不启动 Runtime |
| 无 eligible Runtime | `CAPABILITY_BLOCKED` | 不静默 fallback |
| Evidence 不足 | `CONTEXT_INSUFFICIENT` | 请求补读并重新解析 Invocation |
| Cutover revision 改变 | `CUTOVER_STALE_DRY_RUN` | 拒绝 apply，重新 dry-run |
| Cutover 部分失败 | `CUTOVER_FAILED` | 回滚或保持旧 state，继续维护模式 |

## 16. 验收矩阵

| 目标 | 验收证据 |
| --- | --- |
| Agent 无 Runtime 字段 | shared 合同编译测试 + API 测试 |
| Skill 引用生效 | Compiler 单测 + Invocation snapshot |
| Tool 引用真实可执行 | Tool Resolver 单测 + 各 Adapter 集成测试 |
| Runtime 可替换 | 同 Agent 双 Runtime E2E，身份 hash 不变 |
| v2 唯一 Context | Adapter 输入快照无旧 Workspace 字段 |
| fail closed | 无 eligible Runtime/Tool/Evidence 测试 |
| 活动历史零保留 + 只读归档 | file/PostgreSQL cutover dry-run/apply/idempotency、加密 round-trip、根目录隔离和只读权限测试 |
| 不删除 Workspace | Artifact 外部 URI 和 Workspace 安全测试 |
| 无旧恢复 | Recovery/Queue/Browser Broker dataEpoch 隔离测试 |

## 17. 明确删除的旧语义

实现完成后不得再出现：

- `ContextPipelineVersion = 'v1' | 'v2'`。
- `CONTEXT_PIPELINE_V2_ENABLED`。
- `Agent.runtimeType/modelId`。
- `RuntimeAgentProfile.runtimeType/modelId/runtimeSelection`。
- `EngineeringRuntimeSelection` 和 `agent_override`。
- Session 固化 `executionTarget`。
- `pairAgentWithExecutionTarget()`。
- Orchestrator `selectEngineeringRuntime()`。
- 旧 Session 默认值、backfill、迁移和 Resume 分支。
