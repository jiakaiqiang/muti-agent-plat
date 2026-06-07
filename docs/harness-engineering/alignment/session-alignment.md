# Session Alignment

## Purpose

This document maps SessionStatus to Harness stages. The same mapping can be reused by another project even when its state names differ.

## State matrix

| SessionStatus | Harness stage | Meaning |
| --- | --- | --- |
| DRAFT_INPUT | requirement | Input exists but no intent contract is ready. |
| AGENT_DISCUSSING | requirement/design | Agents are clarifying the goal and constraints. |
| WAIT_USER_CONFIRM | human_intervention | The brief is ready and waits for user confirmation. |
| REVISING_BRIEF | requirement | The intent contract needs revision. |
| EXECUTING | implementation | The confirmed plan is being executed. |
| POST_REVIEW | review | Outputs are being checked against intent and evidence. |
| REWORKING | implementation/verification | A defined rework target is being handled. |
| WAIT_USER_DECISION | human_intervention | Scope, risk, or permission needs a human decision. |
| COMPLETED | delivery | Delivery is complete and memory can be deposited. |
| FAILED | feedback | Failure must be routed by 07-feedback-loop. |
| CANCELLED | terminal | This round was explicitly stopped. |

## WAIT_USER_CONFIRM rule

WAIT_USER_CONFIRM is an engineering gate, not just a UI state. It requires goal, scope, constraints, acceptance criteria, risks, and open questions to be visible.
