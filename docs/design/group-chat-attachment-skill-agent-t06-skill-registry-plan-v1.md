# GC-06 Skill 注册中心与分层治理 Plan v1

> [Spec](../product/group-chat-attachment-skill-agent-t06-skill-registry-spec-v1.md) · [Task](../implementation/group-chat-attachment-skill-agent-t06-skill-registry-task-v1.md) · [Checklist](../quality/group-chat-attachment-skill-agent-t06-skill-registry-checklist-v1.md)

## 研究定位

- Skill 后端：`apps/server/src/modules/skills/`。
- Skill 前端：`apps/web/src/components/SkillManager.vue`、`apps/web/src/stores/skill.ts`。
- Agent 管理保持独立：`apps/server/src/modules/agents/`。

## 设计决策

- 复用现有 Skill 模块和 ContextPack 注入边界，不把 Agent 元数据移入插件表。
- 以 `scope`、`scopeId`、`categoryId`、`status`、`revision` 建模；`SkillCategory` 也带同一范围，避免跨范围引用分类。
- 查询时按用户、群聊和系统范围合并，再执行个人 > 群聊 > 系统去重。
- 分类删除采用 fail-closed：仍有 Skill 时拒绝。
- 升级个人 Skill 为群聊级是显式写入，不需要审批状态机。
- Skill 与 Agent 保持两个注册域；Skill API 只返回 Skill/分类元数据，Agent 继续来自 Agent 管理模块。

## 实施步骤

1. 补齐 Skill scope/category/status/revision 合同和旧数据默认值。
2. 增加查询合并和同名覆盖纯函数，过滤停用项并按分类/名称排序。
3. 增加分类 CRUD、迁移保护、启停和个人升级群聊接口。
4. 增加系统/群聊/个人权限单测和历史引用兼容测试。
5. 在 Web store 暴露可用 Skill/分类查询，管理页显示来源层级。

## 风险

- 同名覆盖必须使用稳定 canonical key，不能只依赖显示名称。
- 停用和删除不能抹掉历史消息所需的展示快照。
- 现有单用户本地 API 在未提供身份头时保留兼容的系统管理员默认路径；提供 `x-skill-role` 后按 scope 严格拒绝越权写入。
