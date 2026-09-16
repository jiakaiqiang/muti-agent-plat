# 本地 Runtime 结构化输出纪律 SDD

状态：已实现
日期：2026-08-21
关联：`docs/devops/system-architect-structured-output-timeout-sdd.md`（2026-08-20，本文修正其覆盖范围）

## 1. 问题与证据

2026-08-21 系统架构师再次出现 2026-08-20 已声明修复的同一失败：时间线显示「工具 StructuredOutput 结构化输出校验失败：Output does not match required schema: root: must have required property 'schemaVersion', root: must have required property 'kind', root: must have required property 'status'」。

### 1.1 失败样本

从 `collaboration_events` 取出的 5 次 `StructuredOutput` 校验失败：

| 形态 | 数量 | 提交的根对象 |
| --- | --- | --- |
| 把单个 Artifact 当成整个执行结果 | 4 | 根字段为 `uri`/`type`/`title`/`content`/`summary`，缺 `schemaVersion`/`kind`/`status`，另含合同未声明的 `statusInfo`、`agentMessagesJson`、`summaryText` |
| `task_brief` 数组字段提交成字符串 | 1 | 字段名正确，但 `scope`/`outOfScope`/`constraints`/`acceptanceCriteria`/`risks`/`openQuestions` 六个数组字段是字符串 |

第一种形态的根字段集合与 `RuntimeArtifactOutputSchema` 完全一致，说明模型把 `changedArtifacts[]` 的元素误当成了返回值本体。其中一条的 `content` 字面值是 `STRUCTURED_OUTPUT_PLACEHOLDER`。

涉及 Agent `0001`、`0003`、`0004`，不是单个 Agent 的偶发行为。

### 1.2 为什么 2026-08-20 的修复没有生效

四个失败调用的执行目标均为 `executionLocation=local`、`workspaceProviderKind=local_bridge`。

`apps/server/src/modules/runtimes/runtime.service.ts` 在本地执行时不解析服务端适配器：

```text
const isLocalExecution = input.executionTarget.executionLocation === 'local';
const adapter = isLocalExecution ? undefined : this.registry.getAdapter(runtimeType);
```

2026-08-20 的修复只写在 `ClaudeCodeRuntimeAdapterService.prompt()` 里，本地执行根本不经过它。实际执行路径是 `packages/local-runtime-cli/src/adapters/prompt.ts` 的 `buildLocalRuntimePrompt()`，该函数只给出 Schema 和 example，没有任何根对象纪律。在整个 `packages/local-runtime-cli` 内检索 `changedArtifacts|root arguments|Never wrap|StructuredOutput|schemaVersion`，无任何匹配。

即 SPEC-CLAUDE-OUTPUT-001 声明的「两条 prompt 路径」漏掉了第三条，而第三条正是本次失败发生的路径，覆盖率为零。

### 1.3 为什么模型能自由猜测结构

反编译 claude.exe v2.1.238 后确认，`--json-schema` 只有在 Schema 通过关键字白名单（`$schema`、`type`、`description`、`title`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`const`、`anyOf`）时才会派生 `strictInputJSONSchema` 并启用约束解码。用同一份过滤规则回放 9 个已注册合同，结果是 9/9 全部退化为事后校验，原因是合同普遍使用 `minLength`、`minimum`、`pattern`、`minItems`。且启用条件为 `e.strictInputJSONSchema && it("tengu_structured_output_strict", !1)`，开关默认关闭。

结论：约束解码不可依赖，prompt 纪律是当前唯一可控杠杆。

`packages/shared/src/runtime-contracts/preflight.ts` 的 `assertStrictJsonSchema` 允许的关键字比 Provider 白名单更宽，内部 preflight 通过并不代表 Provider 侧能约束解码。

### 1.4 超时是结果而不是原因

`PHASE_TIMEOUT_TASK_EXECUTION_MS=600000`。每轮校验失败后模型需重新组装约 12 KB 的结果，单轮耗时数分钟：10:07:42 与 10:58:46 两次跑满 600 秒判定 `RUNTIME_TIMEOUT`，10:25:09 在 565 秒勉强完成。

### 1.5 已经生效的部分

SPEC-RUNTIME-OBS-001 有效。时间线正确显示「结构化输出校验失败」而不是「完成」，因为 `isError` 由 shared 的 `frameToRuntimeEvent` 设置、由 `runtime-stream-consumer.ts` 渲染，两条路径共用。这本身就是把纪律文本放进 shared 的依据。

