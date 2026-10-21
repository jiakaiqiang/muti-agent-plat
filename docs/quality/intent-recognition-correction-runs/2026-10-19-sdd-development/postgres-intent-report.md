# 意图事务 PostgreSQL 验证与准入错误修复

Run ID：`SDD-2026-10-20-postgres-intent`。依据四件套中的 IR02、IR07.4、IR08.3/4、IR09.4 及事务一致性要求。整个专项仍在实施。

## 当前结果

以本机已有的 PostgreSQL 16.13 镜像启动独立临时数据库，实际运行原来跳过的 21 项数据库集成测试，并新增 4 项新语义事务测试。最终 **25 通过、0 失败、0 跳过**；自动创建新数据库的复现脚本再次取得同样结果。没有使用项目生产连接或改动 `.env`。

本轮修复 `LogicalOperationStore.reserve` 校验顺序：先返回会话生命周期准入错误，再检查意图版本。两层检查仍在同一个预约事务中，并且都先于次数消耗和 invocation 预约。删除中的会话继续返回既有 `SESSION_ADMISSION_CLOSED`；不会被新增意图检查改成 `INTENT_EXECUTION_STALE`。原数据库测试断言保持不变。

## 新增数据库效果验证

| 场景 | 实际断言 |
| --- | --- |
| 独立连接同时确认 | 第一连接持有分类租约；同选请求得到处理中，反选得到冲突；随后重放成功。只分类一次、只新增一个任务、保存两个版本和一个收据/解决事件/Outbox |
| 确认写入失败 | PostgreSQL BEFORE INSERT trigger 拒绝目标会话的 resolution receipt；WorkItem、版本、step、解决事件和 Outbox 全部回滚；路由保持 blocked |
| 两个纠错 planner 竞争 | 独立 PersistenceService/连接共同处理一条纠错，模型只调用一次；旧 10 分钟约束替换为 30 分钟，requirement revision 只递增一次，释放对应屏障且 Session 仍为 PAUSED |
| 纠错激活写入失败 | PostgreSQL trigger 拒绝新版本记录；旧约束仍有效，旧 requirement revision 不变，屏障保留，没有新 step/applied 事件/Outbox |

这些是实际 SQL 事务与独立连接测试。模型是确定性 service fixture；服务重建是新 PersistenceService 重新加载，不等于独立操作系统进程崩溃恢复。原 21 项另覆盖迁移幂等/注释、并发状态更新、停止收据、删除恢复、预算、摘要和路由历史等；具体名称见日志。

## 验证证据

| 命令/范围 | 结果 | 文件 |
| --- | --- | --- |
| 3 个 PostgreSQL integration suites，顺序运行 | 25/25；无跳过 | `postgres-intent-complete.log` |
| `node tests/evaluation/run-intent-postgres-sdd.mjs` | 新临时数据库重现 25/25；退出码 0 | `postgres-intent-repro.log`、`postgres-intent-repro.json`、`postgres-intent-runner.log` |
| LogicalOperation、纠错接收/激活、新澄清 File 相关回归 | 65/65；退出码 0 | `postgres-intent-file-regression.log` |
| Server 类型检查 | 退出码 0，新增 SQL 回滚场景前的源码 | `postgres-intent-typecheck.log` |
| 最终 Server 构建 | 退出码 0，覆盖全部新增测试 | `postgres-intent-build.log` |
| Harness / diff | 退出码见 manifest | `postgres-intent-harness.log`、`postgres-intent-diff-check.log` |
| 临时环境回收 | 复现容器已删除；本轮标签无残留容器 | `postgres-intent-repro.json`、`postgres-intent-cleanup.json` |

原始失败保留：`postgres-intent-baseline.log` 为 20 通过、1 错误合同失败；`postgres-intent-transactions-first.log` 为新 fixture 的触发条件未命中和缺 routing revision 默认值，修正后 `postgres-intent-transactions-second.log` 3/3。最终第四个场景和反选竞争均在两次 25/25 中覆盖。不把重复运行累加为独立用例数。

自动脚本只使用已有镜像，记录 image digest，绑定 loopback 随机端口；不读取生产数据库配置。清理前核对精确容器 ID、名称、任务标签，再删除该容器及其匿名卷。数据库测试结束时故障注入 trigger 数量为 0，迁移记录为 23。

## 范围与后续

补齐了原先缺失的真实 PostgreSQL 局部证据，不代表整个 backend/client/runtime 矩阵完成。尚未验证 PostgreSQL 上的真实模型 HTTP 全链路、实际测试执行器的数据库矩阵、跨进程中途崩溃、迁移副本混合 worker、双客户端乱序、源码/报告执行器和独立准确率评测。未重新运行全仓测试；本轮仅改预约校验顺序和测试脚本，针对性 File/SQL 回归及 Server 构建已通过。

下一实现依赖仍包括报告/源码效果执行。检查代码发现 `ArtifactsService` 使用实例缓存和整集合持久化；新增事务内报告写入前需要先处理与既有创建路径的状态一致性，避免新报告被旧缓存覆盖。该部分本轮只做了源码定位，没有宣称已经修复。
