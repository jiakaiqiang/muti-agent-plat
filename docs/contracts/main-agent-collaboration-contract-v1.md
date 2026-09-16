# 主 Agent 协作合同 v1：阶段 0 冻结基线

> 日期：2026-09-16
> 状态：共享类型、纯校验函数和合同测试已实现；业务入口接入按后续阶段执行。
> 版本：`COLLABORATION_CONTRACT_VERSION = '1.0'`，独立于 ContextEnvelopeV2、数据库 schemaVersion 和 RuntimeOutput 版本。
> 范围：本次不启用新流程、不改变删除行为、不迁移业务数据、不发布新 HTTP 接口。

[总计划](../roadmap/main-agent-collaboration-roadmap-v1.md) | [阶段 0 Spec](../product/main-agent-collaboration-phase-0-spec-v1.md) | [现状/迁移基线](../implementation/main-agent-collaboration-phase-0-baseline-v1.md)

## 1. 权威来源与实现边界

- 可执行合同：[collaboration-contracts.ts](../../packages/shared/src/collaboration-contracts.ts)。由 shared index 增量导出，不改现有 SessionStatus、AgentDefinition 或 InvocationPlan 的必填字段。
- 验证：[collaboration-contracts.spec.ts](../../packages/shared/src/collaboration-contracts.spec.ts)。不启动模型、不操作数据库、不创建后台服务。
- 现有 WorkItem、DecisionRecord、TaskBrief、Artifact、LogicalOperation、SessionStopRequest、ContextEnvelopeV2 继续是对应领域事实，不创建同义替代模型。
- 本文件冻结的是后续阶段必须满足的语义及合同名称。只有 shared 类型/纯函数属于本阶段 implemented；下文 HTTP、表/集合与运行接入均标为 deferred，不是当前可调用能力。
- 字符串类型的角色/状态来自客户端时不可信。纯函数的通过结果不是认证、授权、可信停止证据或“已经发生副作用”的证明；业务服务仍必须读取受保护注册表、持久化记录并原子校验。

## 2. 身份链与归属

`Session → WorkItem → 讨论/委派或工作流运行/任务 → LogicalOperation → Invocation`。

| 对象/字段 | 含义与唯一性 | 是否可跨会话共享 |
| --- | --- | --- |
| AgentDefinition / agentId | 角色配置、能力与 Profile 版本，不是执行实例 | 可以共享定义 |
| sessionId + workItemId | 会话与本次逻辑需求，归属必须可核实 | 不共享私有状态 |
| generation | 会话工作资格代次，停止/删除/恢复后按合同推进，阻挡迟到写入 | 不共享 |
| profileRevision + contextSnapshotId | 本次执行固定的角色版本与上下文依据 | 只引用明确共享规则，不共享私人上下文 |
| operationId | 有限尝试/预算/停止的逻辑操作 | 不跨会话重用 |
| invocationId | 单次真实调用，可与日志/回执/产物关联 | 不跨调用重用 |

`CollaborationExecutionIdentity` 的 scope 必须属于以下之一：

- intent：routingId。
- discussion：discussionId；专家委派另带 delegationId，主 Agent 本轮综合可无 delegationId。
- workflow：workflowRunId + taskId。
- summary：checkpointKey（需求、覆盖范围与输入版本对应的逻辑键）。

身份中的 ID 均为非空字符串；generation/profileRevision 为正安全整数。后续数据库服务负责校验 referenced ID 真实存在且同属 session/workItem，不能仅凭格式验证派发。

`collaborationExecutionKey` 用固定次序 JSON tuple 编码，包含需求、代次、上下文/角色版本和运行身份，避免分隔符碰撞。它用于句柄/上下文分区；不是启动幂等键、停止授权令牌或数据库替代主键。已有控制动作和初次消息先建立 WorkItem 后才能生成新策略执行身份，不能为缺失归属填随机假值。

