# Workspace Index First 与按需上下文系统设计 v1

> 2026-07-30 更新：本文中的单活动 Session Lease 章节只保留历史背景。当前同目录多 Session 创建、隔离执行、FIFO 写回、三方合并和冲突恢复以 [`workspace-multi-session-isolation-writeback-v1.md`](./workspace-multi-session-isolation-writeback-v1.md) 为准。

> 日期：2026-07-28
> 状态：已实施；固定 Windows 环境 100K 真实文件绝对性能基准待发布前归档
> 适用版本：Agent Cluster V1
> 上游产品边界：[`../product/agent-cluster-prd-v1.md`](../product/agent-cluster-prd-v1.md)
> 上游 Context 设计：[`context-pipeline-v2-only-agent-decoupling-system-design-v1.md`](context-pipeline-v2-only-agent-decoupling-system-design-v1.md)
> Workspace 位置设计：[`local-and-server-runtime-workspace-separation-discussion-result-v1.md`](local-and-server-runtime-workspace-separation-discussion-result-v1.md)
> 后续多会话计划：[`../roadmap/unfinished-tasks-v2.md`](../roadmap/unfinished-tasks-v2.md)
> 实施映射：[`../implementation/workspace-index-first-on-demand-context-development-v1.md`](../implementation/workspace-index-first-on-demand-context-development-v1.md)
> 验收报告：[`../quality/workspace-index-first-acceptance-v1.md`](../quality/workspace-index-first-acceptance-v1.md)

## 1. 文档目的

本文定义 V1 中工作目录选择、Session 创建、项目索引、Context Envelope、按需文件读取和工作区一致性的唯一目标架构。

本文解决以下已确认问题：

- 选择本地目录后创建会话很慢。
- 会话创建同步递归扫描目录并读取文件正文，耗时随项目规模增长。
- 如果把扫描改为后台任务，扫描与 Agent 分析仍可能形成竞速，分析可能长期等待扫描。
- 同一个 `workspaceId` 下并发运行多个会话会产生快照过期和共享目录冲突；V1 不实现完整多会话隔离。
- 系统已有 Workspace Provider、Workspace Index Entry、`ContextEnvelopeV2` 和补充证据读取能力，但当前生命周期没有按索引导航与按需取证正确拆分。

本文是上述主题的权威设计。`executing-pull-context-design-v1.md` 保留为历史讨论稿；其中“讨论阶段先扫描门面文件”“前端上传轻量 Snapshot”等与本文冲突的内容不再作为目标行为。

## 2. 已确认决策

1. V1 对同一工作区只支持一个活动 Session；允许保留多个已完成或历史 Session。
2. 本地与服务器是 Workspace Provider 和 Runtime 执行位置的差异，不形成两套 Context 架构。
3. 选择目录只完成授权和绑定，不递归扫描，不批量读取文件，不计算全仓库文件 hash。
4. Session 创建不得等待全量扫描或完整索引。
5. Agent 先使用项目索引导航，再根据当前任务按需执行 `listDirectory`、`searchText` 和 `readFile`。
6. 后台索引可以增量构建，但其完成时间不得成为群聊、讨论或执行阶段的全局门禁。
7. 代码级结论必须经过 L3 Evidence 门禁；证据不足时只补读当前调用需要的内容并重建 Envelope。
8. 一次 Invocation 使用冻结的 Context Envelope；后台索引完成或工作区变化不能原地修改已经发出的 Envelope。
9. 文件写回继续使用 base revision、base hash、ChangeSet 和审计机制，不由索引替代。
10. 同一工作区多活动会话的独立 Snapshot、sandbox/worktree 和冲突合并留到后续版本。

## 3. 现状与根因

### 3.1 当前阻塞路径

当前工作树中的 Session 创建链路包含：

```text
Web 创建 Session
  -> SessionsService.create
  -> resolveWorkspaceBinding
  -> scanWorkspaceProvider / scanServerWorkspace
  -> recursive listDirectory
  -> 为目录条目读取文件并计算 hash
  -> 最多读取 80 个文本文件正文
  -> 创建 Session
  -> 开始 Agent 讨论
```

`scanWorkspaceProvider` 当前最多递归处理 350 个条目、深度 12，随后读取最多 80 个文本文件、单文件最多 80KB、正文总量最多 550KB。Local Runtime 的 `listDirectory` 还会为每个文件计算 SHA-256，因此目录枚举本身也会触发文件读取。

本地模式中，每个 Workspace Provider 操作还需要经过 Platform Backend 与 Local Runtime CLI 的请求/响应链路。最终表现为目录越大、文件越多、磁盘越慢，会话创建越慢。

### 3.2 引入原因

本地/服务器双模式改造要求：

- 客户端不能上传自造 `workspaceSnapshot`。
- `local_bridge` 不向服务器暴露本机绝对路径。
- Platform Backend 必须获得可验证的 Workspace Context。

为满足以上安全边界，当前实现将“服务器生成 Snapshot”直接解释为“创建 Session 时同步扫描并读取工作区”。安全目标正确，但把以下四种不同职责错误地放进了同一个阻塞请求：

- Workspace 授权与绑定。
- 项目导航索引构建。
- 文件正文取证。
- 文件一致性 hash 校验。

### 3.3 已有可复用基础

系统已经具备：

- `WorkspaceProvider`：`getRevision/listDirectory/statFile/readFile/searchText/applyChangeSet`。
- `WorkspaceIndexEntry`、导航清单和 Project Map Builder。
- `ContextEnvelopeV2` L0-L6 分层合同。
- `CONTEXT_INSUFFICIENT` 与 Supplemental Context 重试链路。
- Local Runtime 工作区授权、revision watcher、路径边界和敏感文件检查。
- ChangeSet、base hash、workspace revision 和写回串行化。

