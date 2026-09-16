---
artifact: design_plan
stage: design
producedBy: architect
schemaVersion: "0.1"
status: ready
deliveryId: agent-execution-reliability-v1
createdAt: 2026-09-14
intentContractRef: agent-execution-reliability-spec-v1
---

# Plan：Agent 执行可靠性与调用效率修复

[Spec](../product/agent-execution-reliability-spec-v1.md) · [Tasks](../implementation/agent-execution-reliability-tasks-v1.md) · [Checklist](../quality/agent-execution-reliability-checklist-v1.md)

## 1. 决策、约束与现状

选择在现有模块内逐步收敛控制逻辑：先修复重复路由和预算边界，再减少无效模型工作，最后增强检查点。仅放宽超时无法解决重复执行；全量重写调度器会扩大风险，均不作为本方案。

依据用户讨论，保留所选工作流、严格质量语义、双端独立外观、本地目录授权和真实文件证据。本设计已进入实现并完成隔离验证；实现复用现有停止回执、StructuredOutput 监督、Workflow NodeRun/attempt、WorkspaceChangeSet 和恢复入口。后文为目标设计，实际落点与限制见第 9 节及 Checklist。

| 模块 | 当前落点 | 计划职责 |
| --- | --- | --- |
| context-management / intent-recognition / sessions | isSnapshotCurrent、finish、processIntentRouting | 业务指纹、重建计数、控制规则、幂等应用 |
| runtime-invocation / runtimes / orchestrator | invoke、start、runRuntime、runOneTask | 共享操作监督、子调用预算、预检复用 |
| local-runtime / packages/local-runtime-cli | invocation event/result、runtime.ts、适配器 | 有效进展、真实结束回执、候选捕获与恢复 |
| runtime-routing / agents | InvocationResolver、SystemAgentRuntimePolicy | 已授权候选内分阶段选择、连接级故障隔离 |
| workflows / recovery / persistence | NodeRun、checkpointInterruptedExecution、写回恢复 | 检查点一致性、迁移、恢复与副作用幂等 |
| shared / Web / desktop | 类型、taskActivity、工作区组件 | 合同版本、诊断事件、共享状态呈现 |

相关权威文档：[Runtime 合同](../contracts/runtime-contract-v0.1.md)、[事件合同](../contracts/event-contract-v0.1.md)、[质量返工规格](../product/workflow-quality-rejection-rework-spec-v1.md)、[工作区隔离与写回](workspace-multi-session-isolation-writeback-v1.md)、[原桌面工作区规格](../product/codex-style-multi-agent-workspace-spec-v1.md)。本设计为目标行为，实施时同步这些合同，不能将未实现目标提前写成现有能力。

## 2. 调用与预算架构

```text
用户消息 / Workflow 节点
  → 规则路由或程序预检
  → LogicalOperation（持久化预算、业务版本、恢复位置）
  → InvocationResolver（授权、Runtime、模型、工具、输出版本）
  → 共享 Supervisor → local bridge / server adapter
  → 真实候选与测试证据 → 严格提交验证
  → 检查点 → 既有 FIFO 写回 / 工作流迁移
```

Supervisor 是现有 Runtime 调用链的内部实现，不新增独立调度产品或公开服务。监督职责单一：外层负责逻辑操作预算，适配器负责传输/进程结束和具体工具时限；移除重复创建相互覆盖的阶段计时器。系统 RuntimeInvocationService 不能绕过它。

### 2.1 建议持久化模型

以下为目标字段，T0/T2 需对现有 shared 类型和关系存储映射逐字段审计；最终命名在实现与合同中一致。

| 对象 | 必需信息 | 不变量 |
| --- | --- | --- |
| RoutingRecord | businessFingerprint、snapshotRebuildCount、operationId、actionIdempotencyKey | 计数独立、单调；原因字段不控制次数 |
| LogicalOperation | id、parentId、session/workItem/task/nodeAttempt、policyVersion、status、deadlineAt、remainingActiveMs、maxAttempts、attemptsUsed、stopState | 原子预留调用额度；子 deadline 不晚于父 deadline |
| Invocation | operationId、attempt、connectionId、modelId、protocol、phase timings、failureClass | 不记录凭据；模型未知保留原因 |
| AcceptanceCheckpoint | inputFingerprint、agent/permission/tool/evidence versions、decisionSource、decision | 仅相同有效输入可复用 |
| ExecutionCheckpoint | operation/nodeAttempt、baseRevision、candidate manifest/hash、test evidence、submissionVersion、writebackId、completed stages | 检查点指向实际受控产物；不能用 success 文案替代事实 |

