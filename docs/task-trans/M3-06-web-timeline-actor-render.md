# M3-06 · 前端 ChatTimeline 双数据源渲染兼容

## 目标

`apps/web/src/components/ChatTimeline.vue`（及关联 store）：优先读 `event.actor`，不存在回退 `fromAgentId`；渲染 icon/name 走统一 `useActor(event)` composable。

## 依赖

M3-05。

## 前置阅读

- 现有 `ChatTimeline.vue`
- `apps/web/src/stores/event.ts`

## 测试步骤（红）

新建/追加 `ChatTimeline.spec.ts`：

1. 事件有 actor → 渲染 actor.id 关联 agent 名/头像
2. 事件仅有 fromAgentId → 回退渲染同结果
3. actor.type='user' → 渲染用户头像
4. actor.type='system' → 渲染系统 icon（不显示头像）

## 实现要点（绿）

- 新 `composables/useActor.ts`：`(event) => { type, id, displayName, avatarUrl }`
- ChatTimeline 用 composable，删除内嵌 `if (fromAgentId) ...` 分支

## 验收目标

- [ ] 4 用例绿
- [ ] 前端手工 smoke（跑 web + server，看 timeline 头像正常）
- [ ] `apps/web` typecheck 通过

## 时间估算

15 分钟。

## 提交信息

```
task(M3-06): 前端 ChatTimeline actor 兼容渲染
```