因此目标不是新增第二套上下文系统，而是恢复并补齐现有“索引导航 + 按需证据”主链路。

## 4. 目标与非目标

### 4.1 功能目标

| ID | 目标 |
| --- | --- |
| G-01 | 目录选择耗时只与用户操作和目录授权校验有关，不随项目文件数量线性增长 |
| G-02 | Session 创建不递归扫描目录、不批量读取文件正文，并立即进入讨论阶段 |
| G-03 | Agent 使用项目索引完成导航，使用按需读取获得当前任务所需的真实文件证据 |
| G-04 | 索引未完成、索引过期或后台索引晚于 Agent 分析时，群聊仍能推进且代码结论不失去证据门禁 |
| G-05 | `ContextEnvelopeV2` 继续作为 Runtime 唯一权威上下文载荷 |
| G-06 | 本地和服务器 Workspace 使用相同的索引、证据和一致性语义 |
| G-07 | V1 通过单工作区单活动 Session 约束避免跨会话共享目录竞态 |
| G-08 | 所有补读、证据不足、超时和写回冲突都可观测、可审计、可恢复到明确状态 |

### 4.2 性能目标

| ID | 目标 |
| --- | --- |
| P-01 | 已连接 Local Runtime 下，目录授权完成后的 Workspace 注册接口 P95 小于 500ms |
| P-02 | 不含外部模型耗时，`POST /api/sessions` P95 小于 1s |
| P-03 | Session 创建耗时不因 1,000、10,000、100,000 文件三个规模档位发生线性增长 |
| P-04 | 单轮 Supplemental Context 最多处理 8 个路径、512KB 正文和 10s Provider 时间 |
| P-05 | 单次 Invocation 最多执行 2 轮 `CONTEXT_INSUFFICIENT` 补读重试 |
| P-06 | Runtime 输入只包含预算内导航和 Selected Evidence，不包含工作区全量正文 |

P95 目标在本地开发基准环境和受控 CI 性能夹具中分别记录；CI 只使用相对退化阈值阻断，避免共享 Runner 抖动造成误报。

### 4.3 非目标

- V1 不支持同一 `workspaceId` 下多个活动 Session 并发分析或执行。
- V1 不提供会话级独立文件系统 Snapshot、branch、sandbox 或自动三方合并。
- 不引入 pgvector、embedding 或完整语义 RAG 替代 Workspace Index。
- 不把全部文件正文持久化到 Platform Backend。
- 不让浏览器直接读取、缓存或上传本机目录正文。
- 不允许 Generic LLM、Codex 或 Claude Code 绕过 Workspace Provider 和能力治理读取工作区外文件。
- 不通过延长 Session 创建超时掩盖扫描问题。
- 不以“后台扫描最终会完成”为 Agent 正确性的前提。

## 5. 架构约束与不变量

### 5.1 生命周期不变量

- `authorize workspace`、`create session`、`build index`、`hydrate evidence` 是四个独立生命周期。
- Session 创建的关键路径禁止递归 `listDirectory`、批量 `readFile`、`searchText` 和全仓库 hash。
- 后台索引状态只能影响后续 Invocation 的导航质量，不能阻塞 Session 状态流转。
- 已创建的 `ContextEnvelopeV2` 不可变；任何补读都必须生成新的 Envelope 和新的 Invocation attempt。

### 5.2 上下文不变量

- L1/L2 是导航信息，不等于代码事实证据。
- 文件内容、行范围、hash 和读取 revision 只进入 L3 Selected Evidence。
- 源码分析、代码修改和架构结论在缺少必要 L3 Evidence 时必须返回 `CONTEXT_INSUFFICIENT`。
- Project Map 可以基于部分索引生成，但必须携带索引完整度，不得伪装为完整项目视图。
- Runtime 不接收重复的 `workspaceSnapshot/workspaceManifest/selectedEvidenceContents/projectMap` 旧载荷。

### 5.3 Workspace 不变量

- `local_bridge` 的绝对路径只存在于 Local Runtime CLI。
- `server_local` 的绝对路径只由 Server Workspace Provider 使用，且必须通过根目录、敏感目录和 symlink 校验。
- Workspace Index 不授予文件读取权限；真实读取仍需 Provider capability 和 Tool Authority 允许。
- 文件 hash 在选中文件读取、stat 或写回校验时计算，不在普通导航枚举中强制计算。
- V1 同一工作区最多持有一个活动 Session Lease。

## 6. 总体架构

```text
Browser UI
  -> Workspace Authorization / Selection
  -> POST /sessions with SessionWorkingDirectory

Platform Backend
  -> WorkspaceBindingValidator
  -> WorkspaceActiveSessionLease
  -> SessionsService creates Session immediately
  -> Context Router reads current WorkspaceIndexSnapshot
  -> ContextEnvelopeV2 Builder creates bounded L0/L1/L2/L3
  -> Runtime Invocation
       -> completed
       -> CONTEXT_INSUFFICIENT
            -> SupplementalContextHydrator
            -> WorkspaceProvider list/search/read
            -> rebuild ContextEnvelopeV2
            -> retry same logical Invocation

Workspace Plane
  -> LocalBridgeWorkspaceProvider -> Local Runtime CLI -> local directory
  -> ServerLocalWorkspaceProvider -> server directory
  -> WorkspaceIndexService -> persistent metadata-only index
  -> WorkspaceRevisionWatcher -> incremental invalidation/update
```

### 6.1 组件职责

