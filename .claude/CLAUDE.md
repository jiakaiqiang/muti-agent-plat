# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库中工作时提供指引。

Agent Cluster 是一个多智能体协作系统：一组基于角色的 agent 围绕用户目标进行讨论，产出一份可确认的任务简报（task brief），通过可插拔的运行时（runtime）执行任务，评审结果，并交付总结。后端为 NestJS，前端为 Vue 3，`packages/shared` 契约包是两端共享的唯一事实来源（source of truth）。

## 命令

这是一个 npm workspaces 单仓库（monorepo，Node >= 20，仅 ESM）。请在仓库根目录运行。

```bash
npm install                              # 安装所有 workspace
npm run build         # 构建所有 workspace（server 消费前 shared 必须先构建）
npm run typecheck     # 跨所有 workspace 执行 tsc --noEmit —— 主要的正确性校验关卡
npm run test          # server workspace 的 `node --test`（目前没有单元测试 → 实际上是空操作）
npm run lint          # 透传；没有任何 workspace 定义了 linter，因此什么也不做
```

各 workspace 的开发服务器：

```bash
npm run dev -w @agent-cluster/server     # 构建 + 在 :3000 上 `node --watch`（API 位于 /api 下）
npm run start -w @agent-cluster/server   # 运行预构建的 server，不带 --watch（见下方注意事项）
npm run dev -w @project/web              # Vite 开发服务器，运行在 :5173
```

本地基础设施（Postgres+pgvector、Redis），用于全栈运行：

```bash
docker compose up -d
```

### 测试（E2E 冒烟套件是真正的测试面）

各 workspace 中没有 `*.test.ts`/`*.spec.ts` 单元测试。验证逻辑位于 `tests/e2e/`：每个 `run-*.mjs` / `*-smoke.mjs` 脚本会构建 `shared`+`server`，在一个空闲端口上以临时数据文件和场景专属的环境变量启动 server，然后针对 REST/SSE API 做断言。CI（`.github/workflows/ci.yml`）会运行 typecheck → build → 其中的一个子集。运行其中之一：

```bash
npm run test:e2e:main-chain          # 完整 happy path：创建 → 简报 → 确认 → 执行 → 评审 → 交付
npm run test:e2e:interactive-messaging   # 用户消息路由 / 中断
npm run test:e2e:v2-runtime          # 通过 fake CLI 测试 codex/claude_code CLI 适配器
npm run test:e2e:postgres-persistence    # 需要 docker compose 的 Postgres
# ……完整列表见 package.json 的 "scripts"（security、ops、bullmq、real-data-mode 等）
```

## 架构

### 契约优先的单仓库（Contract-first monorepo）
`packages/shared/src/contracts.ts` 定义了每一个领域类型、枚举、事件类型以及运行时 I/O 形态。两端应用都通过 `@agent-cluster/shared` 别名导入它，该别名在 `tsconfig.base.json` 和 `apps/web/vite.config.ts` 中解析到**源码**（`packages/shared/src/index.ts`）—— 而非构建后的 dist。修改契约是一次跨切面的变更；`docs/contracts/*-v0.1.md` 中的契约文档描述了 v0.1 期望的稳定性规则（patch/minor/breaking）。

### 后端（`apps/server`，NestJS）
了解后端请参考 `docs/architecture/server.md`

协作引擎是**事件溯源（event-sourced）**的。每一个有意义的步骤都会通过 `EventsService` 写为一个 `CollaborationEvent`，它既持久化该事件，又将其推送到按会话划分的 RxJS `Subject`。`EventsController` 暴露历史记录（`GET /sessions/:id/events`）和实时 SSE 流（`GET /sessions/:id/events/stream`）。前端的所有 UI 状态都从这些事件派生 —— 各 service 从不直接推送视图模型。

会话生命周期是 `sessions.service.ts` 中的一个状态机（`SessionStatus`，允许的状态转换在 `assertControlTransition` 中强制约束）。整个流程均由 `OrchestratorService` 驱动：
1. `POST /sessions` → `AGENT_DISCUSSING`；简报规划在**后台**运行（`discussAndCreateBrief`，coordinator agent），因此 HTTP 调用立即返回，进度通过 SSE 流式推送 → `WAIT_USER_CONFIRM`。
2. `POST /sessions/:id/briefs/:briefId/confirm` → `EXECUTING`；`confirmBrief` 根据简报的建议项创建任务，`executeRuntimeTasks` 逐个执行任务 → 执行后评审（review agent）→ 最终交付（coordinator）+ 一个 `feishu_draft` 制品（notification agent，仅草稿，绝不发送）→ `COMPLETED`。
3. `POST /sessions/:id/messages` → Coordinator 首先对消息进行**分诊（triage）**（`OrchestratorService.triageUserMessage`，一次 LLM 调用，返回带 `route` 的 `user_message_handling_plan`），因此 Coordinator 是唯一的决策者和唯一的对接点 —— 它不是把消息正则扇出去的分发器。`UserMessageRouterService` 现在仅作为**兜底**（在 triage 运行时调用失败时使用），外加一个快速命令检查（`isQuickCommand`）。`route` 决定具体动作：`answer`（Coordinator 回复）、`ask_user`（Coordinator 提出一个澄清问题 —— 仅当确实被阻塞时）、`apply_to_agents`（在内部把约束同步给相关 agent，然后由 Coordinator 发出**一条**汇总的确认 —— agent 绝不直接给用户发消息）、`revise_brief`（重新生成尚未确认的简报 → 回到 `WAIT_USER_CONFIRM`）、`new_task` 或 `command`。执行过程中的约束/纠正仍可暂停到 `WAIT_USER_DECISION`。每个 agent 的行为由 `orchestrator/agent-personas.ts` 中的人设塑造（注入到各运行时的 `systemPrompt`）；只有 Coordinator 与用户对话。
4. `pause` / `resume` / `cancel` 端点执行受保护的状态转换。

