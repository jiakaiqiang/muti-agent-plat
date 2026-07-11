# M1-09 · 帧 → `agent_message` mapper TDD

## 目标

新建 `frame-to-output.mapper.ts` 的第一半：把 `result` 帧（+累计 `assistant_text`）映射为 `RuntimeOutput` 的 `agent_message` kind。

## 依赖

M1-08 已合并。

## 前置阅读

- `packages/shared/src/contracts.ts` 的 `AgentMessageOutput` 类型
- 上游设计第 3.5 节的 kind 映射表

## 测试步骤（红）

新建 `frame-to-output.mapper.spec.ts`：

1. `agent_message`：给 `[{kind:'assistant_text',text:'你好'},{kind:'assistant_text',text:'世界'},{kind:'result',payload:{}}]` → `{kind:'agent_message', messageKind:'summary', content:'你好世界'}`
2. `result.payload.content` 优先于累计文本
3. 无 assistant_text 无 payload.content → 抛显式错误（`OUTPUT_SCHEMA_INVALID`）
4. `payload.messageKind` 落地（如 `discussion`），否则默认 `summary`

## 实现要点（绿）

```ts
export function framesToAgentMessage(frames: RuntimeStreamFrame[]): AgentMessageOutput { ... }
export function framesToOutput(kind, frames): RuntimeOutput { switch(kind) { case 'agent_message': ... } }
```

其他 kind 先抛 `not implemented`，M1-10 补齐。

## 验收目标

- [ ] `frame-to-output.mapper.ts` + `.spec.ts`
- [ ] 4 用例全绿
- [ ] `typecheck` 通过

## 时间估算

12 分钟。

## 提交信息

```
task(M1-09): 帧 → agent_message mapper TDD
```
