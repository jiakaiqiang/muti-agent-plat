# M1-05 · 看门狗：idle 超时 TDD

## 目标

在 M1-04 基础上补齐 **idle 超时**：首帧后开始计时，每次 `notifyFrame()` 重置；`idleTimeoutMs` 内无新帧 → `onTimeout('idle')`。

## 依赖

M1-04 已合并。

## 前置阅读

- 上游设计第 4.1 状态机

## 测试步骤（红）

在 `liveness-watchdog.spec.ts` 追加 3 个用例：

1. **idle 触发**：`start({firstFrameTimeoutMs: 30_000, idleTimeoutMs: 60_000})` → 20s 后首帧 → 再 60s 无帧 → `onTimeout('idle')`
2. **idle 被刷新**：首帧后每 30s 一帧、共 4 次（120s） → 无 `idle` 触发
3. **first_frame 与 idle 隔离**：首帧未到时不能触发 idle
4. **idleTimeoutMs 缺省不启用**：仅设 firstFrameTimeoutMs → 首帧后随便多久都不触发 idle

`npm run test -- liveness-watchdog` → **新用例红**（旧的仍绿）。

## 实现要点（绿）

补 `notifyFrame()`：
- 首帧到达时清 first_frame timer、挂 idle timer
- 之后每帧清 idle timer 重挂
- `idleTimeoutMs` 未提供时跳过

## 验收目标

- [ ] 新增 3 用例全绿；旧 4 用例仍绿
- [ ] `typecheck` 通过
- [ ] 只改 `liveness-watchdog.{ts,spec.ts}` 两个文件

## 时间估算

10 分钟。

## 提交信息

```
task(M1-05): LivenessWatchdog idle 超时 TDD
```

## 常见坑

- 别把 first_frame 和 idle 用同一个 timer 变量——切换错序会漏清
