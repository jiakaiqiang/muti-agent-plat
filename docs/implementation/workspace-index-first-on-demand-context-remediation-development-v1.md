# Workspace Index First 与按需上下文补齐开发设计 V1

> 日期：2026-07-29
>
> 状态：Ready for implementation
>
> 适用范围：Agent Cluster V1，单 Workspace 单活动 Session
>
> 权威系统设计：[`../design/workspace-index-first-on-demand-context-system-design-v1.md`](../design/workspace-index-first-on-demand-context-system-design-v1.md)
>
> 当前实施说明：[`workspace-index-first-on-demand-context-development-v1.md`](workspace-index-first-on-demand-context-development-v1.md)
>
> 当前验收报告：[`../quality/workspace-index-first-acceptance-v1.md`](../quality/workspace-index-first-acceptance-v1.md)

## 1. 文档目的

本文档把当前代码复核发现的缺口转换为可直接执行的开发任务。它不重新设计 Workspace Context，也不恢复 Session 创建时的全量扫描，而是在现有 `Index First + On-demand Evidence + ContextEnvelopeV2` 主链上补齐正确性、安全性、会话隔离、可观测性和真实验收。

本文档完成前，当前实施说明和验收报告中的“已实施”“Covered”只能表示主链代码存在，不能作为发布完成结论。最终状态必须以本文档第 13 节的退出规则为准。

## 2. Intent Contract

### 2.1 目标

| ID | 目标 |
| --- | --- |
| G-01 | 选择目录只完成授权、canonical path 校验和 Workspace Binding，不递归扫描、不读取正文 |
| G-02 | `POST /sessions` 不等待完整索引，在 `empty/building/stale/failed` 状态下都能创建 Session |
| G-03 | Agent 使用当前可用索引导航；无索引结果时通过有界根目录引导继续，而不是直接失败或等待完整扫描 |
| G-04 | Agent 可以请求目录、搜索、文件和文件行范围；补读结果只进入新的不可变 `ContextEnvelopeV2` |
| G-05 | 索引扫描中持续发布可消费的部分 generation；扫描完成时间不成为讨论或执行门禁 |
| G-06 | 所有 list/search/read 操作都满足 Workspace 边界、symlink 和 revision 一致性要求 |
| G-07 | L1/L2/L3 实际遵守 15%/10%/40% Token 上限，不只记录预算数字 |
| G-08 | V1 在服务端全局保证同一 Workspace 只有一个活动 Session |
| G-09 | Platform Backend 不接收完整本地索引或全项目正文，只接收 Summary、有界投影和按需证据 |
| G-10 | 所有等待、补读、重试和后台扫描都有上限、可取消、可观测，并能进入明确终态 |

### 2.2 非目标

- 不实现同一 Workspace 多活动 Session 的 sandbox、worktree、独立 Snapshot 或自动合并。
- 不引入 embedding、向量数据库或语义 RAG 替代 Workspace Index。
- 不在 Platform Backend 建立本地项目正文镜像。
- 不恢复 `workspaceSnapshot` 作为 Session 创建或 Runtime 输入的权威载荷。
- 不要求首次 Invocation 等待完整索引。
- 不为导航枚举或局部文件读取计算完整文件 hash。
- 不保留第二套 Local/Server Context 流程；两种运行位置只允许 Provider 实现不同。

### 2.3 强制不变量

1. `authorize workspace`、`create session`、`build index`、`hydrate evidence` 是四个独立生命周期。
2. Session 创建关键路径禁止递归 `listDirectory`、批量 `readFile`、`searchText` 和全仓 hash。
3. 一次 Invocation 使用冻结的 `ContextEnvelopeV2`。索引晚完成只能影响下一次 Invocation。
4. L1/L2 只用于导航；源码结论、代码修改和架构结论必须有 L3 正文证据。
5. Provider 是完整索引和真实文件的事实所有者；Backend 只保存有界任务投影和证据审计。
6. 局部读取返回 `rangeHash`；完整 hash 只在完整读取、显式 stat 或写回冲突校验时计算。
7. V1 的单活动 Session 约束由服务端 Lease 保证，不能依赖前端按钮或单进程内存 Map。

## 3. 当前缺口基线

