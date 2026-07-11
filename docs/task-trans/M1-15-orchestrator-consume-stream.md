# M1-15 · orchestrator 消费 stream 写真事件

## 目标

`orchestrator.service.ts` 的 `runRuntime`（约 :3959–:3986）：如 adapter 有 `stream?`，并发消费 iterator 把帧翻译成 `events.create` 调用（`runtime_progress` / `tool_called` / `tool_completed` / `artifact_created`）。

## 依赖

M1-14 已合并。

## 前置阅读

- 现有 :3959–:3986 心跳代码
- `packages/shared/src/contracts.ts:932` `AgentRuntimeEvent`
- 事件类型 `tool_called`/`tool_completed`

## 测试步骤（红）

新建 `orchestrator-streaming.spec.ts`：

1. 注入假 adapter（有 stream 方法，产 5 帧后 result）→ 断言 `events.create` 被调 ≥3 次真事件（非 RUNTIME_HEARTBEAT）
2. `tool_use` 帧 → `events.create({type:'tool_called', metadata:{toolCallId,...}})`
3. `tool_result` 帧 → `events.create({type:'tool_completed', metadata:{toolCallId,output前 200 字符}})`
4. 假 adapter 无 stream 方法 → 保持现状（合成心跳未触发本用例的真事件）

## 实现要点（绿）

- 在 `try { runPromise = runtime.run(...) }` 之前，判 adapter 支持 stream？（此处 adapter 从 registry 拿）
- 用 `void (async () => { for await (const frame of adapter.stream(runId)) { events.create(...) } })()` 并发消费
- 心跳保留（M1-16 才降级）

## 验收目标

- [ ] 4 用例绿
- [ ] `typecheck` 通过
- [ ] 关闭流式（`off`）时行为与现状一致

## 时间估算

15 分钟。

## 提交信息

```
task(M1-15): orchestrator 消费 stream 写真实运行时事件
```

## 常见坑

- 别 `await for-await`——那样阻塞 `runPromise`；必须并发
- iterator 终止后要正常清理（不要泄漏 promise）