## 3. 动作所有权与信任边界

| 动作 | 提议/决策所有者 | 实际提交与约束 |
| --- | --- | --- |
| propose_intent_route | intent_router | 只返回结构化建议，不修改 Session/WorkItem |
| apply_intent_route | domain_service | 校验引用、状态、业务指纹、幂等及权限后提交 |
| delegate_expert / publish_synthesis | coordinator（主 Agent） | 已选成员内受控咨询，委派有版本/预算/退出条件 |
| submit_expert_report | expert | 可见结论/证据/风险，回到主 Agent 汇总，不自主改派 |
| publish_requirement_document / request_requirement_confirmation | coordinator | 领域服务发布不可变文档版本和精确确认记录 |
| request_member_selection | coordinator | 成员外邀请、不可用成员替代先问用户 |
| confirm_requirement / approve_member_change | user | 必须是服务端记录的真实用户动作，模型不能代签 |
| select_workflow / request_workflow_start | user | 确认后选已发布图；选择与启动可以同一次明确提交 |
| create_workflow_run / advance_workflow_node | workflow_engine | 依所选图与确认快照推进；Sessions 可作为入口但不建立第二调度器 |
| request_scope_change_choice / decide_scope_change | coordinator / user | 主 Agent 解释影响，用户决定暂缓/放弃/暂停修订 |

`isCollaborationActionOwner` 只检验上述矩阵，不代表持有人身份可信。系统角色继续通过现有 AgentCatalog/SystemAgentRegistry 解析，产品别名 main-agent 不能产生新权限。专家咨询产生的工具审批仍受原 Tool Authority 管理，不与“需求确认”混成同一授权。

## 4. 消息、正式文档与确认绑定

`CollaborationMessageTarget` 固定 sessionId、messageIdempotencyKey、mentionedAgentIds；可带 workItemId/revision 与 replyToEventId。@ 是明确的用户目标，分类器不可静默丢弃；成员资格服务端再次校验。初始消息与后续消息共用语义，但不要求不存在的 WorkItem 在初次输入前已有 ID。

`RequirementConfirmationBinding` 固定：sessionId、workItemId、workItemRevision、confirmationId、documentId、documentRevision、contentHash、businessFingerprint。`matchesRequirementConfirmation` 只有两个完整、合法绑定逐项相等时才返回 true；它不验证用户是否真的点击了确认，也不消费确认。

阶段 4 服务必须在同一事务检查有效用户动作、当前版本和未消费状态，再写决策/事件。文档变更生成新版本，不原地覆盖；新旧确认保留审计。文档 ID 对应现有 Artifact/TaskBrief 聚合，不能另建无关联正文。

`CollaborationWorkflowStartBinding` 在有效需求确认之外增加 workflowId/version/hash、agentMappingHash 和 startRequestId。需求确认发生在流程选择之前，因此需求确认对象不预填一个尚未选定的流程。新图发布不改变已锁定运行。

## 5. 生命周期、版本读取与双端兼容

`CollaborationLifecycleSnapshot` 是独立的生命周期合同，不能把 active/deleting/deleted 塞进现有 SessionStatus。字段包括 contractVersion、sessionId、dataEpoch、generation、revision、state、admission、stopStatus，以及可选 deleteRequestId/deletedAt。

- active + admission=open + stopStatus=idle/confirmed，且身份/代次/合同版本匹配：仅表示具备继续执行其他准入检查的资格。
- admission=closed、deleting、deleted、requested/waiting/unknown stop：不准入新调用。
- deleted/deleting 却 admission=open：非法快照，拒绝。
- 快照缺失：legacy_snapshot，不推断为新策略 active；存量会话继续原语义，由后续显式升级处理。
- 未知合同/状态、其他 session/dataEpoch、旧代次、非法计数：不准入。
- 只增加不影响执行含义的展示字段可安全忽略；未知控制状态不能降级为 active。

