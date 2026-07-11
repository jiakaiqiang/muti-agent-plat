# M2-05 · ClaudeAdapter 实现 `stream/cancel`

## 目标

ClaudeAdapter 补齐 `stream?(runId)` / `cancel?(runId)`；接看门狗（首帧 30s / idle 10min，与 codex 对齐）。

## 依赖

M2-04。

## 前置阅读

- M1-13 codex 对应实现
- M1-04~06 看门狗接口

## 测试步骤（红）

追加 `claude-code-runtime-adapter-streaming.spec.ts` 用例：

1. `stream(runId)` 收到帧序列一致
2. `cancel(runId)` 幂等
3. cancel 后 result.status = 'cancelled'
4. 首帧超时 → error.code=RUNTIME_TIMEOUT, details.watchdog='first_frame'
5. idle 超时 → details.watchdog='idle'

## 实现要点（绿）

同 codex 模式，adapter 维护 `Map<runId, {channel, child, watchdog}>`。

## 验收目标

- [ ] 5 新用例绿
- [ ] `typecheck` 通过

## 时间估算

12 分钟。

## 提交信息

```
task(M2-05): ClaudeAdapter 实现 stream/cancel + 看门狗
```
