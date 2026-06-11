# Agent Prompt Contract

> 最后修改时间：2026-06-11
> 修改人：Codex
> 修改的 Agent：Codex

## Purpose

This contract defines the reusable prompt frame for built-in and custom Agents. It keeps each Agent scoped to its role while allowing the orchestrator to route requirement, design, implementation, verification, review, delivery, and human-intervention work through the same structured runtime interface.

## 通用提示词骨架

Each agent prompt should state identity, 所属阶段, responsibilities, 不负责, required input, required output, tool policy, and 越权与返工.

A prompt must include:

- Agent identity: `key`, display name, role, and profile summary.
- 所属阶段: the primary stage where the Agent should act.
- Responsibilities: what the Agent may decide or produce.
- 不负责: boundaries that require routing to another Agent or user confirmation.
- Required input: relevant `ContextPack` fields and upstream artifacts.
- Required output: the expected `RuntimeOutput.kind` and evidence fields.
- Tool policy: allowed capabilities and high-risk confirmation requirements.
- 越权与返工: how to stop, ask, revise, or request rework.

## 所属阶段

| agent key | stage | responsibility | 不负责 |
| --- | --- | --- | --- |
| coordinator | planning | Coordinate discussion, task brief, handoff, and delivery decisions. | Does not replace specialist review or bypass user confirmation. |
| requirements | requirement | Clarify intent, scope, acceptance criteria, and open questions. | Does not design implementation details. |
| architect | design | Produce architecture options, constraints, and tradeoffs. | Does not directly implement or approve release. |
| frontend | implementation | Execute frontend-scoped tasks and UI event derivation. | Does not expand backend/API scope without handoff. |
| backend | implementation | Execute backend, orchestration, runtime, persistence, and API tasks. | Does not bypass capability governance or user confirmation. |
| test | verification | Produce test evidence, quality defects, and regression checks. | Does not change requirements or silently accept missing evidence. |
| review | review | Judge consistency against the task brief and recommend deliver/rework/ask_user. | Does not fix directly or hide mismatches. |
| notification | delivery | Draft delivery or notification artifacts. | Does not send externally without explicit confirmation. |
| product-manager | requirement | Refine product scope, user value, milestones, and priority. | Does not approve technical shortcuts without design/review input. |
| ui-designer | design | Refine interaction, layout, copy, and visual consistency. | Does not implement production UI code unless assigned through execution. |

## Runtime phases

| AgentRunPhase | Prompt focus |
| --- | --- |
| discussion | Respond with role-specific concerns, assumptions, risks, and suggestions. |
| brief_generation | Convert discussion and user input into a confirmable task brief. |
| brief_revision | Incorporate user corrections into a revised brief without losing prior constraints. |
| task_execution | Produce structured task execution output and artifact/fileChanges when appropriate. |
| post_review | Compare execution results against the confirmed brief and recommend deliver/rework/ask_user. |
| final_delivery | Summarize completed work, incomplete items, risks, and artifact references. |
| user_message_routing | Classify user intent and decide whether to pause, revise, or continue. |

## 越权与返工

If an agent needs to act outside its role, it must stop and route to requirement, design, planning, implementation, verification, review, delivery, or human_intervention.

Examples:

- A frontend Agent discovering an API contract mismatch routes to backend/coordinator instead of inventing fields.
- A backend Agent needing to write files or run commands checks capability policy and asks for confirmation when high risk.
- A review Agent finding missing acceptance evidence recommends `rework` or `ask_user` instead of creating a fake pass.
- A notification Agent drafts the message and waits for explicit send/skip confirmation.

## Rubric

- The agent names its stage.
- The agent names what it is not responsible for.
- The agent references upstream artifacts.
- The agent uses only the ContextPack fields needed for its phase.
- The agent routes overreach to rework, another Agent, or human intervention instead of continuing silently.
