# GC-06 Skill 注册中心与分层治理 Spec v1

> 任务：GC-06 | 预计：10–15 分钟 | 前置：GC-01
> [总路线图](../roadmap/group-chat-attachment-skill-agent-sdd-roadmap-v1.md) · [Plan](../../docs/design/group-chat-attachment-skill-agent-t06-skill-registry-plan-v1.md) · [Task](../../docs/implementation/group-chat-attachment-skill-agent-t06-skill-registry-task-v1.md) · [Checklist](../../docs/quality/group-chat-attachment-skill-agent-t06-skill-registry-checklist-v1.md)

## 目标

把 Skill 统一纳入可分类、可启停、可分层覆盖的插件注册中心；Agent 仍由 Agent 管理模块维护。

## 分层与优先级

- 系统级：系统管理员维护。
- 群聊级：群聊管理员维护。
- 个人级：用户自己维护，默认仅本人可用。
- 同名优先级：个人级 > 群聊级 > 系统级。
- 个人 Skill 升级为群聊级无需审批。

## 分类与状态

- 一级分类，每个 Skill 只能属于一个分类。
- 分类和 Skill 按名称排序。
- 删除分类前必须先迁移 Skill。
- 停用 Skill 不出现在 `/` 列表，历史引用保留。
- 历史消息重新执行使用当前最新启用版本。

## 验收标准

- `GC06-AC1`：三个层级能独立创建和读取。
- `GC06-AC2`：同名 Skill 按个人 > 群聊 > 系统覆盖。
- `GC06-AC3`：分类约束和删除前迁移被强制执行。
- `GC06-AC4`：停用影响新选择但不删除历史引用。
- `GC06-AC5`：个人 Skill 可无审批升级群聊级。
