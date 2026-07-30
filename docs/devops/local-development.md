# 本地开发启动说明

## 前置要求

- Docker Desktop 或兼容 Docker Compose v2 的运行环境。
- Node.js、包管理器和应用启动脚本由 Frontend/Backend Team 最终确认。
- 本地端口默认使用：前端 `5173`，后端 `3000`，PostgreSQL `5432`，Redis `6379`。

## 初始化环境变量

复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

Linux/macOS：

```bash
cp .env.example .env
```

如本机已有 PostgreSQL 或 Redis 占用端口，可在 `.env` 中调整 `POSTGRES_PORT` 或 `REDIS_PORT`。

默认运行模式会调用真实 `generic_llm` runtime。至少需要在 `.env` 中配置：

- `GLOBAL_DEFAULT_RUNTIME_TYPE=generic_llm`
- `RUNTIME_STREAMING=off`：可选 `off/codex/claude_code/all`，只控制事件流模式，不改变路由目标。
- `LLM_PROVIDER=openai-compatible`
- `LLM_MODEL=gpt-4.1-mini`
- `LLM_API_KEY=<your api key>`
- `AGENT_CLUSTER_SECRET_KEY=<high-entropy deployment secret>`：新增或更新持久化 Runtime 凭据时必填，用于 AES-256-GCM 加密；不得提交到仓库。
- `LLM_BASE_URL=https://api.openai.com/v1`
- `LLM_DRY_RUN=false`
- `LLM_MOCK_FALLBACK=false`
- `VITE_ENABLE_MOCKS=false`

选择 Codex/Claude Code 创建会话时，前端会把首选 Runtime 和用户勾选的备用 Runtime 组成有序严格 allowlist。
Provider 故障时只会按该顺序降级，不会静默切换到未授权的 `generic_llm`。CLI Runtime 需要 `server_local` 工作区；可在创建
会话时填写服务器可访问的绝对路径，或用 `VITE_DEFAULT_SERVER_WORKSPACE_PATH` 预填本地默认路径。
Codex 还需要 `CODEX_RUNTIME_ENABLED=true`。Windows 本地环境可先使用
`RUNTIME_STREAMING=off`，由适配器通过 shell 调用 Codex CLI。
项目级分析通常需要把 `CODEX_RUNTIME_TIMEOUT_MS` 设置为 `600000` 或更高；默认短超时只适合探针调用。

Claude Code 需要 `CLAUDE_CODE_ENABLED=true`。Provider 调用必须直接执行原生程序并使用参数数组，禁止通过 Windows `cmd.exe` 传递 `--json-schema` 等结构化参数。Windows npm 安装会从 `claude.cmd` 同级安装目录自动解析 `node_modules/@anthropic-ai/claude-code/bin/claude.exe`；也可以显式配置：

```powershell
$env:CLAUDE_CODE_COMMAND='C:\path\to\@anthropic-ai\claude-code\bin\claude.exe'
```

`CLAUDE_CODE_COMMAND` 在 Windows 下不得指向 `.cmd` 或 `.bat`。历史 `CLAUDE_CODE_SHELL` 配置不再控制 Provider 启动；测试命令仍可独立使用 shell。

### LLM 网关长请求配置

HTTP 524 表示请求已经到达网关，但网关等待上游响应超时。若 Claude CLI 在约 120 秒后收到 524，提高 `CLAUDE_CODE_TIMEOUT_MS` 只能延长平台等待时间，不能绕过更短的上游网关超时。应优先修复可控网关链路：

- 流式接口关闭响应缓冲并立即透传首个 SSE frame；不要在代理层聚合完整模型响应。
- 网关的 upstream/read timeout 必须覆盖模型最长响应时间，平台 Runtime deadline 应再留出清理和落盘余量。建议从“模型 540 秒、网关 600 秒、平台 660 秒”起步，再按观测数据收敛。
- 若外层 CDN/代理的硬超时不可调整，长请求应改走可配置的企业路由、DNS-only 路由或内部负载均衡，不能依赖应用层无限重试掩盖。
- 记录首字节耗时、总耗时、HTTP 状态、provider endpoint、请求关联 ID；Cloudflare 响应存在 Ray ID 时一并记录到受控 Debug/Audit。

Nginx 类网关可使用以下基线，最终数值仍需服从上游 Provider 的实际限制：

