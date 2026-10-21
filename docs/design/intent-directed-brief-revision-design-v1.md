# 版本化指定 Agent 草稿修订

实现增量：已增加审阅结果事务、完整定稿依赖和现有 Brief 执行器的等待/意见输入，见[结果存储记录](../quality/intent-recognition-correction-runs/2026-10-19-sdd-development/directed-brief-store-report.md)。上一阶段“一律拒绝”现已替换为逐步骤、目标、版本和完整意见校验；结构化指派入口与审阅模型执行器仍未启用。

状态：实施中，结构化用户入口、审阅执行和全部意见后定稿已接通；恢复展示与完整环境矩阵尚待补齐。继承意图识别 Spec/Plan/Task/Checklist 的版本、权限、纠错和失败恢复约束。该设计补齐已有修订表单的 assignedAgentKeys 行为，不启用通用 ordered_plan。

## 用户语义

指定 Agent 分别审阅用户修改，Coordinator 汇总意见形成新的待确认草稿。用户选中的每个 Agent 都必须有独立持久化步骤，不允许丢弃不可用目标或回退为 Coordinator。所有意见成功并通过版本校验后才能定稿；一项失败时保留已完成意见，显示失败目标，不用部分成功冒充整体完成。生成新稿仍不批准任务或授予工具效果。

## 不可变计划

结构化请求继续绑定原 Brief/卡片/意图版本/epoch，并增加用户原始 assignedAgentKeys。受理事务从当前会话可用 Agent 集合逐一解析为 ID，拒绝未知、重复、停用、非本会话目标，保存原 key 和解析 ID。不能让模型选择替代目标。分类只解释修改内容和关系，绑定的审阅名单由服务端加入计划。

合法同任务、无执行效果的修订提交事务先保存说明和逐题回答，再派生每个目标一个 review_brief 和一个 prepare_brief。所有步骤绑定同一 requirementRevision、executionEpoch、Decision hash、generation 和旧 Brief ID/版本。review_brief 是内部动作，不进入模型输出枚举。定稿步骤的 requiredBriefReviewStepIds 列出全部审阅步骤；这是内部物理依赖，与模型的语义 segment dependencies 分开。

本阶段 `deriveDirectedBriefSteps` 保留所有明确目标、独立 step/idempotency 身份、共同原文证据和无工具 scope，并生成完整定稿依赖。客户端已传递指派修订，生产提交事务调用该 helper；Runtime 和 Brief 存储核验每位审阅者和完整依赖，不能忽略名单继续生成。

## 执行与发布顺序

1. 受理及分类事务成功后保存所有 queued 步骤；暂停时不领取、不开始预算。
2. 每个审阅步骤独立领取、租约和有限操作预算，实际调用固定目标 Agent、brief_revision phase、agent_message 合同和空工具。启动、结果落盘和意见发布分别重验原计划及当前 Agent 可用性。
3. 输入包含原草稿、用户修改和当前有效 Decision；审阅意见属于建议，不能写入确认 Decision 或覆盖用户约束。结果按步骤存储，事件/Outbox 原子发布，重复调度和恢复不重做已完成审阅。
4. 定稿只有在全部 requiredBriefReviewStepIds 为 completed、结果齐全且精确匹配版本/目标时领取。Coordinator 输入带每份意见的 Agent/步骤/调用来源，视为待核对建议；有遗漏或旧版本意见就阻止定稿。
5. 新稿沿既有事务发布、解决旧卡并等待用户确认。任何纠错、暂停、取消、删除、换代或目标变化通过现有绑定拒绝迟到结果。
6. 单目标失败显式重试保留旧预算和其他完成意见，创建该目标的新有限 operation；定稿失败仅重试定稿，不重复审阅。停止未知先对账。重启恢复沿同一预算，不凭新 worker 重置。

## 验证要求与未完成项

已完成基础验证：两目标完整派生、独立身份、输入不被修改、空/重复/超过八个目标拒绝、模型内部动作拒绝、未实现执行器不能绕过 Runtime 门。

下一步必须完成受理名单解析和不可变绑定、review_brief 持久化执行器/结果事务、定稿依赖核验、按目标失败恢复、共享两端表单解除限制。验收要覆盖两目标不同意见确实进入新稿、一项失败不定稿、完成意见不重跑、并发/重启/暂停/纠错迟到结果，以及真实 HTTP、PostgreSQL 与双端交互。当前基础测试不替代这些结果，也不构成完整 IR06/IR09/IR10 或 AC 通过。