同一逻辑消息预算覆盖网络重试、Schema 修复和快照重建；初始 maxAttempts=2、active budget=120000ms。快照最多重建一次不表示额外赠送两次调用。CLI 内部模型请求可能不全部可观察，平台尝试数不得冒充真实 HTTP 请求数；以父截止限制不可见内部重试，已知内部用量另记。

开发/验证按节点和操作设置有界策略，初次迁入当前有效阈值；没有足够样本不直接修改生产阈值。补上下文、接单回退、Provider 替代、结果格式修复沿用父预算。工具重试不得重放未知副作用。

等待用户前结束并确认所有活动调用，暂停扣减 active budget 并保存剩余额度。正常恢复继续剩余额度；额度耗尽后的显式“重新尝试”创建关联的新操作并留审计，自动恢复不得重置预算。后端停机后活动操作标为 interrupted/stop-unconfirmed，核对进程与写回后等待显式恢复；不因重启自动重跑模型。

## 3. 第一批：停止无效循环

### 3.1 业务指纹与原子应用

业务指纹至少覆盖 activeWorkItemId/revision、需求输入版本、决策账本、影响控制动作的任务/工作流状态、待确认目标。不能继续引用被普通日志推进的通用事件计数或通用 touchedAt。新需求到来时先更新业务版本，再允许应用后续判断。

持有 routing lease 的处理者在应用前重新校验业务版本，并在同一持久化事务中消费 actionIdempotencyKey 与记录决定；实际执行通过既有幂等 effect/执行入口推进，避免“数据库已标完成但业务动作未发送”的间隙。租约过期的旧返回不得提交。

业务变化首次发生时原子递增 snapshotRebuildCount；第二次变化或预算耗尽时结束自动处理，使用现有澄清/等待能力。将 stale 处理从递归改为有界驱动。迁移旧路由记录缺计数时按新策略重新核对，不复活终态路由。

### 3.2 有效活动与终止

统一分类 transport / model_output / tool_started / tool_progress / tool_result / submission / diagnostic。去重后的有效活动可更新时间；重复错误、心跳和重放事件不可续期。工具运行设置作用域截止，缺少工具进度协议时明确降级为有界等待，不能假装持续有进展。

停止状态 proposed→requested→confirmed，或 requested→unconfirmed。仅 confirmed 允许启动替代调用；迟到回执只清理停止状态。失败分类与终止理由保持一致，格式预算耗尽不能记为“被新需求替代”。若需扩展 termination kind，须补齐 shared 解码、旧版本行为及合同测试。

### 3.3 Provider 策略

认证/协议/Schema 不兼容不可自动重试；DNS/网络失败有限重试；429/临时 5xx 按 Retry-After 加有界退避；424 等非标准业务错误依赖结构化错误码，不单凭 HTTP 数字一概判断。

隔离键采用 connectionId + modelId + protocol；未知模型使用显式 unknown 分桶且记录证据缺失。切换时重新验证 Runtime 支持、工作区位置、权限、输出合同和用户允许列表。替代候选不足则等待，不静默改为 mock、换账号或新供应商。

## 4. 第二批：减少无效模型工作

### 4.1 程序预检与接单复用

按确定性配置检查 Agent 职责范围、可用工具/权限、目录 revision、上游产物和 Runtime 可用性。满足最低条件可生成 decisionSource=rule 的 accepted；这不是模型承诺或验收结论。预检中职责/目标不明确时仅提供短上下文给现有 SystemAgentRuntimePolicy 允许的判断 Runtime。

输入指纹未变的执行重试复用接单。已明确 rejected/blocked 的结果不被通用预检覆盖，仍走现有补上下文/改派/停车分支。质量阶段 accepted 表示可以开始验证，不能自动 approve。

### 4.2 讨论与上下文

需求讨论聚焦未知问题；架构阶段引用已确认需求和项目索引，输出变更范围/约束/风险。选中 Workflow 的必需节点按原依赖执行，不能自动改快照。独立咨询可在同一冻结输入下受限并发，按原角色顺序合并并显式呈现冲突；并发度默认 1，容量验证后再配置。