```nginx
proxy_http_version 1.1;
proxy_buffering off;
proxy_request_buffering off;
proxy_read_timeout 600s;
proxy_send_timeout 600s;
send_timeout 660s;
```

平台侧默认最多执行三次 provider attempt：首选 Runtime 两次（首次失败后重试一次），随后最多一次授权备用 Runtime。重试延迟尊重 `Retry-After`，但受 `RUNTIME_PROVIDER_RETRY_MAX_DELAY_MS` 上限约束；连续失败后 circuit 在 `RUNTIME_PROVIDER_CIRCUIT_TTL_MS` 内阻止同一 Runtime 继续放大故障。

- `AGENT_CLUSTER_PERSISTENCE_BACKEND=postgres`
- `AGENT_CLUSTER_SEED_DEFAULT_AGENTS=false`
- `ENABLE_BULLMQ=true`

如果缺少 `LLM_API_KEY` 或 `LLM_BASE_URL`，后端会显式返回运行时配置错误并写入事件流，不会静默回退到 mock。只有显式设置 `LLM_MOCK_FALLBACK=true` 或 mock 演示模式时，`generic_llm` 才会使用 mock fallback。

## 启动基础设施

```bash
docker compose up -d postgres redis
```

查看状态：

```bash
docker compose ps
```

查看日志：

```bash
docker compose logs -f postgres redis
```

停止服务但保留数据卷：

```bash
docker compose down
```

清理数据卷会删除本地数据库和 Redis 数据，执行前需要明确确认：

```bash
docker compose down -v
```

## PostgreSQL 和 pgvector

Compose 使用 `pgvector/pgvector:pg16` 镜像，数据库具备安装 pgvector 扩展的能力。应用 migration 或数据库初始化脚本应执行：

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

当前仓库只预留初始化挂载目录 `docs/devops/postgres/init`，不放业务 schema，避免与 Backend Team 的 migration 并行工作冲突。

当前后端已支持真实 PostgreSQL collection 持久化。默认配置：

- `AGENT_CLUSTER_PERSISTENCE=true`
- `AGENT_CLUSTER_PERSISTENCE_BACKEND=postgres`
- `DATABASE_URL=postgresql://agent_cluster:agent_cluster_dev@localhost:5432/agent_cluster`
- `AGENT_CLUSTER_POSTGRES_COLLECTION_TABLE=agent_cluster_collections`
- `AGENT_CLUSTER_SEED_DEFAULT_AGENTS=false`

该实现会把会话、事件、任务、Memory、RAG 知识库等现有 collection 状态写入 PostgreSQL JSONB 表，服务重启后从数据库恢复。后续若落地细粒度业务表和 migration，可在保持 API 契约不变的前提下替换底层实现。

真实数据模式默认不会把内置默认 Agent 自动写入持久化 `agents` collection，但 `GET /api/agents` 和前端 Agent 选择器仍会展示内置默认 Agent，并与 `POST /api/agents` 创建的自定义 Agent 合并显示。只有需要把默认团队显式落库时，才设置：

```bash
AGENT_CLUSTER_SEED_DEFAULT_AGENTS=true
```

## Redis 和 BullMQ

Redis 默认开启 AOF：

```text
redis-server --appendonly yes
```

后端 BullMQ 建议使用 `.env` 中的：

- `ENABLE_BULLMQ=true`
- `REDIS_URL`
- `BULLMQ_PREFIX`
- `QUEUE_ATTEMPTS`
- `QUEUE_CONCURRENCY`

队列命名建议与系统设计保持一致：

- `agent-discussion-queue`
- `agent-task-queue`
- `runtime-invocation-queue`
- `rag-indexing-queue`
- `notification-queue`
- `post-review-queue`

启用 `ENABLE_BULLMQ=true` 后，确认任务契约会把执行投递到 `agent-task-queue`，同进程 `ExecutionWorker` 会消费 job。`GET /api/ops/queues` 会连接 Redis/BullMQ 并返回每个队列的 `waiting`、`active`、`completed`、`failed` 数值。未启用时该接口仍返回 disabled 状态，后端改用进程内后台执行和 `RecoveryService` 启动恢复。

## 应用启动建议

建议使用根目录 supervisor 同时启动前后端：

```bash
docker compose up -d postgres redis
npm install
npm run dev
```

`npm run dev` 会固定启动 8099 后端和 8089 前端，并持续检查 `/api/health`。后端在首次启动超时、已就绪后持续失联，或任一开发子进程异常退出时，supervisor 会关闭整组进程并返回非零退出码，避免只剩前端继续展示过期会话状态。