| 组件 | 负责 | 禁止负责 |
| --- | --- | --- |
| Workspace Authorization | 校验目录、创建/返回 `workspaceId`、声明权限 | 扫描项目正文、构建 Session Context |
| WorkspaceBindingValidator | 校验 Workspace 在线、名称、Provider 和 capability | 递归枚举目录 |
| WorkspaceActiveSessionLease | 保证 V1 单工作区单活动 Session | 文件锁、任务调度锁 |
| WorkspaceIndexService | 构建、保存、更新元数据索引 | 保存文件正文、决定 Agent 任务 |
| Context Router | 根据任务从索引选择导航和候选证据 | 直接访问未授权绝对路径 |
| SupplementalContextHydrator | 有界读取指定目录、搜索和文件正文 | 全仓库预灌、无限重试 |
| ContextEnvelopeV2 Builder | 冻结 L0-L6、预算和 revision | 原地修改已发出的 Envelope |
| Workspace Provider | 执行真实 list/stat/read/search/write | 跨 Workspace 访问、绕过权限 |
| Runtime Adapter | 消费 InvocationPlan、返回结果或证据请求 | 自行切换 Workspace 或扩权 |

## 7. 核心数据合同

以下为目标合同。实施时可以保留兼容字段用于服务端内部组装，但不得继续以全量 Snapshot 作为 Session 创建前置条件。

### 7.1 Workspace Binding

```ts
type WorkspaceBinding = {
  workspaceId: UUID
  providerKind: 'local_bridge' | 'server_local'
  displayName: string
  capabilities: WorkspaceCapabilities
  boundRevision: WorkspaceRevision
  boundAt: ISODateTime
}
```

`WorkspaceBinding` 表示 Session 使用哪个工作区，不表示已经扫描工作区。

### 7.2 Workspace Index Snapshot

```ts
type WorkspaceIndexStatus = 'empty' | 'building' | 'ready' | 'stale' | 'failed'

type WorkspaceNavigationEntry = {
  path: string
  kind: 'file' | 'directory'
  size?: number
  modifiedAt?: ISODateTime
  language?: string
  generated: boolean
  sensitive: boolean
}

type WorkspaceIndexSnapshot = {
  workspaceId: UUID
  revision: WorkspaceRevision
  generation: number
  status: WorkspaceIndexStatus
  complete: boolean
  entries: WorkspaceNavigationEntry[]
  entrypoints: string[]
  detectedStack: string[]
  indexedEntries: number
  truncated: boolean
  updatedAt: ISODateTime
  errorCode?: string
}
```

导航条目不要求 `hash`。这避免 `listDirectory` 为建立索引读取每个文件。完整文件 hash 只在完整读取、显式 `stat` 或 ChangeSet 校验时计算；行范围或截断读取只计算已返回字节的 `rangeHash`，不得为了局部取证额外扫描整个大文件。

Provider 是完整索引的事实所有者。Platform Backend 只保存 Index Summary 和当前任务查询得到的有界投影，不接收、持久化或在每次 Invocation 固定拉取完整 `entries`。

```ts
type WorkspaceIndexQueryInput = {
  query?: string
  pathHints?: string[]
  symbols?: string[]
  intent?: string
  limit?: number // 默认 50，硬上限 200
  generation?: number
}
```

### 7.3 Session Workspace Context

```ts
type SessionWorkspaceContext = {
  binding: WorkspaceBinding
  indexGeneration?: number
  indexRevision?: WorkspaceRevision
  indexComplete: boolean
}
```

Session 保存创建或最近一次 Invocation 观察到的索引引用，不持有“必须持续同步”的全仓库正文副本。

### 7.4 Selected Evidence

继续使用 `ContextEnvelopeV2.L3.files`，每个文件至少包含：

```ts
type ContextL3EvidenceFile = {
  path: string
  content: string
  byteLength: number
  hash: FileHash
  revision: WorkspaceRevision
  startLine?: number
  endLine?: number
}
```

`ContextL3EvidenceFile.hash` 表示本次 Envelope 实际携带正文的内容 hash：完整读取时可复用完整文件 hash，行范围或截断读取时使用 `rangeHash`。Evidence 是一次 Invocation 的不可变输入；即使工作区随后变化，本次调用仍可审计自己看到的确切内容、范围、revision 和 hash。

### 7.5 Active Session Lease

```ts
type WorkspaceActiveSessionLease = {
  workspaceId: UUID
  sessionId: UUID
  acquiredAt: ISODateTime
  updatedAt: ISODateTime
  status: 'active' | 'released'
}
```

Lease 由 Platform Backend 持久化或通过现有 Persistence 抽象保存。进程重启后必须根据非终态 Session 重建，不能只存在于进程内 Map。

## 8. Workspace Index 设计

### 8.1 索引所有权

- `local_bridge`：Local Runtime CLI 是索引事实所有者，因为它最接近本机文件系统且不暴露绝对路径。
- `server_local`：Server Workspace Provider 侧的 WorkspaceIndexService 是索引事实所有者。
- Platform Backend 可以缓存有界的任务相关索引投影，但不能通过重复全量扫描或固定大分页维护本地工作区索引。

### 8.2 索引构建

首次授权后立即返回 Workspace Summary，同时异步启动索引：

1. 读取根目录和常见项目入口。
2. 按广度优先逐层枚举。
3. 排除 `.git/node_modules/dist/build/.next/.cache/coverage` 等生成目录。
4. 标记敏感路径但不读取内容。
5. 记录 path、kind、size、mtime、language，不计算全量内容 hash。
6. 每处理固定条目或固定时间片提交一个 generation，使部分索引可被读取。
7. 完成后标记 `ready/complete=true`。

索引任务必须支持取消、超时分片和进程重启恢复。单次调度时间片建议不超过 100ms，避免阻塞 Local Runtime 的心跳和 Invocation 请求。

