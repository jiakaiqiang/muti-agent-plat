# GC-01 共享消息、Tag 与附件合同 Checklist v1

> [Spec](../product/group-chat-attachment-skill-agent-t01-contracts-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t01-contracts-plan-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t01-contracts-task-v1.md)

## 自动验证

- [x] 共享包 typecheck 通过：`npm run typecheck -w @agent-cluster/shared`。
- [x] 合同单测覆盖空消息、单 Skill、多 Agent 和附件状态。
- [x] 多个 Skill 引用被拒绝。
- [x] 归一化结果保留可读文本、Skill、Agent 和附件结构化引用。

## 手工验证

- [ ] 普通文本消息不需要附加 Tag 或附件字段。
- [ ] 图片和文件引用都可以使用稳定附件 ID。
- [ ] 识别失败状态不会被误判为识别成功。

## 证据记录

| 项目 | 记录 |
| --- | --- |
| 执行日期 | 2026-09-22 |
| 命令 | `npm run typecheck -w @agent-cluster/shared`; `node --import tsx --test packages/shared/src/group-chat-contracts.spec.ts` |
| 结果 | 类型检查通过；定向合同测试 7/7 通过 |
| 失败/跳过原因 | 首次沙盒内测试因 Node test runner `spawn EPERM` 未启动，随后在沙盒外重跑通过；无断言失败 |
