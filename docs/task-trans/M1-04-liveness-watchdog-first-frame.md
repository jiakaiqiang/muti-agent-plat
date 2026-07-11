# M1-04 · 看门狗：首帧超时 TDD

## 目标

新建 `LivenessWatchdog`，实现**首帧超时**判定：spawn 后 `FIRST_FRAME_TIMEOUT_MS` 内未收到任何帧 → 触发 `onTimeout('first_frame')`。

## 依赖

M1-03 已合并。

## 前置阅读

- 上游设计第 4 节看门狗状态机

## 测试步骤（红）

新建 `apps/server/src/modules/runtimes/streaming/liveness-watchdog.spec.ts`，用 `vi.useFakeTimers()`：

1. **未启动**：new + 未 `start()` → 快进 60s，`onTimeout` 未被调用
2. **首帧到达**：`start()` → 快进 20s → `notifyFrame()` → 再快进 60s → `onTimeout` **未** 被 `first_frame` 触发（idle 逻辑 M1-05 覆盖）
3. **首帧超时**：`start(firstFrameTimeoutMs: 30_000)` → 快进 30s → `onTimeout('first_frame')` 被调用 1 次
4. **stop 后**：`stop()` → 快进 100s → `onTimeout` 未被调用

`npm run test -- liveness-watchdog` → **红**。

## 实现要点（绿）

新建 `liveness-watchdog.ts`：

```ts
export type WatchdogReason = 'first_frame' | 'idle' | 'absolute';

export class LivenessWatchdog {
  constructor(
    private opts: {
      firstFrameTimeoutMs: number;
      idleTimeoutMs?: number;      // M1-05
      absoluteTimeoutMs?: number;  // M1-06
      onTimeout: (reason: WatchdogReason) => void;
    }
  ) {}
  start(): void { /* 挂首帧 setTimeout */ }
  notifyFrame(): void { /* 清首帧 timer；idle/absolute 见 M1-05/06 */ }
  stop(): void { /* 清所有 timer */ }
}
```

本任务**只实现 first_frame 分支**，其余留 TODO。

## 验收目标

- [ ] `liveness-watchdog.ts` + `.spec.ts`
- [ ] 4 个用例全绿
- [ ] `typecheck` 通过

## 时间估算

12 分钟。

## 提交信息

```
task(M1-04): LivenessWatchdog 首帧超时 TDD
```

## 常见坑

- 一定要用 fake timers，别 `setTimeout` 真等
- `onTimeout` 只能被调用 1 次（首帧超时后自动 `stop()`），否则 M1-05 会误触发
