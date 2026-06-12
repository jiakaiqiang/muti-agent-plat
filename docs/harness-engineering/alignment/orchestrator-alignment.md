# Orchestrator Alignment

> 最后修改时间：2026-06-12 11:20:34 +08:00
> 修改人：Claude Code
> 修改的 Agent：Claude Code

## Purpose

This document maps orchestration behavior to a reusable Harness execution model.

## AgentRunPhase matrix

| AgentRunPhase | Harness stage | Required output |
| --- | --- | --- |
| discussion | requirement/design | Discussion summary, risks, and open questions. |
| brief_generation | requirement | Intent contract or task brief. |
| brief_revision | requirement | Revised brief with change reason. |
| task_acceptance | planning/implementation handoff | Task claim decision (accept or decline) with reason. |
| task_execution | implementation | Implementation summary and produced artifacts. |
| post_review | review | Review report with an explicit decision. |
| final_delivery | delivery | Final delivery and memory candidates. |
| user_message_routing | human_intervention/feedback | Route, priority, pause decision, and target stage. |

## Standard orchestration shape

runPipeline should coordinate the whole delivery. runOneTask should execute a bounded task. runPostReview should make an independent review decision. runFinalDelivery should produce delivery material and memory candidates.

## ExecutionOutcome

| ExecutionOutcome | Meaning |
| --- | --- |
| delivered | Acceptance is satisfied. |
| rework | A target stage must be repeated. |
| ask_user | Human input is required. |
| cancelled | The round was stopped. |
| failed | The process cannot continue without failure handling. |
