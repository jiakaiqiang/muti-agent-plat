# 群聊持久化与恢复 Tasks v1

- [x] T1 定义相关集合事务与差量合并合同，添加并发缓存复现测试（AC1–4、7）。
- [x] T2 实现 PostgreSQL 事务/写入锁与缓存刷新，迁移 Runtime 和 Context 调用点（AC1–4）。
- [x] T3 统一失败阶段恢复及确认幂等（AC5）。
- [x] T4 修复停止回执通知条件与重复处理（AC6）。
- [x] T5 运行真实隔离 PostgreSQL 并发、后端相关回归、类型检查与构建（AC8）。
- [x] T6 更新 API/运行时合同、checklist 与交付记录；不自动重跑用户任务。

范围与取舍见 [Plan](../design/session-persistence-recovery-plan-v1.md)，验收见 [Checklist](../quality/session-persistence-recovery-checklist-v1.md)。
