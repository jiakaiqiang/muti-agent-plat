# Multica 对标改造剩余事项需求文档 v1

> 日期：2026-07-10
> 状态：Codex 本地 CLI/Runtime 可用，P0 仅受其外部模型上游验收阻塞；Claude 与 PR-02～PR-04 已完成验收；P1 的 PR-06 已完成，PR-05 工程实现完成；剩余真实验收已纳入计划但暂不启动；P2 冻结
> 需求类型：P0/P1 统一闭环交付与 P2 后续版本规划
> 上游需求：[`../analysis/multica-actionable-refactor-plan-v1.md`](../analysis/multica-actionable-refactor-plan-v1.md)
> 已完成实现：[`../roadmap/multica-refactor-completion-execution-plan-v1.md`](../roadmap/multica-refactor-completion-execution-plan-v1.md)
> 当前功能状态：[`../analysis/feature-inventory-and-status-v1.md`](../analysis/feature-inventory-and-status-v1.md)
> 系统设计基线：[`../design/multica-refactor-completion-system-design-v1.md`](../design/multica-refactor-completion-system-design-v1.md)

## 1. 背景

Multica 对标改造 R1～R7 已完成代码实现和受控本地自动化验收，但当前验证主要基于 stub、本地 file persistence、fake PostgreSQL pool 或无 Redis 的内联执行。

系统要进入真实环境灰度或生产发布，还需要完成真实 CLI、PostgreSQL、Redis、工作目录安全和超时参数的环境验收，并补齐 Skill 前端管理。以上 P0/P1 事项作为一个统一交付阶段，必须全部完成后才能形成闭环。

v0.3 兼容清理、跨 Session Resume 和真实 Runtime Autopilot 统一归入 P2 后续计划。P0/P1 闭环完成前，P2 只保留需求和设计输入，不进入开发。

本需求文档只定义剩余工作，不重复实现已经完成的 R1～R7 功能。

## 2. 目标

### 2.1 发布目标

- 证明 Codex 和 Claude Code 在真实 CLI、真实凭据和真实工作目录中可稳定运行。
- 证明 ActorRef PostgreSQL 回填可以安全 dry-run、备份、执行、回滚和重复执行。
- 证明 Autopilot 在真实 Redis/BullMQ 中能够定时触发、去重、恢复和停止调度。
- 证明 Workdir Brief 在真实文件权限、异常退出和并发执行条件下不会破坏用户文件。
- 形成可用于发布审批的验证报告、失败回滚方案和配置基线。

### 2.2 P0/P1 闭环目标

- 提供 Skill 可视化管理和 Agent 绑定入口。
- 完成 Watchdog 参数基线、真实环境报告、回滚演练和配置基线。
- 保证 P0/P1 的需求、系统设计、代码、测试、合同和运维文档同步闭环。

### 2.3 P2 后续目标

- 为 v0.3 删除 deprecated Actor 字段、legacy Runtime 路径提供安全迁移条件。
- 在权限、隔离和成本边界明确后支持跨 Session Resume 和真实 Runtime Autopilot。
- P2 必须在 P0/P1 闭环完成后重新确认范围、设计和发布策略。

## 3. 范围与优先级

| 编号 | 需求 | 优先级 | 发布阻断 | 当前状态 |
| --- | --- | --- | --- | --- |
| PR-01 | 真实 Codex/Claude CLI 验收 | P0 | 是 | Codex 本地 CLI/Runtime 可用、生产验收暂停：Claude 已完整通过；Codex 历史三次 `upstream_400`，2026-07-12 三次补验返回 502 |
| PR-02 | PostgreSQL ActorRef 回填演练 | P0 | 是 | 已完成：隔离 PostgreSQL dry-run/apply/幂等/备份/回滚通过 |
| PR-03 | Redis/BullMQ Autopilot 调度验收 | P0 | 是 | 已完成：真实 Redis 调度/去重/停用/重启恢复/队列指标通过 |
| PR-04 | Workdir Brief 生产安全演练 | P0 | 是 | 已完成：Windows 字节恢复/崩溃恢复/lease/失败留证/TTL 通过 |
| PR-05 | Watchdog 参数和可观测性基线 | P1 | 是（闭环门禁） | 工程实现完成：指标、超时诊断、采样脚本和分析器已完成；真实采样任务已纳入计划但暂不启动 |
| PR-06 | Skill 管理前端 | P1 | 是（闭环门禁） | 已完成：列表/编辑/文件校验/Agent 绑定/删除影响/注入预览、组件测试和浏览器 e2e 已落地 |
| PR-07 | v0.3 Actor/legacy 清理 | P2 | 不进入当前阶段 | 冻结，待 P0/P1 闭环 |
| PR-08 | 跨 Session Resume | P2 | 不进入当前阶段 | 冻结，待 P0/P1 闭环 |
| PR-09 | Autopilot 真实 Runtime 与高风险治理 | P2 | 不进入当前阶段 | 冻结，待 P0/P1 闭环 |