需要单独调试某一侧时，仍可分别执行：

```bash
npm run dev --workspace @agent-cluster/server
npm run dev --workspace @project/web
```

单独启动不会提供整组健康托管；若浏览器显示“后端连接已中断”，应先检查 `http://127.0.0.1:8099/api/health`，不要把 WebSocket 重连错误误判为 Agent 自身卡死。

后端启动时会从仓库根目录向上查找 `.env` 并加载未设置的变量；前端 Vite 配置也会从仓库根目录读取 `VITE_*` 变量。
未显式设置 `AGENT_CLUSTER_DATA_DIR` 或 `AGENT_CLUSTER_DATA_FILE` 时，文件持久化目录同样锚定到该 `.env` 所在的仓库根目录，不受 npm workspace 的当前工作目录影响。

常用真实数据验证命令：

```bash
npm run test:e2e:real-data-mode
npm run test:e2e:generic-llm-real
npm run test:e2e:postgres-persistence
npm run test:e2e:bullmq-ops
npm run test:e2e:real-agents-no-seed
```

其中 PostgreSQL 和 BullMQ smoke 会优先复用可连接的本机服务；不可连接时会临时启动 Docker 容器并在结束后清理。

## Migration 和 seed 建议

Backend Team 落地 migration 后，建议提供可重复执行的命令：

```bash
pnpm --filter @agent-cluster/server db:migrate
pnpm --filter @agent-cluster/server db:seed
```

DevOps 验收时至少确认：

- migration 可在空库执行成功。
- `CREATE EXTENSION IF NOT EXISTS vector` 已执行。
- 默认 Agent seed 可重复执行，不产生重复脏数据。
- 后端可以连接 PostgreSQL 和 Redis。

## 本地安全默认值

`.env.example` 默认使用真实 LLM 编排，但关闭真实高风险能力和 mock fallback：

- `ENABLE_HIGH_RISK_TOOLS=false`
- `ALLOW_FILE_WRITE_RUNTIME=false`
- `ALLOW_COMMAND_RUNTIME=false`
- `LLM_DRY_RUN=false`
- `LLM_MOCK_FALLBACK=false`
- `MOCK_RUNTIME_ENABLED=false`

只有在用户确认且运行时权限策略落地后，才应开启真实文件写入、命令执行、外部通知发送等能力。

后端默认使用 `CORS_ORIGIN` 作为跨域白名单，未配置时允许本地前端
`http://localhost:5173` 和 `http://127.0.0.1:5173`。API 响应会写入基础安全响应头：
`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY` 和
`Referrer-Policy: no-referrer`。

如需本地演示或跑 E2E mock 闭环，显式开启：

```bash
VITE_ENABLE_MOCKS=true
GLOBAL_DEFAULT_RUNTIME_TYPE=mock
RUNTIME_STREAMING=off
LLM_MOCK_FALLBACK=true
MOCK_RUNTIME_ENABLED=true
```

## Local Ollama runtime

The default local LLM runtime can use Ollama through its OpenAI-compatible API.
Start Ollama, pull a model, then configure:

```bash
ollama pull llama3.2
ollama serve
```

```env
GLOBAL_DEFAULT_RUNTIME_TYPE=generic_llm
RUNTIME_STREAMING=off
LLM_PROVIDER=ollama
LLM_MODEL=llama3.2
LLM_API_KEY=
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_DRY_RUN=false
LLM_MOCK_FALLBACK=false
VITE_ENABLE_MOCKS=false
```

For `LLM_PROVIDER=ollama`, the backend uses a local placeholder API key
internally because Ollama's OpenAI-compatible endpoint requires an API key
header but ignores its value. If Ollama is not running or the model has not
been pulled, the session fails visibly and writes an error event instead of
falling back to mock data.

## Real Agent workflow

When `AGENT_CLUSTER_SEED_DEFAULT_AGENTS=false`, built-in default Agents are
still visible through `GET /api/agents` and the UI Agent selector, but they are
not automatically written into the persisted `agents` collection. Create custom
Agents from the right Agent panel or through:

```bash
curl -X POST http://localhost:3000/api/agents \
  -H "content-type: application/json" \
  -d "{\"name\":\"Research Agent\",\"role\":\"Collects context\",\"tags\":[\"research\"],\"capabilityIds\":[\"cap-brief\"]}"
```

