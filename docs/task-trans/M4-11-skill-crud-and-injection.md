# M4-11 · Skill CRUD + ContextPack 注入 TDD

> 状态：✅ 已完成（2026-07-10）  
> 实际实现：CRUD、Agent 绑定/解绑、删除引用清理、稳定顺序 `systemRules` 与 Workdir Brief 注入均已完成。

## 目标

新增 `SkillsController`（REST：POST/GET/PATCH/DELETE `/api/skills`、POST `/api/agents/:id/skills`）；ContextPack 组装点把 agent 挂载的 skill 内容并入 `systemRules`。

## 依赖

M4-10。

## 前置阅读

- 现有 controller 风格
- ContextPack 组装位置（`orchestrator.service.ts` 或 context-router）

## 测试步骤（红）

`skills.controller.spec.ts`：
1. POST 创建 skill → 200 + id
2. PATCH 更新
3. DELETE
4. POST `/agents/:id/skills` 绑定，GET agent 时能查到

`context-pack-with-skills.spec.ts`：
5. agent 无 skill → contextPack.systemRules 保持
6. agent 挂 2 个 skill → contextPack.systemRules 包含两段 skill.content

## 实现要点（绿）

- controller 转发 service
- ContextPack builder 增加 skill 拼装步骤

## 验收目标

- [ ] 6 用例绿
- [ ] `typecheck` 通过
- [ ] `docs/contracts/api-contract-v0.1.md` 增 skill 端点

## 时间估算

15 分钟。

## 提交信息

```
task(M4-11): Skill CRUD + ContextPack 注入 TDD
```
