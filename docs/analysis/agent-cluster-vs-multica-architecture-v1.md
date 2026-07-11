# Agent Cluster 与 Multica 全景架构对比与优化方案 v1

> 更新时间：2026-07-09
> 分析对象：[multica-ai/multica](https://github.com/multica-ai/multica)（开源 managed agents 平台，Go + Next.js + PostgreSQL/pgvector）
> 源码依据：`server/migrations/001~026`、`server/internal/daemon/{client,hub,local_skills,reconcile,slash_skill,types}.go`、`docs/product-overview.md`
> 本仓库对照：`apps/server/src/modules/`、`packages/shared/src/contracts.ts`
> 关联文档：运行时/CLI 执行层的深度对比见 [`multica-runtime-comparison-v1.md`](./multica-runtime-comparison-v1.md)，本文覆盖更广的**全景架构面**（Actor 多态、Skill 表结构、Session Resumption、Autopilot、事件时间线、模块级改造优先级），两者互补、不重叠。

---

## 0. 阅读指引

- 只想看运行时/CLI 怎么执行、为什么"成功被误判失败"→ 读 [`multica-runtime-comparison-v1.md`](./multica-runtime-comparison-v1.md)。
- 想看整体架构差异、Agent/Actor/Skill/Session 建模、以及我们模块目录级的改造顺序 → 读本文。

---

## 1. Multica 六个维度深挖

### A. Daemon 与 Runtime（价值 ★★★）

核心机制：

- **HTTP 长轮询 + WebSocket 补信号**：daemon 主循环用 HTTP 定时 poll 服务端（claim task、heartbeat），WS 只是"reconnect 后立即触发一次对账"的信号通道（见 `reconcile.go` 的 `reconcileBroadcaster`：edge-triggered + 一槽 replay + debounce）。这个组合比纯 WS 稳定得多——掉线重连不丢任务，认领一致性由 HTTP + 数据库保证。
- **Pairing 流程**（`005_daemon_pairing.sql`）：daemon 首次启动生成一次性 token → 用户在 Web 审批 → daemon 换取长期 token 绑定 workspace。表字段：`token / daemon_id / device_name / runtime_name / runtime_type / approved_by / expires_at / status(pending→approved→claimed→expired)`。
- **Runtime = 一台机器上的一个 CLI**：`daemon_connection(agent_id, daemon_id, status, last_heartbeat_at, runtime_info JSONB)`。心跳 + `runtime_gone` 检测让服务端可以判定"这台机器还在不在"。
- **精细错误码识别**（`client.go`）：`isTaskNotFoundError` / `isRuntimeNotFoundError` / `isUnauthorizedError` / `isWorkspaceNotFoundError` — daemon 用这些区分"任务被服务端删了"（应中断本地 CLI）、"runtime 被清理了"（应重新注册）、"token 过期"（应触发重新登录）。这是长时运行 daemon 必须的健壮性。服务端把 `runtime not found` 特意只和 `pgx.ErrNoRows` 绑定，避免一次 DB 抖动让 daemon 误自清理。
- **X-Client-Platform / Version / OS header**：每个 daemon 请求都带身份，服务端可基于此做灰度、兼容降级。
- **bundleClient 分离**：普通控制面请求 30s 超时；skill bundle 下载用无固定超时的独立 client，由调用方按体积算 context deadline。

Task claim payload（`types.go` 的 `Task` 结构）给 daemon 一次性打包了：`WorkspaceContext`（workspace 级 system prompt）、`ThreadName`（CLI 原生 session 命名）、`PriorSessionID` + `PriorWorkDir`（复用上一轮）、`ProjectID/Title/Description/Resources`、`ConnectedApps`（本次任务允许的 MCP 覆盖）、`TriggerCommentID/ThreadID/Content/AuthorType/AuthorName`、`NewCommentCount/NewCommentsSince`（增量提示，避免每次全量塞历史）、`IsLeaderTask`（squad-leader 协调角色）。

### B. Actor 多态（价值 ★★★★★）

贯穿全部业务表的 `xx_type` + `xx_id` 二元组，无 FK 约束（多态所以只能应用层保证一致）：

| 表 | 字段 | 允许值 |
|---|---|---|
| `issue` | `assignee_type` + `assignee_id` | `member` / `agent` |
| `issue` | `creator_type` + `creator_id` | `member` / `agent` |
| `comment` | `author_type` + `author_id` | `member` / `agent` |
| `inbox_item` | `recipient_type` + `recipient_id` | `member` / `agent` |
| `inbox_item` | `actor_type` + `actor_id`（012 补） | `member` / `agent` |
| `activity_log` | `actor_type` + `actor_id` | `member` / `agent` / `system` |

带来的能力：Agent 可以创建 Issue、发评论、@别人、被订阅、被 @ 触发新任务、进收件箱。所有"@某个 agent 触发任务"都是同一套机制，不需要专门的 API。

### C. Skill 系统（价值 ★★★☆☆）

表结构极简（`008_structured_skills.sql`）：

```
skill (workspace_id, name, description, content, config JSONB)
skill_file (skill_id, path, content)   -- 一个 skill 可带多个文件
agent_skill (agent_id, skill_id)       -- M2M 挂载
```

流转链路：

1. 用户在 Web 建 Skill → 存 `skill.content` 与 `skill_file`。
2. 挂到 Agent → `agent_skill` 关联。
3. Task claim 时打包 → daemon 拉 skill bundle。
4. daemon 把 `skill.content` 和 `skill_file[]` 写到本地 `work_dir/.claude/skills/<name>/SKILL.md`（或对应 provider 目录）。
5. CLI 自己按需读（**不塞 prompt**）。
6. 支持 `[/skill-name](slash://skill/id)` 语法在 issue 描述里强触发（`slash_skill.go` 用正则 `\[/(...)\]\(slash://skill/([^)]+)\)` 识别）。

本地 skill 反向发现（`local_skills.go`）：daemon 扫描 `~/.claude/skills`、`~/.codex/skills`、`~/.gemini/skills` 等 provider 目录 + 通用 `~/.agents/skills` 跨工具 fallback（provider 优先、universal 兜底、同 key provider 胜出），上报到服务端供用户"导入"。解决"用户已有本地 skill，怎么让团队共享"的问题。上限：单文件 1MB、bundle 8MB、128 文件、目录深度 4。

### D. Autopilot（价值 ★★★☆☆）

001~026 migration 未直接出现 autopilot 表（在更后面的 migration），从 `product-overview.md` 与目录结构还原：

- **Autopilot = cron/webhook/手动触发器 → 自动创建 issue → 分配给 agent → 走正常任务流程**。
- 相关表：`autopilot / autopilot_trigger / autopilot_run`；`issue.origin` 记录来源。
- 独立 `issueguard/duplicate.go` 防重复建单（如"每日 bug triage"，昨天 issue 还在则不重复建）。
- scheduler 独立：走 pg-cron。

核心洞察：Autopilot 不是"另一套执行引擎"，而是"issue 创建器 + 触发器"，最终仍复用任务队列。

### E. Session Resumption（价值 ★★★★★）

极简但极有效（`020_task_session.sql` 只加两列）：

```sql
ALTER TABLE agent_task_queue ADD COLUMN session_id TEXT;
ALTER TABLE agent_task_queue ADD COLUMN work_dir TEXT;
```

机制：

1. 首次执行 `(agent_A, issue_X)`：Claude Code 返回 `session_id_1`，daemon 写回。
2. 第二次执行 `(agent_A, issue_X)`：服务端查同 `(agent_id, issue_id)` 最新已完成任务 → 拿 `session_id_1` + `work_dir_1` → 塞进 `Task.PriorSessionID / PriorWorkDir`。
3. daemon 用 `claude --resume <session_id_1>` 复用 CLI 原生 session store，工作目录也复用。
4. 效果：上下文、文件系统状态、git 状态、临时构建产物全部保留。

配套 `task_message` 表（`026_task_messages.sql`）：`(task_id, seq, type, tool, content, input JSONB, output)` 记录 tool calls / content chunks，用于 UI 展示执行过程，不用于恢复。

### F. 事件/时间线（价值 ★★☆☆☆）

- `activity_log(workspace_id, issue_id, actor_type, actor_id, action, details JSONB)` — 通用日志，`action` 是自由字符串（如 `status_changed`、`assignee_changed`）。
- `comment` — 讨论。
- Timeline 就是这两个表按时间合并。
- **没有事件类型枚举，没有独立事件模块** — 靠 `action` + `details JSONB` 极简扩展。

对比我们的 `collaboration_events` 有 20+ 明确事件类型（`user_message` / `brief_created` / `task_reworked` / `rag_retrieved` …），Multica 走另一个极端：牺牲类型安全，换演进灵活性。

---

## 2. 模块目录对比：Agent Cluster vs Multica

| 我们的目录 | Multica 对应 | 差距 |
|---|---|---|
| `modules/sessions/` | 无直接对应（Issue 才是核心） | Multica 无 Session 概念，我们的 10+ 状态可简化 |
| `modules/orchestrator/` | `service/task.go` + `autopilot.go` | Multica 无独立编排层，Coordinator 逻辑内嵌在 leader-task |
| `modules/intent-recognition/` | 无对应 | **我们的独有优势**，Multica 靠 `@agent` 直接触发 |
| `modules/runtimes/` | `internal/daemon/` + `daemonws/` | **最大差距**：我们在服务端跑 CLI，Multica 在本地 daemon 跑 |
| `modules/tasks/` | `agent_task_queue` + `service/task.go` | Multica 简单得多，无 blocked/reworking/reviewing 精细状态 |
| `modules/events/` | `activity_log` + `comment` | 我们强类型，Multica 灵活 |
| `modules/memory/` | 无对应（Skill 只是文件注入） | **我们的独有优势** |
| `modules/rag/` | 无对应 | **我们的独有优势** |
| `modules/capabilities/` | `agent.mcp_config` JSONB + ConnectedApps | 我们精细，Multica 直白 |
| `modules/queue/`（BullMQ） | pg-cron + scheduler | Multica 用 Postgres 一套搞定 |
| `packages/shared` 预设 agents | 无预定义 Agent | **理念差异**：我们预设角色，Multica 让用户自建 |

---

## 3. 优化方案（按优先级）

> 说明：本节为方案与影响面评估，不含实现代码。落地时每一步都应先更新对应合同/文档，再动模块，并补 e2e。

### P0-1 本地 Daemon 抽离（架构级）

问题：服务端进程内 `execFile` 跑 Codex/Claude Code 行不通——CLI 天生跑在用户机器上，需要用户的 `~/.claude`、SSH key、git 凭证、项目工作目录。

方案要点：

1. 新增 `packages/daemon/`（本地进程）。
2. 服务端新增 `modules/daemon/`：pairing / claim / heartbeat / report-result 端点 + `daemon_connection` 状态维护。
3. 新增表：`daemon_pairing_session`（照搬 Multica 005）、`daemon_connection`（照搬 001）。
4. `runtimes/` 的 codex/claude adapter 不再本地 exec，改为写 `agent_task_queue` 等 daemon poll 认领；`generic-llm-runtime`（LM API）与 `mock-runtime`（e2e）保留服务端。

影响面：runtimes / execution / queue / e2e。中等改动，约 2 周。兜底：先做 daemon 骨架 + Codex adapter 迁移，验证通路再迁 Claude Code。

### P0-2 Agent 提升为一等 Actor

问题：`contracts.ts` 里到处散着 `agentId?` / `userId?`，语义不统一，扩展痛苦。

方案要点：

1. 引入统一类型 `ActorType = 'user' | 'agent' | 'system'`、`ActorRef = { type; id }`。
2. 逐步替换事件/任务/消息里的 from/assignee 字段为 `ActorRef`；`user_message` / `agent_message` 事件合并为 `message` + `actor.type` 区分。
3. 表加 `actor_type` + `actor_id` 列（无 FK，照 Multica），一次性 migration 回填旧列。
4. 前端 timeline 用 `actor` 渲染，不再 `agentId ? agent : user`。

影响面：contracts + 几乎所有事件消费者。大改动，一次性收益极高，约 3 周。

### P1-3 Session 状态机简化 + 引入 Issue 视角

问题：10+ 状态职责重叠，用户视角难懂。

方案要点（不推翻 Session，只补层）：

1. 新增 `issue` 表（对应 Multica）：`issue(id, workspace_id, title, description, status, assignee ActorRef, creator ActorRef, session_id?, …)`。
2. Session 降级为"某个 issue 的一次协作过程"，一个 issue 可对应多个 session。
3. 状态合并：`DRAFT_INPUT/AGENT_DISCUSSING/WAIT_USER_CONFIRM/REVISING_BRIEF → aligning`；`EXECUTING → executing`；`POST_REVIEW/REWORKING → reviewing`；`WAIT_USER_DECISION → paused`；`COMPLETED/FAILED/CANCELLED` 保留。
4. 前端 `SessionWorkspace.vue → IssueWorkspace.vue`，Session 变成里面的 tab / 历史。

收益：任务可跨会话追踪、复盘、复用。影响面大，约 3-4 周，可延后到 P0 落地后。

### P1-4 Session Resumption

问题：每次新 session 从零开始，Memory + RAG 组装成本高、失真率大。

方案要点（P0-1 daemon 落地后接近零成本）：

1. `agent_task` 加 `session_id TEXT` + `work_dir TEXT`。
2. 派发任务时查同 `(agent_id, issue_id)` 上一条 completed task 的这两列，塞进 daemon payload（对应 `PriorSessionID/PriorWorkDir`）。
3. daemon 用 `--resume <session_id>` 复用，含"resume 失败回退新会话"语义。

影响小，约 2-3 天，前提是 P0-1 完成。

### P1-5 Skill 极简通道（补充 Memory/RAG，非替换）

问题：用户想手动补一份"部署流程说明"给 Agent，现只能走 RAG 上传或塞 memory，太重。

方案要点：

1. 在 `modules/capabilities/` 下新增 `skill(workspace_id, name, description, content, files JSONB)` + `agent_skill(agent_id, skill_id)`。
2. Context 组装 ContextPack 时，把当前 Agent 挂载的 skill 内容注入 `constraints` / `systemRules`。
3. 进阶：daemon 落地后改为写文件到 `work_dir/.claude/skills/`，让 CLI 自读（更省 token）。

影响小，约 1 周。

### P2-6 Autopilot

问题：所有 Session 都需用户手动发起。

方案要点（BullMQ 已在）：

1. `autopilot(workspace_id, name, trigger_type, trigger_config, issue_template, agent_id, enabled)` + `autopilot_run`。
2. 新增 `modules/autopilot/`，定时用 BullMQ repeatable job。
3. 加 issueguard：同一 autopilot 未完成 issue 存在时不重复创建。
4. Session/Issue 加 `origin` 追溯来源。

影响小到中，约 1-2 周，P1 后再做。

---

## 4. 明确不建议做的事

- ❌ 推翻 `intent-recognition`：Multica 没有它，但我们面向企业协作，`@agent` 直接触发太粗暴。
- ❌ 推翻 Memory + RAG 只留 Skill：我们面向研发协作需要过程沉淀，Multica 面向单人+agent 用不着。
- ❌ 推翻 Task Brief + 用户确认闭环：这是"防止 AI 乱来"的关键防线，Multica 无此设计是缺陷不是优点。
- ❌ 把强类型 `collaboration_events` 改成灵活 `activity_log`：类型安全是演进护栏，别丢。

---

## 5. 推荐执行顺序

```
第一阶段（1-2 月）架构基础
  P0-1 Daemon 抽离      → 让 Codex/Claude 真正跑得起来
  P0-2 Actor 一等公民   → 让代码语义一致

第二阶段（1 月）产品化
  P1-4 Session Resumption → 立竿见影降低 Memory 成本
  P1-5 Skill 极简通道     → 用户自助
  P1-3 Issue 视角引入     → 任务长生命周期

第三阶段（1 月）自动化
  P2-6 Autopilot
```

---

## 6. 实施注意

- Multica 是 Go + Next.js，代码不能直接搬，借鉴的是架构模式。
- 涉及运行时执行层的改动（P0-1 等），先同步 [`multica-runtime-comparison-v1.md`](./multica-runtime-comparison-v1.md) 第 5 节的建议与 `docs/contracts/` 中的运行时合同，再动 adapter。
- 表结构类改动（P0-2 / P1-3 / P1-4）先在 `docs/design/agent-cluster-system-design-v1.md` 落设计，再写 migration。

---

## 附：来源

- [multica-ai/multica GitHub](https://github.com/multica-ai/multica)
- [multica migrations](https://github.com/multica-ai/multica/tree/main/server/migrations)（daemon_pairing、task_session、structured_skills、task_messages 等）
- [multica daemon 实现](https://github.com/multica-ai/multica/tree/main/server/internal/daemon)（client.go / types.go / local_skills.go / reconcile.go / slash_skill.go）
- [multica product-overview.md](https://github.com/multica-ai/multica/blob/main/docs/product-overview.md)
