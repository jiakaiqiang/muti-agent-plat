# Multica 与 Agent Cluster 运行时架构对比分析 v1

> 更新时间：2026-07-09
> 分析对象：[multica-ai/multica](https://github.com/multica-ai/multica)（开源 managed agents 平台，Go + Next.js + PostgreSQL/pgvector，约 39K stars）
> 源码依据：`server/pkg/agent/agent.go`、`claude.go`、`codex.go`、`models.go`、`server/internal/daemon/daemon.go`、`server/pkg/protocol/messages.go`
> 本仓库对照：`apps/server/src/modules/runtimes/`、`docs/analysis/system-pain-points-v1.md`

## 1. 总体架构相似点

两个项目在核心抽象上高度同构，属于同一条 "managed agents" 赛道：

| 维度 | Multica | Agent Cluster（本项目） |
| --- | --- | --- |
| Agent 与执行环境解耦 | Agent 选择 Runtime（本机 daemon 或云端），Runtime 上报可用 CLI | Agent 与 Runtime 解耦，同一 Agent 可切 mock / generic_llm / codex / claude_code |
| 任务生命周期 | enqueue → claim → start → complete/fail | tasks 模块状态机 + `claimed` 状态（定义了但少用） |
| 实时事件流驱动 UI | WebSocket 推送进度到看板和 activity timeline | `collaboration_events` 事实源，SSE/WS 驱动群聊、协作图、工作流三视图 |
| 存储 | PostgreSQL 17 + pgvector，规范化表 | PostgreSQL（当前 JSONB collection），pgvector 规划中 |
| 团队编排层 | Squads：leader agent 决定谁接活 | Orchestrator + Coordinator：讨论、brief、任务拆解、分配 |
| 多租户预留 | Multi-Workspace 隔离 | 表结构保留 `owner_id` / `workspace_id` / `project_id` |
| 知识沉淀 | Reusable Skills（可复用技能库） | Memory + RAG 知识库 |

Multica 独有、我们没有的能力：Autopilots（cron/webhook 触发周期任务）、Skills 一等公民化、custom runtime profile。

## 2. Multica「任务 → 宿主机 CLI」完整链路

核心代码在 `server/internal/daemon/daemon.go`（约 4700 行）和 `server/pkg/agent/`（每个 CLI 一个 backend）。Server 永远不执行 agent，执行全部下放到用户机器上的 daemon。

### 2.1 Daemon 注册与任务认领

- Daemon 启动后通过 WebSocket 向 server 发 `DaemonRegisterPayload`，携带本机探测到的 `RuntimeInfo[]`（type + version + status），server 由此知道这台机器能跑哪些 CLI。
- 任务分配后 server 只发唤醒提示（`TaskAvailablePayload`），daemon 仍走 HTTP claim 端点认领——WS 只做 hint，认领一致性由 HTTP + 数据库保证，daemon 掉线重连不丢任务。
- Daemon 用槽位信号量（`newTaskSlotSemaphore`）控制并发任务数，槽位编号透传给 agent 进程（`MULTICA_TASK_SLOT`，用于索引 GPU 等机器级共享资源）。
- 心跳（`heartbeatLoop`）复用为控制通道：server 在心跳 ack 里下发待办动作——CLI 升级、枚举模型列表、导入本地技能。所有 server→daemon 低频控制指令都搭心跳的车。

### 2.2 执行环境准备（`runTask`, daemon.go:3451）

- `execenv.Prepare` 建任务级隔离 workdir（`/multica_workspaces/{ws}/{task}/workdir`）；repo 不预 clone，agent 需要时自己跑 `multica repo checkout <url>`（daemon 维护本地 repo cache）。
- 同一 (agent, issue) 对的后续任务可 Reuse 上一次 workdir——路径存数据库，下次 claim 通过 `PriorWorkDir` 传回。
- `execenv.InjectRuntimeConfig` 把 runtime brief（issue id、回复规则、agent instructions、技能清单）写进 workdir 的 CLAUDE.md / AGENTS.md，让 CLI 用自己原生的上下文加载机制去读，而不是全塞进 prompt。任务上下文放 `.agent_context/` sidecar 目录。若 workdir 是用户本地目录，任务结束后逐字节还原（`CleanupRuntimeConfig` + `CleanupSidecars`）。
- 注入任务作用域凭证：`MULTICA_TOKEN` 是 server 签发的 (agent, task) 绑定 token，禁止回落到 daemon 自身凭证——agent 通过它回调 Multica API 发评论、建 issue，权限边界清晰。
- 状态机时序：`StartTask`（dispatched→running）在 workdir 落盘之后才调用，避免消费者读到 running 却找不到目录的竞态。

### 2.3 CLI 进程协议（`server/pkg/agent/`）

统一接口：`Backend.Execute(ctx, prompt, opts) → Session{Messages <-chan, Result <-chan}`。每种 CLI 用它自己的原生 headless 协议：

- **Claude Code**（claude.go）：spawn
  `claude -p --output-format stream-json --input-format stream-json --verbose --strict-mcp-config --permission-mode bypassPermissions --disallowedTools AskUserQuestion [--model X --effort Y --max-turns N --append-system-prompt S --resume <session>]`
  - prompt 通过 stdin 写一个 JSON 帧；stdout 逐行解析 stream-json 事件（assistant/tool_use/system/result/control_request），归一化成统一 `Message` 类型。
  - stdin 写入放独立 goroutine，防止和 stdout 读互相死锁；stdin 保持打开以应答 `control_request` 双向控制帧。
  - stderr 进有界 tail buffer，失败时附在错误信息里。
  - `--resume` 没接上（CLI 生成了新 session 且失败）时返回空 session id，让 daemon 走「新会话重试」回退。
- **Codex**（codex.go）：spawn `codex app-server --listen stdio://`，长驻进程 + JSON-RPC 2.0 双向通信，不是一次性 exec。
- token 用量直接从 CLI 的 result 事件解析，按模型名分桶（`map[model]TokenUsage`，含 cache read/write）。
- MCP：agent 的 `mcp_config` 写临时文件传 `--mcp-config`，配合 `--strict-mcp-config` 防继承宿主机全局配置。
- custom_args 经 blocked-args 白名单过滤后追加，防止覆盖 daemon 硬编码的关键 flag。

### 2.4 存活判定：活性看门狗，不是硬超时

- `ExecOptions.Timeout` 为 0 时没有 wall-clock 死线（agent.go 注释："a session that keeps emitting events is never killed merely for running long"）。
- 存活由 `runIdleWatchdog` 判定——事件流还在动就不杀。
- Codex 另有两个语义级超时：semantic inactivity（默认 10 分钟无语义进展）和 first-turn no-progress（30 秒内一个事件都没有）。
- 取消：daemon 轮询 server 任务状态（`watchTaskCancellation`），用户在 UI 点停止 → daemon interrupt 进程。

### 2.5 结果回传

- 执行中每条 `Message` 转成带 `seq` 的 `TaskMessagePayload` 经 WS 推给 server → 前端 timeline 实时渲染。
- 结束时 `reportTaskResult` 上报 status/output/error/usage/session_id/work_dir。
- 没有任何环节要求模型输出平台自定义的 JSON 合同——结构化信息要么来自 CLI 原生协议帧，要么来自 agent 主动调 Multica API。

## 3. 与本项目当前实现的对比

对照 `apps/server/src/modules/runtimes/codex-runtime-adapter.service.ts` 等：

| 维度 | Multica | Agent Cluster 现状 |
| --- | --- | --- |
| 执行位置 | 宿主机 daemon，server 零执行 | NestJS server 进程内 `execFile` |
| 进程模型 | 长驻/流式（stream-json、app-server JSON-RPC） | 一次性 `codex exec --json <prompt>`，进程退出后整体 `JSON.parse(stdout)` |
| 输出契约 | CLI 原生事件协议，逐帧归一化 | prompt 要求模型 "Return one JSON object" 符合 `RuntimeOutput` schema——靠模型自觉，天然脆弱（近期多个 commit 反复修"成功结果被误判失败"即此根源） |
| 上下文注入 | runtime brief 写入 CLAUDE.md/AGENTS.md + `.agent_context/` sidecar + env，CLI 按需读 | 整个 ContextPack `JSON.stringify` 塞进一条巨型 prompt |
| 存活判定 | 无死线 + 活性 watchdog + 语义超时 | `CODEX_RUNTIME_TIMEOUT_MS` 硬超时 120s（本地慢模型易被误杀，参见 agent 卡死根因分析） |
| 过程可见性 | 逐帧 seq 流式回传，前端实时 timeline | 黑盒执行，结束才有结果 |
| 文件变更捕获 | 隔离 workdir，git 语义 | before/after 全量文本快照 diff（500 文件 / 200KB 上限），大仓库慢且漏 |
| 会话续接 | `--resume <session_id>`，含失败回退 | 无 |
| token 记账 | 从 result 帧解析，按模型分桶 | 硬编码 0 |
| 权限/安全 | `bypassPermissions` + 显式 `--disallowedTools`、blocked args 白名单、任务作用域 token | 依赖 CLI 默认行为 |

我们的 `RuntimeRegistryService` 抽象方向正确（注册时 `checkAvailability`、按 category 列举），与 Multica 的 runtime 注册思想同构，只是粒度停在「server 内 adapter」而不是「机器 + CLI 实例」。

## 4. 模型管理与 Agent 管理对比

### 4.1 Multica 模型管理（`server/pkg/agent/models.go`）

- 模型目录是 per-provider 的：claude/codex 用静态目录 + CLI 探测每个模型的 thinking level 目录（Claude `low|medium|high|xhigh|max`、Codex `none…xhigh`，且知道 `xhigh` 仅 Opus 支持这类 per-model 差异）；opencode/cursor/copilot 等 shell 出 CLI 动态发现，60 秒缓存，失败静默回退。
- 发现动作跑在 daemon 上（模型可用性取决于那台机器的 CLI 登录态），server 通过心跳 ack 的 `pending_model_list` 触发，daemon 枚举后回报。
- 关键哲学：`Model.Default` 只是展示提示——agent 不选模型时 daemon 传空字符串，让 CLI 自己解析默认值（"CLI 的默认永远比平台的静态猜测更贴近用户账号实际支持的"）。

### 4.2 Multica Agent 管理

Agent 是数据库一等实体，字段包括：

- name、provider（backend 类型）、model、thinking level
- instructions（系统提示，随任务注入 execenv）
- skills（技能包，daemon 按需解析下载）
- mcp_config（daemon 写临时文件传 `--mcp-config`）
- custom_args（过白名单后追加到命令行）
- 绑定的 runtime；另有 custom runtime profile：同一 provider 协议族可指向非默认二进制路径

### 4.3 本项目现状

- Agent：`packages/shared/src/default-agent-presets.ts` 静态预设 + agents module，agent 级别没有独立的模型/推理档位/工具配置。
- 模型：`RuntimeModelConfigService` 是全局单选 currentModel（env + 自定义 + Ollama `/api/tags` 发现），只服务 generic_llm。

## 5. 优化建议（按杠杆排序）

1. **claude_code/codex adapter 改用 CLI 原生流式协议**：`claude -p --output-format stream-json` 逐行解析，替代「prompt 要求模型输出自定义 JSON」。一刀同时解决：输出误判失败（P0）、执行过程黑盒、token 记账为 0。`RuntimeOutput` 合同保留在归一化层（CLI 帧 → RuntimeOutput），不再是模型的输出义务。
2. **硬超时改为活性看门狗**：「有事件就不杀 + 语义无进展超时」，消除本地慢模型被固定超时窗口误杀的问题。
3. **上下文注入改为 workdir 写 brief**：ContextPack 中稳定部分写进任务目录的 CLAUDE.md/AGENTS.md（用完清理还原），prompt 只留任务本身，改善 token 消耗和上下文利用率。
4. **支持 `--resume`**：CLI 返回的 session_id 存进 runtime invocation 记录，同任务续跑/返工时复用，参考 Multica 的「resume 失败回退新会话」语义。
5. **模型管理下沉到 per-runtime**：`RuntimeModelConfig` 从全局单选改为按 runtime type 的目录（generic_llm 保留现状，claude_code/codex 走 CLI 探测），agent 增加可选 model/thinkingLevel 字段，空值 = 让 CLI 用自己的默认。
6. **文件变更捕获改用 git**：隔离任务 workdir + `git status/diff` 替代全量文本快照，去掉 500 文件上限。

长期方向（不急）：执行从 server 进程剥离成 daemon/worker——已有 BullMQ，可先把 CLI 执行挪进独立 worker 进程作为中间形态，不必一步到位做跨机 daemon。

## 6. 实施注意

- Multica 是 Go + Next.js，代码不能直接搬，可借鉴的是架构模式。
- 第 1–3 项实施前应先更新 `docs/contracts/runtime-contract-v0.1.md`，再动 adapter，并同步 `tests/e2e/runtime-routing-smoke.mjs` 等相关验证。
