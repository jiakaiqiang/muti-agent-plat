# CI 与发布 Checklist

## CI 基线

每次 PR 或主干合并前建议执行：

- 安装依赖：锁文件必须存在且可复现安装。
- Lint：前端、后端、测试代码全部通过。
- Typecheck：TypeScript 类型检查通过。
- Unit tests：核心模块单元测试通过。
- Contract tests：API、Event、Runtime、Data contract 相关测试通过。
- Integration tests：PostgreSQL、Redis、BullMQ 相关集成测试通过。
- Build：前端和后端均可生产构建。
- E2E smoke：至少覆盖创建会话、生成任务契约、确认执行、dry-run 执行、最终交付链路。

建议 CI 阶段：

```text
install -> lint -> typecheck -> unit-test -> contract-test -> integration-test -> build -> e2e-smoke
```

## CI 环境服务

CI 中需要启动：

- PostgreSQL 16 with pgvector
- Redis 7

数据库初始化要求：

- 空库可执行全部 migration。
- pgvector 扩展已启用。
- seed 可重复执行。

Redis 验收要求：

- BullMQ 能创建 queue、添加 job、消费 job。
- 队列前缀使用 `BULLMQ_PREFIX`，避免 CI 并发污染。

## 发布前 Checklist

- `.env.example` 包含新增配置项，且无真实密钥。
- 数据库 migration 已 review，包含回滚或补救说明。
- 新增队列、worker、定时任务已记录。
- 新增外部依赖已记录超时、重试、降级策略。
- 高风险能力默认关闭，开启需要用户确认或环境级开关。
- Runtime、RAG、Memory、Capability 调用均有结构化日志或审计记录。
- SSE 或实时连接断线重连路径已通过 smoke test。
- 前端构建产物可部署，后端健康检查可通过。
- 版本说明包含功能变更、配置变更、数据变更、已知风险。

## 发布验证

发布后至少验证：

- `GET /health` 或等价健康检查返回成功。
- 后端可连接 PostgreSQL 和 Redis。
- migration 版本与发布版本一致。
- 前端可加载并访问 API。
- 创建会话链路可完成一次 dry-run。
- Redis 队列无持续堆积。
- 错误日志、Runtime invocation log、RAG retrieval log 可检索。

## 回滚 Checklist

- 确认是否包含不可逆数据库变更。
- 若包含数据迁移，先执行备份或确认已有快照。
- 回滚应用版本。
- 回滚或补偿配置项。
- 检查 worker 是否重复消费旧版本 job。
- 检查 Redis pending/delayed/failed job。
- 验证核心链路恢复。

## 观测建议

v1 至少记录以下指标或日志：

- API 请求耗时和错误率。
- SSE 连接数、断开次数、重连次数。
- Queue job started/completed/failed/retried。
- Runtime invocation status、耗时、token 估算、成本估算。
- RAG retrieval query、命中数量、top score。
- Token budget preflight 和超预算事件。
- 用户确认、高风险能力请求、外部通知 draft/send 事件。
