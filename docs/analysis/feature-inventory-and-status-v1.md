# Agent Cluster 功能清单与当前状态

> 更新时间：2026-07-13
> 适用版本：`agent-cluster@0.1.0` 当前工作树
> 本文基于 `apps/server/`、`apps/web/`、`packages/shared/`、`tests/e2e/` 和现有质量文档重新盘点。旧版 2026-06-04 的 P0/P1 问题多数已经修复，不再作为当前事实来源。

## 1. 总体结论

Agent Cluster 当前活动合同已收敛为 Context Pipeline v2-only：Agent Profile 与 Runtime/Model 解耦，每次 Invocation 动态解析执行目标、Tool Catalog 和 ContextEnvelope。核心链路已经具备会话创建、工作区感知、多 Agent 讨论、任务契约、后台执行、复盘交付、受控 CLI Runtime、Workdir Brief、Skill/Tool Profile 引用和切换审计。

当前仍不应把它描述为完整生产级真实研发平台。Context v2、动态 Runtime 路由、Workspace Provider 和 Browser WebSocket Broker 已接入新 Session 主链路；主要剩余缺口集中在：MCP/Human runtime 未落地、Codex 本地 CLI/Runtime 已可用但真实模型上游验收受阻、Watchdog 尚缺每个目标 Runtime 20 次真实样本形成生产参数、RAG 仍是本地关键词检索、外部通知仍为 dry-run、Autopilot 仅允许 mock/low-risk，以及持久化尚未拆成细粒度业务表。

## 2. 当前架构

```text
apps/web (Vue 3 + Pinia)
  SessionWorkspace
  ├─ chat / workflow / collaboration_graph / debug
  ├─ Agent / Workflow / Knowledge / Models / Tools / Notifications 管理入口
  ├─ File System Access 工作区扫描与 fileChanges 写回
  └─ SSE + REST，所有主视图由 collaboration_events 派生

apps/server (NestJS)
  sessions -> orchestrator -> execution -> runtimes
     │            │             ├─ in-process background pipeline
     │            │             └─ BullMQ agent-task-queue worker
     │            ├─ tasks / events / artifacts
     │            ├─ rag / memory / capabilities / skills
     │            ├─ Codex app-server / Claude stream-json
     │            └─ workspace snapshot + recoverable Workdir Brief + fileChanges
  autopilot -> issueguard -> existing session pipeline
  persistence(file JSON / PostgreSQL JSONB collection)
  recovery(on boot, non-BullMQ mode)
  ops/debug endpoints

packages/shared
  Contract types, default agents, metadata, mock fixtures
```

## 3. 能力状态

状态图例：`完成` = 当前代码已有闭环和测试保护；`部分` = 有可用骨架但仍有限制；`预留` = 合同或适配器存在但真实能力未接入。

