# M4-02 · orchestrator 查上一条 completed invocation TDD

## 目标

`orchestrator.service.ts` 派发 `task_execution` 阶段前，查同 `(agentId, taskId)` 最近一条 `status='completed'` invocation，读取其 `cliSessionId/workDir`。

## 依赖

M4-01。

## 前置阅读

- `orchestrator.service.ts` 派发 task_execution 的入口
- `RuntimeService.getInvocationsBySession` 或类似查询

## 测试步骤（红）

新建 `orchestrator-resume-lookup.spec.ts`：

1. 无历史 invocation → 返回 undefined
2. 有 1 条 completed → 返回其 cliSessionId/workDir
3. 有多条：最近的一条 completed 胜出（跳过 failed/cancelled）
4. 跨 session 的同 (agentId, taskId) 不复用（首期收窄口径）

## 实现要点（绿）

- `RuntimeService` 加 `findPriorInvocation(sessionId, agentId, taskId): {cliSessionId, workDir} | undefined`
- orchestrator 在派发时调用

## 验收目标

- [ ] 4 用例绿
- [ ] `typecheck` 通过

## 时间估算

12 分钟。

## 提交信息

```
task(M4-02): orchestrator 查上一条 completed invocation TDD
```
