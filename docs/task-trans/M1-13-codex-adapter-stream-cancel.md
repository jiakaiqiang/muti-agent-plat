# M1-13 · CodexAdapter 实现 `stream/cancel` + 接看门狗

## 目标

CodexAdapter 实现合同上的 `stream?(runId)` 和 `cancel?(runId)`；接入 `LivenessWatchdog`（M1-04~06）。仍不改 `run()` 入口默认路由。

## 依赖

M1-12 已合并。

## 前置阅读

- M1-01 合同 3.a–3.d 语义
- M1-06 watchdog `stop()` 幂等

## 测试步骤（红）

追加用例：

1. `runStreaming` 期间调 `stream(runId)` → 收到帧序列且顺序一致
2. 未调 `runStreaming` 就 `stream(unknown-runId)` → 迭代器立即终止（空）
3. `cancel(runId)` 幂等：连调 2 次不抛
4. `cancel` 后 result.status = 'cancelled'
5. 无首帧 30s → 触发看门狗 → result.error.code = 'RUNTIME_TIMEOUT'、details.watchdog = 'first_frame'
6. idle > 阈值 → result.error.code = 'RUNTIME_TIMEOUT'、details.watchdog = 'idle'

## 实现要点（绿）

- adapter 维护 `Map<runId, {channel, child, watchdog}>`
- `stream(runId)` 返回 channel 的 async iterator
- `cancel(runId)` = kill 进程 + close channel + watchdog.stop()
- watchdog `onTimeout` = kill 进程 + result.error 设置

## 验收目标

- [ ] 6 用例绿
- [ ] `typecheck` 通过

## 时间估算

15 分钟。

## 提交信息

```
task(M1-13): CodexAdapter 实现 stream/cancel + 接看门狗
```