### 8.3 增量更新

文件 watcher 只负责产生 revision 与失效信号：

- 新增或删除：更新父目录和对应条目。
- 修改：更新 size、mtime、language，清除相关 Evidence cache。
- watcher 丢事件或溢出：标记索引 `stale`，后台重建；当前 Invocation 不等待重建。
- Runtime 重连：先暴露上次持久化索引为 `stale`，再后台校验和刷新。

### 8.4 索引可用性

`empty/building/stale/failed` 都不是 Session 创建失败条件。

- `empty`：Context L1 仅包含 Workspace Binding；Agent 可以请求根目录列表或搜索。
- `building`：使用当前部分导航，同时允许按需发现未索引路径。
- `stale`：导航可以作为候选，但读取正文时必须以 Provider 返回的实时 revision/hash 为准。
- `failed`：记录诊断，继续允许有界的直接 list/search/read；若 Provider 也不可用才 fail closed。

任务相关索引查询必须先保留 Provider 已识别的基础入口（例如 `package.json`、构建配置和主入口），再追加词法相关候选，并始终受调用方 `limit` 约束。这样既不会把完整索引回传 Backend，也不会因为某个局部路径命中而丢失识别技术栈和工程入口所需的导航信息。

## 9. 关键时序

### 9.1 本地目录授权

```text
User -> Web: 选择本机目录
Web -> Backend: POST /local-runtime/workspaces/authorize
Backend -> Local Runtime: authorize request
Local Runtime: realpath/stat/boundary/security validation
Local Runtime: create workspaceId + revision + watcher
Local Runtime -> Backend -> Web: Workspace Summary
Local Runtime -> IndexService: start/resume background indexing
```

同步路径只允许执行目录本身的校验，禁止递归枚举子目录。

### 9.2 Session 创建

```text
Web -> Backend: POST /sessions { input, agentIds, workingDirectory }
Backend: validate workspace registration and capabilities
Backend: acquire WorkspaceActiveSessionLease
Backend: getRevision and optional current index summary
Backend: persist Session + first user event
Backend -> Web: 201 Session
Backend: start discussion in background
```

`getRevision` 必须是 O(1) 或近似 O(1) 的 watcher revision 读取，不能临时遍历文件系统生成 revision。

### 9.3 讨论和 Brief

```text
Context Router: read current index snapshot without waiting for complete=true
Context Builder: build L0 Workspace Binding
Context Builder: build bounded L1 navigation and partial L2 project map
Agent: discuss requirement
Agent: source-specific evidence sufficient?
  yes -> produce grounded result
  no  -> return CONTEXT_INSUFFICIENT with requested paths/search intent
```

用户意图初判优先使用用户输入。Workspace Index 可以细化 domain/intent，但不得成为创建 Session 的前置条件。

### 9.4 Supplemental Context

```text
Orchestrator receives CONTEXT_INSUFFICIENT
  -> normalize and deduplicate request
  -> enforce path/count/byte/time budget
  -> listDirectory / searchText / readFile through WorkspaceProvider
  -> record path + hash + revision + truncation
  -> build a new ContextEnvelopeV2
  -> start next attempt of the same logical Invocation
```

Supplemental Context 支持三种动作：

- `list`：发现指定目录下一层或有界深度的路径。
- `search`：在受限范围内使用索引或 `rg` 搜索符号/关键词。
- `read`：读取指定文件或行范围，进入 L3。

目标合同应扩展 `RuntimeContextRequest`，显式表达 `requestedDirectories` 和 `requestedSearches`，不能把所有发现操作继续编码成带 `/` 的伪文件路径。

### 9.5 索引晚于分析完成

这是允许且预期的正常情况：

1. Invocation A 在 generation 3 上构建 Envelope。
2. 后台索引继续生成 generation 4、5。
3. Invocation A 只使用 generation 3 和自己补读的 Evidence，不等待 4、5，也不被原地更新。
4. 如果 A 缺少证据，由 A 自己请求 list/search/read。
5. Invocation B 启动时读取最新可用 generation 5。

因此索引完成先后不会形成“群聊一直等待”的全局状态，也不会让同一次分析中途看到互相矛盾的导航快照。

### 9.6 Workspace 变化

Invocation 启动前读取 live revision：

- 与目标索引 revision 一致：正常构建 Envelope。
- 不一致但所需 Evidence 可实时读取：标记索引 `stale`，按需读取真实文件后继续。
- Evidence 读取前后 revision 变化：丢弃该批结果并重试一次。
- 连续变化或超过预算：返回明确的 `WORKSPACE_REVISION_UNSTABLE`，不无限重试。

### 9.7 文件写回

写回不依赖索引是否完整：

1. Runtime 输出 ChangeSet。
2. Workspace Provider 比较 base revision 和每个变更的 base hash。
3. 通过工作区写锁串行 apply。
4. 成功后推进 revision，失效相关 Evidence 和索引条目。
5. 冲突时返回结构化冲突，不覆盖用户文件。

## 10. V1 单活动 Session 设计

### 10.1 活动范围

以下 Session 状态持有 Lease：

- 讨论、Brief 修订和等待用户确认。
- 执行、Review、Rework 和等待用户决策。
- 可恢复的 `INTERRUPTED`。

完成、明确取消、删除或用户显式放弃 Session 后释放 Lease。历史 Session 可以继续显示和读取，但不能占用执行权。

### 10.2 冲突行为

本节描述的是已经废弃的行为：历史版本会拒绝创建或恢复第二个活动 Session。当前版本允许创建，并在执行/写回阶段使用隔离目录、FIFO 和冲突恢复保护源目录。