初始上下文只含当前任务、相关上游引用和索引，正文按需读取并计入预算。性能报告同时统计初始输入、工具读取、缓存与累计用量，不将初始预算误当作整个 CLI 循环的 token 硬限制。

### 4.3 输出合同演进

新增显式版本的简化提交合同，描述 status、summary、artifactRefs、blockers、nextActions；以严格 Schema 定义每个字段，不由模型生成平台对象身份或测试事实。系统按可信候选清单与工具证据组装领域结果，并独立验证权限、基线和内容完整性。

输出注册表从仅按 kind 查找扩展为按 kind/version 查找，能力协商决定是否可用新版本；运行创建时冻结 outputContractVersion。旧存量输出继续按原 Schema 解码，新运行不降级接受非法旧输出。这里是输出数据版本兼容，不恢复旧 Context 主链路。

格式修复输入仅包含原候选引用、原提交、Schema 错误和必要业务信息，禁用写入和工具副作用。已有一次格式纠正策略复用父预算。CLI 若没有产物捕获能力且在输出解析前退出，先通过 T8 接入可靠候选捕获，不能只改 Prompt 就宣称产物恢复。

## 5. 第三批：节点内检查点

先在现有 Workflow NodeRun / effect / writeback 机制上增加阶段信息，避免并行的第二套工作流状态机。阶段区分 prepared、candidate_captured、verified、submission_validated、writeback_confirmed；验证失败也保存证据和失败结论，不能记为 verified-pass。

Local Runtime 不再在任何失败路径中无条件丢弃可恢复候选。候选须位于 Runtime 自有目录，通过 manifest/hash 提交平台可引用的标识，禁止任意路径读取。捕获须在进程结束后形成一致快照；运行中的未确认候选不用于写回。

| 失败位置 | 恢复输入 | 下一动作 |
| --- | --- | --- |
| 提交格式 | 候选清单＋原提交＋校验错误 | 只修复并验证提交 |
| 测试不通过 | 候选文件＋失败测试证据 | 修改必要代码后复测 |
| 下游执行 | 已完成且版本有效的上游产物 | 当前下游新 attempt |
| 写回冲突 | 原 ChangeSet＋当前文件版本 | 既有冲突决策，不重跑模型 |
| 候选缺失或失效 | 历史摘要、原任务与缺失原因 | 显式节点重试，不伪装续接 |

候选保留策略须有大小上限、过期时间和引用检查；删除仅作用于已验证的 Runtime 自有候选目录，不能触碰用户源码。过期引用返回可解释错误。续接必须隔离 session/workItem/task/权限，不能将旧 CLI 会话直接绑定新目录。

## 6. 双端与观测

服务端诊断事件附 operationId、invocationId、phase、activityKind、retryReason、policyVersion、elapsedMs、remainingMs、stopState。前端将其映射为中文阶段，阶段是事实映射，不能仅因收到心跳显示“任务正常”。未知模型、不可观测上游排队分别显示 unknown，而非推测。

记录 queue/preparation/first-useful-output/tool/validation/backoff/active-total；无法拆分的 CLI 内部等待使用 unclassified，不重复相加。整任务端到端时间与人工等待分列。共享 store/状态映射，独立 Web/桌面布局接入；保留停止回执和两端同步。

## 7. 实施、迁移与回滚

顺序：T0 基线 → 第一批 T1–T3 → 第二批 T4–T6 → 第三批 T7–T8 → T9 完整验收。T7 的观测基础可从第一批开始补，T6 的可恢复格式修复须待 T8 完成后联合验收。

新增字段及关系映射先向后兼容扩展；记录策略/输出版本。旧活跃任务在受支持的边界冻结策略，不在调用中途改变计时规则。旧活动模型进程状态未知时不得升级后自动重放。新简化输出仅对支持的 Runtime 和新运行启用。

回滚优先关闭新预检/简化输出/候选恢复策略，使用能读新字段的上一兼容构建；不能直接降到无法识别新输出版本的二进制，也不能清空检查点“解决”迁移问题。部署与真实任务恢复均不属于本文档生成动作。

## 8. 验证与实测输入