| 领域 | 状态 | 当前事实 |
| --- | --- | --- |
| 会话创建与事件流 | 完成 | `POST /api/sessions` 创建会话并立即返回；brief 生成在后台执行；前端通过 SSE 和事件回补跟进。 |
| 多 Agent 讨论 | 完成 | `DISCUSSION_AGENT_KEYS`、`DISCUSSION_MAX_ROUNDS`、`DISCUSSION_TIMEOUT_MS` 控制讨论参与者、轮次和超时；超时会降级为风险消息继续生成 brief。 |
| 任务契约 | 完成 | Coordinator 生成 `TaskBrief`，保存建议任务，创建 brief markdown 产物和确认卡；用户可确认或要求修订。 |
| 工作流管理与执行 | 完成（线性 v1） | 独立 Workflow Catalog + Runtime；支持草稿、不可变发布版本、归档、Agent/人工确认/机器人确认三类节点、三栏 Vue Flow 编辑器、群聊无默认选中的发布版本弹窗、显式人工门禁、机器人返工与转人工、队列/本地执行和重启恢复。条件、并行、汇聚和能力画像自动匹配后置。 |
| 执行后台化 | 完成 | `ExecutionService` 让 HTTP 只返回受理结果；实际任务、复盘、交付在后台流水线或 BullMQ worker 中推进。 |
| 执行取消与恢复 | 完成 | in-process 模式下持有 `AbortController`；pause/cancel 可中断运行时；resume 重置 stale running 任务后继续；`RecoveryService` 启动时恢复未完成执行。 |
| BullMQ 队列 | 完成 | `ENABLE_BULLMQ=true` 时执行入 `agent-task-queue`，worker 消费并使用 job id 保证幂等；`GET /api/ops/queues` 读取队列计数。 |
| 状态机与复盘 | 完成 | `runPipeline` 返回 `delivered/rework/ask_user/cancelled/failed`；`applyOutcome` 消费复盘建议，自动返工受 `REWORK_MAX_ROUNDS` 限制。 |
| Coordinator 中心任务流转 | 完成 | 任务确认后由 Coordinator 写入 `task_assigned`，任务参与方统一使用 `ActorRef`；任务计划保留路由原因、上下文要求、验证计划和风险；子 Agent 只返回 `task_acceptance_decision`，第一次失败自动改派，第二次失败进入 `WAIT_USER_DECISION`。 |
| 已有会话后续需求 | 完成 | 每条消息先由接收者 Runtime 做意图识别，再进入持久化 FIFO 队列；执行中不打断当前任务，结束后自动拆分派发；空闲/终态会话立即处理；单 `@Agent` 定向派发，多 `@Agent` 先讨论再由接收者拆分。接收者只负责意图识别和任务拆分。 |
| 任务依赖 | 完成 | `SuggestedAgentTask.dependsOnTaskTitles` 会解析为 `dependsOnTaskIds`，执行时只选择依赖已完成的 ready task。 |
| 统一任务上下文 | 完成 | 服务端组装阶段生成 Project Map、导航、最小证据、Tool 结果、摘要记忆和交付引用；Runtime 只接收权威 `ContextEnvelopeV2` L0-L6，不再接收重复 Workspace payload。缺少源码证据时返回 `CONTEXT_INSUFFICIENT`，补读后重建整份 Invocation。 |
| Runtime 路由 | 完成 | `InvocationResolver` 按任务、阶段、Workspace 和 Profile Tool 要求，从 Adapter metadata 派生 eligible 候选并生成 `ResolvedExecutionTarget`；不读取 Agent Runtime 字段，无 eligible runtime 时 fail closed。 |
| Generic LLM | 完成 | OpenAI-compatible/Ollama endpoint；缺配置时失败可见；支持超时、退避重试、取消信号和结构化 JSON 输出校验。 |
| Mock Runtime | 完成 | 支持确定性 dry-run、延迟、失败率、工作区 fileChanges 和多种输出 kind，供本地/e2e 使用。 |
| Codex/Claude Runtime | 完成（本地可用，生产验收部分完成） | Server Runtime 保持 Codex app-server/Claude stream-json 受控执行；Local Runtime CLI 已使用通用 Adapter Registry 同时探测并上报 Codex 与 Claude Code，Claude 本机模式复用 staging、权限交集和 ChangeSet 写回，并通过 stream-json Stub 验收。真实付费模型的本机回归仍需独立确认后执行；Watchdog 20 次真实样本待采集。 |
| MCP/Human Runtime | 预留 | `mcp_tool`、`human` 尚未接入真实执行。 |
| Runtime Session Resume | 完成 | CLI session/workdir 显式写入 invocation log；同 runtime/workdir 恢复；失败或 session mismatch 单次 fresh fallback 并写 `RESUME_FALLBACK`。 |
| ActorRef | 完成（v2-only） | Event/Task/Session/Orchestrator/Web 只使用 `ActorRef`；旧 Agent id 双写、读取 fallback 和回填脚本已删除。 |
| Workdir Brief | 完成 | Codex/Claude 执行前注入 AGENTS.md/CLAUDE.md 受控块和 task sidecar，结束逐字节恢复；支持 lease、崩溃恢复和 TTL。 |
| Skill | 完成（含管理前端） | `skills` collection CRUD、路径/大小/revision 校验；Agent Profile 通过 `${skill:key}` 引用，Compiler 将 Skill 内容与 revision 编译进身份快照，删除前按 Profile 引用分析影响；不保留旧 ID 数组绑定接口。 |
| Autopilot | 完成（功能门控） | CRUD、手工触发、BullMQ scheduler、active issueguard、run/session 追踪已实现；默认禁用并强制 mock/low-risk。 |
| RAG | 部分 | 知识库 CRUD、文档录入、关键词检索、`rag_retrieved` 事件和 Envelope 组装已可用；pgvector/embedding 仍未落地。 |
| Memory | 完成 | session memory 创建/检索/注入；偏好类消息先发确认卡，`POST /memories/confirm` 后才写长期记忆候选。 |
| Capability governance | 部分 | 能力注册、风险分级、check/approve 可用；真实高风险工具执行仍默认关闭且未做端到端真实工具链。**当前问题**：任务执行中遇到审批阻断后用户授权，任务从头重新执行而非断点恢复。**P1 短期方案**（预检查）：任务启动前根据 Agent Profile 预检查所需能力，批量审批后再执行，避免中途打断。**P2 长期方案**（中断恢复）：保存 `PendingInvocation` 上下文，审批后自动从断点恢复执行。设计见 `docs/design/capability-approval-resume-design.md` 和 `docs/roadmap/remediation-plan-v1.md` § 4.5。 |
| Artifacts | 完成 | brief、执行结果、复盘、最终交付、通知草稿均创建 artifact；metadata 支持 `fileChanges`。 |
| Context Pipeline v2 | 完成（本地主链路） | v2 Session 构建 L0-L6 Envelope，Runtime 边界移除重复 legacy workspace payload；源码任务执行 grounded evidence gate，缺证据通过 Workspace Provider 补读后重试。 |
| 工作区感知 | 完成 | 产品只提供 `local_bridge` 与 `server_local`：本地模式由浏览器选择 CLI 已注册工作区并在本机 Runtime 执行；服务器模式由后端校验服务器目录并在服务器执行，Codex/Claude Code 使用独立 Worker。浏览器目录上传、服务器镜像和写回兼容链路已退役。 |
| 文件变更写回 | 完成（受控） | Local Runtime CLI 在授权工作区内通过相对路径、权限、base hash 与 revision 校验应用变更；ServerLocal 保留敏感路径、symlink、hash 冲突和 per-path 写锁。 |
| 用户原文件修订处理 | 完成（V2 候选迭代主链路） | 支持 `W0 -> U1 -> G1 -> U2 -> G2...` 版本链；第一轮和后续轮使用正确内部 Diff，单/多 Agent 共用冻结证据并由启用的系统默认 Receiver 生成唯一候选，Receiver 不可用时 fail closed；部分 Agent 失败由用户显式选择重试、使用成功结果继续或放弃；统一产物编辑器只展示候选全文，保存草稿不触发 Agent；精确确认和 Workspace Hash CAS 后才写回。候选/草稿可跨重启恢复，中断后按持久化结果显式重试 Agent、Receiver 或只做 apply 对账，Provider 异常不会永久卡在 `applying`；大文件和截断上下文 fail closed，Adapter 真实输出上限参与预检；`proposal_only` 在路由和执行两层只保留读取/搜索工具，业务事件不泄露 Prompt、提案、模型摘要或原始错误。PostgreSQL V2 投影实现数据库 advisory lock + CAS，冲突方刷新本地快照；当前验收环境未配置 `RELATIONAL_TEST_DATABASE_URL`，真实 PostgreSQL 的 `3` 项集成测试跳过。Mock Runtime 两轮 HTTP 和浏览器 E2E 覆盖候选-only 编辑、最终写回和 stale 冲突；真实付费模型 E2E 仍需在具备外部 Runtime 凭据的环境单独执行。 |
| 飞书通知 | 部分 | 最终交付会创建 `feishu_draft` artifact 和确认卡；确认后记录 dry-run tool 完成事件；不会调用真实飞书接口。 |
| 前端工作台 | 完成 | 三栏工作台、群聊、工作流、协作图、debug、Agent/Skill/Knowledge/Model/Tool/Notification 管理入口和中文可见文案。 |
| 持久化 | 部分 | file backend 原子 rename；PostgreSQL backend 使用常驻 `pg.Pool` 和 JSONB collection 单 key upsert；尚未拆成细粒度关系表。 |
| 可观测性 | 完成 | 启动日志使用 PersistenceService 的真实 backend/location；Health 暴露 PID、启动时间、commit、pipeline/schema/dataEpoch 和持久化位置；debug API 暴露 ContextEnvelope、identity、execution target、Tool Authority、RAG 和 token usage。 |
| Token 预算 | 完成 | `buildBudget` 和 v2 Envelope 分层预算负责估算与选择；grounded task 不再使用会清空 Evidence 的事后多阶段裁剪；runtime usage 回写 `session.tokenUsed`。 |

