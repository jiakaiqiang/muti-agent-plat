# M4-10 · Skill 合同 + Agent.skillIds + JSONB 存储

> 状态：✅ 已完成（2026-07-10）  
> 实际实现：`Skill/SkillFile`、`Agent.skillIds` 和 `skills` collection 已落地，并包含名称、内容和文件路径/大小校验。

## 目标

`contracts.ts` 加 `Skill`、`Agent` 加 `skillIds?: UUID[]`；`SkillsService` 支持 CRUD（对接 JSONB collection `skills`）。**本任务只做类型与存储 CRUD，不做注入。**

## 依赖

M4-09。

## 前置阅读

- 上游设计第 8 节 R6
- `PersistenceService.getCollection` 用法

## 测试步骤（红）

新建 `apps/server/src/modules/capabilities/skills.service.spec.ts`：

1. `create(skill)` 存入 collection、`get(id)` 拿到
2. `update(id, patch)` 生效
3. `delete(id)` 后 `get` 返回 undefined
4. `listByAgent(agentId)` 按 `agent.skillIds` 过滤

## 实现要点（绿）

- 类型：`Skill { id, name, description, content, files? }`
- `SkillsService`：类似其他 `.service.ts` 风格
- 挂到 `capabilities.module.ts`

## 验收目标

- [ ] 4 用例绿
- [ ] `typecheck` 通过
- [ ] `docs/contracts/data-contract-v0.1.md` 追加 Skill 描述

## 时间估算

15 分钟。

## 提交信息

```
task(M4-10): Skill 合同 + SkillsService CRUD
```
