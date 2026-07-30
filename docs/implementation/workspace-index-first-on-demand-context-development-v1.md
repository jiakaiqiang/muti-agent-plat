# Workspace Index First 与按需上下文实施文档 V1

> 状态：已实施，等待发布环境绝对性能基准  
> 权威设计：[`../design/workspace-index-first-on-demand-context-system-design-v1.md`](../design/workspace-index-first-on-demand-context-system-design-v1.md)  
> 验收证据：[`../quality/workspace-index-first-acceptance-v1.md`](../quality/workspace-index-first-acceptance-v1.md)

## 1. 实施目标

本次改造恢复“索引导航 + 按需读取”的单轨架构，解决以下问题：

1. 选择本地目录或创建 Session 时同步递归扫描，耗时随文件数增长。
2. 简单改为后台扫描后，Agent 仍可能等待完整扫描，或在索引完成前缺少证据。
3. Provider revision、索引 generation 和已读正文 revision 发生竞速时，旧证据可能被误用或导致无限补读。
4. V1 没有多会话文件隔离能力，却允许同一 Workspace 同时启动多个活动 Session。

## 2. 最终主链路

```text
目录授权
  -> 建立 Workspace Binding 和轻量 revision
  -> POST /sessions 立即创建 Session 和首条用户事件
  -> Provider 后台构建 metadata-only index
  -> ContextEnvelopeV2 L1/L2 消费当前可用索引
  -> Grounded Evidence Gate 发现 L3 不足
  -> RuntimeContextRequest 请求 directory/search/file
  -> Provider 有界读取并记录正文范围 hash/revision
  -> 刷新 Selected Evidence 后重试同一阶段
  -> 写回后 revision 变化，旧 L3 自动失效并按新 revision 重新取证
```

Session 创建不调用 Workspace Scanner，也不等待 `indexComplete=true`。索引为空、构建中、过期或失败都属于可推进状态。

## 3. 代码落点

| 能力 | 实现位置 | 关键行为 |
| --- | --- | --- |
| Workspace 合同 | `packages/shared/src/contracts.ts` | Binding、Index、任务查询、分页、directory/search、range hash、Supplemental Resolution、revision evidence |
| Local Runtime 注册 | `packages/local-runtime-cli/src/transport.ts` | 注册只发送 Index Summary，不序列化全部 entries |
| Local Provider Index | `packages/local-runtime-cli/src/workspace.ts` | 后台元数据索引、持久化、文件级 watcher 增量更新、无正文 hash |
| Server Provider Index | `apps/server/src/modules/workspaces/server-local-workspace-index.ts` | 后台元数据索引、sidecar、分页、文件级增量更新、stale/rebuild、重建期间保留上一代导航 |
| Session 快速绑定 | `apps/server/src/modules/sessions/sessions.service.ts` | 移除同步扫描，只校验目录/注册信息并建立 Binding |
| Active Session Lease | `apps/server/src/modules/sessions/sessions.service.ts` | 同 Workspace 非终态 Session 冲突，重启后从持久化 Session 重建语义 |
| Index 刷新 | `apps/server/src/modules/orchestrator/orchestrator.service.ts` | Invocation 前最多等待 500ms 查询最多 50 条任务相关投影；投影先保留基础入口再追加词法相关候选；不固定拉取 2,000 条，失败时继续使用现有状态 |
| L1/L2/L3 | `apps/server/src/modules/context-v2/build-envelope-from-context-assembly.ts` | L1/L2 来自 Index；L3 只接收当前 revision 的已读正文 |
| Project Map | `apps/server/src/modules/orchestrator/project-map.service.ts` | 索引提供导航，已读正文补充 scripts 与技术栈，不回退到全仓正文 |
| Supplemental Context | `apps/server/src/modules/orchestrator/orchestrator.service.ts` | 所有 Runtime 阶段统一补读，8 操作、512KB、10s、默认最多 2 轮；架构任务首次执行前只做 8 文件/256KB/1.5s 的短时入口预读；Session 证据缓存最多 32 项/512KB |
| 内置代码搜索 | `apps/server/src/modules/tools/builtin/code-search.tool.ts` | 直接流式搜索，不构造 Workspace Snapshot；100 结果、512KB 单文件、10s deadline |
| 前端冲突体验 | `apps/web/src/components/SessionWorkspace.vue` | 409 显示当前 Session，并支持跳转和复制 Session ID |
| Runtime 调试 | `apps/server/src/modules/runtimes/runtime.service.ts`、`apps/web/src/components/DebugRuntimeView.vue` | 展示 index generation/status、workspace revision、补读次数/耗时和 L3 evidence paths |
| 工作区指标 | `apps/server/src/common/workspace-metrics.ts`、`apps/server/src/modules/ops/ops.controller.ts` | 采集设计中的 11 项指标，通过 `GET /ops/workspace-metrics` 只读输出聚合数据 |

## 4. 关键不变量

### 4.1 创建路径

- `local_bridge` 只接收 `workspaceId/displayName/capabilities/revision/index summary`。
- `server_local` 只做绝对路径、真实目录、平台仓库边界和 canonical path 校验。
- 创建响应不依赖 `workspaceSnapshot`。
- 客户端上传 `workspaceSnapshot` 返回 400。

### 4.2 索引路径