## 4. 当前主流程

### 4.1 新会话到任务契约

1. 前端可选本地工作区，扫描生成 `WorkspaceSnapshot`。
2. `POST /api/sessions` 创建 `AGENT_DISCUSSING` 会话并写首条 `user_message`。
3. `SessionsService.generateBriefInBackground` 后台调用 `OrchestratorService.discussAndCreateBrief`。
4. 如有工作区快照，先生成工作区分析消息和 `agent-output/workspace-analysis.md` 产物。
5. 多 Agent 讨论按配置轮次运行；讨论超时不会阻断 brief。
6. Coordinator 生成 `brief_created`、brief artifact 和 `user_confirmation_requested`。

### 4.2 确认后执行

1. `POST /api/sessions/:id/briefs/:briefId/confirm` 标记 brief 已确认并进入 `WAIT_WORKFLOW_SELECT`。
2. 用户可先进入工作流管理保存草稿并发布不可变版本，再通过 `POST /api/sessions/:id/workflow/select` 绑定精确版本。
3. `WorkflowRuntimeService` 按定义快照串行推进节点；Agent 自动执行，人工确认显式暂停，机器人确认按结构化结论推进、返工、拒绝或转人工。
4. `ExecutionService.start` 根据 `ENABLE_BULLMQ` 选择 in-process 后台 pipeline 或 BullMQ job。
5. 每个节点完成后将阶段输出写入群聊并进入 `WAIT_WORKFLOW_STEP_CONFIRM`；确认后推进，要求修改则重跑当前节点。
6. 全部节点确认后进入复盘，最终交付创建 markdown artifact、`feishu_draft` artifact 和通知确认卡。

