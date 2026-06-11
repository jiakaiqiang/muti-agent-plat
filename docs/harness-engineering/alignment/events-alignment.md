# Events Alignment

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

## Purpose

Events are the audit trail for Harness Engineering. They should carry stage transitions, decisions, tool usage, confirmations, and delivery memory evidence.

## CollaborationEventType stage signals

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

Projects should reserve the logical event meaning harness_decision_made. It may be a real event type or a metadata.payload decision record.

Recommended payload fields: decisionType, sourceStage, targetStage, reason, evidenceEventIds, confirmationId, artifactId.
