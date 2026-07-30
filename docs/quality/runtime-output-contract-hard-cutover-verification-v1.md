# Runtime 输出合约硬切换验收报告 v1

> 日期：2026-07-16  
> 实现状态：通过（主代理完整回归 + 独立子代理终审 PASS）  
> 部署状态：未执行；当前 8099 旧后端未被本次验收重启或替换

## 1. 验收结论

`runtime-output-contract-management-hard-cutover-v1.md` 定义的代码、合约、数据隔离、事件可见性和验证目标已经实现并通过回归。

本轮真实 Codex 验收发现并修复了一个 Stub 未覆盖的协议缺陷：Codex app-server 0.144.1 以 `item/completed` 的 `agentMessage` 作为最终内容，而 `turn/completed.turn.items` 可能为空。Adapter 现在分别使用完成项作为权威输出、Turn 作为权威终态，再把未经修复的原始 JSON 对象交给共享 validator。

该修复属于 Provider 传输协议组装，不兼容旧 Runtime 输出，不补默认字段，也不把纯文本包装成合法对象。

最终 Codex streaming E2E 还暴露并修复了两个此前单测未覆盖的真实缺口：

1. 工程 Agent 的 Profile 固定声明写文件和命令工具，`task_acceptance` 等只读阶段会将这些工具标记为 `PHASE_BLOCKED`。旧解析器把阶段隔离误判为整个调用失败。现在仅 `PHASE_BLOCKED` 的工具会从本阶段 Catalog 隔离并保留审计记录；审批缺失、Capability 缺失、Workspace/Runtime/执行器不满足仍保持 fail-closed。
2. `runtime-result-context-normalizer.ts` 会删除严格合约中的显式 `requestedContext: null`，也会尝试重写畸形输出。现在 Runtime 输出在共享结果边界原样保留，任何畸形结构由同源 validator 拒绝；只对平台内部 `RuntimeError.requestedContext` 做防御性清洗。

## 1.1 独立子代理完成审计

按用户要求，主实现完成后由独立子代理重新检查源码和验收证据，而不是复述主代理结论。独立审计第一次明确判定“尚未真正完成”，发现以下 5 个缺口：

1. `RuntimeError` 在 Execution/Session/Web 链路丢失 `code`、`retryable`、`details`。
2. Generic LLM 仍会截取 fence/花括号并转义裸控制字符；Codex buffered 仍接受本地包装别名。
3. 模型 proposal 的文件变更仍会进入 Artifact metadata，并被上下文当作 diff 证据。
4. `agent.text_delta`、`tool.called`、`tool.completed`、`run.completed` 旧 Codex 通知仍被生产解析器接受。
5. RuntimeInvocation 启动门禁只检查版本，未逐项对比当前注册中心的 `contractId` 和 `schemaHash`。

第一轮修复后，同一独立审计代理再次从绕过路径出发检查，并继续判定“尚未完成”，发现以下 5 个深层缺口：

1. Generic LLM 仍能从顶层或模型内容中的 `result`、`output`、`final_output` 对象递归取出 RuntimeOutput。
2. 注册中心 validator 会先经 JSON 序列化删除值为 `undefined` 的额外字段，导致非法对象被静默清洗后通过。
3. Codex buffered JSONL 会忽略非 JSON 行，也会接收伪造的 completed-item 外层信封。
4. `task_acceptance` Runtime 失败没有把完整 RuntimeError 传给任务流水线；一次过宽修复又会把 `CAPABILITY_BLOCKED` 等交互错误误判为基础设施失败。
5. Artifact 仍混用了模型 proposal、平台生成的待写入文件和平台观测证据，前端仍直接读取含义模糊的 `payload.fileChanges`。

第二轮整改逐项增加负向测试，并把 Artifact 固定为 `runtimeProposals`、`platformProjections`、`systemEvidence` 三个域。失败分类只新增 `RUNTIME_OUTPUT_CONTRACT_VIOLATION`，没有改变 `CAPABILITY_BLOCKED`、`TOKEN_BUDGET_EXCEEDED`、`CONTEXT_INSUFFICIENT` 的原有交互策略。

最终回归前，独立审计第三次拒绝提前给出通过结论，指出 Codex/Claude 两条 Runtime stub E2E 和验收报告证据仍未闭环。整改结果为：

1. Windows 深层托管 worktree 中，`git show <commit>:<path>` 会在 revision/path 消歧时对组合参数执行 `stat` 并触发 `Filename too long`；基线读取现改为 `git cat-file blob <commit>:<path>`，直接读取已经解析的 blob。
2. Claude stream-json 夹具等待 `control_response`，而 Adapter 关闭 stdin；该无控制通道场景现在显式使用 `STUB_SKIP_CONTROL=1`，并验证 result frame、真实 worktree 文件捕获和源工作区隔离。
3. 旧 E2E 已迁移到显式 Workflow 发布/选择、新 `acceptanceDecision`、Artifact 三域和 `systemEvidence.workspaceChangeSet`；不再从旧 payload 字段读取结果。