| GAP | 严重度 | 当前问题 | 发布影响 |
| --- | --- | --- | --- |
| GAP-01 | P0 | 空索引时架构证据引用为空，补读请求也为空，阶段可能直接以 `CONTEXT_INSUFFICIENT` 停止 | 阻断 |
| GAP-02 | P0 | Local Runtime 构建开始后 Workspace 变化，旧结果仍可能发布为 `ready` | 阻断 |
| GAP-03 | P0 | 扫描中的 checkpoint 只更新 entries 数量，没有发布完整 generation、entrypoints、stack 和通知 | 阻断 |
| GAP-04 | P0 | 稳定读取主要依赖异步 watcher，内容可能被标记为旧 revision | 阻断 |
| GAP-05 | P0 | `server_local` 的 list/search 没有和 read 相同的 realpath/symlink 越界保护 | 阻断 |
| GAP-06 | P1 | Agent 合同只能请求路径，不能请求 `startLine/endLine` | 阻断 |
| GAP-07 | P1 | L1/L2 记录了 Token 预算，但实际 Builder 没有按预算裁剪 | 阻断 |
| GAP-08 | P1 | 索引没有 generated/sensitive/symlink/error coverage 统计 | 阻断 |
| GAP-09 | P1 | 补读达到上限后没有明确的 exhausted 终态；上层超时也不一定取消底层请求 | 阻断 |
| GAP-10 | P1 | directory/search 结果进入上下文前没有和 file read 等价的 revision 稳定校验 | 阻断 |
| GAP-11 | P1 | Active Session Lease 主要在单进程内判断，多 Backend 实例可能同时创建活动 Session | 条件阻断 |
| GAP-12 | P1 | Debug 信息、聚合 E2E 和真实磁盘性能证据不完整，部分旧测试仍使用已废弃 Snapshot | 阻断 |

## 4. 目标架构

```text
Browser
  -> authorize/select workspace
  -> receive WorkspaceBinding immediately
  -> POST /sessions

SessionsService
  -> atomically acquire WorkspaceActiveSessionLease
  -> persist Session and first user event
  -> return without waiting for index

Workspace Provider
  -> start metadata-only index in background
  -> publish immutable partial generations
  -> keep the last usable navigation while rebuilding

Context Router
  -> query current generation with a 500ms upper bound
  -> if no usable entry exists, synthesize a bounded root bootstrap request
  -> build L1/L2 from the current partial projection

Runtime Invocation
  -> consume one frozen ContextEnvelopeV2
  -> completed, or
  -> return RuntimeContextRequest(directory/search/file-range)

Supplemental Context Hydrator
  -> validate authority, realpath boundary and operation budget
  -> execute stable list/search/read through Provider
  -> build a new ContextEnvelopeV2 and a new attempt
  -> stop after the configured retry budget
```

### 4.1 关键时序规则

- Index 在 Agent 分析前完成：本次 Invocation 使用已完成 generation。
- Index 在 Agent 分析期间完成：当前 Envelope 不变，下一次 Invocation 使用新 generation。
- Index 在补读期间变化：丢弃不稳定结果，重试一次；仍变化则返回 `WORKSPACE_REVISION_UNSTABLE`。
- Index 构建失败：Session 继续，允许有界 list/search/read；Provider 不可用时才 fail closed。
- 补读达到上限：当前阶段进入明确失败或等待用户状态，禁止无限 running。

## 5. 数据合同变更

合同修改集中在 `packages/shared/src/contracts.ts`，所有 Provider、Runtime Adapter、持久化和 UI 必须在同一批次完成迁移。

### 5.1 Canonical 文件请求

```ts
export type RuntimeContextFileRequest = {
  path: string;
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
};

export type RuntimeContextRequest = {
  reason: string;
  requestedRefs: TaskEvidenceRef[];
  requestedFiles?: RuntimeContextFileRequest[];
  requestedDirectories?: Array<{
    path: string;
    depth?: number;
  }>;
  requestedSearches?: Array<{
    query: string;
    path?: string;
    include?: string[];
    exclude?: string[];
  }>;
  requestedCommands?: string[];
  followUpInstruction?: string;
};
```

迁移规则：

