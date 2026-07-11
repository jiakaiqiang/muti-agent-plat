# M1-16 · orchestrator 心跳降级为 fallback

## 目标

adapter 支持 `stream?` 时，orchestrator 不再合成 `RUNTIME_HEARTBEAT` 事件；无 `stream?` 时保留原心跳。

## 依赖

M1-15 已合并。

## 前置阅读

- `orchestrator.service.ts:3959–3986` 心跳 setInterval
- M1-15 新增的 stream 消费逻辑

## 测试步骤（红）

追加用例：

1. adapter 有 stream → 60s 内不产生任何 `RUNTIME_HEARTBEAT` 事件
2. adapter 无 stream → 保持原语义，60s 内产生 ≥1 条 heartbeat

## 实现要点（绿）

- `if (adapter.stream)` 分支不 `setInterval`；`else` 分支保留原代码
- clearInterval 保护条件判 `heartbeatTimer !== undefined`

## 验收目标

- [ ] 2 用例绿
- [ ] mock/generic_llm 相关 e2e 全绿（它们无 stream，走 fallback）
- [ ] `typecheck` 通过

## 时间估算

10 分钟。

## 提交信息

```
task(M1-16): orchestrator 心跳仅在 adapter 无 stream 时触发
```
