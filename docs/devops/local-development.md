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

## Redis 和 BullMQ

Redis 默认开启 AOF：

```text
redis-server --appendonly yes
```

后端 BullMQ 建议使用 `.env` 中的：

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

## 应用启动建议

本任务不修改根 `package.json`。后续 app 结构落地后，建议本地启动顺序为：

```bash
docker compose up -d postgres redis
pnpm install
pnpm --filter @agent-cluster/server dev
pnpm --filter @agent-cluster/web dev
```

如果最终 package name 不同，请以各团队实际 package 名为准。

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

`.env.example` 默认关闭真实高风险能力：

- `ENABLE_HIGH_RISK_TOOLS=false`
- `ALLOW_FILE_WRITE_RUNTIME=false`
- `ALLOW_COMMAND_RUNTIME=false`
- `LLM_DRY_RUN=true`
- `MOCK_RUNTIME_ENABLED=true`

只有在用户确认且运行时权限策略落地后，才应开启真实文件写入、命令执行、外部通知发送等能力。