定向验证以 Tasks 和 Checklist 为准；所有实现门禁至少覆盖类型检查、相关单测、必要隔离 E2E 和构建。已有命令包括 `npm run typecheck`、`npm run test:harness`、`npm run test:e2e:cancel`、`npm run test:e2e:recovery`、`npm run test:e2e:rework-loop`、`npm run test:e2e:client-presentation`。

真实模型采样沿用 [Watchdog 基线规程](../devops/watchdog-baseline.md)，在允许的隔离目录、连接、次数和费用内进行。新文档不授权执行采样。要求生产时限建议时，按规程至少 20 个完成样本并单列失败，补慢工具和故障注入；样本不足只报告探索结果，不宣称生产 P95 或成功率提升。

当前没有阻塞文档落盘的开放问题。尚待后续验收输入：实际部署策略阈值、可用模型具体名称、采样预算和 Runtime 原生续接能力；这些不阻塞第一批确定性缺陷修复，不允许通过猜测提前调整用户配置。

## 9. 实现落点与兼容边界（2026-09-14）

- `LogicalOperationStore` 在 RuntimeService 两入口共用；文件存储及 PostgreSQL V8 `logical_operations` 保存原子预留、父截止、暂停剩余时间、一次格式纠正额度、输出版本和停止状态。短控制调用固定 120 秒/2 次平台尝试，长阶段使用有效原配置，无效或 0 采用有限 20 分钟并记录诊断。不是 HTTP 请求次数或 CLI 内部 token 硬限制。
- 业务指纹包含会话/工作项、任务状态与范围、执行人、依赖和决策事件；排除日志计数、用量和活动时间。重建额度独立持久化，过期租约不能提交模型结果。
- 独立咨询有界调度，输入冻结、输出按角色顺序展示；保留不同意见，不用合并结果自动消除业务分歧。必要意见失败不生成确认后的契约。
- `task_execution_result@2.0` 只描述最小业务结论；系统用实际 ChangeSet 组装领域 v1 结果，不采信模型伪造的测试通过。Context 保持 v2 单轨。v1 输出和历史记录继续严格解析，输出版本不支持时拒绝调用。
- 候选为受限、可校验的持久化 ChangeSet，不是保留原始 staging 目录：差异最多 1 MB，原提交最多 256 KB，7 天有效；进程结束后捕获，记录持久化完成后才能恢复。恢复重新校验 session/workItem/task、基线、权限、版本和 hash。
- Claude 提交修复禁工具、启用 `--safe-mode` 禁 hooks/plugins、自定义参数时拒绝修复，并比较修复前后文件 hash。旧 CLI 不识别安全参数时失败停车；Codex 不开启自动提交修复。用户显式重试失败节点时关联原任务，可信候选可用则恢复；原 CLI 思考过程不作可恢复保证。
- `local_runtime.invocation.stopped/stop_ack` 是仅确认进程结束的可选协议，不携带业务产物；CLI 持久化待确认回执并在重连/心跳重传。服务端验证绑定后解除停止屏障并同步双端提示，不接受迟到成功写回。后端崩溃且没有可信回执的工程子进程仍停车；进程内 mock 不被当作外部副作用进程。
- Provider 熔断按连接/模型/协议隔离，候选切换仍限原有允许列表。可确认模型使用实际连接信息，否则记录 unknown。观测拆分平台准备、可观察工具区间及未分类耗时；上游排队、费用无法观测时明确为空，首次有效输出延迟不与总耗时相加。
- 新只读诊断接口为 `GET /api/runtimes/operations?sessionId=...`。双端复用 `taskActivity`，保留各自布局和交互。
- 候选提交错误且安全修复不可用/额度耗尽时保留候选并停车，不能自动退回普通开发。监督额度读写失败请求取消，流式和结果内事件去重；最终结果等已知记账落盘，不等已结束进程的损坏事件迭代器。
- prepared/验证阶段沿用现有 invocation phase、任务状态和真实验证证据；新增 executionCheckpoint 只表示 candidate_captured/submission_validated/writeback_confirmed，不新建第二套工作流状态机，也不标记虚假的 verified-pass。

部署时须协调 server/shared/local CLI 更新；不能在执行中直接降级到不识别输出 v2 的构建。本文没有授权重启现有服务、清空数据或采样真实模型。
