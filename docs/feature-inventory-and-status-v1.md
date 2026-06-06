# Agent Cluster 功能清单 · 业务流程 · 当前问题

> 生成时间：2026-06-04
> 适用版本：v0.1（代码版本 `package.json` `agent-cluster@0.1.0`）
> 本文档基于**代码实测**编写，与设计文档（PRD / 系统设计）逐条对照，重点标注"设计 vs 实现"的差距。
> 与 [project-analysis.md](./project-analysis.md) 互补：那份偏运行态排查，本文偏功能盘点、业务流程与问题分级。

---

## 一、项目概述

**Agent Cluster 是一个"多智能体协作任务系统"**：用户用自然语言下发目标，平台像"管理一个 Agent 工作群"一样，先由 Agent 团队讨论生成一份**任务契约（Task Brief）**并请用户确认，确认后多个 Agent 分工执行，执行后对照契约做**一致性复盘**，最后产出交付物。核心理念是 **执行前先达成共识、执行后可审计复盘、全过程基于事件流可视化**。

| 维度 | 现状 |
| --- | --- |
| 代码组织 | npm workspaces 单仓：`apps/server`（NestJS）+ `apps/web`（Vue 3）+ `packages/shared`（契约） |
| 后端 | NestJS + TypeScript（ESM），13 个功能模块，纯内存 `Map` + JSON/Postgres 快照持久化 |
| 前端 | Vue 3 + Vite + Pinia，三栏工作台 + 四种视图，**完全基于事件流派生 UI** |
| 运行时 | 实际可用：`mock`、`generic_llm`（OpenAI 兼容）；`codex`/`claude_code` 为桩；`mcp_tool`/`human` 未接入 |
| 当前阶段 | **v1 协作闭环（dry-run）**，验收结论"带风险可交付"（见 `docs/quality/v1-closure-acceptance-report.md`） |
| 设计目标版本 | v1 闭环 → v2 真实研发执行 → v3 平台化生态（见系统设计文档） |

---

## 二、系统架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  apps/web (Vue3 + Pinia)                                      │
│  SessionWorkspace（三栏工作台）                               │
│   ├─ 视图：chat / workflow / collaboration_graph / debug      │
│   ├─ stores：session / event / agent / knowledge              │
│   └─ 通过 SSE(EventSource) 订阅事件流，UI 全部由事件派生       │
└───────────────┬───────────────────────────────┬──────────────┘
        REST /api │                       SSE /api/.../stream │
┌───────────────▼───────────────────────────────▼──────────────┐
│  apps/server (NestJS)                                         │
│  sessions ─► orchestrator ─► runtimes(mock / generic_llm)     │
│     │            │  └─► tasks / events / artifacts            │
│     │            └─► rag(knowledge) / memory / capabilities   │
│  user-message-router · debug · ops                            │
│  persistence（file JSON / postgres 子进程快照）               │
└───────────────────────────────────────────────────────────────┘
       packages/shared：SessionStatus / 事件契约 / Runtime 契约 / 默认 Agent
