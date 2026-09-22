# GC-06 Skill 注册中心与分层治理 Task v1

> [Spec](../product/group-chat-attachment-skill-agent-t06-skill-registry-spec-v1.md) · [Plan](../design/group-chat-attachment-skill-agent-t06-skill-registry-plan-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t06-skill-registry-checklist-v1.md)

> 状态：已完成（2026-09-22）

## 任务目标

在既有 Skill 管理模块上补齐三层范围、分类、启停、同名覆盖和个人升级群聊能力。

## 10–15 分钟执行清单

1. 搜索现有 Skill 实体、store 和 API，确定最小兼容字段。
2. 增加 scope/category/status/version 字段或适配映射。
3. 实现个人 > 群聊 > 系统的查询合并函数。
4. 实现分类删除前迁移校验和个人升级群聊接口。
5. 增加启停、覆盖、权限和历史引用单测。

## 已交付

- 共享 `Skill` 合同补充可选 `scope`、`scopeId`、`categoryId`，并新增 `SkillCategory`；旧数据默认归入系统范围。
- 服务端新增纯 `mergeAvailableSkills` 规则，按个人 > 群聊 > 系统覆盖，过滤停用项并按分类、名称排序。
- `SkillsService` 持久化三层 Skill 与分类，支持分类创建/重命名/迁移/删除保护、启停和个人 Skill 无审批升级群聊。
- API 增加 `/skills/available`、分类 CRUD 和 `/:skillId/promote-to-group`；修改操作依据 `x-user-id`、`x-group-id`、`x-skill-role` 校验权限。
- Web Skill store 可读取当前用户可用 Skill/分类，管理页展示来源层级和启用状态；Agent 仍由 Agent 管理模块维护。

## 不做

- 不把 Agent 注册成 Skill 插件。
- 不实现 `/` 选择器 UI（由 GC-07 完成）。

## 完成定义

前端可以获得当前用户可用、已启用且按分类排序的 Skill 列表，并能明确其来源层级。