`evaluateCollaborationAdmission` 是上述纯合同判断；当前后端尚未调用它。阶段 1 必须在读取、队列领取、reserve、结果提交、写回、缓存/记忆索引回填等入口接入，并持久化准入状态。不能声称一个新 helper 能阻止未升级的旧二进制继续写库。

## 6. 策略快照、开关与参数

`CollaborationPolicySnapshot` 包含 contractVersion、policyId/revision、dataEpoch、activation、enabledFeatures、parameters、capturedAt。`createCollaborationPolicySnapshot` 校验、深拷贝并深冻结，拒绝未知配置字段及秘密字段进入有效参数快照。

| 特性开关 | 运行期必需依赖 | 参数合同 | 接入阶段 |
| --- | --- | --- | --- |
| session_lifecycle | 无 | 现有停止时限保持，不在阶段 0 改值 | 1 |
| bounded_context | session_lifecycle | context：maxInputTokens/maxOutputTokens/maxWorkItemTokens/safetyMarginRatio | 2A |
| long_term_memory | bounded_context | memory：summaryTriggerRatio/maxRecallCandidates | 2B |
| layered_cache | long_term_memory | cache：maxEntries/maxBytes/ttlMs | 2C |
| main_agent_discussion | long_term_memory | discussion：maxConcurrency/maxRounds | 3 |
| document_workflow_handoff | main_agent_discussion | 按确认/流程合同 | 4 |
| execution_changes | document_workflow_handoff | 按变更请求合同 | 5 |

实施顺序仍按总计划；运行期允许单独关闭 layered_cache，不能因此关闭讨论正确性路径。所有依赖递归有效，未知/重复特性拒绝。整数限制为正安全整数，比例在 (0,1)，需求累计 Token 上限不得小于配置的单次输入+输出上限。

activation 只支持 disabled（features 必须为空）与 new_sessions_only；没有 all_sessions 自动升级模式。这个字段是服务端策略记录设计，不是已接入的环境变量。阶段 0 不设置任何默认生产额度、不读环境变量、不写策略集合；缺参数拒绝启用对应特性，而不是按“无限”处理。

## 7. 策略升级与旧构建边界

`evaluateCollaborationPolicyAdoption` 要求同 dataEpoch、读端支持合同及全部特性、当前无活动执行、停止可信确认；存量会话还必须 explicitUpgrade=true。缺任一条件均不得采用新快照。

explicitUpgrade/stopConfirmed 是服务端核实后的输入，不接受客户端自报作为事实。停止 confirmed 后仍需检查原调用结束、持久化已提交和目录状态。关闭全局新准入不能改写存量运行快照。

后续发布必须先部署能识别新记录的服务器/worker/客户端能力协商，再启用写入。旧构建没有新 guard 时，通过停止旧 writer、发布版本准入及迁移门禁阻止接管，不能仅靠前端隐藏按钮。兼容构建不存在时向前修复，不部署旧版本并清除新状态。

## 8. 数据与迁移登记（deferred）

| 数据 | 复用/拟新增落点 | 必需约束 | 实施阶段 |
| --- | --- | --- | --- |
| 生命周期 | 拟新增 sessionLifecyclesBySession / session_lifecycles | session 外部 ID 唯一；generation/revision 单调；与 reserve/stop 共事务锁域 | 1 |
| 会话策略快照 | 拟新增 sessionCollaborationPolicies / session_collaboration_policies | 当前 epoch、session 唯一活动版本、不可变历史、显式升级审计 | 1 起逐阶段扩展 |
| 讨论与委派 | 拟新增 discussionsBySession/delegationsBySession 对应 projection | 需求/代次/版本、委派唯一键、操作/调用关联 | 3 |
| 文档与确认 | 扩展 brief/artifact/DecisionRecord | 不可变正文、hash、精确批准、原子消费与 outbox | 4 |
| 长期摘要/依赖 | 扩展 SummaryMemoryCheckpoint/artifact metadata | coveredEventSeq、需求/决策版本、来源、唯一提交 | 2B |
| 预算与缓存用量 | 扩展 operation/调用审计及预算 reservation projection | attempt 去重、未知用量保留、跨实例原子额度 | 2A/2C |