- Index entry 只能包含 path、kind、size、mtime、language、generated、sensitive 等元数据。
- 导航枚举不读取正文计算全量 SHA-256。
- 完整索引留在 Provider；Backend 仅接收注册 Summary 和每轮最多 50 条任务相关元数据投影。
- 任务查询先保留 Provider 识别的基础入口，再追加词法匹配；即使命中局部源码，也不能把 `package.json` 等工程入口从有界投影中挤掉。
- 截断/行范围读取使用真实局部 I/O，只返回 `rangeHash/fileSize/modifiedAt`；只有完整读取、显式 stat 或写回校验计算完整 hash。
- generated、sensitive、symlink 和 Workspace 外路径不进入可用导航。
- 普通文件新增、修改和删除只更新对应条目并推进 generation；已有父目录的 metadata 事件保留已知子树，不能先删除子项再只补回目录本身。
- Index `complete` 的稳定基线只由完整构建或持久化快照更新，临时 stale/incremental 批次不能把后续完整度永久污染为 `false`。
- 新增目录、构建竞速和 watcher 异常才降级为 stale 后台重建。
- 重建期间保留上一代有界导航，状态为 `building/stale`，避免导航真空。
- 旧构建提交前校验 revision；revision 已变化时不得把旧结果发布为 `ready`。

### 4.3 证据路径

- Index 只回答“可能去哪里找”，不能代替代码证据。
- Runtime 只通过 `ContextEnvelopeV2` 接收上下文。
- Source conclusion 需要 L3 文件正文，文件必须带 Provider revision 和本次返回正文的 hash；局部读取使用 `rangeHash`，不得隐式计算完整文件 hash。
- Provider Index 存在时，旧 revision 的 Supplemental Evidence 不进入新 Envelope。
- Runtime 请求的路径即使不在首次 Router evidenceRefs 中，成功补读后也会提升为 Selected Evidence。

### 4.4 有界等待

| 项目 | 上限 |
| --- | --- |
| Invocation 前 Index 获取 | 500ms |
| 单轮 Provider 操作 | 8 |
| 单轮正文 | 512KB |
| Session 证据缓存 | 32 项且正文总量 512KB；旧 revision 正文淘汰 |
| 单文件读取 | 64KB |
| Supplemental Provider 时间 | 10s |
| 架构任务首次入口预读 | 8 文件、256KB、1.5s；失败或超时后继续现有索引流程 |
| Evidence 稳定读取 | revision 变化后重读 1 次 |
| `CONTEXT_INSUFFICIENT` | 默认补读重试 2 轮 |

达到上限后返回 failed/deferred/truncated 诊断，不扩张为全量扫描，也不保持 Session 无限 running。

## 5. Revision 竞速处理

### 5.1 索引构建期间变化

索引构建捕获 `revisionAtStart`。构建完成时如果 Provider revision 已变化：

1. 不发布旧 revision 的 `ready` 快照。
2. 保留已获得的元数据导航。
3. 标记 `stale/complete=false`。
4. 调度下一代构建。

### 5.2 Evidence 读取期间变化

单文件读取后再次查询 Provider revision。两者不一致时丢弃正文并重读一次；连续变化返回 `WORKSPACE_REVISION_UNSTABLE`。

### 5.3 写回后的复核

写回推进 Provider revision。Post-review 不能复用旧正文；Envelope 会淘汰旧 revision L3，通过保留的索引导航提出新补读路径，再以新 revision 复核。

## 6. V1 会话隔离边界

V1 使用单 Workspace 单活动 Session：

- 活动态包括讨论、等待确认、执行、复核、等待决策和可恢复中断。
- `COMPLETED/FAILED/CANCELLED` 不持有 Lease。
- 第二个活动 Session 返回结构化 `409 WORKSPACE_ACTIVE_SESSION_CONFLICT`。
- 该约束由服务端持久化 Session 状态判定，不是前端按钮门禁。

V2 才引入 Session sandbox/worktree、多 revision 快照和跨会话合并；V1 不伪装支持并发隔离。

## 7. 回归原因

全量扫描来自双运行位置改造时对安全要求的错误落地：正确要求是“客户端不能伪造 Snapshot、Backend 必须从受信 Provider 取证”，实现却把它等同为“Session 创建时由服务端同步生成完整 Snapshot”。这把授权、索引、正文取证和 hash 校验四种职责塞进一个阻塞请求。

本次保留安全边界，但重新拆分职责：Binding 负责身份，Provider 侧完整 Index 负责导航，Backend 只持有有界任务投影，Provider read 负责正文，revision/正文范围 hash 负责一致性。

## 8. 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGENT_CLUSTER_SUPPLEMENTAL_CONTEXT_DEADLINE_MS` | `10000` | 单轮补读 deadline，最大 10s |
| `AGENT_CLUSTER_CONTEXT_INSUFFICIENT_MAX_RETRIES` | `2` | 证据不足自动补读轮数 |
| `WORKSPACE_PERF_DISK_TYPE` | `unknown` | 性能报告机器磁盘说明 |

## 9. 验证入口

```bash
npm run test:e2e:workspace-index-first
npm run test:e2e:server-local-project-analysis
npm run test:perf:workspace-session-create
npm run typecheck
npm run test
npm run test:harness
npm run build
```

CI 性能夹具验证创建路径只处理 100K Index Summary，不能替代发布前固定 Windows 机器上的 100K 真实文件绝对基准。
