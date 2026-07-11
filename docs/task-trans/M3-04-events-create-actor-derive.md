# M3-04 · `events.service.create` 单点推导 actor

## 目标

在 `apps/server/src/modules/events/events.service.ts` 的 `create()` 方法**收敛推导** `actor`：调用方传了就用；未传则按规则推导。**上游调用点零改动。**

## 依赖

M3-03。

## 前置阅读

- `events.service.ts` 现状（找 `create()` 方法）
- 推导规则（上游设计 5.2）

## 测试步骤（红）

`events.service.spec.ts` 追加：

1. 传 `actor` → 原样写入
2. 未传 actor 但传 `fromAgentId='a1'` → 推导 `actor={type:'agent', id:'a1'}`
3. 未传 actor 且 type='user_message' → 推导 `actor={type:'user', id: <sessionUserId 或 'system'>}`
4. 未传 actor 且 type in {'runtime_progress','tool_called','tool_completed','runtime_completed','runtime_failed'} 且传 fromAgentId → agent
5. 未传 actor 且 type in {'session_status_changed','error_reported'} 未传 fromAgentId → `{type:'system', id:'system'}`
6. 幂等：actor 已存在则保留（不覆盖）

## 实现要点（绿）

在 `create()` 内加 `input.actor = input.actor ?? deriveActor(input)` 单点收敛。写入前的持久化字段同步。

## 验收目标

- [ ] 6 用例绿
- [ ] 现有 `orchestrator.service.ts` 数十处 `events.create` 调用**不需要修改**
- [ ] `typecheck` 通过

## 时间估算

15 分钟。

## 提交信息

```
task(M3-04): events.service.create 单点推导 actor
```

## 常见坑

- 别把推导写在 orchestrator 上游——那样零散改动、破坏收敛原则
- `user_message` 的 user id 从 session 拿，别拍脑袋写 'system'