- `requestedFiles` 是持久化、审计和内部处理的唯一 canonical 字段。
- Runtime JSON Normalizer 可以临时接受旧 `requestedPaths: string[]`，但必须立即转换为 `requestedFiles`，不能继续写入持久化记录。
- 所有 Runtime prompt/schema/fixture 改为输出 `requestedFiles`。
- 行范围必须满足 `startLine >= 1`、`endLine >= startLine`；`maxBytes` 由服务端再次压到单文件 64KB 上限。
- Local Runtime Provider 传输合同已经支持 `ReadFileInput.startLine/endLine/maxBytes`，不需要为行范围新建第二个操作。

### 5.2 索引 Coverage

```ts
export type WorkspaceIndexCoverage = {
  visitedEntries: number;
  indexedEntries: number;
  excludedGenerated: number;
  sensitiveEntries: number;
  skippedSymlinks: number;
  failedEntries: number;
};

export type WorkspaceIndexSnapshot = {
  workspaceId: UUID;
  revision: WorkspaceRevision;
  generation: number;
  status: WorkspaceIndexStatus;
  complete: boolean;
  entries: WorkspaceNavigationEntry[];
  entrypoints: string[];
  detectedStack: string[];
  indexedEntries: number;
  truncated: boolean;
  updatedAt: ISODateTime;
  errorCode?: string;
  coverage: WorkspaceIndexCoverage;
};
```

约束：Coverage 只包含数量，不包含本地绝对路径或敏感文件名。`indexedEntries` 必须和 `coverage.indexedEntries` 一致。敏感路径仍可作为 `sensitive=true` 的导航条目出现，但不读取正文；`sensitiveEntries` 统计这类条目。生成目录不进入递归队列，计入 `excludedGenerated`。

### 5.3 补读终态

为 Supplemental Resolution 增加统一诊断：

```ts
export type SupplementalContextOutcome =
  | 'resolved'
  | 'partial'
  | 'exhausted'
  | 'cancelled';

export type SupplementalContextResolution = {
  requestedFiles: RuntimeContextFileRequest[];
  hydratedPaths: string[];
  evidenceRevisions?: Record<string, WorkspaceRevision>;
  listedDirectories?: string[];
  completedSearches?: string[];
  failedPaths: Array<{
    path: string;
    code: SupplementalContextPathFailureCode;
    retryable: boolean;
    message?: string;
  }>;
  deferredPaths: string[];
  contentBytes: number;
  outcome: SupplementalContextOutcome;
  attempt: number;
  maxAttempts: number;
};
```

达到最大重试次数后，RuntimeError 使用 `CONTEXT_RETRY_EXHAUSTED`，同时保留最后一次 `CONTEXT_INSUFFICIENT` 的请求和 Resolution。UI 必须展示中文可操作说明。

### 5.4 Lease 合同

```ts
export type WorkspaceActiveSessionLease = {
  workspaceId: UUID;
  sessionId: UUID;
  acquiredAt: ISODateTime;
  updatedAt: ISODateTime;
  status: 'active' | 'released';
};
```

Postgres 使用 `workspace_id` 唯一约束完成原子 acquire。文件持久化模式只支持单 Backend 进程，并必须在运维状态中明确报告该限制。

## 6. 核心算法设计

### 6.1 空索引 Bootstrap

只在“当前阶段需要 Workspace 证据且 Index 查询没有返回可用候选”时执行：

1. Grounded Evidence Gate 生成 `requestedDirectories: [{ path: '.', depth: 1 }]`，不能生成空请求。
2. Hydrator 调用非递归根目录枚举，`limit <= 200`，`deadline <= 500ms`。
3. 从结果中选择常见入口：`AGENTS.md`、`README*`、`package.json`、锁文件、构建文件和一级 `src/app/apps/packages` 目录。
4. 只按任务需要读取入口文件；读取仍受 8 操作、单文件 64KB、单轮 512KB 和 Provider deadline 限制。
5. 生成新的 Envelope 和新的 attempt。后台 Index 是否完成不影响该流程。
6. 根目录为空时返回“工作区没有可分析文件”；Provider 不可用时返回结构化 Provider 错误，不能伪装成能力缺失。

禁止把 Bootstrap 扩展为固定深度递归扫描。发现更深路径必须由后续 directory/search 请求完成。