## 2. 设计合同

### SPEC-OUTPUT-DISCIPLINE-001：纪律文本单一来源

- 结构化输出根对象纪律必须由 `@agent-cluster/shared` 唯一导出，不允许各 Runtime 路径各写一份。
- 服务端适配器不得保留私有副本；`claude-code-runtime-adapter.service.ts` 的本地 `claudeStructuredOutputInstructions()` 必须删除并改为引用 shared。
- 纪律文本必须与工具无关：`buildLocalRuntimePrompt()` 同时服务 Codex，而 Codex 没有 `StructuredOutput` 工具。工具名由调用方按 Provider 传入，缺省时表述为「你返回的那个 JSON 对象的根属性」。

### SPEC-LOCAL-OUTPUT-001：本地 CLI 路径必须携带同一纪律

- 修正 SPEC-CLAUDE-OUTPUT-001：prompt 路径是三条而不是两条，即服务端 buffered、服务端 streaming、本地 CLI。
- `buildLocalRuntimePrompt()` 生成的 prompt 必须包含根对象纪律，覆盖 Claude 与 Codex 两个本地适配器。
- 本地 Claude 适配器必须传入工具名 `StructuredOutput`；本地 Codex 适配器不传工具名。
- 纪律必须对全部 9 个 output kind 生效，且必须显式给出本次调用所需的 `schemaVersion` 与 `kind` 字面值，因为观测到的错误正是缺失这两个字段。

### SPEC-TASK-BRIEF-001：task_brief 数组字段纪律

当 `expectedOutput.kind` 为 `task_brief` 时，prompt 必须明确：

- `scope`、`outOfScope`、`constraints`、`acceptanceCriteria`、`risks`、`openQuestions` 是必填的字符串数组。
- 空集合使用 `[]`，不得把数组字段写成字符串。
- 不得把数组字段或 `suggestedTasks` JSON 编码成字符串。

### SPEC-TASK-EXECUTION-001（继承）：执行结果最小完整形状

沿用 2026-08-20 的约束，文本迁移到 shared 后逐字保持，服务端既有 7 项 prompt 断言必须继续通过：

- `requestedContext`、`agentMessages`、`nextSuggestedActions` 必填，空值分别为 `null`、`[]`、`[]`。
- `changedArtifacts` 必须是 Artifact 对象数组，不得 JSON 编码成字符串。
- 架构或设计正文放在 `changedArtifacts[].content`，不替代 `task_execution_result` 根对象。

### SPEC-LOCAL-DEPLOY-001：本地 CLI 构建前置条件

- `packages/local-runtime-cli` 的 bin 指向 `dist/local-runtime-cli/src/cli.js`，运行的是构建产物而不是源码。
- 只改 `src` 不重新构建时，本修复不会生效，且失败现象与修复前完全一致。
- 因此验收必须包含一次 `npm run build`，并在交付说明中标注该前置条件。

## 3. 验收

自动化验收：

```powershell
node node_modules/tsx/dist/cli.mjs --test --tsconfig apps/server/tsconfig.json `
  apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.spec.ts
