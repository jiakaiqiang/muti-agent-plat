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

- `DEFAULT_AGENT_RUNTIME_TYPE=generic_llm`
- `LLM_PROVIDER=openai-compatible`
- `LLM_MODEL=gpt-4.1-mini`
- `LLM_API_KEY=<your api key>`
- `LLM_BASE_URL=https://api.openai.com/v1`
- `LLM_DRY_RUN=false`
- `LLM_MOCK_FALLBACK=false`
- `VITE_ENABLE_MOCKS=false`
- `AGENT_CLUSTER_PERSISTENCE_BACKEND=postgres`
- `AGENT_CLUSTER_SEED_DEFAULT_AGENTS=false`
- `ENABLE_BULLMQ=true`

如果缺少 `LLM_API_KEY` 或 `LLM_BASE_URL`，后端会使用受控 mock fallback 生成结构化任务契约，保证本地群聊输入能得到反馈。配置了真实模型连接但模型请求失败时，后端仍会把运行失败写入事件流，方便定位真实 LLM 问题。

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
- `QUEUE_CONCURRENCY`

队列命名建议与系统设计保持一致：

- `agent-discussion-queue`
- `agent-task-queue`
- `runtime-invocation-queue`
- `rag-indexing-queue`
- `notification-queue`
- `post-review-queue`

启用 `ENABLE_BULLMQ=true` 后，`GET /api/ops/queues` 会连接 Redis/BullMQ 并返回每个队列的 `waiting`、`active`、`completed`、`failed` 数值。未启用时该接口仍返回 disabled 状态，方便本地无 Redis 时启动后端。

## 应用启动建议

建议本地启动顺序为：

```bash
docker compose up -d postgres redis
npm install
npm run dev --workspace @agent-cluster/server
npm run dev --workspace @project/web
```

后端启动时会从仓库根目录向上查找 `.env` 并加载未设置的变量；前端 Vite 配置也会从仓库根目录读取 `VITE_*` 变量。

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
DEFAULT_AGENT_RUNTIME_TYPE=mock
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
DEFAULT_AGENT_RUNTIME_TYPE=generic_llm
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