### 3.1 阶段门禁

```text
当前阶段：P0 + P1
  -> 系统设计确认
  -> PR-01 ～ PR-06 实现/验收
  -> 合同、测试、运维、报告同步
  -> P0/P1 统一闭环评审
  -> 明确批准后解锁 P2
  -> P2 独立需求/设计/计划
  -> PR-07 ～ PR-09 开发
```

强制规则：

- PR-01～PR-06 必须按现有系统设计边界实施；如果实现需要改变模块职责、合同或安全边界，先更新系统设计再开发。
- P0 完成但 P1 未完成时，当前剩余事项仍不得标记为闭环。
- PR-07～PR-09 在 P0/P1 闭环前不得创建产品代码、migration 或默认开关变更。
- P2 解锁需要一份明确的 P0/P1 完成报告和新的用户/发布评审结论。

## 4. 当前基线

- `ENGINEERING_RUNTIME_STREAMING` 默认值为 `off`，支持 `off | codex | all`。
- Codex app-server、Claude stream-json、RunHandle、cancel、watchdog、usage 和 Resume 已通过受控 stub e2e。
- ActorRef PostgreSQL collection 回填已在隔离 PostgreSQL 实例完成 dry-run、apply、幂等、备份和回滚演练。
- Autopilot 已在隔离 Redis/BullMQ 中完成 Job Scheduler、issueguard、停用和服务重启恢复验收。
- Workdir Brief 已在 Windows 隔离目录完成字节级恢复、无原文件清理、lease 冲突、启动恢复、失败留证和 TTL 清理演练。
- 真实 Codex/Claude CLI 已确认安装并登录；Codex 已在成本确认后尝试三次真实调用（包含一次最小 app-server probe），均在首轮返回上游 `upstream_400`，未产生 token 或 CLI session。Claude 已完成 3 次真实运行、同 session Resume、失效 Resume fallback、cancel 与 legacy 显式失败，且 Workdir Brief 均逐字节恢复。
- Watchdog 已记录首帧、帧间隔、总时长和完整 timeout 诊断，真实 CLI 验收脚本支持显式成本门控的 `sample` 阶段和至少 20 次采样，基线分析器可输出 P50/P95/P99/max 与候选参数。
- Skill 管理前端已接入现有 Skill/Agent API，覆盖 CRUD、文件、绑定、删除影响和新会话注入验证。
- R1～R7 基础质量门此前已通过；PR-05/PR-06 变更集的完整质量门结果记录在 P1 验收报告。

## 5. P0 生产就绪需求（当前闭环阶段）

### PR-01 真实 Codex/Claude CLI 验收

#### 需求说明

在隔离的 staging 工作区中使用真实 Codex CLI、Claude Code CLI 和真实认证配置执行完整任务，不使用测试 stub。

#### 配置要求

```powershell
$env:CODEX_RUNTIME_ENABLED='true'
$env:CLAUDE_CODE_ENABLED='true'
$env:CODEX_RUNTIME_COMMAND='codex'
$env:CLAUDE_CODE_COMMAND='claude'
$env:ENGINEERING_RUNTIME_STREAMING='codex' # 第一阶段
# 验收 Codex 后再切换为 all
```

