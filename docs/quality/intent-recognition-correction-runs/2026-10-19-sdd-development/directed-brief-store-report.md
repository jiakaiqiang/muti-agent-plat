# 指定审阅结果事务与定稿依赖

Run-id：SDD-2026-10-20-directed-brief-store。继续指定修订实现，入口和审阅模型执行器尚未启用。

## 实现

新增 IntentBriefReviewStoreService：只接受 agent_message 合同、非空且不超过 32000 UTF-8 字节的意见；保存/发布均校验当前任务、旧 Brief、计划、generation、epoch、Decision hash、租约和调用 ID。实际提交 Agent 必须精确匹配步骤目标。结果先保存，发布事务再写 agent_message、Outbox 和 completed 状态；发布失败保留候选结果。重放已完成发布返回原事件，不重复写入，不把意见写为确认 Decision，不把部分审阅成功标为整个路由成功。已完成意见及事件引用有持久化不可变保护。

completedBriefReviews 验证定稿依赖与不可变计划完全一致，逐一校验全部审阅者、步骤、版本、原稿、调用和结果。遗漏、重复、错误目标、旧版本、失败状态、空结果或缺收据均不能定稿。结果按用户指定顺序返回且携带来源。Runtime 已用真实步骤校验替换上一阶段的一律拒绝：review_brief 限定 brief_revision 和精确 Agent，prepare_brief 只能在全部意见完成后准入。

现有草稿执行器在领取前等待意见，等待不消耗定稿预算；已失效/被纠错计划不继续等待。全部意见完成后，定稿输入带来源和明确“未确认建议”标签，再走既有草稿发布。审阅意见不能授予工具或覆盖用户已确认约束。

## 证据范围

相关计划/Brief/Store 回归 52 项通过。新增 File 事务场景在真实纠错提交内注入派生计划，手动提交两份合法审阅结果：第一份完成不能开始定稿，第二份完成后现有 executor 输入包含两份意见并发布新稿；验证错 Agent 拒绝、磁盘发布回滚、并发单事件和 Decision 不受意见污染。最终全量回归另覆盖不可变意见保护与失效等待检查，结果见日志与 manifest。

该场景没有实际调用两个审阅 Agent；手动结果和 stub Runtime 仅证明事务与依赖行为。尚无本轮真实 HTTP、PostgreSQL 或双端浏览器证据。初始测试漏填 agent_message.messageKind，合同与类型检查均拒绝；补齐 discussion 后重跑，原日志保留。

下一步仍需审阅 Runtime 执行器（独立预算/租约/恢复/目标可用性）、结构化指派受理、逐目标重试、共享表单及环境验证。整体 IR06/IR09/IR10/阶段门未完成，无提交或部署。