默认 agent（coordinator、requirements、architect、frontend、backend、test、review、notification）定义在 `packages/shared/src/default-agents.ts`。各阶段通过 `key` 经由 `pickSessionAgent` 选取 agent。

### 运行时抽象（`modules/runtimes`）
`RuntimeService.run(AgentRunInput)` 是调用 agent 的唯一入口。它先解析 model+connection（`ModelsService.resolveForAgent`），再按 `agent.runtimeType` 分派到某个适配器，并为每次调用包裹超时 + 重试循环 + 基于 `AbortController` 的取消机制（`RUNTIME_TIMEOUT_MS`、`RUNTIME_MAX_RETRIES`）。适配器：
- `generic_llm` —— 兼容 OpenAI / Ollama 的 chat completions（默认）。
- `codex`、`claude_code` —— 通过共享的 `cli-runtime-adapter.ts` 启动一个外部的 agentic-coding CLI：以 JSON 形式把 `AgentRunInput` 写入 stdin，期望从 stdout 得到一个 `RuntimeOutput`（或 `{ output, toolRequests, usage }`）。任何 `toolRequests` 都经由 `ToolExecutorService`（能力策略 + workspace-root 沙箱）执行，绝不由 CLI 直接执行。
- `mock` —— 用于测试/演示的确定性模拟。

每个结果都是一个带类型的 `AgentRunResult`，其 `output.kind` **必须**匹配调用方的 `expectedOutput.kind`（否则 `completedOutput` 会抛错）。适配器是真实优先（real-first）且默认安全的：被禁用的运行时、缺失的 CLI、超时或无效输出都会返回一个可见的 `failed`/`cancelled` 结果，而不是抛错或悄悄地走 mock。

### 持久化（`modules/persistence`）
这是一个迁移桥接式的 JSON 快照，并非真正的 ORM。各 service 在内存中（`Map`）持有状态，并调用 `getCollection`/`setCollection`。后端默认是 `.cache/agent-cluster/` 下的单个 JSON 文件，或在 `AGENT_CLUSTER_PERSISTENCE_BACKEND=postgres` 时使用 Postgres（通过启动的 `pg` 脚本写入）。默认 agent 以及默认 model/connection 是**仅 seed（seed-only）**的：在启动时从 env 重新派生，并有意排除在持久化存储之外，因此只有用户创建的实体会被保存。

### 前端（`apps/web`，Vue 3 + Pinia）
单页工作区（`App.vue` → `SessionWorkspace.vue`）。`src/api/client.ts` 封装 REST 并构建 SSE URL。`src/stores/` 中的 Pinia store 拥有数据：`event.ts` 打开 `EventSource` 并把进来的事件折叠成时间线/派生状态；`session.ts`、`agent.ts`、`model.ts`、`knowledge.ts` 镜像各自的 REST 资源。`src/types/contracts.ts` 是共享契约在前端的视图。

## 约定与坑（Conventions & gotchas）

- **ESM 的 `.js` 导入说明符。** server（和 shared）源码用 `.js` 扩展名导入相邻的 `.ts` 文件，例如 `import { AppModule } from './app.module.js'`。请保持一致 —— `moduleResolution` 为 `Bundler`，且项目为 `"type": "module"`。
- **嵌套的 server 构建产物。** 因为 server 编译的是 shared 的*源码*（通过路径别名），tsc 将输出根定位在 monorepo 层级：入口点是 `apps/server/dist/apps/server/src/main.js`，即 `start`/E2E 运行器实际执行的文件。
- **`npm run dev` 使用 `node --watch`**，当被监视目录树中的文件变化时可能在请求中途重启（以 ECONNRESET 杀死长时间的运行时流程）。对于完整的端到端流程，请先构建一次，再用 `npm run start -w @agent-cluster/server`。
- **真实优先（Real-first）的运行时。** 默认配置运行真实的 `generic_llm` 运行时，没有 mock 兜底（`.env.example` 指向本地 Ollama）。mock 模式仅为可选开启：`MOCK_RUNTIME_ENABLED=true`、`DEFAULT_AGENT_RUNTIME_TYPE=mock`、`LLM_MOCK_FALLBACK=true`、`VITE_ENABLE_MOCKS=true`。
- **默认 agent 的 seed 受开关控制。** 除非设置 `AGENT_CLUSTER_SEED_DEFAULT_AGENTS=true`，否则 `/api/agents` 为空 —— 任何期望标准团队的 E2E 或本地运行都需要设置它。
- **高风险工具执行受到纵深防护。** 真实的文件写入 / 命令运行需要 `ENABLE_HIGH_RISK_TOOLS=true`，*加上*对应的 `ALLOW_FILE_WRITE_RUNTIME` / `ALLOW_COMMAND_RUNTIME` 开关，*再加上*一个位于 `AGENT_WORKSPACE_ROOT` 内的路径。在本地开发中请保持这些关闭。
- **面向用户的文案是中文。** agent 状态消息、事件内容和 UI 字符串都用中文书写；请与周围的语言保持一致。
- **配置位于根目录的 `.env`**（由 `loadLocalEnv` 加载），且 Vite 从仓库根目录读取 env（`envDir`）。把 `.env.example` 复制为 `.env`。
