# M1-06 · 看门狗：绝对超时 + cancel TDD

## 目标

补 `absoluteTimeoutMs`（可选、默认关）与外部 cancel：`onTimeout('absolute')` 触发；`stop()` 前后一致（cancel 场景由 orchestrator 侧调 `stop()`）。

## 依赖

M1-05 已合并。

## 前置阅读

- 上游设计 4.1 状态机、4.2 配置表

## 测试步骤（红）

新增用例：

1. **absolute 触发**：`start({firstFrameTimeoutMs: 30_000, idleTimeoutMs: 60_000, absoluteTimeoutMs: 90_000})` → 30s 一帧、60s 再一帧、90s 处触发 `onTimeout('absolute')`
2. **absolute 默认关**：不传 absoluteTimeoutMs → 无论过多久无 absolute
3. **stop 抢先**：quantum 到达前 `stop()` → 无任何 onTimeout
4. **多次 stop 幂等**：连调 `stop()` 3 次不抛错

## 实现要点（绿）

- `start()` 时如设了 absolute，挂长 timer
- `stop()` 清所有 timer（用数组管理，避免遗漏）
- `stop()` 幂等：设 `stopped=true` 短路

## 验收目标

- [ ] 新 4 用例绿；总 11 用例绿
- [ ] `typecheck` 通过
- [ ] 只改 `liveness-watchdog.{ts,spec.ts}`

## 时间估算

12 分钟。

## 提交信息

```
task(M1-06): LivenessWatchdog 绝对超时 + cancel TDD
```

## 常见坑

- absolute 触发后必须自动 `stop()`，防止 idle 再补一刀
- 多个 timer 时用集合管理并统一 `unref()`（生产环境别把 Node 进程钉住）
