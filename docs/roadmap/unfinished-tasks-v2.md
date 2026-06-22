# Agent Cluster 未完成任务清单 v2

> 更新时间：2026-06-15
> 目的：把本轮没有完成的后续任务单独列出，供后续继续实现。

## 已进入当前工作树的基础

- 可插拔 Engineering Runtime 合同：`EngineeringRuntimeConfig`、`EngineeringRuntimeSelection`、effective runtime 记录。
- Engineering Runtime 选择优先级：Agent override > Session override > Project default > Global default。
- Session 创建可携带 `engineeringRuntimeType` 或 `engineeringRuntime`。
- `task_acceptance` / `task_execution` 阶段会使用 effective runtime，并在 ContextPack、runtime event、debug summary 中保留选择来源。
- Context Router / Project Map / selected evidence content / supplemental context retry 已有基础闭环。
- Codex / Claude Code adapter 已可被显式启用，并保留 capability preflight、prompt file、actual fileChanges 捕获和测试命令捕获。

## V2-P0

| 任务 | 当前状态 | 下一步验收 |
| --- | --- | --- |
| 真实 Codex / Claude Code 生产化 | Adapter 已存在，默认关闭；stub smoke 可验证文件变更捕获 | 增加隔离 worktree、超时/取消一致性、命令白名单、失败恢复、审计日志查询和真实 CLI 文档 |
| 高风险工具端到端执行 | `cap-file-write` preflight 已接入 runtime 启动前检查 | 将 file write、command run、external tool 都接入 Capability Module，并补用户拒绝/批准/回滚用例 |
| Runtime 受控读取轨迹 | ContextPack 已强调 selected refs，但 adapter 还未记录逐次 read/search trace | 定义 `RuntimeReadTrace`，记录搜索/读取/验证命令，并在 debug/event/artifact 中展示 |
| 文件写回 diff 审阅 | fileChanges 通路和 actual snapshot 捕获已存在 | 前端增加 before/after diff、逐文件 apply/skip、冲突检测和写回审计事件 |

## V2-P1

| 任务 | 当前状态 | 下一步验收 |
| --- | --- | --- |
| Project default runtime 持久化 | 当前支持 session/project 字段和 env project default，没有项目配置表 | 增加项目级 runtime 配置 API，并让 session 创建自动继承 project default |
| Runtime 选择 UI | 后端 API 可接收 override，前端还没有会话级选择控件 | 会话创建弹窗支持选择 session engineering runtime，Debug 显示 effective/configured runtime |
| Role-specific Context Pack 强化 | Context Router 有职责分工和最小证据选择，但 agent role slice 仍较粗 | 按 coordinator/backend/frontend/test/review 生成不同 context slice，并增加隔离 smoke |
| pgvector / embedding RAG | 仍是本地关键词检索 | 新增 embedding provider、pgvector schema、权限过滤和召回质量测试 |
| 持久化 schema 化 | PostgreSQL 后端仍偏 JSONB collection | 拆分 sessions/events/tasks/artifacts/runtime_invocations/memories/knowledge 表和 migration |
| 任务级并发调度 | BullMQ 是会话级 job，ready task 循环推进 | task 粒度入队，增加 claimed/lock/幂等恢复和并发 smoke |

## V2-P2

| 任务 | 当前状态 | 下一步验收 |
| --- | --- | --- |
| 真实飞书通知 | 目前创建草稿和 dry-run tool 事件 | 接 Feishu API，保持发送前确认、失败回滚和审计事件 |
| Human Runtime | 合同预留，未接入等待用户输入流程 | 增加 human task waiting/response API、超时策略和恢复语义 |
| MCP Tool Runtime | 合同预留，未接入 MCP 工具注册/授权 | 增加 MCP registry、capability binding、tool audit 和最小 e2e |
| 工作流模板化 | 架构分析等逻辑仍有一部分混在通用 orchestrator | 抽出 workflow/template 配置，降低 orchestrator 膨胀 |
| Token 使用可视化精度 | `TokenUsageIndicator` 已可见，但部分估算仍简化 | 直接读取 debug token diagnostics，展示真实 trim stage 和字段分布 |

## 推荐继续顺序

1. Runtime 选择 UI + project default runtime API。
2. RuntimeReadTrace 与 Debug 展示。
3. diff 审阅与逐文件写回。
4. Codex / Claude Code 真实 CLI 生产化验证矩阵。
5. pgvector RAG 与持久化 schema 化。