New sessions can be created with built-in default Agent ids or custom Agent ids:

```bash
curl -X POST http://localhost:3000/api/sessions \
  -H "content-type: application/json" \
  -d "{\"input\":\"Plan the task\",\"agentIds\":[\"<agent-id>\"],\"tokenBudget\":30000}"
```

The UI uses the built-in default Agents as the minimum available team, and shows
custom Agents alongside them when they exist.

## Context v2 cutover

`cutover:context-v2` 是破坏性数据切换工具。普通启动、build、test 和 Harness 都不会自动执行 apply。

至少配置：

```bash
AGENT_CLUSTER_PERSISTENCE_BACKEND=file
AGENT_CLUSTER_DATA_FILE=<absolute-path-to-the-exact-active-state-file>
AGENT_CLUSTER_DATA_DIR=<absolute-active-data-root>
AGENT_CLUSTER_CUTOVER_ENVIRONMENT=<local|test|production>
AGENT_CLUSTER_CUTOVER_TOKEN_SECRET=<one-time-token-signing-secret>
AGENT_CLUSTER_CUTOVER_ARCHIVE_KEY=<offline-archive-encryption-key>
AGENT_CLUSTER_CUTOVER_ARCHIVE_DIR=<absolute-path-outside-active-data-root>
AGENT_CLUSTER_CUTOVER_OPERATOR=<operator-id>
```

PostgreSQL 使用 `AGENT_CLUSTER_PERSISTENCE_BACKEND=postgres`、精确的 `DATABASE_URL` 和
`AGENT_CLUSTER_POSTGRES_COLLECTION_TABLE`。file 模式的 cutover CLI 不接受隐式默认文件，必须显式设置
`AGENT_CLUSTER_DATA_FILE`；不要把新默认的 `state.v3.json` 误当成旧进程实际使用的 `state.v2.json` 或 `state.v0.1.json`。

真实切换顺序固定如下：

1. 从当前 `/api/health` 记录 PID、commit、backend、location 和 dataEpoch，并确认浏览器实际连接的地址。
2. 对所有服务副本调用 `POST /api/ops/maintenance/enter`，检查返回的
   `cancellationTimedOutSessionIds` 为空；同时 drain/pause 外部 BullMQ worker、定时任务和入口流量。
3. 停止所有后端、worker 和 Browser Broker 副本，确认没有进程继续写活动数据源。
4. 为独立 CLI 设置 `AGENT_CLUSTER_MAINTENANCE_MODE=true` 和
   `AGENT_CLUSTER_CUTOVER_QUIESCED=true`。该声明只能在上一步由操作者实际核验后设置。
5. 对精确绑定的数据源执行 dry-run，审核 inventory、revision、关系完整性、Artifact 清理计划和归档位置。
6. 使用该次 dry-run 返回的 token 执行 apply；不要在两步之间修改活动数据。
7. 启动新服务，核对新 PID/commit、`pipelineVersion=v2`、`dataSchemaVersion=3`、新 dataEpoch、空 Session 列表及归档 hash。

维护入口示例（每个副本分别执行）：

```bash
curl -X POST http://127.0.0.1:8099/api/ops/maintenance/enter \
  -H "content-type: application/json" \
  -H "x-maintenance-token: $AGENT_CLUSTER_MAINTENANCE_TOKEN" \
  -d '{"reason":"context-v2-cutover","requestedBy":"<operator-id>"}'
```

完成 quiesce 后，在明确指定的数据源上执行 dry-run：

```bash
npm run cutover:context-v2 -- --dry-run
```

审核 inventory、backend、revision、environment、活动数据位置、外部归档目录和一次性 token 后，仍需单独取得真实数据切换授权，才能执行：

```bash
npm run cutover:context-v2 -- --apply --confirm <dry-run-token>
```

apply 先原子写入 AES-256-GCM 加密只读归档及 manifest，再替换活动 state。归档必须位于活动数据根之外，不会被 Session API、Recovery 或 Resume 加载；旧会话只能离线审计，不能恢复运行。

活动 state 替换后，审计先写为 `cleanup_pending`；受控 Artifact 清理完成后再原子更新为 `applied`。若清理中断，使用同一 token 重试会先校验归档密文/hash/长度并继续未完成清理，不会重新开放旧 Session。

未获得该授权时，不得对当前 file/PostgreSQL 数据执行 apply；“所有旧数据不兼容”的产品决策不等于一次具体删除操作已经获批。