### 6.2 部分索引 Generation

Local 和 Server Provider 使用相同状态机：

```text
empty
  -> building(generation N, complete=false)
  -> building(generation N+1, complete=false)
  -> ready(generation N+2, complete=true)

workspace changed during build
  -> stale(generation N+1, complete=false)
  -> schedule next build

build failed
  -> failed, keep last usable navigation
```

发布规则：

- 每处理 250 条或每 250ms 形成一次内存 checkpoint，以先到者为准。
- 每个 checkpoint 都重新派生 `entrypoints`、`detectedStack`、Coverage 和 `indexedEntries`，推进 generation，并通知查询方。
- 磁盘持久化最多每 1 秒或每 5,000 条执行一次，避免每 250 条序列化全部 100K entries。
- 完整 entries 使用独立 Index sidecar 流式写入并原子替换；Local Runtime 主状态只保存 Index Summary 和 sidecar 引用。
- checkpoint 发布前比较 `revisionAtStart` 和当前 Provider revision。不同则发布 `stale`，不能发布 `ready`。
- rebuild 期间保留上一代可用导航，不能出现导航真空。

### 6.3 Stable Provider Operation

所有操作先执行统一的 `resolveAndAssertWorkspacePath()`：

1. 词法解析相对路径，拒绝绝对路径和 `..` 越界。
2. 对已存在目标执行 `realpath`。
3. 验证 canonical target 位于 canonical root 内。
4. 目录枚举和搜索不能跟随指向 Workspace 外的 symlink/junction。
5. sensitive/generated 权限规则在 canonical 校验后执行。

一致性规则：

- `readFile`：在同一文件句柄上读取前后执行 stat/fstat；同时同步观察目标路径 metadata。文件版本变化则丢弃结果并重试一次。
- `listDirectory`：记录操作开始和结束 revision；枚举期间同步观察触达路径，revision 变化时重试一次。
- `searchText`：记录开始和结束 revision；每个候选文件在读取前后校验 metadata，任何变化使本轮结果无效。
- watcher 只负责异步增量通知，不能作为 stable read 的唯一事实来源。
- 第二次仍不稳定时返回 `WORKSPACE_REVISION_UNSTABLE`，结果不得进入 L1/L2/L3 或证据缓存。

### 6.4 Token Budget

在 Context Builder 内执行真实裁剪：

1. 根据 `maxInputTokens` 计算 L1 15%、L2 10%、L3 40% 上限。
2. L1 按“显式请求、entrypoint、任务 path hint、其他导航”稳定排序后逐项计量和裁剪。
3. L2 按“项目入口、技术栈、相关模块、其他模块”排序后裁剪。
4. L3 继续按任务相关度、显式请求和验证需要裁剪。
5. 每层记录 `usedTokens` 和 `truncated`，测试断言实际序列化内容不超过对应预算。
6. 裁剪后没有必要 L3 时，Grounded Evidence Gate 必须返回证据不足，不能产生源码结论。

### 6.5 Supplemental Retry 与取消

- 默认最多 2 次补读 attempt。
- 每个 attempt 最多 8 个 Provider 操作、512KB 正文和 10 秒总 Provider 时间。
- 上层 deadline、用户取消、Runtime 断线和 Session 终止统一传递 `AbortSignal` 到 Broker/Provider。
- 超时后必须从 pending registry 移除请求；迟到响应只记审计，不能修改 Session。
- 重复请求按规范化后的 directory/search/file-range key 去重。
- 达到预算后写入 `outcome=exhausted` 和 `CONTEXT_RETRY_EXHAUSTED`，Session 不能继续保持无期限 running。

### 6.6 单活动 Session Lease

Acquire 必须和 Session 创建处于同一个持久化事务或同一个原子临界区：

```text
acquire(workspaceId, sessionId)
  -> no active lease: insert and continue
  -> same session lease: idempotent success
  -> other active session: 409 WORKSPACE_ACTIVE_SESSION_CONFLICT
```

