# M1-01 · 补 runtime-contract 流式语义章节

## 目标

在 `docs/contracts/runtime-contract-v0.1.md` 现有第 3 节"统一 Adapter 接口"之后新增一小节，明确 `stream?` / `cancel?` 可选方法的调用契约与帧→事件映射关系。**仅改文档，无代码变更。**

## 依赖

无（M1 起点）。

## 前置阅读

- `docs/contracts/runtime-contract-v0.1.md` 第 3 节
- `packages/shared/src/contracts.ts:1066` `AgentRuntimeAdapter`
- `packages/shared/src/contracts.ts:932` `AgentRuntimeEvent`
- 上游设计 [`multica-refactor-development-design-v1.md`](../design/multica-refactor-development-design-v1.md) 第 3.1 节

## 测试步骤（红）

TDD 对文档任务的表达形式：**先写"验证约定"**——本任务的验证约定是"接下来的 M1-02 及后续任务写代码时，能引用本文档明确的语义作为依据"。

1. 打开 `docs/contracts/runtime-contract-v0.1.md`
2. Grep 当前文档：`grep -n "stream\|cancel\|流式" docs/contracts/runtime-contract-v0.1.md`
3. 断言：**当前应无"流式帧语义"章节**（这是"红"的证据）

## 实现要点（绿）

在第 3 节末尾追加：

- **3.a 流式语义**：`stream?(runId)` 消费方约定——orchestrator 只调用一次、直到 iterator 终止为止；adapter 保证同 runId 帧按生成顺序推送；`run()` 返回后 iterator 必须在有限时间内终止。
- **3.b 帧类型与事件映射**：明确 CLI 帧的四大类（assistant_text / tool_use / tool_result / result）→ `AgentRuntimeEvent.type` 的映射表（`runtime_progress` / `tool_called` / `tool_completed` / `runtime_completed`）。**内部帧类型定义在 runtimes 模块内部，不进合同**。
- **3.c cancel 语义**：`cancel?(runId)` 幂等；调用后 `run()` 必须以 `status: 'cancelled'` 结束；已发出的帧不撤回。
- **3.d 兼容**：本节为可选实现——adapter 未实现 `stream?` 时，orchestrator 走合成心跳的既有降级路径。

## 验收目标

- [ ] `docs/contracts/runtime-contract-v0.1.md` 新增 3.a–3.d 四小节
- [ ] `grep -n "3.a 流式语义\|3.b 帧类型\|3.c cancel\|3.d 兼容" docs/contracts/runtime-contract-v0.1.md` 命中 4 条
- [ ] `git status` 仅显示一个改动文件
- [ ] 无代码改动（`git diff --name-only` 无 `.ts` 文件）

## 时间估算

10 分钟。

## 提交信息

```
task(M1-01): runtime-contract 补流式语义章节
```

## 常见坑

- 不要在合同里直接写内部帧类型的字段——它是 runtimes 模块内部实现，写进合同就跨层了
- cancel 的"幂等"语义要写清楚，否则后续 M1-13 实现时会自由发挥
