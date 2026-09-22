# GC-01 共享消息、Tag 与附件合同 Plan v1

> [Spec](../product/group-chat-attachment-skill-agent-t01-contracts-spec-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t01-contracts-task-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t01-contracts-checklist-v1.md)

## 研究定位

- 共享类型入口：`packages/shared/src/contracts.ts`、`packages/shared/src/index.ts`。
- 前端合同映射：`apps/web/src/types/contracts.ts`、桌面共享合同入口。
- 事件和消息已有合同：`docs/contracts/api-contract-v0.1.md`、`docs/contracts/event-contract-v0.1.md`。

## 设计决策

- 复用现有合同文件，不新增平行 JSON schema。
- 使用字符串联合状态和稳定 ID，避免前端依赖显示名称。
- 对可选引用使用空数组/`undefined` 的既有约定，避免把普通消息变成特殊消息。
- 校验函数保持纯函数，便于前后端和单测复用。

## 实施步骤

1. 在 shared contracts 增加消息指令和引用类型。
2. 增加数量约束校验：Skill ≤ 1、Agent ≥ 0、附件 ≥ 0。
3. 导出类型和校验函数。
4. 增加最小单测，覆盖合法空消息、组合消息和非法多个 Skill。

## 影响范围

- 允许修改：`packages/shared/src/`、对应合同测试。
- 谨慎触碰：现有消息解析调用点，只做兼容适配。
- 禁止修改：运行时权限、数据库迁移和 UI 样式。

## 风险与验证

- 风险：既有消息字段命名冲突；先搜索现有 `metadata`、`attachments`、`mentions` 字段再落名。
- 验证：共享包 typecheck、合同单测、序列化 round-trip。
