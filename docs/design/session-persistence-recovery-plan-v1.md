# 群聊持久化与恢复 Plan v1

依据 [Spec](../product/session-persistence-recovery-spec-v1.md)，遵循项目 Harness 协议。

## 决策

新增受集合范围约束的在线事务接口：排序获取集合锁，在事务内读取最新持久化状态，将声明的集合交给同步纯 mutator，提交实际变化。普通写入使用相同锁，并将本地前后差量应用于数据库最新值。所有业务写事务持有维护锁的共享侧，维护全局变更持有独占侧，防止两类路径穿透。

运行时操作仅锁 logicalOperationsBySession；调用日志仅锁 runtimeInvocationsBySession；Context 声明其读取/写入集合（包含 sessions、tasks、events/outbox 和 Context 相关集合）。同一集合第一版串行，避免引入未经验证的行级锁或 schema 迁移；不持锁等待模型或网络。

差量处理以对象字段、稳定记录 ID 为单位（id / invocationId / idempotencyKey），保留数据库并发新增记录；没有稳定 ID 的数组作为整体值。只应用调用者实际修改的字段。缓存刷新把等待期间本地差量叠加到已提交结果，不整份替换 state。规范化通过数据库读取后的业务投影完成，在线路径不再以 null/缺省差异比较全库 hash；维护 CAS 保持原语义。

仅 SQL serialization/deadlock 等可判定瞬时冲突有限退避，记录集合与尝试次数，无敏感业务正文。业务校验错误不重试，mutator 不得触发模型/文件写入。

resume 在通用 EXECUTING 分支之前检查失败检查点/缺少契约，复用 retryFailedSession；旧版误入 WAIT_USER_DECISION 且原因为缺少契约的情况按事件证据恢复。保留工作流用户决策、停止屏障、显式确认和已完成检查点。

停止回执区分“持久化结束事实”和“待停止已确认通知”。通知必须基于结束前确实存在未确认/请求中的停止，重复 ack 保持幂等。

## 顺序与风险

1. 添加复现测试（数据差量、PostgreSQL 并发、恢复入口、回执通知）。
2. 实现在线事务与所有相关写入锁，迁移三个业务调用点，保留维护 API。
3. 修复阶段恢复和通知语义。
4. 执行定向单测、真实隔离 PostgreSQL、类型检查和构建；必要时扩大到后端回归。
5. 更新合同与 checklist 证据。是否重启实际服务需检查当前活动任务；不自动执行历史模型任务。

核心风险：锁顺序死锁、带副作用的回调、稳定 ID 合并误删除、Context 读集合遗漏、继续绕过业务决策。通过排序锁、同步回调合同、合并单测、限制集合接口及恢复测试控制。

## 实现落点与审查结论

- persistence：新增 `state-delta.ts` 和 `mutateCollections`；普通写入保存待提交差量，事务完成只合并对应缓存。事件待提交差量仅包含新增事件。
- relational-state-store：共享维护锁、排序集合锁、定向 Runtime/Context 读取；复合配置读取保留原加载器回退。集合内仍按原投影规则写入，暂未引入行级事务或增量 schema。
- logical-operation-store / runtime.service / context-management：在线路径迁移完成；legacy-workitem-migration 保留全局 CAS。
- sessions：卡片与明确继续命令共用恢复入口；添加失败阶段选择、重复确认幂等、陈旧确认拒绝及旧缺失契约状态恢复。
- local-runtime：在事务内匹配和结束调用；通知基于真实待停止状态，普通结束回执仍正常确认。

验证仅使用测试 fixture、临时文件和独立 PostgreSQL 数据库。未调用真实模型、未重放历史会话、未清理业务数据库；未主动重启 Web、桌面或后端进程。实际运行环境加载新后端代码后，Web/桌面共用修复，无需分别修改页面。
