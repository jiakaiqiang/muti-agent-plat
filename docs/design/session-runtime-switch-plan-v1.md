# Session Runtime 动态切换 Plan v1

状态：2026-10-11 已接入命令/明确自然语言/API、停止屏障、任务级接续和故障备用链。下面保留原完整设计；本轮实现范围、验证与边界见第 15 节，完整产品验收尚未全部完成。

依据：[Spec](../product/session-runtime-switch-spec-v1.md) | [Tasks](../implementation/session-runtime-switch-tasks-v1.md) | [Checklist](../quality/session-runtime-switch-checklist-v1.md)。

## 1. 研究结论

- Session 创建入口接收 `runtimePreference`，现有 Session 没有更新 RuntimePreference 的专用 API。
- `SessionsService.sendMessage` 在精确命令后才进入普通意图路由；“使用 Claude Code 继续”不属于现有精确命令，因此 PAUSED 时会 queued。
- `hasActiveSessionWork` 把 PAUSED 视为 deferred，`processNextFollowUp` 又在 PAUSED 时早退，形成等待闭环。
- `OrchestratorService` 已实现 Provider 失败后同 Runtime 重试一次，再从 `allowedRuntimeTypes` 选择候选；用户取消或 Abort 会终止该链。
- `InvocationResolverService` 已具备 allowlist、Workspace、Capability、Tool、可用性和明确排除候选的校验。
- `SessionLifecycleStore`、Runtime stop-state、LogicalOperation 和 outbox 已提供可信停止与恢复设施，应复用而不是另建弱化的取消逻辑。
- `runtimePreferenceForAgent` 当前允许 Coordinator 系统策略覆盖 Session 偏好；主动切换需要改为“管理员上限 + Session 显式优先”。

## 2. 方案选择

选择“持久化切换状态机 + 可信停止屏障 + 平台上下文重建”。

不采用：

- 直接修改 `preferredRuntimeType` 后调用 resume：无法证明旧 Invocation 已停止，可能并发写入。
- 把切换文本当普通 Intent Router 决策：模型不应决定有副作用的执行控制，PAUSED 时也无法消费。
- 将主动切换伪装成 Provider fallback：会错误继承旧 attempt 预算和失败原因，也无法表达用户选择。
- 跨 Runtime 传递 CLI session：Codex/Claude Code 会话协议和状态不可互换。

## 3. 架构边界

新增 `RuntimeSwitchCoordinatorService`，只协调切换事务，不承担 Runtime 选择算法或 Session 消息规划。

| 模块 | 职责 |
| --- | --- |
| shared/contracts | RuntimePreference、RuntimeSwitchRequest、事件 payload、终止原因和 attempt trace |
| sessions | API 入口、聊天命令分流、Session 投影和恢复原阶段 |
| runtime-switch | 请求状态机、预检、停止协调、策略应用和幂等恢复 |
| runtimes/lifecycle | 可信停止、generation fence、Invocation 取消和迟到结果隔离 |
| runtime-routing | 目标 Runtime 资格验证、allowlist/能力交集和明确候选解析 |
| orchestrator | 新 Runtime Invocation、ContextEnvelope 重建、retry/fallback 协调 |
| persistence/recovery | file/PostgreSQL 存储、迁移、重启恢复和 outbox |
| web | Runtime 选择、切换状态、SSE 收敛和错误反馈 |

Architecture Constraints：

- allowed_change_scope：上述模块、相关合同文档与定向测试。
- forbidden_change_scope：Agent Profile 语义、Skill/Tool 授权模型、Workspace 写回规则、无关工作流和无关 UI 重构。
- dependency_direction：UI/聊天入口 -> Session API -> RuntimeSwitchCoordinator -> Lifecycle/Runtime/Resolver；Orchestrator 不反向调用 UI 或 Controller。
- contract_stability：新增字段保持可选；旧 Session 和旧事件可读取；未知新事件由旧客户端安全忽略。
- invariants：Spec I1-I8 全部为实现硬约束。

## 4. 合同设计

### 4.1 RuntimePreference

在 `packages/shared/src/contracts.ts` 增加：

```ts
fallbackRuntimeTypes?: RuntimeType[];
revision?: number;
```

`allowedRuntimeTypes` 只表达权限，`fallbackRuntimeTypes` 表达顺序。规范化必须去重、过滤非法值，并验证首选和 fallback 都属于允许集合。

### 4.2 RuntimeSwitchRequest