- 凭据通过部署环境注入，不写入仓库、日志、artifact 或测试快照。
- staging workdir 必须是一次性副本或专用测试仓库。
- 高风险文件写入仍必须经过 `cap-file-write` preflight。

#### 场景

1. Codex 完成长中文和代码块任务，不出现 `OUTPUT_SCHEMA_INVALID`。
2. Claude Code 完成同等任务并返回合法 `RuntimeOutput`。
3. 执行过程中持续产生 `runtime_progress/tool_called/tool_completed`。
4. `usage.totalTokens > 0`，runtime invocation 保存真实 CLI session id 和 workdir。
5. 第二轮同任务成功 Resume；过期 session 触发一次 `RESUME_FALLBACK` 后成功新建会话。
6. 用户 cancel 后 CLI 进程退出，任务不会错误进入 completed。
7. `ENGINEERING_RUNTIME_STREAMING=off` 时 legacy 路径仍能运行或显式失败，不发生静默 mock fallback。

#### 验收标准

- Codex 和 Claude 各连续执行至少 3 次，无进程残留、无用户文件污染。
- 所有运行均可在 timeline 和 runtime invocation log 中追溯。
- Resume 成功与 fallback 场景各至少验证一次。
- 输出一份脱敏验收报告，记录 CLI 版本、操作系统、耗时、事件数、token usage 和失败重试情况。

### PR-02 PostgreSQL ActorRef 回填演练

#### 需求说明

在生产数据副本或 staging PostgreSQL 上验证 `eventsBySession/tasksBySession` ActorRef 回填，不直接首次作用于生产主库。

#### Dry-run

```powershell
$env:AGENT_CLUSTER_PERSISTENCE_BACKEND='postgres'
$env:DATABASE_URL='<staging-postgresql-url>'
$env:AGENT_CLUSTER_POSTGRES_COLLECTION_TABLE='agent_cluster_collections'
node scripts/backfill-actor-ref.mjs --backend postgres
```

#### Apply

```powershell
node scripts/backfill-actor-ref.mjs --backend postgres --apply
```

`--apply` 属于高风险数据库写入，执行前必须获得人工确认并记录：数据库标识、表名、dry-run 统计、备份策略和回滚责任人。

#### 验收标准

- dry-run 输出 scanned/skipped/filled，且与抽样查询结果一致。
- apply 前创建时间戳备份表。
- `eventsBySession` 和 `tasksBySession` 在同一事务内更新；失败时 rollback。
- 已有 ActorRef 不被覆盖。
- 连续执行第二次时 `filled=0` 或符合新增数据数量，证明幂等。
- 从备份表恢复后，抽样记录与 apply 前一致。
- 形成回填报告，包括行数、耗时、备份表、抽样结果和回滚演练结果。

### PR-03 Redis/BullMQ Autopilot 调度验收

#### 需求说明

使用真实 Redis 验证 Autopilot Job Scheduler、worker、issueguard 和服务重启恢复。

#### 配置要求

```powershell
$env:AUTOPILOT_ENABLED='true'
$env:ENABLE_BULLMQ='true'
$env:REDIS_URL='redis://<host>:<port>/<db>'
$env:BULLMQ_PREFIX='agent-cluster-staging'
```

#### 场景

1. 创建 enabled 且带 cron schedule 的 Autopilot。
2. scheduler 到时创建一个 `scheduled` run 和一个 `origin='autopilot'` session。
3. 同一 Autopilot 已存在 queued/running run 时，不重复创建 session。
4. worker 重启后继续追踪已有 `sessionId`，不重复建会话。
5. disable 或删除 Autopilot 后移除 scheduler，后续不再触发。
6. Redis 短暂不可用时失败可见，恢复后不会产生重复 active run。

#### 验收标准

- `GET /api/ops/queues` 能看到真实队列计数。
- `autopilotRuns`、Session、首事件和 artifact 可通过 `autopilotRunId` 追溯。
- issueguard 在并发触发下只保留一个 active run。
- 调度关闭后观察至少两个原 schedule 周期，不再产生新 run。
- 输出 Redis/BullMQ 验收和故障恢复报告。

### PR-04 Workdir Brief 生产安全演练

#### 需求说明