### 4.3 用户插话与需求修订

- 执行前、确认中或等待决策时的补充需求会重新打开需求理解循环，取消未完成任务，重新生成 brief。
- 执行中的 pause/cancel 会取消当前执行；resume 会重置 stale running 任务并重新推进。
- 偏好类消息不会直接写长期记忆，而是先请求用户确认。

## 5. 当前剩余风险

Multica R1～R7 的生产就绪验收与直接后续增强，统一记录在 [Multica 对标改造剩余事项需求文档](../product/multica-refactor-production-readiness-requirements-v1.md)。

| 优先级 | 风险 | 影响 | 建议 |
| --- | --- | --- | --- |
| P0 | Codex 本地可用，生产上游验收阻塞 | Codex CLI、登录态、app-server 启动、Runtime 注册、事件和 stream metrics 均可用；历史三次首轮调用返回 `upstream_400`，2026-07-12 三次新 probe 均返回 Responses API 502，且 `totalTokens=0` | 保持本地 Runtime 可用标记；上游恢复或切换有效配置后补跑 Codex probe 与完整真实验收，不进行无界重试。 |
| P0 | 真实数据 cutover 尚未执行 | v2 主链和代码级门禁可用；当前用户数据仍可能由旧进程/旧数据源提供，普通启动不会自动切换 | 用 Health 核对 PID/commit/backend/location，单独确认 dry-run、外部加密只读归档与 apply，再停止旧进程并部署。 |
| P1 | Watchdog 生产参数尚无真实样本基线 | 指标、诊断、采样和分析器已完成；Claude 单次真实 probe 成功并使用 49,762 tokens，但 20 元费用上限不足以安全批准约 100 万 tokens 的 20 次采样 | 明确可审计计费方式并提高费用/使用额度后，为每个目标 Runtime 采集至少 20 次 completed 样本，批准参数并演练回滚。 |
| P0 | MCP/Human runtime 未实现 | 平台仍不能统一调用 MCP 工具执行器或人工 runtime | 后续按现有 Runtime Adapter/Capability 合同接入，保持失败可见和审计。 |
| P0 | 真实高风险工具未端到端接入 | 文件写入、命令执行、外部工具执行仍只在策略层预留 | 在 workspace sandbox、用户确认和审计事件齐备后逐项开启。 |
| P1 | RAG 仍是关键词检索 | 大规模知识库召回质量有限 | 接入 embeddings/pgvector，并新增检索质量与权限测试。 |
| P1 | Postgres 是 JSONB collection 存储 | 可恢复但难以做复杂查询、索引和审计 | 后续以 migration 拆分 sessions/events/tasks/artifacts/runtime_invocations 表。 |
| P1 | 任务执行是 ready task 循环，未做子 Agent 自动流转 | 多 Agent 并行度有限，第一阶段仍由 Coordinator 串起异常恢复 | 后续在 `agent_suggested/agent_delegated` 模式下补 delegation depth、幂等锁、审计和用户确认策略。 |
| P2 | 通知仍为 dry-run | 无真实飞书发送能力 | 增加真实发送 adapter，并保持显式确认和失败回滚。 |
| P2 | 部分架构分析特化逻辑混在通用编排 | 特定需求措辞会触发特殊产物路径 | 抽成可配置模板或专题 workflow，避免通用 orchestrator 膨胀。 |

