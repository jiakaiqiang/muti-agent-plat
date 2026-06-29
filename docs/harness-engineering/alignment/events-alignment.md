# Events Alignment 事件对齐

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

## 目的

事件是 Harness Engineering 的审计轨迹。它们应承载阶段流转、决策、工具调用、人工确认与交付记忆证据。

## CollaborationEventType 阶段信号

- brief_created
- brief_confirmed
- task_created
- task_completed
- post_review_started
- post_review_completed
- final_delivery_created
- user_confirmation_requested
- tool_called
- error_reported

## harness_decision_made

各项目都应保留 `harness_decision_made` 这个逻辑事件语义。它可以是一种真实的事件类型，也可以表现为 `metadata.payload` 中的一条决策记录。

推荐 payload 字段：`decisionType`、`sourceStage`、`targetStage`、`reason`、`evidenceEventIds`、`confirmationId`、`artifactId`。
