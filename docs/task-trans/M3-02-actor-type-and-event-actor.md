# M3-02 · 定义 `ActorRef` + `CollaborationEvent.actor`

## 目标

`packages/shared/src/contracts.ts` 加 `ActorType` / `ActorRef`；`CollaborationEvent` 加 `actor?: ActorRef`（可选，双写过渡）；旧字段 `fromAgentId` 加 `/** @deprecated v0.3 移除，改用 actor */` 注释。

## 依赖

M3-01。

## 前置阅读

- `contracts.ts:262-298` `CollaborationEvent`
- 上游设计 5.1

## 测试步骤（红）

新增 `packages/shared/src/actor-ref.spec.ts`：

1. 类型层：`ActorType` 只允许 `'user' | 'agent' | 'system'`（用 `@ts-expect-error` 验证非法值）
2. `ActorRef` 结构：`{ type; id }`
3. `CollaborationEvent` 可 optional 携带 actor（不影响旧结构）

## 实现要点（绿）

```ts
export type ActorType = 'user' | 'agent' | 'system';
export interface ActorRef { type: ActorType; id: UUID; }

// CollaborationEvent 内加：
actor?: ActorRef;
/** @deprecated v0.3 移除，改读 actor */
fromAgentId?: UUID;
```

## 验收目标

- [ ] 类型测试绿
- [ ] `packages/shared` build 通过
- [ ] `apps/server` typecheck 通过（现有 fromAgentId 用法不受影响）
- [ ] `apps/web` typecheck 通过

## 时间估算

12 分钟。

## 提交信息

```
task(M3-02): 定义 ActorRef 与 CollaborationEvent.actor 双写字段
```
