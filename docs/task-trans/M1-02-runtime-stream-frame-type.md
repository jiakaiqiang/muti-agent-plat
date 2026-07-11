# M1-02 · 内部帧类型 `RuntimeStreamFrame`

## 目标

在 `apps/server/src/modules/runtimes/streaming/runtime-stream-frame.ts` 新建内部帧类型定义 + 类型层测试。**不写运行时逻辑**，只定义类型 + 用 `expectTypeOf` 或断言函数守卫类型形状。

## 依赖

M1-01 已合并（合同章节先行）。

## 前置阅读

- 上游设计第 3.2 节的统一帧类型定义
- `packages/shared/src/contracts.ts:932` `AgentRuntimeEvent`（了解外部事件类型，避免命名冲突）

## 测试步骤（红）

1. 新建 `apps/server/src/modules/runtimes/streaming/runtime-stream-frame.spec.ts`
2. 写测试：
   - 用类型守卫函数 `isResultFrame(frame): frame is Extract<RuntimeStreamFrame, {kind:'result'}>` 断言 6 种帧的 kind 判别
   - 断言 `RuntimeStreamFrame` 是 discriminated union（`kind` 字段窄化）
3. `npm run test -- runtime-stream-frame` → **红**（文件不存在）

## 实现要点（绿）

新建 `apps/server/src/modules/runtimes/streaming/runtime-stream-frame.ts`：

```ts
export type RuntimeStreamFrame =
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool_use'; toolCallId: string; tool: string; input: unknown }
  | { kind: 'tool_result'; toolCallId: string; tool: string; output: string; isError?: boolean }
  | { kind: 'result'; payload: unknown; usage?: RawUsage; cliSessionId?: string }
  | { kind: 'system'; subtype: string; raw: unknown }
  | { kind: 'stderr_tail'; text: string };

export type RawUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
};

export const isResultFrame = (f: RuntimeStreamFrame): f is Extract<RuntimeStreamFrame, { kind: 'result' }> =>
  f.kind === 'result';
// 同法为其余五种加守卫
```

## 验收目标

- [ ] `runtime-stream-frame.ts` 与 `.spec.ts` 两个新文件
- [ ] `npm run test -- runtime-stream-frame` 全绿
- [ ] `npm run typecheck` 通过
- [ ] 无 shared 包变更（`git diff --name-only packages/` 空）

## 时间估算

12 分钟。

## 提交信息

```
task(M1-02): 新增内部 RuntimeStreamFrame 帧类型
```

## 常见坑

- 不要把这个类型 export 到 `@agent-cluster/shared`——它是内部实现，暴露到合同就绑死了
- `toolCallId` 必须有，否则 M1-15 无法把 `tool_use` 和 `tool_result` 配对