### 10.3 重启恢复

服务启动时根据持久化 Session 状态重建 Lease：

- 同一 workspace 出现多个非终态 Session 时 fail closed，并产生运维诊断。
- 不自动挑选“最后更新”的 Session 继续执行。
- 运维或用户完成显式冲突处理后才能恢复。

## 11. 一致性模型

系统采用“导航最终一致、Invocation Evidence 冻结一致、写回乐观并发控制”的组合模型：

| 数据 | 一致性 |
| --- | --- |
| Workspace Index | 最终一致，可部分、可 stale |
| Context Envelope | 每个 Invocation attempt 内不可变 |
| Selected Evidence | 记录读取 revision/hash，随 Envelope 冻结 |
| Session 状态 | Platform Backend 权威持久化 |
| Multi-Session Workspace | workspaceId 可绑定多个活动 Session；写任务隔离、ChangeSet FIFO 写回，状态可持久化恢复 |
| 文件写回 | base revision + base hash + workspace write lock |

索引不能作为写回并发控制依据；Session Snapshot 也不能替代 live Provider revision。

## 12. 预算与限流

### 12.1 Index 预算

- 后台运行，不占用 Session 创建 deadline。
- 使用时间片和分页，单批条目建议 250。
- 生成目录直接跳过，不进入后续队列。
- 索引快照对 Platform Backend 的单次返回设置条目和字节上限；通过 cursor 分页。

### 12.2 Supplemental Context 预算

| 项目 | V1 默认值 |
| --- | --- |
| 每轮路径数 | 8 |
| 每轮目录列表 | 200 项/目录 |
| 每轮搜索结果 | 50 条 |
| 单文件正文 | 64KB |
| 每轮正文总量 | 512KB |
| Provider 时间 | 10s |
| 单 Invocation 补读轮数 | 2 |
| 同路径同 revision 重复读取 | 去重 |

架构分析可以在首次任务执行前，根据当前有界索引投影预读基础入口；该预读最多 8 个文件、256KB、1.5s。超时、Provider 离线或只读到部分文件时立即继续现有索引与 Evidence Gate 流程，不能等待后台索引完成，也不能扩大为目录扫描。

达到限制时返回 `truncated/deferredPaths`，不得扩大为全量扫描。

### 12.3 Context Token 预算

- L1 navigation 不超过输入预算的 15%。
- L2 project map 不超过 10%。
- L3 evidence 不超过 40%。
- L3 选择按任务相关性、显式请求、入口文件和验证需要排序。
- Token 裁剪不能把“有代码结论但无任何 L3 Evidence”包装成成功。

## 13. 安全设计

- Local Runtime 授权时拒绝文件系统根目录、用户 Home 和平台仓库目录。
- 所有路径统一转成 Workspace 相对路径，拒绝绝对路径、`..` 和 symlink 越界。
- `.env`、凭据、私钥、`.ssh`、`.aws`、`.npmrc`、`.docker/config.json`、`.git/config` 等敏感路径禁止索引正文和按需读取。
- Index 只包含非敏感元数据；敏感路径可以完全隐藏，避免通过文件名泄漏。
- `searchText` 使用固定字符串或安全参数调用 `rg`，禁止拼接 shell 命令。
- Workspace Provider 的 read/search/list 分别接受能力治理和审计。
- Local Runtime 断线后，未完成请求失败为可诊断的 `BROKER_OFFLINE`，不得降级到服务器读取本机目录。
- `server_local` 不得指向平台代码仓库、凭据目录或拒绝范围。

## 14. 失败与降级

| 场景 | 行为 | 是否阻塞 Session 创建 |
| --- | --- | --- |
| Index 不存在 | 使用空导航，允许按需 list/search/read | 否 |
| Index 构建中 | 使用部分 generation | 否 |
| Index stale | 导航仅作候选，Evidence 实时校验 | 否 |
| Index 构建失败 | 记录诊断，继续有界 Provider 读取 | 否 |
| Provider 不可读 | 源码任务返回 `CONTEXT_INSUFFICIENT/READ_UNAVAILABLE` | 否，任务阶段 fail closed |
| Local Runtime 离线 | 明确中断/阻塞，不跨位置降级 | 创建时若目标 Workspace 已离线则拒绝绑定 |
| Workspace 持续变化 | 一次重试后返回 `WORKSPACE_REVISION_UNSTABLE` | 否 |
| 补读超时 | 保留已成功 Evidence，返回 deferred/timeout | 否 |
| 第二个活动 Session | 返回 409 冲突 | 是，符合 V1 边界 |
| 写回 hash 冲突 | 不覆盖文件，返回结构化冲突 | 否，当前任务进入冲突处理 |

任何失败都不能转成无上限等待状态。所有等待必须有 deadline、终止原因和用户可见结果。

## 15. 前端交互

### 15.1 目录选择

- “选择本机目录”只展示系统目录选择等待，不展示“扫描全部文件”。
- 授权成功后立即把 Workspace 加入选择列表。
- 创建按钮只依赖 Workspace 已连接和 Runtime 可用，不依赖 `indexStatus=ready`。

### 15.2 Session 创建

- API 返回后立即进入 Session 页面并建立事件连接。
- 不再把 `workspaceSnapshot` 是否存在作为 `sessionScanStatus=completed` 的判断条件。
- 可以在 Debug/诊断区域展示“索引构建中/部分/已更新/失败”，但它不能成为全屏阻塞状态。

### 15.3 证据补读

- 群聊只展示有意义的“正在读取相关文件”或失败事件，不逐条刷屏展示内部目录分页。
- Debug 视图展示 requested action、path/query、revision、hash、bytes、truncated、duration 和结果。
- 超时或权限不足必须给出明确可操作提示。