```

**架构主线（与设计一致的部分）**：
- **事件流是唯一事实源**：所有关键动作都写入 `collaboration_events`，前端三种视图都从同一份事件流派生（`apps/web/src/stores/event.ts`）。
- **Agent 身份与 Runtime 解耦**：`Agent.runtimeType` 决定由哪个 Runtime 执行（`packages/shared/src/contracts.ts:41`）。
- **Context Pack 动态组装**：每次执行前临时拼装上下文，不传全量历史（`orchestrator.service.ts:535`）。

---

## 三、功能清单

**实现状态图例**：✅ 已实现可用　⚠️ 已实现但明显简化/与设计有差距　🅿️ 仅预留/桩代码　❌ 未实现

### 3.1 会话与协作核心

| 功能 | 状态 | 说明 / 代码位置 |
| --- | :--: | --- |
| 自然语言创建协作会话 | ✅ | `POST /api/sessions`，自动选默认 Agent 团队，写入首条 `user_message`（`sessions.service.ts:61`） |
| 会话列表 / 详情 | ✅ | `GET /api/sessions`、`GET /api/sessions/:id`；列表含 `requiresUserAction` 标记 |
| 任务契约生成 | ⚠️ | 仅调用一次 coordinator 的 runtime 产出契约；"多 Agent 讨论"是**硬编码的 2 条 agent_message**，非真实多 Agent 对话（`orchestrator.service.ts:60-152`） |
| 任务契约确认 → 执行 | ✅ | `POST /api/sessions/:id/briefs/:briefId/confirm`，确认后由建议任务创建 `AgentTask` |
| 任务契约驳回 / 修订 | ⚠️ | `reject` 仅把状态切到 `REVISING_BRIEF`，**未触发重新讨论生成新版契约**（`sessions.controller.ts:63`） |
| 用户消息（执行前/中插话） | ⚠️ | 先写事件再路由；约束/纠正类在执行中会暂停到 `WAIT_USER_DECISION`，但**无法真正中断正在运行的执行循环**（详见问题 P1-9） |
| 暂停 / 继续 / 取消 | ⚠️ | `pause`/`resume`/`cancel` 仅做状态迁移；`resume`（→`EXECUTING`）**不会重新触发执行**（`sessions.controller.ts:38-51`） |

### 3.2 任务编排与执行

| 功能 | 状态 | 说明 / 代码位置 |
| --- | :--: | --- |
| 由契约建议生成任务 | ✅ | `tasks.createFromSuggestions`（`tasks.service.ts:17`） |
| 任务执行驱动 | ⚠️ | 单层 `for` 循环**顺序**执行（`orchestrator.service.ts:206-323`） |
| 任务依赖（DAG） | ❌ | `dependsOnTaskIds` 建表即写死为 `[]`，`dependsOnTaskTitles` 被忽略（`tasks.service.ts:25`） |
| 任务认领 / 并发 / worker | ❌ | 无 `claimed`/并发；契约里的 `claimed`/`reviewing` 等状态从未被写入 |
| BullMQ 异步队列执行 | ❌ | `.env` `ENABLE_BULLMQ=true`、docker 有 Redis，但 **BullMQ 仅在 `/ops/queues` 监控端点被引用**，编排器从不投递任务、无 worker 消费（`ops.controller.ts:2`）。6 个队列名恒为空 |
| 复盘一致性检查 | ⚠️ | 生成 `post_review_report`，但 **`recommendation`（deliver/rework/ask_user）被忽略**，不会据此进入返工/等待决策（`orchestrator.service.ts:333-360`） |
| 最终交付 | ✅ | 生成 `final_delivery` markdown 产物 + 飞书草稿产物（`orchestrator.service.ts:374-452`） |

### 3.3 Runtime（运行时）

| Runtime | 状态 | 说明 / 代码位置 |
| --- | :--: | --- |
| `mock` | ✅ | 确定性模拟输出（`mock-runtime.service.ts`） |
| `generic_llm` | ⚠️ | OpenAI 兼容 `chat/completions`，强制 `response_format=json_object`；**未实现超时与重试**（`LLM_TIMEOUT_MS`/`LLM_MAX_RETRIES` 定义了但代码未使用，`generic-llm-runtime.service.ts:46`） |
| `codex` | 🅿️ | 桩：调用即 `throw`，标注 reserved for v2（`codex-runtime-adapter.service.ts:9`） |
| `claude_code` | 🅿️ | 同上（`claude-code-runtime-adapter.service.ts:9`） |
| `mcp_tool` / `human` | ❌ | 契约中存在，`runtime.service.ts:43` 仅二选一路由（`generic_llm` 否则 `mock`），其余类型**静默 fallback 到 mock** |
| Runtime 调用日志 | ✅ | 每次调用记录 `RuntimeInvocationLog`，供 debug 查询（`runtime.service.ts:53`） |

### 3.4 知识库（RAG）

| 功能 | 状态 | 说明 / 代码位置 |
| --- | :--: | --- |
| 知识库 CRUD / 文档录入 | ✅ | `knowledge.controller.ts`：`/knowledge-bases`、`/:id/documents`、`/:id/search` |
| 四级作用域（global/project/session/agent） | ✅ | `KnowledgeScope`（`contracts.ts:49`） |
| 检索注入 Context Pack | ✅ | 执行前按 Agent 默认库 + 会话库检索，注入 `ragSnippets`（`orchestrator.service.ts:621`） |
| 向量检索（pgvector / embeddings） | ⚠️ | `.env` `RAG_EMBEDDING_MODEL=local-keyword-search`，实为**本地关键词检索**，非真实向量召回 |
| 检索来源可追溯（库/文档/chunk） | ✅ | `rag_retrieved` 事件携带 `matchedChunks`，前端 Agent 卡片展示 |

### 3.5 Memory（记忆）

| 功能 | 状态 | 说明 / 代码位置 |
| --- | :--: | --- |
| 记忆创建 / 检索 | ✅ | `/api/sessions/:id/memories`（`memory.controller.ts`） |
| 注入 Context Pack | ✅ | 检索相关记忆注入，并发 `memory_used` 事件（`orchestrator.service.ts:455`） |
| 记忆分层（short/session/long_term_candidate） | ✅ | `MemoryScope`（`contracts.ts:324`） |
| 长期记忆"需用户确认写入" | ⚠️ | 设计要求确认；实现把 `preference_input` 消息**自动**写为 `long_term_candidate`（confidence 0.72，`sessions.service.ts:135`） |

### 3.6 能力管控（Capabilities）

| 功能 | 状态 | 说明 / 代码位置 |
| --- | :--: | --- |
| 能力注册表 + 风险分级 | ✅ | 8 项默认能力，low/medium/high（`default-capabilities.ts`） |
| 能力查询 / check / approve | ✅ | `/api/capabilities`、`/:id/check`、`/:id/approve` |
| 高风险默认需确认 | ✅ | `.env` `ENABLE_HIGH_RISK_TOOLS=false`、`REQUIRE_USER_CONFIRMATION=true` |
| 高风险能力的**真实执行** | ❌ | `file_write`/`command_run` 仅做策略门控，无真实写文件/执行命令（v2 范围） |

### 3.7 产物与通知

| 功能 | 状态 | 说明 / 代码位置 |
| --- | :--: | --- |
| 产物创建 / 列表 / 下载 | ✅ | `artifacts.controller.ts`，支持多种 `ArtifactType`（`contracts.ts:52`） |
| 飞书通知草稿 | ✅ | 交付时生成 `feishu_draft` 产物，`mode=draft`、`dryRun=true` |
| 飞书真实发送 | ❌ | `.env` `FEISHU_MOCK_ENABLED=true`，仅草稿，无真实发送/确认发送流程 |

### 3.8 前端工作台

| 功能 | 状态 | 说明 / 代码位置 |
| --- | :--: | --- |
| 三栏协作工作台 | ✅ | `SessionWorkspace.vue` |
| 四视图：群聊 / 工作流 / 协作图 / 调试 | ✅ | `viewModes = ['chat','workflow','collaboration_graph','debug']`（`SessionWorkspace.vue:35`） |
| 聊天时间线（事件→消息） | ✅ | `ChatTimeline.vue` + `event.ts` 的 `chatMessages` getter |
| Agent 状态卡片 / 协作图 / 工作流图 | ✅ | `AgentStatusPanel`/`CollaborationGraphView`/`WorkflowRuntimeView` |
| 确认卡片（契约/决策） | ✅ | `ConfirmationCard.vue` + `activeConfirmation` getter |
| 调试视图（上下文包/调用/RAG/token） | ✅ | `DebugRuntimeView.vue` + `/api/sessions/:id/debug/*` |
| SSE 实时 + 断线回补 | ✅ | `EventSource` + `afterEventId` 增量拉取（`event.ts:251-283`） |

### 3.9 运维与持久化

| 功能 | 状态 | 说明 / 代码位置 |
| --- | :--: | --- |
| 健康检查 | ✅ | `GET /api/health` |
| 队列观测 | ⚠️ | `GET /api/ops/queues` 能连 Redis 读计数，但队列里**永远没有任务**（见 3.2） |
| 本地持久化（JSON 快照） | ✅ | 默认 `.cache/agent-cluster/state.v0.1.json`，原子写（`persistence.service.ts`） |
| Postgres 持久化 | ⚠️ | 通过 **`execFileSync` 子进程 + 每次全量覆盖写**实现，非连接池/ORM（`persistence.service.ts:103`） |
| 服务重启后执行恢复 | ❌ | 仅恢复数据，不恢复运行中的任务（详见问题 P0-4） |

### 3.10 Token / 成本

| 功能 | 状态 | 说明 |
| --- | :--: | --- |
| 调用用量记录 | ✅ | `RuntimeUsage` 记录在调用日志，debug 可查 |
| 五层预算 / preflight / 压缩降级 | ❌ | 契约 `RuntimeBudget` 存在，但编排器**所有 `budget` 都传 `{}`**，无预算检查/压缩/降级（`orchestrator.service.ts:69,252` 等） |

---

## 四、核心业务流程

### 4.1 会话状态机（契约定义 vs 实际走通）

契约定义了 11 个状态（`contracts.ts:4`）：

```
DRAFT_INPUT → AGENT_DISCUSSING → WAIT_USER_CONFIRM → REVISING_BRIEF
            → EXECUTING → POST_REVIEW → REWORKING → WAIT_USER_DECISION
            → COMPLETED / FAILED / CANCELLED
```

**实际代码真正走通的路径**（其余为"定义了但当前流程不会进入"）：

```
[create] ──► AGENT_DISCUSSING ──► WAIT_USER_CONFIRM
                                       │ confirm
                                       ▼
                                   EXECUTING ───────────────► COMPLETED   （顺利）
                                       │                         ▲
                                       │ 任一任务失败/异常        │ 若已产出 final_delivery
                                       ▼                         │
                                     FAILED          (复盘/交付完成后由 EXECUTING 直接置 COMPLETED)

  执行中插话(约束/纠正) ─► WAIT_USER_DECISION ─(resume)─► EXECUTING（仅改状态，不重启执行）
```

- `POST_REVIEW`、`REWORKING` 状态**有事件、但会话状态机不进入**：复盘在 `EXECUTING` 内部完成，结束后直接判 `COMPLETED`（`sessions.service.ts:186-189`）。
- 复盘 `recommendation=rework/ask_user` 被忽略，不会进入 `REWORKING`/`WAIT_USER_DECISION`。

### 4.2 端到端主流程（实际实现）

```
1. 用户输入目标
   POST /api/sessions
   → 创建 Session(status=AGENT_DISCUSSING)，写入 user_message 事件

2. 生成任务契约（HTTP 请求内同步等待 ⚠️）
   orchestrator.discussAndCreateBrief()
   → coordinator 调 runtime 产出 task_brief
   → 发 2 条硬编码 agent_message（requirements/architect）
   → 发 brief_created（brief_card）+ user_confirmation_requested（confirmation_card）
   → status=WAIT_USER_CONFIRM
   ★ 前端通过 SSE 收到事件，渲染契约确认卡

3. 用户确认契约
   POST /api/sessions/:id/briefs/:briefId/confirm
   → status=EXECUTING；按建议任务创建 AgentTask(pending)，发 task_created

4. 顺序执行任务（HTTP 请求内同步执行整条链 ⚠️）
   for task of tasks:
     task=running → task_started → runtime_started
     → runtime.run(task_execution) → rag_retrieved / memory_used
     → 成功：task=completed + artifact_created + runtime_completed + task_completed
     → 失败：task=failed + runtime_failed + task_rejected，抛错 → 会话 FAILED

5. 复盘（仍在同一请求内）
   post_review_started → review Agent 调 runtime 产出 post_review_report
   → 生成 test_report 产物 → post_review_completed

6. 最终交付（仍在同一请求内）
   coordinator 调 runtime 产出 final_delivery
   → 生成 markdown 交付产物 + feishu_draft 草稿产物
   → final_delivery_created

7. 收尾
   回到 confirmBrief：若 status 仍为 EXECUTING → 置 COMPLETED
   ★ 整个 3→7 在**一个 HTTP 请求**内同步完成才返回响应
```

### 4.3 用户消息处理（User Message Router）

```
POST /api/sessions/:id/messages
  → router.route()：正则识别 intent（7 类）+ 是否暂停
  → 写 user_message 事件 → coordinator 回一条 decision 事件（含 handlingPlan）
  → preference_input：自动写入 long_term_candidate 记忆
  → 执行中(EXECUTING/REWORKING/POST_REVIEW) + (constraint|correction)：
      status=WAIT_USER_DECISION，发冲突确认卡
```
> `affectedTaskIds` / `affectedAgentIds` 恒为空数组；意图判断为正则，非 LLM（`user-message-router.service.ts`）。

### 4.4 前端事件派生（UI 数据流）

前端**不轮询任务内部状态**，而是从事件流派生所有视图状态（`event.ts`）：
- `chatMessages`：事件按类型映射为聊天消息（brief/confirmation/task/tool/rag/artifact/review/delivery/error）
- `taskStates`：聚合 `task_*` 事件 payload 得任务卡
- `agentCards`：聚合 `agent_status_changed`/`rag_retrieved`/发言事件得 Agent 状态
- `activeConfirmation`：扫描 `user_confirmation_requested/resolved`/`brief_confirmed` 得当前待确认卡

---

## 五、当前问题（按严重程度分级）

> 说明：以下问题均经代码核实并标注位置。问题描述聚焦"**真实可用性与可靠性**"，与 v1"dry-run 演示闭环"的验收目标分开看待——v1 演示目标已达成，但要走向真实研发执行（v2）前，以下 P0/P1 是硬门槛。

### P0 — 阻断真实执行与可靠性

**P0-1　执行链绑定 HTTP 请求同步执行，无后台化**
确认契约后，从"创建任务 → 顺序执行所有任务 → 复盘 → 交付"全部在 `confirmBrief` 的**单个 HTTP 请求内 `await` 完成**（`sessions.controller.ts:58` → `sessions.service.ts:182` → `orchestrator.service.ts:206`）。真实 LLM 模式下一次会话有 ≥4 次模型调用，请求可能持续数分钟，极易触发网关/浏览器超时，且执行进度无法在请求返回前被独立观测。创建会话生成契约同理同步阻塞（`sessions.service.ts:95`）。
> 注：README 称契约"后台异步生成（generateBriefInBackground）"，**与现有代码不符**——现状是同步 `await`。

**P0-2　Generic LLM Runtime 无超时与重试**
`runOpenAiCompatible` 直接 `await fetch(...)`，未使用 `AbortController`，未读取 `LLM_TIMEOUT_MS`/`LLM_MAX_RETRIES`（`generic-llm-runtime.service.ts:46-127`）。模型不可达或慢响应时请求会无限挂起，叠加 P0-1 会导致整条链卡死。

**P0-3　状态机收尾不完整 / 复盘结论被忽略**
- 复盘 `recommendation`（rework/ask_user）未被消费，无返工与"请用户决策"路径（`orchestrator.service.ts:342`）。
- 任一任务失败即 `throw`，整个会话直接 `FAILED`（`sessions.service.ts:191`），不进入 `WAIT_USER_DECISION`/`REWORKING`。
- 正常路径 `EXECUTING` 直接置 `COMPLETED`，`POST_REVIEW`/`REWORKING` 状态形同虚设。

**P0-4　服务重启后无执行恢复**
各 Service 构造时仅从持久化恢复**数据**，不恢复**运行中的执行**。由于执行依附于 HTTP 请求（P0-1），重启/请求中断后 `running` 任务永久停滞，无重试/恢复入口（无 recover/retry API）。

### P1 — 架构与扩展性

**P1-5　BullMQ/Redis 声明启用但未真正承载执行**
`ENABLE_BULLMQ=true`、docker 提供 Redis，但 BullMQ 仅用于 `/ops/queues` 读取队列计数（`ops.controller.ts`）。编排器从不入队、无 worker，6 个业务队列恒空。异步化、并发、重试、削峰能力均缺失（与 P0-1 同根）。

**P1-6　Postgres 持久化用子进程 + 全量覆盖写**
`postgres` 后端通过 `execFileSync(node -e ...)` 起子进程执行 `pg` 脚本，且**每次 `setCollection` 全量 upsert 整个 state**（`persistence.service.ts:103-167`）。而 `events.create` 每写一条事件就 `persist()` 一次（`events.service.ts:51`）——一次任务执行产生十余条事件 ⇒ 十余次子进程 + 全量写，同步阻塞事件循环，吞吐与可靠性都差。

**P1-7　多 Agent 协作被简化为脚本化输出**
"Agent 讨论"是 2 条硬编码 `agent_message`（`orchestrator.service.ts:93-109`）；任务执行是顺序循环，无依赖、无认领、无 @ 协作、无真实多 Agent 往返。距 PRD 的"群聊式多 Agent 协作"差距大。

**P1-8　非 generic_llm 的 Runtime 静默降级到 mock**
`runtime.service.ts:43` 为 `runtimeType==='generic_llm' ? generic : mock` 的二元判断。若某 Agent 配为 `codex/claude_code/mcp_tool/human`，不会报错，而是**静默用 mock 执行**，易造成"以为在用真实运行时、实则 mock"的误判。

**P1-9　执行中"暂停"无法真正中断**
插话触发 `WAIT_USER_DECISION` 只改会话状态（`sessions.service.ts:145`），但任务执行在 P0-1 的同步循环里，无取消令牌（contract 定义了 `cancel?`，未实现），循环会继续跑完；`resume`（→`EXECUTING`）也不会重新触发任何执行（`sessions.controller.ts:43`）。

### P2 — 体验、治理与一致性

**P2-10　后端文案中英混杂**
`orchestrator.service.ts` 的事件 `content` 几乎全为英文（"Created task…"、"Started task…"），而 `sessions.service.ts` 为中文。中文用户在同一时间线看到中英混排，体验割裂。
> 复核：未发现 `U+FFFD` 乱码字节，project-analysis.md 所述"乱码"在当前代码未复现，准确表述应为"**中英文案不统一**"。

**P2-11　Token 五层预算未落地**
所有 runtime 调用 `budget` 传 `{}`，无 preflight 估算、无超预算压缩/降级/暂停（`orchestrator.service.ts` 多处）。`TOKEN_BUDGET_DEFAULT` 等配置未生效。

**P2-12　长期记忆"用户确认写入"未落地**
`preference_input` 消息被自动写为 `long_term_candidate`（`sessions.service.ts:135`），与 PRD"长期记忆 v1 需用户确认写入"的治理要求不符。

**P2-13　本地多服务端口易混淆**
沿用 project-analysis 观察：本地常并存 3000/3001/3100 多套服务与 5173/5180 前端，任务来源易误判。建议启动时打印 API base / 数据文件 / 运行模式，并在前端显著展示。

---

## 六、改进建议（优先级对应上节）

1. **执行后台化（解 P0-1/P0-4/P1-5）**：把"确认契约→执行→复盘→交付"从 HTTP 请求剥离，真正投递到 BullMQ 队列由 worker 驱动；HTTP 仅返回"已受理"，前端经 SSE 跟进。启动时扫描 `EXECUTING` 会话与 `running/pending` 任务做恢复或标记可恢复失败。
2. **LLM 健壮性（解 P0-2）**：`fetch` 接入 `AbortController` + `LLM_TIMEOUT_MS`，按 `LLM_MAX_RETRIES` 对可重试错误退避重试，超时显式产出 `runtime_failed`。
3. **补全状态机收尾（解 P0-3）**：消费复盘 `recommendation`——`rework`→`REWORKING` 重跑、`ask_user`→`WAIT_USER_DECISION`；任务失败进入决策而非整会话 `FAILED`；显式区分 `POST_REVIEW`/`COMPLETED`。
4. **持久化改造（解 P1-6）**：用常驻 `pg` 连接池 + 按集合/按行增量写替代子进程全量写；事件写入合并/批量持久化。
5. **Runtime 路由显式化（解 P1-8）**：用注册表按 `runtimeType` 派发；未实现的类型显式报错而非 fallback。
6. **协作深度（解 P1-7）**：实现任务依赖调度、Agent 认领与并发、真实多 Agent 讨论回合。
7. **治理补齐（解 P2-10/11/12）**：统一中文文案；落地 token preflight；长期记忆改为确认后写入。

---

## 七、一句话总结

> Agent Cluster 已经把**多 Agent 协作产品骨架**（事件流事实源、契约确认、复盘交付、四视图可视化、契约/数据/运行时模型）搭得相当完整，v1 dry-run 演示闭环可用且有自动化与人工验收证据。**下一阶段的关键不是加功能，而是补可靠性**：把执行从 HTTP 请求中解耦并队列化、给真实 LLM 加超时重试、补全状态机收尾与任务恢复——这四项（P0）是从"能演示"走向"能真干活"的硬门槛。
