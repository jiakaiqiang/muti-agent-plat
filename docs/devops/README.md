# DevOps 骨架说明

本目录记录本地开发、CI、发布和基础运维约定。当前仓库处于并行开发初期，DevOps 骨架只覆盖基础设施和流程文档，不修改 `apps/server/src`、`apps/web/src` 或 `docs/contracts`。

## 当前交付

- 根目录 `docker-compose.yml`：提供 PostgreSQL、Redis，本地 PostgreSQL 镜像使用 `pgvector/pgvector:pg16`，预留 RAG 向量检索能力。
- 根目录 `.env.example`：覆盖前端、后端、数据库、Redis、BullMQ、LLM Runtime、RAG、Memory、Feishu mock 和高风险能力开关。
- 根目录 `.gitignore`：覆盖 Node、构建产物、环境文件、日志、测试报告和本地运行数据。
- `docs/devops/local-development.md`：本地启动与常见操作说明。
- `docs/devops/ci-release-checklist.md`：CI、发布和回滚 checklist。

## package.json 建议

当前任务要求不实际修改根 `package.json`。后续建立 monorepo 时，建议根脚本保持薄封装：

```json
{
  "scripts": {
    "dev": "concurrently \"pnpm --filter @agent-cluster/server dev\" \"pnpm --filter @agent-cluster/web dev\"",
    "dev:infra": "docker compose up -d postgres redis",
    "dev:down": "docker compose down",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "build": "pnpm -r build"
  }
}
```

如果后续不使用 pnpm workspace，可将脚本替换为 npm workspace 或各 app 目录内脚本。