## 6. 当前验证入口

常规质量门：

```bash
npm run typecheck
npm run test
npm run build
npm run test:harness
npm run test:e2e:main-chain
npm run test:e2e:p1-behaviors
npm run test:e2e:runtime-routing
npm run test:e2e:codex-streaming
npm run test:e2e:claude-streaming
npm run test:e2e:workdir-brief
npm run test:e2e:skill-injection
npm run test:e2e:autopilot
npm run test:e2e:coordinator-controlled-routing
npm run test:e2e:runtime-model-switch
npm run test:e2e:task-dependency
npm run test:e2e:multi-agent-discussion
npm run test:e2e:workflow-managed-execution
npm run test:e2e:rework-loop
npm run test:e2e:cancel
npm run test:e2e:recovery
npm run test:e2e:memory-confirm
npm run test:e2e:token-budget
npm run test:e2e:artifact-file-changes
npm run test:e2e:workspace-snapshot-payload
npm run test:e2e:server-local-project-analysis
npm run test:e2e:postgres-persistence
npm run test:e2e:bullmq-ops
npm run test:e2e:ops
npm run test:e2e:security
```

真实环境相关测试会依赖本地 PostgreSQL/Redis/Ollama 或自动拉起临时容器；只改文档时可不跑完整矩阵，但最终交付需说明。