### Runtime 输出合同启动检查

Runtime 输出合同位于 `packages/shared/src/runtime-contracts/`。后端模块加载时会运行 `assertRuntimeContractsReady()`，验证七类 `1.0` Schema 的 Strict Structured Outputs 约束、示例和稳定 hash。失败时后端不得带病接收 Runtime 任务。

发布前至少执行：

```bash
npm run typecheck
npm run test
npm run test:harness
npm run build
```

通过 `GET /api/sessions/:sessionId/debug/runtime-invocations` 核对每次调用的 `outputContract.contractId`、`contractVersion`、`schemaHash`。内部 Codex/Claude 通知应出现在 `runtimeDiagnostics`，但不得出现在聊天时间线。

真实 Codex 验收属于可能产生费用的外部调用，必须先取得当次明确授权，再设置 `RUN_REAL_CODEX_ACCEPTANCE=1` 执行 `npm run test:e2e:real-codex-acceptance`。`probe` 模式可用 `REAL_CODEX_ACCEPTANCE_RUNS` 显式限制调用次数；默认仍为 3。验收同时检查 `turn/start` 接受 Strict Schema、最终 `item/completed` 输出通过同源 validator、Token/CLI session/stream metrics 均有效。

## 稳定后端与 Watch 边界

需要验证业务文件修改不会触发平台重启时，使用编译产物入口：

```bash
npm run start:server:stable
```

该命令先构建 shared/server，再运行 `dist/apps/server/src/main.js`，不启用源码 Watch。通过 `GET /api/health` 记录 `processId` 和 `startedAt`；修改会话绑定的业务目录后，这两个值都应保持不变。

开发入口 `npm run dev` 的后端 Watch 只覆盖 `apps/server/src` 和 `packages/shared/src`。每次触发会记录具体文件路径、watcher PID 和 watcher `startedAt`，业务工作区、Browser Mirror 和 `dist` 不属于 Watch 根目录。

## Local Runtime CLI 内部预览

当前 CLI 是 Windows + Codex/Claude Code 的 npm workspace 内部预览版。先构建：

```powershell
npm run build -w @agent-cluster/shared
npm run build -w @agent-cluster/local-runtime-cli
$runtimeCli = 'packages/local-runtime-cli/dist/local-runtime-cli/src/cli.js'
node $runtimeCli version
```

本仓库开发环境直接运行：

```powershell
npm run dev
```

开发 supervisor 会同时启动 Server、Web 和 Local Runtime CLI。回环地址启用开发管理员豁免时，CLI 会自动取得本机设备令牌，不要求开发者先执行 `agent-runtime login`。创建会话并选择“本机 Runtime”后，点击“选择本机目录”，平台会通过已连接的 CLI 打开操作系统目录选择器；目录绝对路径只写入 CLI 本地状态，浏览器和平台后端只接收 `workspaceId` 并自动选中新工作区。

单独运行 CLI 或非回环部署仍保留显式设备码绑定流程：

```powershell
node $runtimeCli login --server https://agent.example.com
node $runtimeCli start
```

`login` 会显示一次性设备码和激活页面。浏览器打开该页面并确认后，CLI 才能取得设备令牌。开发 supervisor 会在没有显式值时把 `PUBLIC_WEB_URL` 设置为当前 Web 地址；单独启动稳定后端或服务器部署时必须配置实际可访问的前端地址，例如：

```env
PUBLIC_WEB_URL=https://agent.example.com
LOCAL_RUNTIME_MIN_CLI_VERSION=0.1.0
LOCAL_RUNTIME_ADMIN_TOKEN=<random-value-with-at-least-32-characters>
```

Local Runtime 的设备审批、设备管理和工作区列表使用单用户管理员令牌。生产环境必须配置 `LOCAL_RUNTIME_ADMIN_TOKEN`，否则后端拒绝启动。浏览器激活页面会在当前标签页会话中保存该令牌，并以 Bearer Token 调用管理接口。开发环境如需免输入令牌，只能显式设置 `LOCAL_RUNTIME_ALLOW_LOOPBACK_ADMIN_BYPASS=true`，且该豁免只接受回环地址，在生产环境会导致启动失败。