npm run test --workspace @agent-cluster/shared
npm run test --workspace @agent-cluster/local-runtime-cli
npm run typecheck
npm run build
```

行为验收：

1. 对全部 9 个 output kind 生成纪律文本，每份都必须包含根对象纪律与该 kind 的 `schemaVersion`、`kind` 字面值。
2. 传入工具名时文本出现 `the root arguments to StructuredOutput`；不传时不得出现任何工具名。
3. `task_execution_result` 的纪律必须包含三个必填空值字段与 `changedArtifacts` 数组约束。
4. `task_brief` 的纪律必须包含六个数组字段的名字与禁止字符串化的约束。
5. `buildLocalRuntimePrompt()` 对 Claude 产出的 prompt 必须包含纪律与 `StructuredOutput`；对 Codex 必须包含纪律但不含 `StructuredOutput`。
6. 服务端普通 prompt 与 task-sidecar prompt 的既有 7 项断言全部继续通过。
7. 既有严格合同测试继续拒绝缺字段、额外字段、错误版本和错误 output kind。

## 4. 非目标

- 不修改任何 Runtime output Schema，不把必填字段改为可选，不放宽 `additionalProperties: false`。
- 不自动解包 `{ content: ... }` 等 Provider 私有包装，不丢弃额外字段，不补造业务内容。
- 不修改 600 秒阶段截止，不修改重试策略。
- 不为了换取约束解码而删除 `minLength`、`minimum`、`pattern`、`minItems`：开关默认关闭，改 Schema 换不回约束解码。
- 不在本次修复中补齐本地路径的 `tool_invocations` 审计落库。
- 不在本次修复中把 routingMode 拼写约束加进 shared：服务端两条路径已覆盖，本地缺失属于未观测到的潜在缺口。
- 不通过真实 Claude 调用执行验收，避免外部费用和非确定性。

## 5. 实施与验证结果

### 5.1 改动清单

| 文件 | 改动 |
| --- | --- |
| `packages/shared/src/runtime-contracts/structured-output-instructions.ts` | 新增。纪律文本唯一来源，`buildStructuredOutputInstructions(kind, { submissionToolName? })`；工具名缺省时表述为「你返回的那个 JSON 对象」 |
| `packages/shared/src/runtime-contracts/index.ts` | 导出新模块 |
| `packages/local-runtime-cli/src/adapters/prompt.ts` | 本次缺口本体。`buildLocalRuntimePrompt()` 注入纪律，新增 `LocalRuntimePromptOptions` |
| `packages/local-runtime-cli/src/adapters/claude-code-adapter.ts` | 传入 `submissionToolName: 'StructuredOutput'` |
| `packages/local-runtime-cli/src/adapters/codex-adapter.ts` | 未改动。不传工具名，符合 SPEC-OUTPUT-DISCIPLINE-001 |
| `apps/server/src/modules/runtimes/claude-code-runtime-adapter.service.ts` | 删除私有 `claudeStructuredOutputInstructions()`，两处调用点改为引用 shared |
| `packages/shared/src/structured-output-instructions.spec.ts` | 新增 5 项测试 |
| `packages/local-runtime-cli/src/adapters/prompt.spec.ts` | 新增 7 项测试 |
| `packages/local-runtime-cli/package.json` | 在枚举式 `test` 脚本中注册新 spec，否则永不执行 |

### 5.2 验证结果

- `@agent-cluster/shared`：85 项通过、0 项失败。
- `@agent-cluster/local-runtime-cli`：80 项通过、0 项失败，含新增 7 项 prompt 测试。
- `claude-code-runtime-adapter.service.spec.ts`：36 项通过、0 项失败。SPEC-TASK-EXECUTION-001 要求的既有 7 项 prompt 断言在文本迁移到 shared 后继续通过。
- 全仓 `npm run typecheck` 通过。
- 全仓 `npm run build` 通过。
- 构建产物核对：`dist/local-runtime-cli/src/adapters/prompt.js` 确实调用纪律函数，`claude-code-adapter.js` 确实带 `submissionToolName`，本地 CLI 自带的 shared 副本与服务端 dist 中都存在纪律文本。

### 5.3 交付前置条件

SPEC-LOCAL-DEPLOY-001 已在仓库内满足，但对已安装的本地 CLI 不自动生效：

- `packages/local-runtime-cli` 的 bin 指向 `dist/local-runtime-cli/src/cli.js`，且 `dist` 内自带一份 shared 副本，不共享仓库根的 `packages/shared/dist`。
- 用户机器上运行的本地 Runtime CLI 必须重新构建或重新安装，否则继续使用旧 prompt，失败现象与修复前完全一致。
- 实施过程中先跑测试、后构建 shared 时复现过同一失败类别：`does not provide an export named 'buildStructuredOutputInstructions'`，因为 shared 的 `main` 指向 `dist/index.js`。这条实测支持了该 SPEC 的必要性。

### 5.4 遗留

- 本修复只提高 prompt 纪律，不能在协议层保证根对象正确。约束解码 9/9 退化为事后校验且开关默认关闭，模型仍可能提交错误根对象；本次只消除「本地路径完全没有纪律」这一确定性缺口。
- 真实 Claude 回放验收未执行，属声明的非目标。修复效果需在下一次系统架构师本地执行中观察。
- 本地路径 `tool_invocations` 审计落库、`preflight.ts` 与 Provider 白名单宽度差异、本地 routingMode 拼写约束，三项仍未处理。
