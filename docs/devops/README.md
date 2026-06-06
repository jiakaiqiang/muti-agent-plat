# DevOps 骨架说明

本目录记录本地开发、CI、发布和基础运维约定。当前仓库处于并行开发初期，DevOps 骨架优先覆盖基础设施、流程文档、CI 门禁和轻量观测入口。

## 当前交付

- 根目录 `docker-compose.yml`：提供 PostgreSQL、Redis，本地 PostgreSQL 镜像使用 `pgvector/pgvector:pg16`，预留 RAG 向量检索能力。
- 根目录 `.env.example`：覆盖前端、后端、数据库、Redis、BullMQ、LLM Runtime、RAG、Memory、Feishu mock 和高风险能力开关。
- 根目录 `.gitignore`：覆盖 Node、构建产物、环境文件、日志、测试报告和本地运行数据。
- `.github/workflows/ci.yml`：执行安装、typecheck、build、主链 E2E、P1 行为 E2E、mock-free 前端检查、真实 LLM 兼容烟测、PostgreSQL 持久化 smoke、BullMQ ops smoke 和真实模式 Agent 不自动 seed 检查。
- `docs/devops/local-development.md`：本地启动与常见操作说明。
- `docs/devops/ci-release-checklist.md`：CI、发布和回滚 checklist。
- `GET /api/health`：服务健康检查。
- `GET /api/ops/queues`：BullMQ 队列观测入口；启用 `ENABLE_BULLMQ=true` 时从 Redis/BullMQ 读取真实 job counts，未启用时返回 disabled 状态。
- `GET /api/sessions/:sessionId/debug/*`：开发态调试入口，覆盖 Context Pack、Runtime invocation、RAG retrieval 和 token usage。
- 后端启动默认按 `CORS_ORIGIN` 收敛跨域白名单，并为 API 响应写入基础安全响应头。
- `LOG_FORMAT=json`：启用服务端 JSON 结构化日志。

## package.json 脚本

根脚本保持薄封装，调用 workspace 内部脚本：

```json
{
  "scripts": {
    "dev": "npm run dev --workspaces --if-present",
    "build": "npm run build --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test:e2e:main-chain": "node tests/e2e/run-main-chain.mjs",
    "test:e2e:p1-behaviors": "node tests/e2e/run-p1-behaviors.mjs",
    "test:e2e:ops": "node tests/e2e/ops-smoke.mjs",
    "test:e2e:security": "node tests/e2e/security-smoke.mjs",
    "test:e2e:real-data-mode": "node tests/e2e/real-data-mode-smoke.mjs",
    "test:e2e:generic-llm-real": "node tests/e2e/generic-llm-real-smoke.mjs",
    "test:e2e:postgres-persistence": "node tests/e2e/postgres-persistence-smoke.mjs",
    "test:e2e:bullmq-ops": "node tests/e2e/bullmq-ops-smoke.mjs",
    "test:e2e:real-agents-no-seed": "node tests/e2e/real-agents-no-seed-smoke.mjs",
    "test:e2e:debug-memory": "node tests/e2e/debug-memory-smoke.mjs",
    "test:e2e:persistence": "node tests/e2e/persistence-smoke.mjs"
  }
}
```
