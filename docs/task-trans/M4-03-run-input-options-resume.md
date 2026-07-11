# M4-03 · `AgentRunInput.options.resume` 透传 TDD

## 目标

orchestrator 派发时把 M4-02 查到的 `{cliSessionId, workDir}` 塞入 `input.options.resume`；adapter 侧目前先接收后透传（不消费，M4-04/05 才用）。

## 依赖

M4-02。

## 前置阅读

- `contracts.ts` `AgentRunInput.options?: Record<string, unknown>`

## 测试步骤（红）

追加 orchestrator 测试：

1. 有 prior invocation → 派发时 `input.options.resume === {cliSessionId, workDir}`
2. 无 prior → `input.options.resume` 缺省
3. 非 task_execution 阶段（如 discussion）→ 不塞 resume

## 实现要点（绿）

- orchestrator 派发前构造 options
- Codex/Claude adapter 单测：收到 resume 时**不消费但记录到 log**（防遗漏）

## 验收目标

- [ ] 3 用例绿
- [ ] `typecheck` 通过

## 时间估算

10 分钟。

## 提交信息

```
task(M4-03): AgentRunInput.options.resume 透传 TDD
```
