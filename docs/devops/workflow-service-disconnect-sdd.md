# 工作流执行期间服务断连 SDD

状态：已实现
日期：2026-08-19

## 1. 问题与证据

工作流运行期间会连续产生工具事件。旧实现每新增一个事件，都把当前进程中的全部 `eventsBySession` 重新序列化，并在 PostgreSQL 中逐条重写全部历史 `collaboration_events`，同时逐条尝试插入 `event_outbox`。

故障样本中有 5,358 条事件、约 6.7 MB 事件载荷，却产生了 1,593,749 次 `collaboration_events` 更新和约 1.6 GB PostgreSQL 临时数据。后端事件循环和数据库回调长时间拥塞，1.5 秒健康探针连续超时 60 秒后，开发 supervisor 按设计以退出码 1 关闭前后端进程组。退出码 1 是保护动作，不是根因。

Local Runtime 在服务离线重连时还会为同一个 `AbortSignal` 持续累积监听器，最终产生 `MaxListenersExceededWarning`。它会放大离线日志噪声，但不是前后端断开的首要原因。

## 2. 设计合同

### SPEC-PERSIST-001：事件增量持久化

- `EventsService.create()` 只提交本次新建的单个事件，不再提交完整事件集合。
- PostgreSQL 在同一个事务中锁定目标 Session、分配严格递增的 `session_seq`、插入一条 `collaboration_events`，并插入一条 `event_outbox`。
- 事件插入使用 `external_id` 幂等，Outbox 插入使用 `idempotency_key` 幂等。
- 单事件追加不得更新任何历史 `collaboration_events`。
- 事务提交成功后才向 SSE 发布；发布成功后把对应 Outbox 标为 `published`。
- 文件后端保留原子状态文件写入兼容行为。

### SPEC-HEALTH-001：readiness 与 liveness 分离

- `GET /api/health` 是 readiness，负责构建版本、数据 epoch 和持久化配置合同。
- `GET /api/live` 是轻量 liveness，只证明 Nest 进程和事件循环能够响应，不访问持久化或构建状态。
- 开发 supervisor 只在首次就绪前使用 readiness，之后使用 liveness。
- 连续失败日志必须包含探针类型、次数、原因和耗时；首次 readiness 超时或已就绪后的 liveness 连续丢失 60 秒时，仍以退出码 1 关闭整个进程组。

### SPEC-RECOVERY-001：重启恢复边界

- `event_outbox` 与事件在同一事务中提交；服务在发布前退出时，重启后可认领 `pending` 或租约已过期的记录并重新发布。
- 已软删除 Session 的历史事件不再对外发布；恢复 worker 将其 Outbox 标为 `discarded` 并清除租约，避免每次重启重复认领。
- 运行时恢复继续以已有的“存在 `runtime_started` 且不存在终态事件”为中断判据。本次不增加第二套 invocation 运行态真相源。
- Outbox 是事务性发件箱：先把“需要发布的事件”与业务事实一起可靠落库，事务提交后再投递；它避免“数据库成功但消息丢失”或“消息已发但数据库回滚”的双写窗口。

### SPEC-CLI-001：重连监听器有界

- 每次重连等待成功、失败或取消后，都必须移除对应 Abort 监听器。
- 已取消的 signal 立即失败，不注册新监听器。

## 3. 验收

代码级验收：

```powershell
npx tsx --test --tsconfig apps/server/tsconfig.json `
  apps/server/src/modules/events/events.service.spec.ts `
  apps/server/src/modules/persistence/relational/relational-state-store.spec.ts `
  apps/server/src/modules/ops/ops.controller.spec.ts
npm run test -w @agent-cluster/local-runtime-cli
npm run test:dev-supervisor
```

运行时验收：

```powershell
Invoke-RestMethod http://127.0.0.1:8099/api/live
Invoke-RestMethod http://127.0.0.1:8099/api/health
```

工作流压测前记录统计快照，执行事件流压测后取差值。增量路径的历史事件更新数必须为 0，新事件数与新 Outbox 数必须一一对应：

```sql
select relname, n_tup_ins, n_tup_upd
from pg_stat_user_tables
where schemaname = 'agent_cluster'
  and relname in ('collaboration_events', 'event_outbox');

select
  count(*) filter (where status = 'pending') as pending,
  count(*) filter (where status = 'publishing') as publishing,
  count(*) filter (where status = 'published') as published,
  count(*) filter (where status = 'discarded') as discarded
from agent_cluster.event_outbox;
```

故障注入验收：在事件事务提交后、SSE 发布前终止后端，重启后该事件只能存在一条，Outbox 最终必须进入 `published`，不得生成重复时间线事件。

## 4. 非目标

- 不把 Harness Engineering 产品化为业务模块。
- 不改变工作流编排状态机或 Runtime 输出合同。
- 不用更长的 supervisor 容忍时间掩盖持续拥塞。
- 不在本次修改中引入新的 Runtime invocation 运行态真相源。