在 Windows 和目标部署操作系统上验证真实目录权限、原子替换、崩溃恢复、并发 lease 和清理策略。

#### 配置要求

```powershell
$env:AGENT_CLUSTER_WORKDIR_BRIEF='true'
$env:AGENT_CLUSTER_BRIEF_STAGING_DIR='<managed-staging-directory>'
$env:AGENT_CLUSTER_BRIEF_TTL_MS='604800000'
```

#### 场景

1. workdir 原本没有 AGENTS.md/CLAUDE.md。
2. workdir 已有 UTF-8、CRLF/LF 或包含中文的说明文件。
3. Runtime 正常完成、主动 cancel、进程强制终止、服务重启。
4. 两个任务尝试并发占用同一 workdir。
5. staging 目录不可写、磁盘空间不足或恢复过程中出现权限错误。

#### 验收标准

- 正常、失败和重启恢复后，原文件字节 hash 与注入前完全一致。
- 原本不存在的文件在恢复后不存在。
- 同一 workdir 同时只能持有一个有效 lease。
- 恢复失败必须保留 manifest 和备份，不得静默删除证据。
- TTL 只清理 `restored` 状态的 staging，不删除 active/failed recovery 数据。
- 形成包含 before/applied/restored hash 的安全演练报告。

## 6. P1 完善需求（当前闭环阶段）

### PR-05 Watchdog 参数与可观测性基线

#### 需求说明

使用真实慢任务校准 first-frame、idle 和 absolute timeout，避免正常慢任务被误杀，同时保证卡死任务能被及时中断。

#### 验收标准

- 连续产生事件且总时长超过旧 120 秒阈值的任务不会被杀死。
- 无首帧任务在配置阈值内失败，错误可区分 `first_frame`、`idle`、`absolute`。
- 每次 timeout 记录 runtime、runId、阶段、阈值、最后活动时间和 stderr tail 摘要。
- staging 至少采集 20 次真实运行数据后确定生产推荐值。
- absolute timeout 默认保持关闭，除非有明确的成本或合规上限。

#### 当前实施状态

- 已新增 `RuntimeStreamMetrics`，并把 completed/failed/cancelled/timeout 的流式指标持久化到 Runtime invocation。
- timeout 已记录 runtime、runId、phase、阈值、开始/最后活动/超时时间、elapsed、idle 时长、首帧状态和最多 1,000 字符的脱敏 stderr 摘要。
- Codex/Claude 已支持独立 first-frame、idle 和默认关闭的 absolute 环境配置；非法配置不会把 watchdog 静默关闭。
- 已提供带成本保护的 20 次真实采样入口、20 个只读示例任务和分位数分析器。
- 尚未获得本轮 20 次真实 CLI 调用的成本批准，也未形成基于真实样本的最终生产推荐值，因此 PR-05 尚未完成验收。
- 运维步骤见 [`../devops/watchdog-baseline.md`](../devops/watchdog-baseline.md)。

### PR-06 Skill 管理前端

#### 需求说明

在 Web 管理入口提供 Skill 列表、创建、编辑、删除、Agent 绑定和注入预览；复用已完成的 `/api/skills` 和 Agent Skill 绑定 API。

#### 功能范围

- Skill 列表和详情。
- 创建/编辑 name、description、content、files。
- 文件路径和大小限制的前端提示。
- Agent 绑定/解绑。
- 删除前展示受影响 Agent，删除后刷新引用。
- 显示最终注入顺序和内容摘要，不展示不必要的完整敏感内容。

#### 验收标准

- API 校验错误可以定位到对应字段。
- 重名、路径穿越、文件过大和重复路径在 UI 中明确提示。
- 绑定后新建会话的 ContextPack 包含对应 `[Skill:<name>]`。
- 删除 Skill 后 Agent 不保留悬空 skill id。
- 补充 Web typecheck、组件测试和浏览器 e2e。

#### 当前实施状态