- Postgres 新增 `workspace_active_session_leases` 表，`workspace_id` 为主键或唯一键。
- Session 进入 `COMPLETED/FAILED/CANCELLED` 时释放 Lease。
- 进程重启时对非终态 Session 和 Lease 进行一致性恢复。
- 文件持久化模式使用现有持久化串行化机制，只声明单 Backend 实例支持。
- V1 不增加文件级锁、会话 sandbox 或跨会话合并。

## 7. 组件修改矩阵

| 区域 | 主要文件 | 修改内容 |
| --- | --- | --- |
| Shared contracts | `packages/shared/src/contracts.ts` | `requestedFiles`、Coverage、Resolution outcome、错误码和 Lease 合同 |
| Runtime schema | `packages/shared/src/runtime-contracts/` | Runtime 输出 schema 改为 canonical 文件范围请求 |
| Local Runtime | `packages/local-runtime-cli/src/workspace.ts` | 部分 generation、稳定读取、revision 提交校验、Coverage |
| Local persistence | `packages/local-runtime-cli/src/state.ts` | Summary 与 Index sidecar 分离，避免同步序列化 100K entries |
| Local transport | `packages/local-runtime-cli/src/transport.ts` | 只注册 Summary；透传范围请求、取消和结构化不稳定错误 |
| Server Provider | `apps/server/src/modules/workspaces/server-local-workspace-provider.ts` | 统一 stable operation 和 canonical boundary |
| Server index | `apps/server/src/modules/workspaces/server-local-workspace-index.ts` | 真正的 partial generation、Coverage、提交前 revision 校验 |
| Workspace tools | `workspace-list-directory.ts`、`workspace-search-text.ts`、`workspace-read-file.ts` | 统一 realpath/symlink guard 和操作稳定性 |
| Context v2 | `apps/server/src/modules/context-v2/` | L1/L2 实际 Token 裁剪、partial 诊断、L3 gate |
| Orchestrator | `apps/server/src/modules/orchestrator/orchestrator.service.ts` | 空索引 Bootstrap、范围补读、新 Envelope、取消和 exhausted 终态 |
| Runtime adapters | `apps/server/src/modules/runtimes/` | schema/prompt/normalizer/audit 全面使用 `requestedFiles` |
| Sessions | `apps/server/src/modules/sessions/sessions.service.ts` | 原子 acquire/release Lease，不依赖进程内 Map |
| Persistence | `apps/server/src/modules/persistence/` | Lease 存储接口、Postgres 表与迁移、恢复一致性 |
| Debug API/UI | `apps/server/src/modules/debug/`、`apps/web/src/components/DebugRuntimeView.vue`、`ChatTimeline.vue` | 展示目录、搜索、文件范围、结果、截断、失败、重试和 generation |
| Metrics | `apps/server/src/common/workspace-metrics.ts` | partial、bootstrap、unstable、boundary、exhausted、event-loop delay 指标 |
| E2E | `tests/e2e/`、`package.json` | 新场景并入唯一聚合验收命令，清除旧 Snapshot 夹具 |

## 8. Architecture Constraints

### 8.1 允许修改

- `packages/shared/src/`
- `packages/local-runtime-cli/src/`
- `apps/server/src/modules/workspaces/`
- `apps/server/src/modules/context-v2/`
- `apps/server/src/modules/orchestrator/`
- `apps/server/src/modules/runtimes/`
- `apps/server/src/modules/sessions/`
- `apps/server/src/modules/persistence/`
- `apps/server/src/modules/debug/`
- `apps/server/src/common/workspace-metrics.ts`
- `apps/web/src/components/ChatTimeline.vue`
- `apps/web/src/components/DebugRuntimeView.vue`
- 与上述行为直接对应的测试、脚本和文档

### 8.2 禁止修改方向

- 禁止重新调用 `scanWorkspaceProvider/scanServerWorkspace` 作为 Session 创建前置条件。
- 禁止为了空索引回退到全仓固定深度扫描。
- 禁止把完整 `WorkspaceIndexSnapshot.entries` 放进 Local Runtime 注册消息。
- 禁止把完整索引或全项目正文持久化到 Platform Backend。
- 禁止取消 L3 Evidence Gate 来绕过证据不足。
- 禁止用更长 Session/Agent 超时掩盖索引等待。
- 禁止在 V1 引入多 Session 文件隔离能力。

## 9. 可执行工作包