前三轮独立审计解决了 Provider、Artifact、RuntimeError 和 invocation 身份门禁问题，但后续扩大到完整工作流验收后又发现了新的闭环缺口，因此早期 PASS 不能作为本次最终结论。整改后的权威行为为：

- Provider 内容必须是可直接解析的完整 JSON；不剥 fence、不截取、不转义修复、不接受非官方本地包装。
- 模型重新生成是新的、可计数的 Provider 请求，原始非法输出始终保持拒绝。
- 模型提议只进入 `runtimeProposals`；平台生成的待写入文件只进入 `platformProjections`；diff 证据与“平台观测文件变更”只读取 `systemEvidence.workspaceChangeSet`。
- `RuntimeError` 从 Adapter/Orchestrator 经 ExecutionService、Session 事件传到 Web 错误卡，保留 `code`、`message`、`retryable`、`details` 和 `requestedContext`。
- 旧 Codex 方法只作为未知 debug 通知处理，不能驱动用户进度、工具或结果状态。
- 持久化 invocation 的 `contractId`、`contractVersion`、`schemaHash` 必须与当前注册中心完全一致。

## 1.2 后续完整工作流审计与整改

2026-07-16 的后续审计把范围从单个 Runtime Adapter 扩展到 Brief、Workflow、Task acceptance、执行中插话、Post Review、Rework、RAG 与最终交付。新增完成项如下：

1. 所有“确认 Brief 后等待完成”的活动 E2E 都显式发布并选择 Workflow；Harness 会阻止旧的隐式执行路径重新出现。
2. `task_acceptance_decision@1.0` 成为唯一 Runtime 接受合约，旧 `claimDecision` payload 和旧任务 Agent id 字段不再进入 Shared、Server、Web、E2E 或活动合同文档。
3. 执行中高优先级补充上下文会取消被替代 invocation，并在同一 Workflow 节点上重启；不会把整个 Workflow 误取消。
4. Post Review 返工创建新的 Workflow run；`ask_user` 进入 `WAIT_USER_DECISION` 并保留可操作确认，不再误标 Workflow 失败。
5. 模型 proposal、平台待写入 projection 和平台观测证据保持三域隔离；本地架构报告只能由平台生成路径写入。
6. Codex workdir sidecar 只序列化权威 `ContextEnvelopeV2`；执行中补充记忆进入 L5，不伪造成 L3 文件证据。
7. RAG 查询同时包含用户原始目标、Brief 和当前 Workflow task 语义，P1 进程级验收验证 `rag_retrieved` 能命中知识 marker。
8. P1 插话测试等待同一任务的 `task_started -> runtime_started` 事件序列，消除了把 Session `EXECUTING` 误当成任务已开始的竞态。
9. 独立只读子代理终审补跑 `npm run test:harness:v2-only-context`，确认 17/17 通过；同时确认 RuntimeOutput `0.1` fixture 未回流、旧任务字段归零、真实 Codex 台账 exactly 3 次、报告诚实记录未部署/未执行环境项、`git diff --check` 通过。

本轮未为补证据发起第 4 次真实 Codex 调用，也未重启或替换 8089/8099 的现有服务。

## 2. 需求与证据矩阵

| 验收项 | 结果 | 权威证据 |
| --- | --- | --- |
| 七类 `1.0` 输出集中注册 | 通过 | `packages/shared/src/runtime-contracts/registry.ts` 与 7/7 注册中心测试 |
| 类型、Schema、示例和 validator 同源 | 通过 | TypeBox 声明、`runtimeOutputExamples`、AJV strict validator |
| 对象封闭、字段必填、可选语义使用 `null` | 通过 | Strict preflight 与非法 fixture 测试 |
| Runtime 启动前 Preflight | 通过 | `assertRuntimeContractsReady()` 模块启动门禁 |
| Codex、Claude、Generic LLM、Mock 使用同一合约 | 通过 | Provider 针对性测试与三类 E2E |
| Mapper 不修复旧输出 | 通过 | 缺字段、额外字段、旧版本、错误 kind、纯文本拒绝测试 |
| Provider 不做文本级本地修复 | 通过 | fence、前后文本、裸控制字符、Codex 包装别名全部拒绝测试 |
| Runtime 结果边界不删除 `null` 或重写输出 | 通过 | `runtime-result-context-normalizer` 原样保留测试与 Codex streaming E2E |
| Tool Authority 按阶段隔离工具且不放宽硬权限 | 通过 | `PHASE_BLOCKED` 只读阶段回归测试；其他 blocked reason 继续返回 `CAPABILITY_BLOCKED` |
| Artifact 三域分离 | 通过 | proposal、platform projection、system evidence 顶层分域；旧 metadata/payload `fileChanges` 消费路径移除；只有 WorkspaceChangeSet 能生成 diff 证据 |
| 内部协议通知不进入用户时间线 | 通过 | 事件分类、Web 过滤、Codex streaming E2E；原始通知保留在 Debug/Audit |
| 新 data schema 与新 epoch 隔离旧数据 | 通过 | `dataSchemaVersion=3`、`state.v3.json`、Session/Queue/Recovery/Broker 门禁测试 |
| Invocation 记录合约身份 | 通过 | Debug 数据包含 contract id、version、schema hash |
| Invocation 启动门禁校验当前身份 | 通过 | 错误 contract id/hash 持久化 fixture 均以 `CUTOVER_REQUIRED` 拒绝 |
| RuntimeError 端到端保真 | 通过 | Execution/Session/Web 测试与隔离浏览器错误卡验收 |
| 真实 Codex 接受 Strict Schema | 通过 | Codex CLI 0.144.1 真实 probe，修复后连续两次完成 |
| 全量回归不影响其他功能 | 通过 | typecheck、test、Harness、build 全部通过 |

