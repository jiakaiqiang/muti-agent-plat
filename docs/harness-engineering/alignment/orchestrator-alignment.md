# Orchestrator Alignment 编排对齐

> 最后修改时间：2026-06-12 11:20:34 +08:00
> 修改人：Claude Code
> 修改的 Agent：Claude Code

## 目的

本文档把编排器的行为映射到一个可复用的 Harness 执行模型。

## AgentRunPhase 矩阵

| AgentRunPhase | Harness 阶段 | 必需产出 |
| --- | --- | --- |
| discussion | requirement / design | 讨论摘要、风险、待解决问题。 |
| brief_generation | requirement | intent contract 或 task brief。 |
| brief_revision | requirement | 带变更理由的修订版 brief。 |
| task_acceptance | planning / implementation 交接 | 任务领取决定（接受或拒绝）及理由。 |
| task_execution | implementation | 实现摘要与产出的产物。 |
| post_review | review | 带明确决策的评审报告。 |
| final_delivery | delivery | 最终交付与记忆候选。 |
| user_message_routing | human_intervention / feedback | 路由、优先级、暂停决定、目标阶段。 |

## 标准编排形态

- `runPipeline` 负责协调整个交付。
- `runOneTask` 负责执行一个有界任务。
- `runPostReview` 负责给出独立的评审决策。
- `runFinalDelivery` 负责产出交付物料与记忆候选。

## ExecutionOutcome 执行结果

| ExecutionOutcome | 含义 |
| --- | --- |
| delivered | 验收已通过。 |
| rework | 必须重新执行某个目标阶段。 |
| ask_user | 需要人工输入。 |
| cancelled | 本轮被终止。 |
| failed | 没有失败处理就无法继续。 |
