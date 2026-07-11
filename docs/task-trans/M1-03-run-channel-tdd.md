# M1-03 · `RunChannel` 有界通道 TDD

## 目标

实现 per-runId 帧通道：run() 内部产帧 → push；stream(runId) 消费；有界（默认 512 帧），满时按策略丢弃中间 `assistant_text` 帧、保留 `tool_*`/`result`。

## 依赖

M1-02 已合并。

## 前置阅读

- 上游设计第 3.2、3.6 节
- Node 内置 `stream/web`（若用 ReadableStream）或自己写 async iterator

## 测试步骤（红）

新建 `apps/server/src/modules/runtimes/streaming/run-channel.spec.ts`，覆盖 5 个用例，全部先红：

1. **顺序**：push 三帧后 `for await` 依序拿到三帧
2. **close**：close 后 iterator 终止（不阻塞）
3. **有界**：容量 3，push 5 帧（都是 `assistant_text`）→ 消费得到最新 3 帧且顺序保持
4. **优先保留**：容量 3，push 顺序 [text1, tool_use1, text2, text3, result1] → 溢出时先丢 text，保留 tool_use 与 result
5. **单消费者**：并发两次 `stream(runId)` 抛显式错误（or 第二次拿空迭代器，明确一种即可）

`npm run test -- run-channel` → **红**。

## 实现要点（绿）

新建 `run-channel.ts`：

- `RunChannel` 内部用双队列：优先队列（tool_*/result/system/stderr_tail）+ 普通队列（assistant_text）
- `push(frame)` 满时先弹普通队列头
- `[Symbol.asyncIterator]()` 用 `Promise` + `pendingResolvers` 唤醒等待中的消费者
- `close()` 设置 done 标志，唤醒所有等待者
- `stream()` 二次调用抛 `Error('RunChannel already streaming')`

## 验收目标

- [ ] `run-channel.ts` 与 `.spec.ts`
- [ ] `npm run test -- run-channel` 5 用例全绿
- [ ] `npm run typecheck` 通过

## 时间估算

15 分钟。

## 提交信息

```
task(M1-03): RunChannel 有界帧通道 TDD
```

## 常见坑

- 消费者慢于生产者时不要无限缓冲——容量必须硬上限
- close 时如果消费者已经在 `await next()`，必须唤醒并让 iterator 终止，别死锁