### WP-01：合同与失败语义

依赖：无。

实施：

1. 在 Shared contracts 增加 `RuntimeContextFileRequest`、Coverage、Resolution outcome、Lease 和错误码。
2. 更新 Runtime 输出 schema、Normalizer、所有 Runtime Adapter prompt 和 fixture。
3. Normalizer 临时接受 `requestedPaths` 输入别名，但内部只产生 `requestedFiles`。
4. 更新持久化序列化和 Debug DTO。
5. 把 `LOCAL_RUNTIME_PROTOCOL_VERSION` 从 5 提升到 6。Coverage 成为必填字段，旧 CLI 不能继续被当作兼容客户端；Server 与 CLI 必须同批发布。

完成定义：

- 全仓生产代码不再读取 `RuntimeContextRequest.requestedPaths`，仅 Normalizer 迁移入口允许出现。
- 行范围非法输入被拒绝或规范化，不进入 Provider。
- Shared 合同测试、Runtime schema 测试、Adapter 测试通过。

### WP-02：Workspace 安全与稳定读取

依赖：WP-01。

实施：

1. 抽取并复用统一 canonical path/symlink guard。
2. 为 server_local 的 list/search 补齐和 read 相同的边界校验。
3. 为 Local/Server read/list/search 实现 before/after 稳定校验和一次重试。
4. 让 Broker deadline 和取消向底层传播，清理迟到响应。
5. 增加 boundary violation、unstable revision 和 cancellation 指标。

完成定义：

- 工作区内 symlink/junction 指向外部时，list/search/read 全部拒绝。
- 操作期间修改文件时，旧结果不进入上下文。
- 局部读取只返回 `rangeHash`，测试证明没有调用完整 hash 路径。

### WP-03：空索引 Bootstrap 与补读闭环

依赖：WP-01、WP-02。

实施：

1. 修改 Grounded Evidence Gate，使空索引产生根目录请求而不是空请求。
2. Hydrator 支持 directory/search/file-range 的统一预算、去重和审计。
3. 每次成功补读后生成新的 Context Assembly、Envelope 和 Invocation attempt。
4. 实现 `resolved/partial/exhausted/cancelled` 终态。
5. UI 展示中文的请求明细和 exhausted 处理建议。

完成定义：

- `empty/failed` Index 下，架构分析能通过根目录引导取得第一批证据。
- Index 晚于 Agent 分析完成不阻塞当前 Invocation，也不原地修改 Envelope。
- 最多两轮补读后明确终止，不存在无限 running。

### WP-04：真实部分索引

依赖：WP-02。

实施：

1. 在 Local 和 Server Index Builder 中实现统一 checkpoint 状态机。
2. checkpoint 生成新的 generation、entrypoints、detectedStack、Coverage 和通知。
3. 构建提交前重新检查 revision；竞速时发布 stale 并调度下一代。
4. Index entries 与主状态分离持久化，使用流式 sidecar 和原子替换。
5. watcher 溢出、目录新增或异常时保留上一代导航并重建。

完成定义：

- 观察者能在完整扫描结束前读取至少一个 `building/complete=false` 的非空 generation。
- 旧 revision 永远不会发布为 `ready`。
- 100K entries checkpoint 不造成 Runtime 心跳超时或明显事件循环阻塞。

### WP-05：Context Token 预算

依赖：WP-01、WP-03、WP-04。

实施：

1. 为 L1/L2 增加确定性 Token 计量和裁剪函数。
2. 保留 entrypoint 和显式请求的优先级，避免相关文件挤掉基础入口。
3. 将每层 `usedTokens/truncated` 纳入 Debug 诊断。
4. 补齐边界值、超长路径、超大 project map 和无 L3 场景测试。

完成定义：

- 实际序列化后的 L1/L2/L3 分别不超过 15%/10%/40%。
- 相同输入产生相同裁剪结果。
- 裁剪不会把缺少证据的源码结论包装成成功。

### WP-06：全局单活动 Session Lease

依赖：WP-01。

实施：

1. 在 Persistence 抽象增加 acquire/release/reconcile。
2. Postgres 增加唯一 Lease 表和事务实现。
3. SessionsService 在创建 Session 前原子 acquire，终态后 release。
4. Recovery 对非终态 Session 和 Lease 做幂等对账。
5. 文件存储模式标记为单 Backend 实例；多实例启动配置必须失败或给出阻断健康状态。

