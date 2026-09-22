# GC-14 端到端验收与追踪矩阵 Spec v1

> 任务：GC-14 | 预计：10–15 分钟 | 前置：GC-01–GC-13
> [总路线图](../roadmap/group-chat-attachment-skill-agent-sdd-roadmap-v1.md) · [Plan](../../docs/design/group-chat-attachment-skill-agent-t14-acceptance-plan-v1.md) · [Task](../../docs/implementation/group-chat-attachment-skill-agent-t14-acceptance-task-v1.md) · [Checklist](../../docs/quality/group-chat-attachment-skill-agent-t14-acceptance-checklist-v1.md)

## 目标

用最小但完整的端到端场景证明需求文档中的核心行为，并建立需求 → 任务 → 测试 → 证据追踪关系。

## 必须覆盖

- 附件上传、识别、失败重试和删除。
- 只发送附件和附件自动上下文。
- `/Skill` 分类选择、单 Skill 限制和普通 `/` 文本。
- `@Agent` 搜索、多选、群外加入确认和主 Agent 隐藏。
- 显式 Agent 路由、无 `@` 多 Agent 分发和主 Agent 汇总。
- 协同面板、中止、失败重试和版本化重新汇总。
- 权限、历史、群聊删除和失效引用。

## 验收标准

- `GC14-AC1`：每条需求 AC 至少关联一个任务和一个验证证据。
- `GC14-AC2`：正向、负向和生命周期场景均有结果。
- `GC14-AC3`：未执行项标记 pending，不伪造通过。
- `GC14-AC4`：Web/桌面共享合同不产生语义分叉。
- `GC14-AC5`：运行全局最小验证集合并记录环境。