### 15.4 单 Session 冲突

- 409 时展示当前活动 Session，并提供“返回该会话”。
- 结束或删除现有 Session 是显式操作，不提供自动抢占。

## 16. API 与合同变更

### 16.1 Session 创建

`POST /api/sessions` 请求保持 `workingDirectory`，禁止客户端上传 `workspaceSnapshot`。响应不保证包含完整 Snapshot，只保证 Workspace Binding 已建立。

### 16.2 Workspace Index

Workspace Provider 增加语义化索引读取能力，具体可以通过现有 Broker operation 扩展：

```ts
getIndexSnapshot(input: {
  cursor?: string
  limit?: number
  generation?: number
}): Promise<WorkspaceIndexSnapshotPage>

queryWorkspaceIndex(input: WorkspaceIndexQueryInput): Promise<WorkspaceIndexQueryResult>
```

两个操作都只能读取 Provider 侧已维护索引，不能在请求内临时全量构建索引。Runtime Invocation 的正常路径使用 `queryWorkspaceIndex`，默认最多返回 50 条任务相关导航；`getIndexSnapshot` 只用于诊断、分页管理和兼容 Provider，不得固定请求 2,000 条作为每轮上下文。

### 16.3 Runtime Context Request

目标合同：

```ts
type RuntimeContextRequest = {
  reason: string
  requestedRefs: TaskEvidenceRef[]
  requestedPaths?: string[]
  requestedDirectories?: Array<{
    path: string
    depth?: number
  }>
  requestedSearches?: Array<{
    query: string
    path?: string
    include?: string[]
    exclude?: string[]
  }>
  requestedCommands?: string[]
  followUpInstruction?: string
}
```

Normalizer、JSON Schema、Runtime adapter、Debug 和测试必须同时更新，未知字段继续 fail closed。

### 16.4 诊断字段

Runtime Invocation 审计增加：

- `workspaceIndexGeneration`
- `workspaceIndexStatus`
- `workspaceIndexComplete`
- `workspaceRevisionAtStart`
- `supplementalContextAttempt`
- `supplementalContextDurationMs`
- `evidenceBytes`
- `evidencePaths`

不得记录敏感正文到普通日志。

## 17. 模块改造范围

| 模块/路径 | 目标改动 |
| --- | --- |
| `apps/server/src/modules/sessions/` | Session 创建只绑定 Workspace；允许相同 Workspace 的多个活动 Session；移除同步 Workspace 扫描 |
| `apps/server/src/modules/workspaces/` | 增加 Index Snapshot 抽象；Provider 索引读取；保留有界 list/search/read/apply |
| `apps/server/src/modules/context-v2/` | 直接从 Index Snapshot 构建 L1/L2；L3 只接收真实 Evidence |
| `apps/server/src/modules/orchestrator/` | 扩展有界 Supplemental Context；revision 校验；重试预算 |
| `apps/server/src/modules/runtimes/` | 扩展 Context Request Schema、Normalizer、Adapter 和审计 |
| `apps/server/src/modules/persistence/` | 持久化 Session Lease 和必要索引引用；正文仍按 Content Reference 规则处理 |
| `packages/local-runtime-cli/src/` | Provider 侧持久化增量索引；目录枚举不计算全量 hash；watcher 更新 generation |
| `packages/shared/src/` | Workspace Index、Context Request、错误码和诊断合同 |
| `apps/web/src/stores/localRuntime.ts` | Workspace Summary 与 index status 状态管理 |
| `apps/web/src/components/SessionWorkspace.vue` | 创建流程取消 Snapshot 完成依赖；增加非阻塞诊断和 Lease 冲突提示 |

### 17.1 允许修改

- 上表路径及其直接单元测试、合同测试、E2E、设计和 API 文档。

### 17.2 禁止修改

- 不恢复 `browser_local` 或 Browser Workspace Mirror。
- 不把 Local Runtime 绝对路径传给 Platform Backend。
- 不重新引入 Context v1 或双 Context Pipeline。
- 不在 V1 实现多 Session sandbox/worktree 产品能力。
- 不借此重写 Agent Profile、Runtime Router 或工作流系统。

## 18. 分阶段实施

### Stage 1：解除 Session 创建阻塞

- Local Workspace Binding 只做注册、capability 和 O(1) revision 校验。
- Server Workspace Binding 只做目录边界校验和 Provider 注册。
- 从 `resolveWorkspaceBinding` 移除同步 `scanWorkspaceProvider/scanServerWorkspace`。
- Intent Recognition 在无 Snapshot 时正常工作。
- 前端创建成功不依赖 `workspaceSnapshot`。

完成标准：AT-01 至 AT-05 通过。

### Stage 2：Provider 侧 Metadata Index

- 引入 `WorkspaceIndexSnapshot` 和分页读取合同。
- Local Runtime 与 Server Provider 实现后台、持久化、增量索引。
- `listDirectory` 导航路径不计算全部文件内容 hash；局部 `readFile` 不计算完整文件 hash。
- Platform Backend 通过 `queryWorkspaceIndex` 获取任务相关有界投影，不复制 Provider 完整索引。
- Index generation、partial、stale、failed 状态可诊断。

完成标准：AT-06 至 AT-11 通过。

### Stage 3：Context v2 直接消费索引

- L1 Navigation 与 L2 Project Map 从 Index Snapshot 构建。
- Index 完整度进入 Envelope 诊断，不进入 Runtime 重复旧载荷。
- 已有 `workspaceSnapshot` 只作为过渡内部字段，逐步退出权威路径。

完成标准：AT-12 至 AT-15 通过。

### Stage 4：完整按需取证

