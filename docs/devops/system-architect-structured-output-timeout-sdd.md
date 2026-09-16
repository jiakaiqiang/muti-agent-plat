# 系统架构师结构化输出超时 SDD

状态：已实现
日期：2026-08-20

## 1. 问题与证据

2026-08-19 19:00 左右，系统架构师在同一个工作流节点连续三次执行失败：

| 本地时间 | Runtime invocation | 结果 |
| --- | --- | --- |
| 18:58:33 - 19:08:33 | `acc24513-7be2-43f0-b7ff-a8fd709863b2` | 600 秒 `phase_timeout` |
| 19:16:08 - 19:26:08 | `229b6772-4f5f-48a4-abe9-63ae222ff6d0` | 600 秒 `phase_timeout` |
| 19:27:43 - 19:37:43 | `d949c129-dce4-4025-bd7d-ba5fda62f10f` | 600 秒 `phase_timeout` |

这些调用不是没有模型输出。Claude Code 在每次执行中都读取了工作区并调用了 `StructuredOutput`，但提交的参数不符合严格的 `task_execution_result` 合同：

- 完整结果被包装在根级 `content` 字段中，导致合同字段没有直接位于根对象。
- 修复尝试曾把单个 Artifact 当成整个执行结果。
- 最后一次直接提交根对象时，仍缺少 `requestedContext`、`agentMessages`、`nextSuggestedActions`，并包含合同未声明的根级 `metadata`。
- 单次架构结果约 15-19 KB；每次错误修复需要数分钟，最终撞上 600 秒阶段截止。

时间线把 `isError: true` 的 `StructuredOutput` 事件显示为“工具 StructuredOutput 完成”，掩盖了超时前已经发生的 Schema 校验失败。

## 2. 设计合同

### SPEC-CLAUDE-OUTPUT-001：Provider 根对象纪律

- Claude buffered 和 streaming 两条 prompt 路径必须使用同一组结构化输出约束。
- `StructuredOutput` 参数必须直接使用注册 Schema 的根字段。
- 禁止把整个结果包装在 `content`、`output`、`result`、`payload`、`artifact` 或 `metadata` 中。
- 必须包含 Schema 的全部必填字段，且不得增加未声明的根字段。
- 平台内部 Runtime output 合同继续严格校验，不通过静默解包、丢弃额外字段或补造业务内容来接受错误输出。

修正（2026-08-21）：本条声明的「两条 prompt 路径」不完整。实际存在第三条路径，即 `packages/local-runtime-cli/src/adapters/prompt.ts` 的 `buildLocalRuntimePrompt()`。本地执行（`executionLocation=local`）不解析服务端适配器，因此本次修复对本地路径覆盖率为零，同一失败于 2026-08-21 在本地路径复现。修正见 `docs/devops/local-runtime-structured-output-discipline-sdd.md`。

### SPEC-TASK-EXECUTION-001：执行结果最小完整形状

当 `expectedOutput.kind` 为 `task_execution_result` 时，prompt 必须明确：

- `requestedContext`、`agentMessages`、`nextSuggestedActions` 是必填字段，不是可选字段。
- 没有补充上下文、Agent 消息或下一步建议时，分别使用 `null`、`[]`、`[]`。
- `changedArtifacts` 必须是 Artifact 对象数组；不得把数组或 Artifact JSON 编码成字符串。
- 架构分析正文放在 `changedArtifacts[].content`，不能替代整个 `task_execution_result` 根对象。

### SPEC-RUNTIME-OBS-001：结构化输出失败可见

- `tool_completed` 事件携带 `isError: true` 时，用户可见文案必须表示失败，不能沿用 Provider 的“完成”文案。
- `StructuredOutput` 错误应显示为“结构化输出校验失败”。
- 时间线 metadata 保留 `isError: true` 和最多 200 字符的 `outputPreview`，用于定位缺失字段。
- 事件类型仍保留为 `tool_completed`，因为它表示工具调用已经返回；成功或失败由 metadata 和可见文案表达。

### SPEC-PHASE-TIMEOUT-001：超时只作为安全截止

- `PHASE_TIMEOUT_TASK_EXECUTION_MS=600000` 继续作为整个执行阶段的绝对截止。
- 本次不延长阶段超时，也不在 Schema 校验失败后重置截止时间。
- 超时前出现的结构化输出失败必须留在时间线中，使最终 `phase_timeout` 不再掩盖直接原因。

## 3. 验收

自动化验收：

```powershell
node node_modules/tsx/dist/cli.mjs --test --tsconfig apps/server/tsconfig.json `
  apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.spec.ts `
  apps/server/src/modules/orchestrator/runtime-stream-consumer.spec.ts
npm run typecheck
```

行为验收：

1. 为 `task_execution_result` 生成普通 prompt 和 task-sidecar prompt。
2. 两份 prompt 都必须包含根对象纪律、三个必填空值字段和 `changedArtifacts` 数组约束。
3. 构造一个 Provider 文案为“调用工具 StructuredOutput 完成”但 `isError: true` 的事件。
4. 持久化后的时间线文案必须包含“结构化输出校验失败”，不得包含误导性的“完成”。
5. 既有严格合同测试继续拒绝缺字段、额外字段、错误版本和错误 output kind。

## 4. 非目标

- 不修改 `task_execution_result` 共享 Schema，不把必填字段改为可选。
- 不自动接受 `{ content: task_execution_result }` 等 Provider 私有包装。
- 不增加 Claude Code 内部重试次数。
- 不更改工作流状态机、自动重试策略或 600 秒阶段截止。
- 不通过真实 Claude 调用执行验收，避免外部费用和非确定性；真实回放作为后续人工验收。

## 5. 实施与验证结果

- Claude 普通 prompt 与 task-sidecar prompt 已复用同一套根对象纪律，并补充 `task_execution_result` 必填字段和 Artifact 数组约束。
- `StructuredOutput` 返回 `isError: true` 时，时间线会显示“结构化输出校验失败”及错误摘要，不再沿用 Provider 的“完成”文案。
- 定向回归测试共 45 项，全部通过。
- 服务端完整测试通过：1215 项通过、4 项跳过、0 项失败；附加 7 项开发守护测试全部通过。
- Claude streaming 本地桩 E2E 通过。
- 全仓 `npm run typecheck` 通过。
- 严格 Runtime output Schema、重试策略和 600 秒阶段截止均未修改。
- workflow 版 Claude buffered 桩 E2E 未进入 Runtime：其既有工作流节点夹具缺少发布校验要求的 `stageDescription` 和 `outputContract`。该测试债务不属于本次修复范围；buffered 分支由定向单测和服务端完整测试覆盖。