- Web 工作台新增独立 Skill 管理入口，支持列表、创建、编辑、删除和文件内容维护。
- 表单在提交前提示名称、路径穿越、重复路径和文件大小问题，并展示服务端字段错误。
- Agent 绑定和解绑复用现有 Agent 更新 API；删除确认会列出受影响 Agent，删除成功后同步清理前端引用。
- 注入预览显示稳定顺序、文件路径和摘要，不展示不必要的完整敏感内容。
- 组件测试覆盖字段校验与交互；浏览器 e2e 覆盖创建、文件、绑定、新会话 ContextPack 注入、删除影响和悬空引用清理。
- PR-06 已完成，验证证据见 [`../quality/multica-p1-acceptance-report-v1.md`](../quality/multica-p1-acceptance-report-v1.md)。

## 7. P2 后续版本计划（P0/P1 闭环后解锁）

本节当前只作为后续需求池，不授权进入实现。P0/P1 未全部完成并通过闭环评审前，不创建 P2 开发任务。

### PR-07 v0.3 Actor 与 legacy Runtime 清理

- 删除 `fromAgentId/assigneeAgentId/assignedByAgentId` 前，确认历史数据回填率为 100%。
- 新读写路径只使用 ActorRef，旧字段至少经历一个稳定版本的只读兼容期。
- 评审是否合并 `user_message/agent_message` 为统一 message + actor。
- 删除 `stream?/cancel?` 和 legacy `execFile` 前，真实 streaming 灰度必须稳定运行一个发布周期。
- 需要独立 migration、回滚方案、合同版本和前端兼容评审。

### PR-08 跨 Session Resume

- 明确 workspace、project、owner 和 runtime 身份边界，禁止跨用户或跨不可信 workdir 恢复。
- 定义 prior session 的选择、过期、撤销和审计规则。
- Resume 前验证工作目录、仓库身份、当前分支和关键文件 hash。
- 失败仍只允许一次 fresh-session fallback。
- 需要独立安全设计和数据保留策略，不纳入当前 v0.2。

### PR-09 Autopilot 真实 Runtime 与高风险治理

- 当前 `runtimeType='mock'`、`riskLevel='low'` 不变，直到 P2 独立需求、系统设计和验收方案获批。
- 接入 Codex/Claude 前必须定义 token/cost 上限、工作目录隔离、Capability approval 和失败通知。
- 无人在场时不得自动批准文件写入、命令执行、外发通知或创建 PR。
- 高风险动作应使 run 进入 waiting，并产生可由用户处理的确认入口。
- 增加日/周运行次数限制、最大 active 时长和全局 kill switch。

## 8. 非目标

以下是平台其他长期缺口，但不属于本次 Multica R1～R7 剩余事项：

- MCP Tool Runtime 和 Human Runtime 的完整实现。
- 飞书真实发送、GitHub/GitLab PR 和 CI/CD Connector。
- pgvector/embedding RAG、复杂知识库权限和检索质量优化。
- 多用户、多租户、计费、成本报表和大规模分布式 Agent 集群。

这些事项应进入独立 PRD/设计，不得借生产验收扩大本需求范围。

## 9. 依赖与约束

- 不引入 Prisma 或第二套数据库抽象，继续使用现有 PersistenceService。
- `ENGINEERING_RUNTIME_STREAMING` 默认保持 `off`，按 `codex` → `all` 灰度。
- Autopilot 默认禁用；生产启用必须同时具备 Redis、监控和停止调度方案。
- 所有凭据必须通过部署环境注入并脱敏。
- 数据库 apply、生产目录写入、发布切流和外部系统操作必须单独获得人工确认。
- 不删除 legacy/deprecated 路径，除非进入 PR-07 并通过独立评审。
- P0/P1 的实现必须遵循现有 Runtime、Actor、Workdir Brief、Skill、Autopilot 系统设计；设计发生变化时先更新设计文档和合同。
- P2 不与 P0/P1 并行开发，避免兼容清理或能力扩张破坏当前验收基线。

## 10. 发布门禁

### 10.1 必须通过

```powershell
npm run typecheck
npm run test
npm run test:harness
npm run build
npm run test:e2e:main-chain
npm run test:e2e:runtime-routing
npm run test:e2e:postgres-persistence
npm run test:e2e:bullmq-ops
```