- `RuntimeContextRequest` 支持 directory/search/read。
- Supplemental Context 实现计数、字节、时间和重试预算。
- Evidence 记录 revision 和本次返回正文 hash；局部读取使用 `rangeHash`，变化时重试一次。
- Session 证据缓存最多 32 项、正文最多 512KB，旧 revision 正文失效，不能跨轮无限累积。
- `CONTEXT_INSUFFICIENT` 不形成无限循环。

完成标准：AT-16 至 AT-23 通过。

### Stage 5：V1 Active Session Lease 与发布收口

- 持久化 Lease、重启重建、409 冲突和前端引导。
- 补齐指标、日志、E2E、性能基准、文档和回滚开关。
- 删除或隔离创建路径不再使用的全量 Scanner。

完成标准：全部验收规则通过。

## 19. 验收规则

### 19.1 功能验收矩阵

| ID | 场景 | 验收规则 | 自动化层级 |
| --- | --- | --- | --- |
| AT-01 | 本地目录授权 | 只校验根目录并返回 Workspace Summary；没有递归 `listDirectory/readFile/searchText` | 单元 + Broker 合同 |
| AT-02 | Local Session 创建 | `POST /sessions` 不调用 `scanWorkspaceProvider`，成功返回 Session | 单元 + E2E |
| AT-03 | Server Session 创建 | 创建路径不调用全量 `scanServerWorkspace`，只完成安全绑定 | 单元 + E2E |
| AT-04 | 无索引创建 | Index 为 `empty/failed` 时仍可创建 Session 并产生首条用户事件 | E2E |
| AT-05 | 讨论启动 | Session 响应后异步进入讨论，不等待 `indexComplete=true` | E2E |
| AT-06 | 部分索引 | `building/complete=false` 的条目可以生成有界 L1/L2 | 单元 |
| AT-07 | 索引无正文 | Index Snapshot 不包含文件 content | 合同 |
| AT-08 | 索引不强制 hash | 导航枚举不读取文件内容计算所有 SHA-256 | 单元 + 性能夹具 |
| AT-09 | 生成目录过滤 | 生成目录不进入递归队列，coverage 统计正确 | 单元 |
| AT-10 | 增量更新 | 新增、修改、删除会推进 generation 并更新对应条目 | 单元 + 集成 |
| AT-11 | watcher 溢出 | Index 标记 stale 并后台重建，现有 Session 不挂起 | 集成 |
| AT-12 | L1 导航 | Envelope L1 来源于 Index Snapshot，包含 generation/revision 诊断 | 单元 |
| AT-13 | L3 权威证据 | 源码结论引用的文件正文来自 Provider read，带正文范围 hash/revision；局部读取不计算完整文件 hash | 单元 + E2E |
| AT-14 | 无重复旧载荷 | Runtime Invocation 不携带 Snapshot/Manifest/Evidence/ProjectMap 重复字段 | 合同 + Harness |
| AT-15 | Token 预算 | L1/L2/L3 分别遵守 15%/10%/40% 上限 | 单元 |
| AT-16 | 目录发现 | Agent 可以请求有界目录列表并在下一 attempt 使用结果 | E2E |
| AT-17 | 文本搜索 | Agent 可以请求有界 search，结果包含 path/line/snippet/revision | E2E |
| AT-18 | 文件补读 | Agent 可以请求指定文件/行范围，正文进入新 Envelope L3 | E2E |
| AT-19 | 补读去重 | 同一 revision、同一路径不会重复读取或重复计入 L3 | 单元 |
| AT-20 | 补读预算 | 第 9 个路径进入 deferred；正文超过 512KB 被截断；跨轮 Session 证据缓存不超过 32 项/512KB | 单元 |
| AT-21 | 补读超时 | 10s 后结构化结束，不保持 Invocation running | 集成 |
| AT-22 | 重试上限 | 第 3 次 `CONTEXT_INSUFFICIENT` 被阻断并生成明确诊断 | 单元 + E2E |
| AT-23 | 索引晚完成 | 旧 Invocation 不被更新、不等待；新 Invocation 使用新 generation | 并发集成测试 |
| AT-24 | revision 变化 | Evidence 读取期间 revision 变化时丢弃结果并最多重试一次 | 单元 + 集成 |
| AT-25 | revision 不稳定 | 连续变化返回 `WORKSPACE_REVISION_UNSTABLE`，无无限重试 | E2E |
| AT-26 | 单活动 Session | 同一 workspace 第二个活动 Session 返回 409 和当前 sessionId | E2E |
| AT-27 | 历史 Session | 已完成 Session 不阻止创建新 Session | E2E |
| AT-28 | Interrupted Lease | 可恢复 Interrupted Session 继续持有 Lease，不能被静默抢占 | E2E |
| AT-29 | 重启恢复 | 服务重启后 Lease 从持久化状态重建 | 集成 + E2E |
| AT-30 | 写回冲突 | base hash 不一致时不覆盖文件，并返回结构化冲突 | 现有单元 + E2E |
| AT-31 | 本地断线 | Local Runtime 断线后请求明确失败，不降级到 server runtime | E2E |
| AT-32 | 敏感路径 | list/search/read 均不能泄漏敏感路径和正文 | 安全测试 |

### 19.2 性能验收