持久化字段：id、sessionId、source、from/targetRuntimeType、resumeAfterSwitch、fallbackMode、status、expectedSessionRevision、previousSessionStatus、stopRequestId、stoppedInvocationIds、createdAt、updatedAt、error 和 idempotencyKey。

状态迁移：

```text
requested -> preflighted -> stopping -> stop_confirmed
    -> applying -> resuming -> completed
                         \-> failed
```

`failed` 记录 failureStage；仅允许对应阶段的显式重试。终态不可回退。

### 4.3 RuntimeAttemptTrace

新增 `trigger`、`switchRequestId`、`switchFromRuntimeType`。主动切换使用新 attemptGroupId；后续 Provider retry/fallback 继续在该新组内递增。

### 4.4 终止原因

ExecutionTermination 增加 `runtime_switch`，source=`user`，scope=`session` 或 `invocation`。它与 `user_paused`、`user_cancelled` 分开审计。

## 5. API 与命令

新增：

```http
POST /api/sessions/:sessionId/runtime-switch
GET  /api/sessions/:sessionId/runtime-switch
```

POST body：

```json
{
  "targetRuntimeType": "claude_code",
  "resumeAfterSwitch": true,
  "fallbackMode": "exclude_previous_once",
  "expectedSessionRevision": 12
}
```

请求必须带 Idempotency-Key。POST 返回已持久化请求；切换进度通过 Session 详情和 SSE 事件更新。GET 返回当前或最近一条请求，用于刷新恢复。

确定性命令解析在普通 Intent Routing 前执行。解析器从 Runtime 注册表读取显示名和别名，输出 target、resumeAfterSwitch 和 fallbackMode。`/runtime` 插件和 UI 不经过自然语言解析，直接提交结构化请求。

## 6. 切换事务

### 6.1 无活动 Invocation

预检成功后，在同一持久化事务中更新 RuntimePreference、revision、切换状态和 outbox。若 Session 为 PAUSED 且请求要求继续，再经既有恢复守卫重开 admission。

### 6.2 有活动 Invocation

1. 基于当前 Session/WorkItem/Agent/Workspace 构造只读预检输入。
2. 解析目标 Runtime，验证其确实为 target，不允许路由器静默选择其他候选。
3. 持久化 `preflighted`，再关闭 lifecycle admission。
4. 创建或复用 SessionStopRequest，使用 `runtime_switch` 终止 Intent、Brief、Execution 和 Runtime。
5. 等待统一 stop summary；超时保持 stopping，不修改首选 Runtime。
6. stop confirmed 后执行 `completeRuntimeSwitch` 原子事务：更新偏好和 revision、递增 lifecycle generation、写事件/outbox并进入 applying/resuming。
7. 重开 admission，通过目标 Runtime 创建新 Invocation。

`completeRuntimeSwitch` 必须使用 expected Session revision 和 switch request version 做 CAS。生命周期 generation 递增后，旧 generation 的迟到回调只能完成资源清理和审计，不能应用业务结果。

## 7. Context 与执行候选

- 重新调用现有 Context v2 组装器，不复制聊天正文到 RuntimeSwitchRequest。
- 保持相同 WorkItem、Agent identity、Skill bindings、ToolCatalog 和决策账本引用。
- 不设置来自旧 Runtime 的 `resume.cliSessionId`。
- task_execution 若存在 executionCandidate，按既有 candidateId、基线、schema、Workspace binding、权限和 generation 校验后使用；无效时记录原因并从任务检查点重建。
- 未完成 writeback 在切换前冻结；只有新 generation 明确接管后才能继续处理。

## 8. 策略优先级与 fallback

EffectivePolicy 计算：

```text
adminAllowed ∩ sessionAllowed ∩ workspaceEligible ∩ taskEligible
```

选择优先级：

1. 合法的切换目标或 Session 显式 preferred。
2. 系统 Agent preferred 默认值。
3. Project policy。
4. Smart Router。
5. Global default。

管理员 allowed 是硬边界，管理员 preferred 不是强制覆盖。Coordinator 和 task_acceptance 使用同一规则。

fallback 使用 `fallbackRuntimeTypes` 顺序并再次执行资格校验。`exclude_previous_once` 把 fromRuntimeType 加入当前新 attemptGroup 的 excludedRuntimeTypes；组结束后清除。`target_only` 原子更新 allowed/preferred/fallback 三个字段。

## 9. 事件与 UI 状态

新增单一事件类型 `runtime_switch_changed`，payload 包含 switchRequestId、version、status、from/target、fallbackMode、stopRequestId、activeRuntimeType、preferredRuntimeType 和安全错误摘要。

