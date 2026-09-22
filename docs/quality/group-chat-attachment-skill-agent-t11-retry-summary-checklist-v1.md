# GC-11 取消、失败重试与重新汇总 Checklist v1

> [Spec](../product/group-chat-attachment-skill-agent-t11-retry-summary-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t11-retry-summary-plan-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t11-retry-summary-task-v1.md)

## 自动验证

- [x] 一个 Agent 失败时其他 Agent 继续。
- [x] 取消后已完成结果保留。
- [x] 失败 Agent 可单独 retry。
- [x] retry 后不会自动修改原汇总。
- [x] 手动 re-summarize 追加新版本。
- [x] 新汇总只纳入成功和重试成功结果。
- [x] 取消后的迟到结果不会落地。

## 手工验证

- [x] 面板能看到失败、重试和汇总版本。
- [x] 原汇总仍可展开查看。
- [x] 临时汇总明确标记为当前阶段结果。

## 证据记录

| 项目 | 记录 |
| --- | --- |
| 执行日期 | 2026-09-22 |
| 命令 | `npm run typecheck -w @agent-cluster/server`; `npm run typecheck -w @project/web`; `node ../../node_modules/tsx/dist/cli.mjs --test --test-force-exit src/modules/sessions/sessions.service.spec.ts`; `npm run test -w @agent-cluster/server`; `npm run test -w @project/web` |
| 结果 | Session Service 120/120；Server 1675 passed / 17 skipped；Server dev 7/7；Web 350/350；类型检查通过 |
| 失败/跳过原因 | 无 |