此外必须完成 PR-01～PR-06。即使 Autopilot 默认禁用，PR-03 也必须在 staging Redis/BullMQ 环境完成，才能证明 R7 调度链路闭环。

### 10.2 发布产物

- 真实 CLI 验收报告。
- PostgreSQL backfill 与回滚报告。
- Redis/BullMQ scheduler 验收报告。
- Workdir Brief 安全演练报告。
- Watchdog 推荐参数表。
- 配置项清单和脱敏环境样例。
- 已知限制、回滚步骤和责任人。

## 11. 分阶段实施计划

1. 基于现有系统设计确认 P0/P1 的 Architecture Constraints、环境、责任人和回滚边界。
2. 准备隔离 staging、真实 CLI、凭据、PostgreSQL 数据副本和 Redis namespace。
3. 执行 PR-01，先 `codex` 灰度，再切 `all` 验证 Claude。
4. 执行 PR-04，完成 workdir 正常、失败、崩溃和并发安全演练。
5. 对 PostgreSQL 副本执行 PR-02 dry-run、apply、幂等和 rollback。
6. 执行 PR-03 scheduler、issueguard、disable 和 worker 重启测试。
7. 收集真实运行数据并完成 PR-05 Watchdog 参数与可观测性基线。
8. 按系统设计和现有 API 完成 PR-06 Skill 管理前端及浏览器 e2e。
9. 汇总 PR-01～PR-06 的实现、验证、合同、运维和回滚报告，完成 P0/P1 统一闭环评审。
10. P0/P1 闭环明确通过后，为 PR-07～PR-09 新建独立 P2 需求、系统设计和执行计划，再开始开发。

## 12. 风险与处理

| 风险 | 影响 | 处理要求 |
| --- | --- | --- |
| 真实 CLI 协议或版本变化 | streaming/resume 失效 | 固定验收版本，启动时记录版本，协议变化重新生成 schema |
| 数据库回填误写 | 历史事件/任务损坏 | 数据副本先演练、事务、备份表、抽样和回滚 |
| Redis 重复调度 | 重复会话和成本增加 | issueguard、job id、重启测试、kill switch |
| Workdir 恢复失败 | 用户文件被污染 | byte backup、hash、manifest 保留、RecoveryService 启动恢复 |
| Watchdog 配置过短/过长 | 误杀或资源泄漏 | 基于真实运行分位数调优，错误类型和最后活动可观测 |
| Autopilot 越权 | 无人值守高风险副作用 | v0.1 保持 mock/low-risk，真实 Runtime 需独立审批设计 |

## 13. Q&A 与决策记录

- 需求结果：将当前剩余事项整理为可执行的生产就绪需求，并区分发布阻断与未来增强。
- 范围边界：只覆盖 Multica R1～R7 已实现功能的真实环境验收和直接后续增强。
- 已采用决策：P0 与 P1 合并为当前统一闭环阶段，PR-01～PR-06 全部完成后才允许解锁 P2。
- P2 决策：PR-07～PR-09 仅保留后续计划，当前不授权开发。
- 假设：后续会提供隔离 staging、真实 CLI 凭据、PostgreSQL 数据副本和 Redis 环境。
- 当前无新增产品设计阻塞；实际闭环仍受 Codex 外部上游和 PR-05 真实采样成本授权约束。任何数据库 apply、生产切流或外部副作用操作仍需执行时单独确认。

## 14. 完成定义

本需求只有在以下条件满足后，才可将“生产就绪剩余事项”标记为完成：

- PR-01～PR-06 全部完成并通过各自验收标准。
- PR-03 在真实 staging Redis/BullMQ 环境完成，不因 Autopilot 默认禁用而跳过。
- PR-05 给出经过真实运行数据验证的参数建议并落入运维配置基线。
- PR-06 完成 Skill 管理前端、组件测试和浏览器 e2e。
- 发布产物齐全，凭据和日志均已脱敏。
- 回滚方案已演练，不只是写在文档中。
- 当前质量门和 legacy/off 回归继续全绿。

PR-07～PR-09 不计入当前 P0/P1 完成范围；只有 P0/P1 闭环评审通过后，才可转入独立 P2 设计和开发阶段。