集合/表名为冻结的后续设计落点，尚未注册进 PersistenceService，不能当成已存在数据读取。正式迁移实施时按最新编号追加；当前源码迁移序列到 9，本阶段没有新增或执行迁移。File/PostgreSQL 同阶段对齐，不能只加前端字段或内存 Map。

先生成不可变输入快照，外部模型/CLI 调用在事务外；落库比较领域版本/代次/租约并写 outbox。控制锁作用于相关集合/会话，不把在线更新恢复为全库 revision CAS。

## 9. HTTP 与事件登记（deferred）

当前 API 不变。阶段 1 的接口语义冻结如下，正式接入必须同步现有 API/OpenAPI/客户端合同：

| 入口 | 目标语义 | 当前状态 |
| --- | --- | --- |
| GET /api/sessions/:id/lifecycle | no-store，读取生命周期与阻塞；读取失败不可默认开放准入 | 未实现 |
| DELETE /api/sessions/:id | 开始/重用删除请求；未完成返回 202，已隐藏返回 200；data 中 deleted 仅终态 true | 现有入口仍物理删除，行为变更在阶段 1 |
| POST /api/sessions/:id/restore | 请求含 requestId/expectedGeneration；幂等恢复为 PAUSED；过期/不安全恢复返回 409，不自动执行 | 未实现 |
| GET /api/sessions?visibility=deleted | 明确查询可恢复历史，普通列表排除 deleted，deleting 保留进度/阻塞 | 未实现 |

生命周期事件拟采用 session_lifecycle_changed，携带 sessionId、generation、revision、deleteRequestId（如适用）和状态；阶段 1 写入 shared 事件联合类型及 outbox。消息投影只接受同代更高 revision，不能用到达时间排序覆盖状态。服务器持久化裁决是权威，UI 不自行判断已经停稳。

删除是请求资源的幂等动作；进行中重复请求复用同一 requestId。恢复后的新删除生成新代次和新请求。网络断开、数据库失败不会触发物理 purge。已有 stop-state API 继续复用，pending_sync 通过目标明细和 blockers 表达，不添加与现有停止合同冲突的总状态。

## 10. 已冻结产品案例

1. 用户“做订单导出”→主 Agent 组织所选专家→用户 @ 质量补充验收→专家回复回主 Agent→主 Agent 文档 v1→用户确认 v1→选已发布流程→唯一启动。
2. 主 Agent 想邀请未选架构师→由主 Agent 请求成员选择→用户拒绝则不调用；不能生成一个名字冒充已授权成员。
3. 用户打开 v1 卡片时主 Agent 已发布 v2→旧确认拒绝→展示差异→用户重新确认，不把“继续”当任意新版批准。
4. A/B 共用前端 Agent→A 停止/删除→只终止 A 的调用与队列；B 不受影响；共享本地助手进程不被退出。
5. 正在开发时新增独立需求→主 Agent 识别后新建需求并选择协作成员/排队→不把旧全部历史继承过去，不跳过新需求确认和流程选择。

这些是后续阶段验收输入，不是阶段 0 已完成的端到端功能。

## 11. 阶段 0 交接要求

- shared 合同和纯函数测试通过；未知/旧版本只读兼容不得推断新执行许可。
- 现状差距、存储迁移、API/事件/双端接入和安全回退均有归属阶段。
- 阶段 1 开工先实现生命周期持久化与入口校验，再改变删除行为；不得只调用纯函数就宣布跨进程隔离完成。
- 第三方缓存、真实模型成本、生产参数、实际迁移与回退演练在各自阶段验证，本阶段不伪造运行证据。
