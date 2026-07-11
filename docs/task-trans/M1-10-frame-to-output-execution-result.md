# M1-10 · 帧 → `task_execution_result` mapper TDD

## 目标

补齐 mapper 剩余 kind，重点 `task_execution_result`：从 `result.payload` + `tool_use/tool_result` 帧累计推 `changedArtifacts`。

## 依赖

M1-09 已合并。

## 前置阅读

- `TaskExecutionResultOutput` 类型（含 `status/summary/changedArtifacts` 等）

## 测试步骤（红）

追加用例：

1. `task_execution_result` 基线：payload.summary/status 直落
2. `changedArtifacts`：payload.metadata.fileChanges 存在时直落
3. 从 tool_result 帧推导：多次 `write_file` tool_result → 汇成 `changedArtifacts`
4. `status` 缺省 → `'completed'`
5. `task_brief` / `task_acceptance_decision` / `post_review_report` / `final_delivery` / `user_message_handling_plan` / `task_claim_decision` 各写 1 个基线用例（payload 直落）

## 实现要点（绿）

- 大 switch，每 kind 一个纯函数
- 未列出的 kind → 抛错（防漏映）

## 验收目标

- [ ] 追加约 10 用例，全绿
- [ ] `typecheck` 通过

## 时间估算

15 分钟。

## 提交信息

```
task(M1-10): 帧 → task_execution_result / 其余 kind mapper TDD
```

## 常见坑

- 别为了减重合并 kind——kind 是 discriminated union，压扁反而失去类型收窄