幂等键：`runtime-switch:<switchRequestId>:<version>`。事件与状态更新进入同一事务和 outbox。

Web store 先读取 GET 快照，再只接受同 request 更高 version 或新 request。UI 分开展示：

- 首选 Runtime。
- 当前活动 Runtime。
- 备用顺序。
- 切换阶段和阻塞原因。

切换入口放在群聊工作台的 Runtime 控制区；聊天命令成功后展示同一状态，不额外制造第二套本地乐观状态。

## 10. 错误与恢复矩阵

| 场景 | 行为 |
| --- | --- |
| 目标未授权/能力不符 | 预检失败，当前执行和偏好不变 |
| 目标离线 | 预检失败；可提示重连，不自动停止当前 Runtime |
| 停止超时/未知 | 保持 stopping、admission closed，禁止替代调用 |
| 策略提交失败 | 保持 stop_confirmed/applying，可幂等重试，不恢复旧执行 |
| 目标启动失败 | 依据 fallbackMode 和错误分类处理；不可重试错误 fail closed |
| 重复 POST | 返回同一 RuntimeSwitchRequest |
| stale revision | 409，客户端刷新后重新选择 |
| 服务在 stopping 重启 | 从 stop-state 核对，不重发模型调用 |
| 服务在 resuming 重启 | 只恢复有可信检查点的只读/安全路径；写操作等待用户或现有恢复协议 |
| 旧 Runtime 迟到成功 | 记录审计/用量，拒绝业务输出和写回 |

## 11. 持久化与兼容

- 新增 `runtimeSwitchRequestsBySession` file collection 和 relational 映射；实施时按最新 migration 编号追加，不在文档预占编号。
- `SessionDetail.runtimePreference` 新字段可选，旧数据按派生规则读取。
- 新增事件对旧客户端为未知事件；旧客户端仍可从 session_status/runtime_started 获得基本状态。
- 不执行 dataEpoch 清零，不删除历史 Session，不重写历史 Invocation。
- 灰度开关 `SESSION_RUNTIME_SWITCH_ENABLED` 控制新入口；关闭时返回明确不支持，不把命令当普通需求排队。

## 12. 可观测性

结构化日志字段至少包含 sessionId、workItemId、switchRequestId、stopRequestId、operationId、old/new invocationId、from/target runtime、generation、revision、status、failureStage 和 diagnosticRef。

指标至少包含切换请求数、各阶段耗时、预检失败、停止超时、切换成功/失败、迟到结果拒绝、fallbackMode 分布和重启恢复结果。不得记录凭据、提示全文、附件正文或本机绝对路径。

## 13. 验收映射

| Spec AC | 设计覆盖 |
| --- | --- |
| AC1-AC2 | 确定性命令、统一 API、切换事务和 PAUSED 恢复 |
| AC3-AC4 | 停止前预检、可信停止屏障、generation fence |
| AC5 | Context v2 重建与 executionCandidate 校验 |
| AC6-AC7 | 分离的 fallback 顺序、fallbackMode 和现有 Provider 重试链 |
| AC8 | Idempotency-Key、CAS、请求 version |
| AC9 | 持久化状态机、stop-state 核对和保守恢复 |
| AC10 | runtime_switch_changed、快照/SSE 版本收敛和 UI 状态 |
| AC11 | EffectivePolicy 交集和显式选择优先级 |
| AC12 | 合同、迁移、file/PostgreSQL、E2E 与构建门禁 |

## 14. 发布与回退

先发布可读取新字段的 shared/server，再执行 relational migration，随后发布 Web，最后开启功能开关。观察切换失败、停止超时和迟到结果指标。

回退先关闭新入口并停止创建切换请求；对 stopping/applying 请求完成停止核对，保留请求、事件、stop-state 和 Invocation 审计。禁止删除切换记录或伪造 completed 来解除屏障。旧构建不能安全理解新状态时，只能向前修复。

## 15. 2026-10-11 实现与意图识别架构

### 已实现入口

- `POST /api/sessions/:sessionId/runtime-switch`：`targetRuntimeType` 为 codex、claude_code、generic_llm 或 fallback；`Idempotency-Key` 请求头或 body.idempotencyKey 必填。
- `GET /api/sessions/:sessionId/runtime-switch`：返回当前/最近请求与有效 Runtime 偏好。
- `/runtime switch claude_code --continue`；可用 `--pause`、`--after-step`、`--session`、`--target-only`。
- 明确自然语言示例：“换成 Claude，继续把剩下的做完”“Codex 卡住了，用备用的继续”“下一步开始用 Claude”“切到 Claude，先不要执行”。
- 默认仅当前 WorkItem 生效；`--session` 或“整个会话都用 Claude”修改会话偏好，不修改全局配置。缺少继续指令时，运行中沿用继续语义，已暂停保持暂停。
- 询问、否定、引用及业务需求不执行切换；目标模糊时澄清。自然语言当前为保守的确定性语法，并非任意自由文本分类器。