完成定义：

- 两个 SessionsService/Backend 实例并发创建同一 Workspace 时只有一个成功。
- 重启后仍能拒绝第二个活动 Session。
- 终态释放后可以创建新 Session。

### WP-07：可观测性、聚合验收与性能

依赖：WP-02 至 WP-06。

实施：

1. Debug API/UI 展示 generation、index status、目录/搜索/文件范围、结果、耗时、字节、截断、失败和重试。
2. 补齐 Coverage、bootstrap、revision unstable、retry exhausted 和 Lease 冲突指标。
3. 删除或改写仍上传 `workspaceSnapshot` 的旧 E2E 夹具。
4. 把所有 Workspace Index First 单元、集成、E2E 和冲突测试加入唯一聚合命令。
5. 在固定 Windows 机器上创建真实 1K/10K/100K 文件目录，采集磁盘类型、P50/P95 和事件循环延迟。
6. 根据最终代码同步实施说明、验收报告和功能状态文档。

完成定义：

- 聚合命令真实运行第 10 节全部阻断用例。
- Debug 页面可以回答一次补读请求从提出到完成的完整过程。
- 真实磁盘性能报告归档，不能再用 metadata summary 代替绝对性能结果。

## 10. 测试与验收矩阵

| 验收项 | 测试场景 | 层级 |
| --- | --- | --- |
| AT-01 | 目录授权不递归、不读取正文、不计算全仓 hash | 单元 + E2E |
| AT-02 | 1K/10K/100K 规模下 Session 创建耗时不线性增长 | 性能 |
| AT-03 | `empty/building/stale/failed` 都能创建 Session 和首条用户事件 | E2E |
| AT-04 | 空索引架构任务生成根目录请求并在下一 attempt 使用结果 | E2E |
| AT-05 | Index 在分析期间完成，只影响下一 Invocation | 并发集成 |
| AT-06 | 扫描未完成时发布可消费的 partial generation | 单元 + 集成 |
| AT-07 | revision 变化时旧构建不能发布为 ready | 并发单元 |
| AT-08 | Coverage 对 generated/sensitive/symlink/error 计数正确 | 单元 |
| AT-09 | navigation/index 不包含正文和内容 hash | 合同 + 单元 |
| AT-10 | 文件行范围进入 L3，只有 `rangeHash` | 合同 + E2E |
| AT-11 | directory/search/file 请求都在下一 attempt 可用 | E2E |
| AT-12 | list/search/read 全部阻断 Workspace 外 symlink/junction | 安全 E2E |
| AT-13 | read/list/search revision 竞速重试一次，连续变化明确失败 | 并发集成 |
| AT-14 | L1/L2/L3 实际不超过 15%/10%/40% | 单元 + E2E |
| AT-15 | 补读达到两轮后进入 exhausted，不无限 running | E2E |
| AT-16 | deadline/cancel 会终止底层 Broker/Provider 请求 | 集成 |
| AT-17 | 两 Backend 实例竞争同一 Workspace Lease 只有一个成功 | Postgres 集成 |
| AT-18 | 注册载荷只含 Summary；Backend 查询投影默认 50、硬上限 200 | 合同 + 性能 |
| AT-19 | Debug 展示完整请求、结果、revision、hash、截断和重试 | Web + E2E |
| AT-20 | 100K 真实文件索引期间 Runtime 心跳正常，记录事件循环延迟 | 固定环境性能 |

建议新增测试文件：

```text
tests/e2e/workspace-empty-index-bootstrap.spec.ts
tests/e2e/workspace-partial-generation.spec.ts
tests/e2e/workspace-context-file-range.spec.ts
tests/e2e/workspace-revision-race.spec.ts
tests/e2e/workspace-symlink-boundary.spec.ts
tests/e2e/workspace-retry-exhausted.spec.ts
tests/e2e/workspace-active-lease-concurrency.spec.ts
scripts/workspace-real-files-performance.mjs
```

聚合命令 `npm run test:e2e:workspace-index-first` 必须至少包含：

