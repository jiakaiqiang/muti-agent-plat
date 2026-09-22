# GC-12 历史、生命周期与删除一致性 Checklist v1

> [Spec](../product/group-chat-attachment-skill-agent-t12-lifecycle-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t12-lifecycle-plan-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t12-lifecycle-task-v1.md)

## 自动验证

- [x] 停用 Skill 后历史 Tag 仍展示。
- [x] 历史 Skill 重执行使用当前最新启用版本。
- [x] 删除 Agent 后历史 Tag 保留但执行被拒绝。
- [x] 删除消息同步删除附件引用和本体。
- [x] 删除群聊清理附件和临时 Agent 关系。
- [x] 新 Agent 可读取加入前历史消息和附件索引。
- [x] 重复删除和清理幂等。

## 安全验证

- [x] 历史 Tag 展示不等于恢复已删除附件正文权限。
- [x] 已失效附件不能被新消息引用。

## 证据记录

| 项目 | 记录 |
| --- | --- |
| 执行日期 | 2026-09-22 |
| 命令 | `npm run typecheck -w @agent-cluster/server`; `npm run test -w @agent-cluster/server`; `npx tsx --test --test-force-exit --tsconfig tsconfig.json src/modules/sessions/historical-context.spec.ts`; 删除/附件定向测试：`npx tsx --test --test-force-exit --test-name-pattern="deleting a Session|deleting a user message" --tsconfig tsconfig.json src/modules/sessions/sessions.service.spec.ts src/modules/attachments/attachments.service.spec.ts` |
| 结果 | typecheck 通过；Server 全量 1680 通过、17 跳过、0 失败，开发门禁 7/7；历史上下文 3/3；删除/生命周期定向 4/4；附件关联清理定向 1/1。 |
| 失败/跳过原因 | 无 |
