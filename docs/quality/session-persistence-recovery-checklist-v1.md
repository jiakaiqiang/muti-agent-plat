# 群聊持久化与恢复 Checklist v1

当前状态：2026-09-14 完成实现、自动验证和代码审查。实际用户会话未重跑；以下结论不等于真实模型全流程已完成。

| 条件 | 验证 | 结果 |
| --- | --- | --- |
| AC1–2 | 真实 PostgreSQL 操作预留与事件/outbox/普通集合并发 | 通过；在线三类调用点不再使用全局 CAS |
| AC3 | 延迟事务期间插入新事件/修改会话，检查缓存及数据库 | 通过；覆盖排队前、事务等待中、本地连续提交和另一进程新增记录 |
| AC4 | 独立连接重复预留、重复回执、回滚、重试上限 | 通过；并发预留仅一次成功，未知停止仍阻止启动；40001/40P01 最多 3 次，业务错误不重试 |
| AC5 | FAILED 契约生成恢复、重复确认、已有契约执行恢复 | 通过；另覆盖旧缺失契约死端、已有旧契约的修订失败、文本继续和过期卡片 |
| AC6 | 正常结束不通知、未确认停止只通知一次 | 通过；覆盖并发重复回执、错误设备绑定、重复 ack 路径 |
| AC7 | 全局 CAS 拒绝旧版本、file 持久化失败不污染缓存 | 通过；真实 PostgreSQL 旧全局版本拒绝、文件事务写入失败回滚、fileRevisions 独立 CAS 回归 |
| AC8 | 定向单测、PostgreSQL、类型检查、构建 | 通过；具体命令和环境限制如下 |

真实用户会话：不自动重跑。数据/设备/目录权限保持原样；未经验证不声称真实模型全链路成功。

## 可复核证据

- `npm run test -w @agent-cluster/server`：主测试 1291 通过、0 失败、7 跳过；开发启动脚本测试 7/7 通过。7 个跳过包含未设置测试连接时跳过的 6 个 PostgreSQL 测试（已另行全部执行），以及 Windows 不允许创建符号链接的 1 个既有测试。
- `node scripts/test-session-persistence-postgres.mjs`：6/6 通过。创建独立数据库 `agent_cluster_sdd_test_47800_1789380736631`，验证结束仅删除该数据库；未写业务数据库。测试包含独立 PersistenceService/Pool 竞争及重新构造进程状态后的停止屏障，未调用真实模型。
- Sessions 定向回归：67/67 通过，包括全量回归后补充的“已有旧契约的 brief_revision 失败通过文本继续”用例。
- 双端共享会话组件与 store 定向回归：`npm run test -w @project/web -- src/stores/session-version-gate.spec.ts src/components/SessionWorkspace.spec.ts`，13/13 通过。
- `npm run typecheck`：整个 workspace 通过，包含 server、shared、local-runtime-cli、desktop 和 Web。
- `npm run build -w @agent-cluster/server`：通过。
- `npm run test:harness`：通过。
- 本次实现相关文件 `git diff --check`：通过（按 Windows CRLF 规则检查）。

关键测试文件：`persistence-scoped-mutation.spec.ts`、`state-delta.spec.ts`、`postgres-migration-runner.integration.spec.ts`、`sessions.service.spec.ts`、`local-runtime-connection.service.spec.ts`、`logical-operation-store.spec.ts`。双端继续操作均调用共享 `sessionStore.resumeSession` 与后端 `/sessions/:id/resume`，返回的 session 结构保持兼容。

## 交付边界

本次只修改后端行为、测试和合同，未改变 Web/桌面样式。未主动重启现有服务或调用用户历史任务。加载新后端代码后，两端共同生效。集合级串行和复合配置加载仍有进一步性能优化空间；本修复消除已确认的持久化/恢复缺陷，不承诺外部模型不再超时。