### 接续与安全不变量

`RuntimeSwitchCoordinator` 通过 ports 复用 SessionsService 的停止/恢复、InvocationResolver 的能力预检，以及 RuntimeSwitchStore 的持久化事务。旧执行停止未知时保留 stopping；暂停能够撤销待执行切换。偏好、Session revision、generation、检查点和应用事件/outbox 同事务更新。

接续保存 WorkItem、Brief、任务状态、候选引用、阶段与最近调用引用，重新构建 ContextEnvelope；跨 Runtime 不复用原生 CLI session。候选校验范围、索引基线、实际 worktree 基线、权限、内容哈希和输出版本；失败或缺失时停止接续，不静默重跑写任务。恢复上下文明确要求核对已有改动和证据、验证未完成步骤，不把模型自述当成测试证据。

Provider 可重试故障仍先同 Runtime 重试一次，再按 fallbackRuntimeTypes 选择；可信 CLI close 异常直接尝试备用。静默、未知结束、权限/协议/输出合同错误、用户取消不自动切换。成功接管的备用在当前 WorkItem 内保持选择，后续显式切换清除该临时选择。自动切换继承原操作预算；用户主动切换使用新的执行代次与操作，并继续受 WorkItem 累计预算限制。

### 当前意图识别的层次

| 层次 | 代码 | 职责 |
| --- | --- | --- |
| 执行控制入口 | shared/runtime-control-intent.ts；deterministic-command-guard.service.ts；SessionsService.sendMessage | 确定性 Runtime 切换、暂停/继续、状态询问、特定工作流控制，先于业务消息排队 |
| 消息接收与快照 | MessageIngressService；ContextManagementService.buildIntentSnapshot | 消息幂等、附件与 @ 目标解析、当前 WorkItem/决策/阶段和 revision 快照 |
| 语义判断 | SemanticIntentRouterService | 系统 intent_router 调用模型，识别 dialogueAct、scopeRelation、contextPolicy、requestedAction 和引用；有限重试，无法判断则澄清 |
| 决策校验 | SemanticIntentRouterService.validate；ContextManagementService.applyIntentRoute | 校验输出合同、引用范围、@ 目标、需求关联、版本与并发租约，拒绝过期/越界决策 |
| 应用与执行 | RouteApplicationService；SessionsService；OrchestratorService | 激活/创建 WorkItem，继承有效决策与产物，确认需求，编排当前阶段 |

另外仍存在 `IntentRecognitionService` 的关键词分类（domain/intent/requiresCodeChanges）和旧消息处理分支。`INTENT_ROUTING_MODE` 默认 shadow；enforce_new_sessions / enforce_selected_sessions / enforce_all_current_epoch 决定 V2 是否真正接管。因此目前是“分层已存在，迁移尚未完全收敛”，不是所有消息必经模型，也不是所有消息已经走同一条 V2 链路。Runtime 控制入口不依赖业务模型，故主业务 Runtime 失效也能接收明确切换命令。

### 验证与边界

定向测试覆盖命令/自然语言、暂停队列缺陷、目标预检失败、停止未确认、延后切换、用户再次暂停、幂等、任务版本变化、恢复阶段重启、备用顺序、CLI 退出分类、候选文件恢复与篡改拒绝。shared/server/local-runtime 构建与全仓类型检查作为静态门禁。

- completed 表示切换控制事务完成并交给阶段恢复流程，不代表模型已经返回首个 token 或任务交付完成；真实调用仍以 runtime_started/后续事件为准。
- 单步边界指平台任务批次/阶段，不是 CLI 内部每个工具调用。
- 机器断电、整个本地助手被强杀、停止证据缺失时不能保证未持久化改动零丢失；当前仍须等待可信停止并核对最近候选，不会绕过屏障启动第二个执行器。
- resuming 时服务重启不重放副作用，转入可解释失败等待核对。跨模型语义一致性依赖证据校验、约束与后续测试，未声称可以证明两个模型内部理解完全相同。
- 本轮使用现有 runtime_progress 时间线展示阶段，没有新增 Runtime 下拉选择面板。完整 SDD 的 PostgreSQL 多副本故障演练、真实供应商端到端切换和专用 UI 验收仍需独立证据。
