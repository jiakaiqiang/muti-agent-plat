# GC-12 历史、生命周期与删除一致性 Plan v1

> [Spec](../product/group-chat-attachment-skill-agent-t12-lifecycle-spec-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t12-lifecycle-task-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t12-lifecycle-checklist-v1.md)

## 研究定位

- 持久化/恢复：`apps/server/src/modules/persistence/`、`apps/server/src/modules/recovery/`。
- 会话删除：`apps/server/src/modules/sessions/`。
- Agent 管理：`apps/server/src/modules/agents/`。
- 附件：GC-03 领域服务及消息删除事件。

## 设计决策

- 展示快照和执行引用分开：展示保留名称，执行重新校验当前状态。
- 删除使用事务或 outbox 边界，避免消息已删而附件仍可引用。
- 群聊历史访问采用加入时间无关的全量只读范围。
- 任何清理失败都保持不可引用状态并进入可重试清理队列。

## 实施步骤

1. 复核历史消息字段和快照保存。
2. 增加停用/删除后的历史执行守卫。
3. 串接消息删除、附件清理和群聊删除。
4. 增加新 Agent 全历史读取测试。
5. 增加恢复/重复删除幂等测试。

## 风险

- 删除操作不可通过前端隐藏代替服务端状态更新。
- 历史引用展示不能泄露已无权限读取的附件正文。
