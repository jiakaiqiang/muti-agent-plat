# GC-08 `@Agent` 列表与加入确认 Checklist v1

> [Spec](../product/group-chat-attachment-skill-agent-t08-agent-picker-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t08-agent-picker-plan-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t08-agent-picker-task-v1.md)

## 自动验证

- [x] 无权限、停用和不可用 Agent 不出现在列表。
- [x] 主 Agent 不出现在列表。
- [x] 分类和搜索结果正确。
- [x] 多个 AgentRef 可同时保存。
- [x] 群外 Agent 未确认前不加入群聊。
- [x] 重复确认不会创建重复成员关系（会话服务幂等加入测试）。

## 手工验证

- [x] `@` 未选 Agent 时不能发送。
- [x] 新加入 Agent 可查看加入前消息和附件索引（服务端成员事件显式记录可见性）。
- [x] Agent Tag 样式与 Skill Tag 不同。

## 证据记录

| 项目 | 记录 |
| --- | --- |
| 执行日期 | 2026-09-22 |
| 命令 | `npm run typecheck -w @agent-cluster/shared`; `npm run typecheck -w @agent-cluster/server`; `npm run typecheck -w @project/web`; `node ../../node_modules/tsx/dist/cli.mjs --test --test-force-exit src/modules/sessions/sessions.service.spec.ts`; `npm run test -w @project/web -- src/components/UserInputBoxComposer.spec.ts`; `npm run test -w @project/web` |
| 结果 | 三包类型检查通过；Session service 118/118；Composer 15/15；Web 全量 66 文件、346 测试；Server 全量 1665/17 跳过，dev 7/7 |
| 失败/跳过原因 | 无代码失败；Server 全量的 17 个跳过为既有测试标记 |
