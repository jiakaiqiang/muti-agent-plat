# M4-06 · resume 失败降级新会话 + 事件留痕 TDD

> 状态：✅ 已完成（2026-07-10）  
> 实际实现：fallback 统一落在 `RuntimeService`，同时处理 resume 失败和 session id 不一致，最多重试一次。

## 目标

adapter 检测 resume 失败（CLI 报错 / result 帧带新 sessionId 且 != 请求的 id）→ **kill 当前进程 + 自动重启新会话**；orchestrator 写一条 `runtime_progress` 事件 `code:'RESUME_FALLBACK'`。

## 依赖

M4-05。

## 前置阅读

- 上游设计第 6 节 R4 概设

## 测试步骤（红）

追加两个 adapter 的 streaming spec：

1. stub 收到 resume 请求时输出 error → adapter kill → 无 resume 重启 → 完成
2. resume 成功（session_id 一致）→ 不触发 fallback
3. orchestrator：resume 失败路径产生 1 条 `runtime_progress` `code:'RESUME_FALLBACK'`
4. 单次 run 中 fallback 最多触发 1 次（防死循环）

## 实现要点（绿）

- adapter：runStreaming 结束后判 result.cliSessionId 与请求 id 一致；不一致或抛错 → 内部 recursion 一次（with `options.resume = undefined`）
- orchestrator：从帧的 metadata 检测 fallback 标记（adapter 通过 `system` 帧标记）

## 验收目标

- [ ] 4 用例绿（每 adapter 2）
- [ ] `typecheck` 通过

## 时间估算

15 分钟。

## 提交信息

```
task(M4-06): resume 失败降级 + 事件留痕 TDD
```

## 常见坑

- 递归只允许 1 层，第二层失败必须报错，别无限重试