## 3. 三次真实 Codex 调用

用户明确授权了 3 次真实调用，本轮未超过该上限。

| 次数 | 结果 | 说明 |
| --- | --- | --- |
| 1 | 失败并定位根因 | `turn/start` 未出现 Schema 拒绝；Codex 完成了真实流式过程，但旧 Adapter 只读取空的 `turn.items`，本地报 `agent_message: / must be object`。耗时 47,505 ms。 |
| 2 | 通过 | 修复后结构化输出通过同源 validator；耗时 41,395 ms，15,809 tokens，返回 CLI session id 与 stream metrics。 |
| 3 | 通过 | 独立复验再次通过；耗时 82,516 ms，17,578 tokens，返回 CLI session id 与 stream metrics。 |

修复后的两次调用均未出现：

```text
schema must have a 'type' key
Invalid schema for response_format 'codex_output_schema'
```

证据限制：旧验收脚本会覆盖固定状态文件，因此第 1、2 次调用的原始 JSON 未完整保留；其耗时、token 和结果来自当时终端捕获。第 3 次原始状态文件及 SHA-256 已保留。详细台账见 `docs/quality/runtime-output-contract-real-codex-ledger-2026-07-15.json`。脚本现已改为额外写入带时间戳的不可变历史文件，后续调用不会再覆盖前次证据。未为补证据而增加第 4 次付费调用。

## 4. 最终验证

```text
npm run typecheck        PASS
npm run test             PASS
  shared                 68/68
  server                 892 passed, 0 failed, 1 Windows symlink permission skip
  web                    108/108
npm run test:harness     PASS
npm run build            PASS
npm run test:e2e:main-chain                       PASS
npm run test:e2e:p1-behaviors                     PASS
npm run test:e2e:workflow-managed-execution       PASS
npm run test:e2e:executing-supplement-reschedule  PASS
npm run test:e2e:rework-loop                      PASS
npm run test:e2e:codex-streaming                 PASS
npm run test:e2e:generic-llm-response-shapes     PASS
npm run test:e2e:claude-streaming                PASS
npm run test:e2e:v2-startup-gate                 PASS
npm run test:e2e:artifact-file-changes           PASS
npm run test:e2e:codex-runtime-stub              PASS
npm run test:e2e:claude-code-runtime-stub        PASS
npm run test:e2e:task-acceptance-decision        PASS
npm run test:e2e:task-acceptance-fallback        PASS
npm run test:e2e:server-local-source-write-guard PASS
npm run test:e2e:codex-executing-supplement-context PASS
真实 Codex probe                                  2/2 after fix
git diff --check                                  PASS
独立子代理终审                                  PASS
隔离浏览器：错误卡 + Debug RuntimeView             PASS
```

隔离浏览器使用临时 v3 state、临时后端端口和临时 Vite 端口完成，验证到：

- Debug RuntimeView 显示 `runtime.output.task_brief`、`1.0`、`fnv1a32:6ecc713d`、`dataEpoch` 与 System Evidence 计数。
- 故意选择不可用的 Codex 工作区产生结构化错误卡，页面显示 `CAPABILITY_BLOCKED` 与“不可重试”。
- 临时浏览器标签、前后端进程和状态文件均已关闭/删除；没有连接、重启或替换 `8089/8099`。

构建仍有第三方 PURE annotation 和大 chunk 警告，但没有构建错误，与本次 Runtime 合约改造无关。

环境相关的未执行项：本机没有可用 Ollama，因此 `tool-loop-ollama` 跳过；`tool-loop-minimal` 使用外部 Generic LLM 凭证时收到 401 invalid token。这两项没有被伪报为通过，也不影响本地 mock/stub、严格合约和完整工作流回归结论。

## 5. 部署边界

本报告证明当前工作区代码实现通过，不代表运行中的旧服务已切换。

浏览器现场检查显示：8089 前端期望 `pipeline=v2 / dataSchemaVersion=3`，8099 当前后端仍返回 `dataSchemaVersion=2`，因此页面显示 `BACKEND_VERSION_MISMATCH`。本次工作没有擅自重启、部署、执行 data cutover 或删除旧数据。

正式切换仍应按设计文档的发布步骤执行：停止入口、备份、完整版本部署、Contract Preflight、新 data epoch、健康检查、Runtime 冒烟和 Web 验证。回滚必须使用旧代码与对应旧数据快照成对恢复。