```bash
npm run test -w @agent-cluster/shared
npm run test -w @agent-cluster/local-runtime-cli
npm run test:workspace-index-first -w @agent-cluster/server
npm run test -w @project/web
npm run test:e2e:workspace-index-first-smoke
npm run test:e2e:workspace-tools-pull
npm run test:e2e:context-insufficient-retry
npm run test:e2e:context-insufficient-multi-retry
npm run test:e2e:server-local-source-conflict-guard
npm run test:e2e:browser-local-runtime-cli
npm run test:e2e:security
npm run test:e2e:recovery
```

新增用例必须并入该聚合命令，不能只在验收文档中单独列出。

## 11. 性能门禁

| 指标 | 门禁 |
| --- | --- |
| Workspace 注册 P95 | 已连接 Local Runtime 时小于 500ms |
| `POST /api/sessions` P95 | 不含模型耗时，小于 1s |
| 规模稳定性 | 1K/10K/100K 创建耗时最大 P95 不超过最小值 2 倍，允许固定抖动容差 |
| Root Bootstrap | Provider 时间不超过 500ms，非递归，最多 200 entries |
| 单文件补读 | 最多 64KB，记录 P50/P95 |
| 单轮 Supplemental | 最多 8 操作、512KB、10s |
| Retry | 默认最多 2 轮 |
| Index 心跳 | 100K 真实文件索引期间 Local Runtime 心跳不中断 |
| Event loop | 100K 真实文件索引期间 P95 小于 100ms、max 小于 1s |

性能报告必须记录 OS、Node、CPU、内存、磁盘类型、文件系统、文件数量、总字节数、样本数和 P50/P95。`100K metadata summary` 只能证明注册/创建载荷与 entries 解耦，不能替代真实磁盘扫描性能。

## 12. 发布与回滚

### 12.1 发布顺序

1. 先合并 Shared contract、Provider 安全和稳定读取。
2. 再合并空索引闭环和部分索引。
3. 再启用 Token 裁剪和全局 Lease。
4. 最后更新 Debug、聚合测试和文档状态。
5. Shared、Server、Web 和 Local Runtime CLI 必须作为同一个兼容发布批次验证。

### 12.2 数据迁移

- Postgres 先创建 Lease 表/唯一约束，再部署使用 Lease 的 Server。
- Index sidecar 是可重建缓存，不需要把旧 entries 逐条迁移；读取旧状态后补零值 Coverage、标记 stale 并后台重建。
- RuntimeContextRequest 持久化旧记录在读取时迁移 `requestedPaths -> requestedFiles`，新记录只写 canonical 字段。

### 12.3 回滚原则

- 可以删除 Index sidecar 并重建，不影响 Workspace 正文。
- Lease 迁移回滚前必须先停止新 Session 创建，避免并发约束失效。
- 不能回滚到 Session 创建同步扫描。
- 不能通过关闭 Evidence Gate 维持可用性。

## 13. 最终退出规则

只有同时满足以下条件，功能状态才能从“主链存在，闭环未完成”更新为“完成”：

1. GAP-01 至 GAP-12 全部有对应代码、自动化测试和审计证据。
2. AT-01 至 AT-20 全部通过，且聚合命令实际包含所有阻断用例。
3. `npm run typecheck`、`npm run test`、`npm run test:harness`、`npm run build` 全部通过。
4. 固定 Windows 机器的真实 100K 文件性能报告已归档。
5. Local Runtime 注册和 Backend 持久化抽样证明没有完整 entries 和全量正文。
6. 两 Backend 实例的 Postgres Lease 竞争测试通过；文件模式明确限制为单实例。
7. Debug 页面能展示 directory/search/file-range、成功/失败/截断/取消/exhausted 和最终 L3。
8. 实施说明、验收报告、功能状态和本文档结论一致，不再提前标记 Covered。

## 14. 开发执行记录模板

每个工作包合并前填写：

```markdown
### WP-XX 执行记录

- 状态：pending / in_progress / blocked / completed
- 负责人：
- 修改文件：
- 合同变化：
- 数据迁移：
- 已运行测试：
- 测试结果：
- 性能结果：
- 剩余风险：
- 对应 GAP：
- 对应 AT：
```
