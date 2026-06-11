# Agent Cluster 修复方案 v1 当前状态

> 更新时间：2026-06-11
> 配套状态文档：[feature-inventory-and-status-v1.md](../analysis/feature-inventory-and-status-v1.md)
> 本文从原 2026-06-04 的代码级修复方案更新为“修复闭环与后续方案”。原方案中的 P0/P1/P2 大部分已经落地，历史代码片段不再重复保留。

## 1. 修复闭环结论

v1 修复方案的核心目标已经完成：执行不再绑定单个 HTTP 请求，Generic LLM 具备超时/重试/取消，复盘建议会影响状态机，服务重启可恢复执行，BullMQ 可承载后台执行，PostgreSQL 持久化不再依赖子进程全量写，Runtime 不再静默回退 mock，多 Agent 讨论和任务依赖已接入，长期记忆、token 预算和中文文案治理均已落地。

当前路线图应从“补齐 v1 可靠性”切换为“v2 真实执行生产化”。

## 2. 原问题处理状态

| 编号 | 原问题 | 当前状态 | 关键实现 |
| --- | --- | --- | --- |
| P0-1 | 执行绑定 HTTP 同步 | 已修复 | `ExecutionService` 后台执行；`confirmBrief` 返回 accepted；进度走 SSE。 |
| P0-2 | LLM 无超时/重试 | 已修复 | `GenericLlmRuntimeService` 使用 `AbortController`、`LLM_TIMEOUT_MS`、`LLM_MAX_RETRIES` 和退避重试。 |
| P0-3 | 状态机收尾/复盘结论被忽略 | 已修复 | `ExecutionOutcome` + `applyOutcome`；支持 `rework/ask_user/failed/cancelled`。 |
| P0-4 | 重启不恢复执行 | 已修复 | `RecoveryService` 在非 BullMQ 模式启动恢复未完成会话。 |
| P1-5 | BullMQ 未承载执行 | 已修复 | `ExecutionQueue`/`ExecutionWorker` 使用 `agent-task-queue`。 |
| P1-6 | Postgres 子进程全量写 | 已修复核心 | `pg.Pool` 常驻连接、单 key upsert；事件 200ms 批量 flush。细粒度表仍属 v2。 |
| P1-7 | 多 Agent 协作脚本化 | 已修复核心 | `runDiscussion` 多 Agent/多轮可配置；任务依赖解析和 ready task 执行。 |
| P1-8 | 非 generic_llm 静默降级 mock | 已修复 | Runtime 注册表派发；未实现 runtime 返回 `CAPABILITY_BLOCKED`。 |
| P1-9 | 执行中暂停无法中断 | 已修复 | `AbortSignal` 贯穿 execution/runtime；pause/cancel 可取消，resume 可重启。 |
| P2-10 | 后端文案中英混杂 | 已修复 | `common/messages.ts` 收敛中文文案。 |
| P2-11 | Token 预算空转 | 已修复 | `buildBudget`、`fitContextToBudget`、`TOKEN_BUDGET_EXCEEDED`、`tokenUsed` 回写。 |
| P2-12 | 长期记忆自动写入 | 已修复 | 偏好消息先发确认卡，确认后写 `long_term_candidate`。 |
| P2-13 | 多端口/运行态不透明 | 已修复 | 启动日志输出 runtime、persistence、data、BullMQ、recovery。 |

## 3. 当前保留的实现限制

| 限制 | 当前原因 | 后续方案 |
| --- | --- | --- |
| Codex/Claude Code adapter 只显式失败 | 避免在没有 sandbox/权限/审计时真实执行外部 CLI | v2 建立 runtime sandbox、日志、取消、确认和 workspace 绑定后逐步开启。 |
| `mcp_tool`/`human` 未接入 | 合同预留，尚无运行时实现 | 为 human runtime 增加等待用户输入流程；为 MCP runtime 增加工具注册和授权。 |
| RAG 是关键词检索 | v1 重点验证事件和上下文注入链路 | 接入 embedding provider、pgvector schema、召回评估和权限过滤。 |
| Postgres 是 JSONB collection | 最小迁移成本，适合 v1 状态恢复 | 设计 migration，将高频集合拆成关系表和索引。 |
| 队列仍是会话级执行 job | 降低幂等和状态机复杂度 | 后续把每个 task 独立入队，使用 claimed/lock 和依赖调度。 |
| 文件写回缺少 diff 审阅 | 当前先完成 fileChanges 通路 | 前端增加逐文件 diff、冲突检测、跳过和回滚。 |
| 飞书通知是 dry-run | 避免未经确认触发外部副作用 | 接真实 Feishu API，发送前保持确认卡和 capability check。 |

## 4. v2 修复方案建议

### 4.1 真实代码代理 Runtime

目标：让 `codex` 和 `claude_code` 从“显式未实现”变成可控真实执行。

关键要求：

- 每次执行必须绑定明确 workspace root。
- 默认只允许工作区内文件读写。
- 高风险命令、跨目录访问、网络、提交、推送、部署必须走用户确认。
- stdout/stderr、退出码、产物、文件变更和 token/耗时必须写入 runtime invocation log。
- 支持 `AbortSignal` 中断。
- 失败不能吞掉，应转换为 `runtime_failed` 和 `ask_user/failed` outcome。

### 4.2 RAG 生产化

目标：把当前本地关键词检索升级为 embedding + pgvector。

关键要求：

- 新增 migration：knowledge bases、documents、chunks、embeddings。
- 支持按 workspace/project/session/agent scope 过滤。
- 增加 embedding 写入重试和索引状态。
- e2e 验证：相似语义命中、无权限不命中、chunk source 可追溯。

### 4.3 持久化 schema 化

目标：从 JSONB collection 迁移到可查询、可审计、可索引的业务表。

优先拆分：

1. `sessions`
2. `collaboration_events`
3. `agent_tasks`
4. `artifacts`
5. `runtime_invocations`
6. `memories`
7. `knowledge_*`

迁移期间保留 collection 兼容读取，避免破坏已有本地状态。

### 4.4 文件变更审阅

目标：让用户在写回前看清每个文件的 before/after。

关键要求：

- artifact card 展示文件变更数量、路径、操作类型。
- diff 视图按文件展开。
- 支持逐文件 apply/skip。
- 冲突或文件已变化时提示重新生成或手动处理。
- 写回结果产生审计事件。

## 5. 验证策略

v1 修复闭环的最小验证集合：

```bash
npm run typecheck
npm run build
npm run test:harness
npm run test:e2e:main-chain
npm run test:e2e:p1-behaviors
npm run test:e2e:runtime-routing
npm run test:e2e:task-dependency
npm run test:e2e:multi-agent-discussion
npm run test:e2e:rework-loop
npm run test:e2e:cancel
npm run test:e2e:recovery
npm run test:e2e:memory-confirm
npm run test:e2e:token-budget
npm run test:e2e:artifact-file-changes
npm run test:e2e:postgres-persistence
npm run test:e2e:bullmq-ops
npm run test:e2e:ops
npm run test:e2e:security
npm run test:e2e:chinese-copy
```

v2 每接入一个真实外部副作用能力，都必须额外补：权限失败用例、用户拒绝用例、取消用例、审计日志用例和跨重启恢复用例。