服务器端 Codex/Claude invocation 始终使用独立 Worker 子进程；不存在关闭 Worker 后回退到 Nest 进程内执行的开关。Worker 仅继承 Runtime 启动所需的系统变量、Runtime 配置和明确的 Runtime 凭据，不继承数据库、平台管理员或平台加密密钥。

创建会话时选择“本机 Runtime”，可直接点击“选择本机目录”新增并选中工作区，也可选择 CLI 已注册且在线的工作区。平台只保存 `workspaceId`，本地绝对路径只存在于 CLI 状态文件：Windows 默认位于 `%LOCALAPPDATA%\agent-runtime\state.json`，可用 `AGENT_RUNTIME_STATE_FILE` 覆盖以进行隔离测试。

Local Runtime CLI 会通过 Adapter Registry 探测并上报本机实际可用的 Codex 与 Claude Code。工作区连接后，浏览器会按照设备上报的 `runtimeTypes` 自动启用对应选项，不要求用户先在浏览器填写命令路径。Windows 下 Claude Code 默认从 PATH 中的 `claude.exe` 探测；若 npm 只暴露 `claude.cmd`，CLI 会解析其同级安装目录中的 `node_modules/@anthropic-ai/claude-code/bin/claude.exe`。也可以显式指定：

```powershell
$env:AGENT_RUNTIME_CLAUDE_COMMAND='C:\path\to\claude.exe'
# 可选：仅在需要限制 Claude 单次调用费用时设置；不设置则不传费用上限。
$env:AGENT_RUNTIME_CLAUDE_MAX_BUDGET_USD='5'
npm run dev
```

Claude 本机适配器使用 `stream-json`、Runtime 输出 JSON Schema、严格 MCP 配置和受控 Tool 列表；执行仍发生在临时 staging 目录，文件只能通过 ChangeSet 写回授权工作区。它通过 `--setting-sources user` 只加载用户级设置以保留 Claude Code 的 OAuth/系统凭据发现，不加载项目或工作区本地设置；同时 Local Runtime 子进程不会继承 `ANTHROPIC_API_KEY` 等 API 密钥环境变量。若用户的 Claude Code 只依赖环境变量 API Key，需要先改为 CLI 自身支持的登录/凭据方式。`AGENT_RUNTIME_CLAUDE_ARGS_JSON` 仅用于自动化 Fixture/兼容性诊断，不应作为日常配置入口。

权限管理示例：

```powershell
node $runtimeCli workspace grant <workspace-id> workspace_delete
node $runtimeCli workspace grant <workspace-id> dependency_install
node $runtimeCli workspace reset-permissions <workspace-id>
node $runtimeCli workspace revoke <workspace-id>
node $runtimeCli revoke device
```

默认允许授权工作区内读取、创建/修改、测试和执行普通命令。删除或移动文件、安装依赖等危险动作会让会话暂停并在界面中请求用户确认；选择“仅本次允许”后，CLI 只为下一次对应操作发放一次性权限，然后自动恢复为需要确认。旧版工作区在 CLI 重启并加载状态时，会自动把遗留的 `command_execute: confirm` 迁移为默认允许。

上面的 `workspace grant` 命令仍可用于本地诊断或手工预授权。危险命令、工作区外路径、符号链接逃逸和凭据路径始终拒绝，不能通过一次性确认放行。本地 Runtime 离线或不兼容时会明确失败，不会切换到服务器 Runtime。

### 为什么界面仍可能出现旧会话

以下任一条件都会让旧会话继续可见，清理方案文档本身不会改变运行状态：

1. cutover 只做了 dry-run，未对界面实际连接的数据源执行 apply。
2. 旧后端进程仍在监听端口，前端仍请求该进程。
3. 新进程使用了另一份 `AGENT_CLUSTER_DATA_FILE / AGENT_CLUSTER_DATA_DIR / PostgreSQL table`。
4. 前端和后端 commit/pipeline/schema 不一致。
5. 真实 apply 绑定了错误的 file 路径、PostgreSQL 数据库或 collection table。

使用 `GET /api/health` 核对 `processId`、`startedAt`、`commit`、`pipelineVersion`、`dataSchemaVersion`、`dataEpoch`、`persistenceBackend` 和 `persistenceLocation`。前端在 pipeline/schema 不匹配，或配置 `VITE_AGENT_CLUSTER_COMMIT` 后 commit 不匹配时，会清空本地会话状态并禁止所有会话读写操作。停止旧进程、实际 cutover 和部署都属于独立高风险步骤，不能由普通启动或测试隐式执行。
