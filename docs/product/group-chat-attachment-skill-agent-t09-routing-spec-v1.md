# GC-09 Tag 序列化与语义路由 Spec v1

> 任务：GC-09 | 预计：10–15 分钟 | 前置：GC-01、GC-04、GC-05、GC-06、GC-08
> [总路线图](../roadmap/group-chat-attachment-skill-agent-sdd-roadmap-v1.md) · [Plan](../../docs/design/group-chat-attachment-skill-agent-t09-routing-plan-v1.md) · [Task](../../docs/implementation/group-chat-attachment-skill-agent-t09-routing-task-v1.md) · [Checklist](../../docs/quality/group-chat-attachment-skill-agent-t09-routing-checklist-v1.md)

## 目标

把消息正文、Skill、Agent 候选和附件统一转换为结构化执行输入，并实现确定性的路由边界。

## 路由规则

- 一条消息最多一个 Skill。
- 有多个 `@Agent` 时，从候选中按语义选择一个最匹配 Agent 使用 Skill。
- 指定候选都不适配时回退主 Agent。
- 无 `@Agent` 时由主 Agent 分析，并可分发给多个 Agent 协同。
- 主 Agent 始终负责最终汇总。
- `/Skill` 与 `@Agent` 的输入顺序不影响结构化结果。

## 持久化要求

- 保存可读文本和结构化引用。
- Skill 保存 ID、名称快照和选择时版本。
- Agent 保存候选 ID、名称快照和路由结果。
- 附件保存 ID、类型、识别摘要引用和权限边界。

## 验收标准

- `GC09-AC1`：Tag 顺序任意但结构化结果一致。
- `GC09-AC2`：多个候选只产生一个 Skill 执行者。
- `GC09-AC3`：不匹配和无候选时正确回退主 Agent。
- `GC09-AC4`：无 `@` 可以分发多个 Agent。
- `GC09-AC5`：历史消息保留可读和结构化两种表示。
