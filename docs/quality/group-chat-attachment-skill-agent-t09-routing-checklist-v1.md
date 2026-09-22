# GC-09 Tag 序列化与语义路由 Checklist v1

> [Spec](../product/group-chat-attachment-skill-agent-t09-routing-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t09-routing-plan-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t09-routing-task-v1.md)

## 路由矩阵

- [x] 无 Skill、无 Agent：主 Agent 处理普通消息。
- [x] 一个 Skill、无 Agent：主 Agent 处理并可分发多个 Agent。
- [x] 一个 Skill、一个匹配 Agent：该 Agent 执行。
- [x] 一个 Skill、多个候选：只选择一个最匹配 Agent。
- [x] 指定候选均不匹配：回退主 Agent。
- [x] `/` 和 `@` 顺序互换：结构化结果一致。

## 持久化验证

- [x] 可读文本和结构化引用同时保存。
- [x] Skill/Agent/附件使用稳定 ID。
- [x] 历史展示快照不依赖当前列表是否仍可用。

## 证据记录

| 项目 | 记录 |
| --- | --- |
| 执行日期 | 2026-09-22 |
| 命令 | `npm run typecheck -w @agent-cluster/shared`; `npm run typecheck -w @agent-cluster/server`; `npm run typecheck -w @project/web`; `node ../../node_modules/tsx/dist/cli.mjs --test --test-force-exit src/modules/message-routing/tag-routing.spec.ts`; `node ../../node_modules/tsx/dist/cli.mjs --test --test-force-exit src/modules/message-routing/message-ingress.service.spec.ts`; `node ../../node_modules/tsx/dist/cli.mjs --test --test-force-exit src/modules/sessions/sessions.service.spec.ts`; `npm run test -w @agent-cluster/server`; `npm run test -w @project/web` |
| 结果 | 三端 typecheck 通过；路由 6/6；消息入口 7/7；SessionService 118/118；Server 1673 通过、17 跳过；Web 66 文件、346 通过 |
| 失败/跳过原因 | 无 |