| ID | 场景 | 数据集 | 阈值 |
| --- | --- | --- | --- |
| PERF-01 | Workspace 注册 | 100,000 文件目录 | P95 < 500ms，且同步路径无递归调用 |
| PERF-02 | Session 创建 | 100,000 文件目录、已有 Local Runtime 连接 | P95 < 1s，不含外部模型 |
| PERF-03 | 规模稳定性 | 1K/10K/100K 文件 | Session 创建 P95 最大值不超过最小值 2 倍 |
| PERF-04 | 首条 Session 响应 | Index `empty/building/ready` 三状态 | 三者响应差异 < 300ms |
| PERF-05 | 单文件补读 | 64KB 文件、Local Runtime | P95 < 2s |
| PERF-06 | 有界搜索 | 目标在 100,000 文件目录 | 10s deadline 内返回或明确超时 |
| PERF-07 | Runtime 心跳 | 后台索引进行中 | 心跳不丢失，事件循环延迟符合现有运维阈值 |

性能测试必须记录机器、磁盘类型、Node 版本、文件数量、运行次数和 P50/P95。共享 CI 使用回归比例，发布前在固定 Windows 本地环境执行绝对阈值。

### 19.3 用户体验验收

- 用户选择目录后不会看到由全量扫描导致的长时间不可操作状态。
- Session 创建成功后立即进入会话页；索引构建状态仅作非阻塞诊断。
- Agent 需要更多文件时，群聊有简洁进度，Debug 有完整证据轨迹。
- Provider 离线、证据不足、revision 不稳定和 Lease 冲突都有中文可操作提示。
- 不出现“扫描完成后才开始讨论”的流程文案或 UI 门禁。

### 19.4 发布阻断规则

以下任一条件不满足不得发布：

1. Session 创建路径仍可触发递归扫描或批量文件正文读取。
2. 源码结论可以在没有 L3 Evidence 时通过成功门禁。
3. Supplemental Context 没有时间、字节或重试上限。
4. 同一工作区可以启动第二个活动 Session。
5. Local Runtime 断线时发生跨位置静默降级。
6. 敏感路径、symlink 或 Workspace 边界测试失败。
7. PERF-01、PERF-02 或 PERF-03 不达标。

## 20. 验证命令规划

实施完成后至少运行：

```bash
npm run typecheck
npm run test
npm run test:harness
npm run build
npm run test:e2e:main-chain
npm run test:e2e:multi-agent-discussion
npm run test:e2e:workspace-snapshot-payload
npm run test:e2e:server-local-project-analysis
npm run test:e2e:security
npm run test:e2e:recovery
```

应新增聚合命令：

```bash
npm run test:e2e:workspace-index-first
npm run test:perf:workspace-session-create
```

聚合 E2E 覆盖 AT-01 至 AT-32 中的跨模块场景；性能命令输出机器可读 JSON 和人类可读摘要。

## 21. 可观测性

### 21.1 指标

- `workspace_authorization_duration_ms`
- `session_create_duration_ms`
- `workspace_index_status_total{status}`
- `workspace_index_entries_total`
- `workspace_index_generation_duration_ms`
- `supplemental_context_duration_ms`
- `supplemental_context_bytes_total`
- `supplemental_context_retry_total`
- `context_insufficient_terminal_total`
- `workspace_writeback_conflict_total`
- `workspace_revision_unstable_total`

### 21.2 结构化日志

日志关联键至少包含 `workspaceId/sessionId/taskId/invocationId/attemptGroupId`。Local Runtime 操作额外包含 `deviceId/requestId`。禁止记录用户文件正文、凭据、绝对本机路径或敏感文件名。

### 21.3 Debug

Debug 页面应能回答：

- 本次 Invocation 使用哪个索引 generation 和 workspace revision？
- 索引当时是 partial、ready 还是 stale？
- Agent 请求了哪些目录、搜索和文件？
- 哪些请求成功、失败、截断或延迟？
- L3 最终包含哪些证据及其 hash/revision？
- 是否因为预算、权限、断线或 revision 不稳定结束？

## 22. 发布与回滚

### 22.1 发布顺序

1. 先发布支持新旧 Index 合同读取的 Local Runtime CLI。
2. 等已连接设备达到最低兼容版本后，发布 Platform Backend 合同切换。
3. 发布 Web 非阻塞创建体验。
4. 启用新 E2E 和性能发布门禁。
5. 确认不再有调用后删除创建路径的旧 Scanner。

### 22.2 回滚边界

- 可以回滚到“无持久化索引、按需直接 list/search/read”的降级路径。
- 不允许回滚到“Session 创建同步全量扫描”。
- 不允许恢复浏览器上传 Snapshot。
- 不允许关闭 L3 Evidence 门禁换取表面成功。
- 合同升级期间 Provider 必须显式报告不支持的 operation，Backend 不得猜测兼容。

## 23. 后续版本

V2 多会话隔离在本设计基础上扩展，不改变索引优先和按需取证原则。后续至少包括：

- 同一 `workspaceId` 多活动 Session 的独立 Snapshot revision。
- 每个 Session/Task 的 sandbox 或 git worktree。
- live revision 与 Session snapshot revision 比较。
- 跨会话 ChangeSet 冲突检测、合并、取消和恢复。
- 多会话缓存隔离和调度公平性。

在这些能力完成前，V1 的 Active Session Lease 是产品支持边界，不是临时可绕过的 UI 限制。

## 24. 最终完成定义

本设计完成实施必须同时满足：

- 目录选择和 Session 创建与项目规模解耦。
- Session 和群聊不等待完整索引。
- 索引是元数据导航面，不是正文快照。
- Agent 按需读取的真实文件进入 L3 Evidence。
- 后台索引完成先后不影响已启动 Invocation 的一致性。
- 所有读取和重试有界且可审计。
- V1 同一工作区只存在一个活动 Session。
- AT-01 至 AT-32、PERF-01 至 PERF-07、UX 验收和发布阻断规则全部通过。

只有同时满足以上条件，才能认定“恢复原有索引优先架构并解决目录选择缓慢问题”已经完成。
