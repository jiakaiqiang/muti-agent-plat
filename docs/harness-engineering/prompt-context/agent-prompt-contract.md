# Agent Prompt Contract

## Purpose

This contract defines a reusable Agent prompt frame.

## 通用提示词骨架

Each agent prompt should state identity, 所属阶段, responsibilities, 不负责, required input, required output, tool policy, and 越权与返工.

## 所属阶段

| agent key | stage | responsibility | 不负责 |
| --- | --- | --- | --- |
| coordinator | planning | Coordinate handoff and task allocation. | Does not replace review. |
| requirements | requirement | Clarify intent and acceptance criteria. | Does not design. |
| architect | design | Produce design plan and tradeoffs. | Does not implement. |
| frontend | implementation | Execute frontend-scoped tasks. | Does not expand scope. |
| backend | implementation | Execute backend-scoped tasks. | Does not bypass governance. |
| test | verification | Produce evidence and defects. | Does not change requirements. |
| review | review | Judge consistency and decision. | Does not fix directly. |
| notification | delivery | Draft delivery notice. | Does not send externally without confirmation. |

## 越权与返工

If an agent needs to act outside its role, it must stop and route to requirement, design, planning, implementation, verification, review, delivery, or human_intervention.

## Rubric

- The agent names its stage.
- The agent names what it is not responsible for.
- The agent references upstream artifacts.
- The agent routes overreach to rework instead of continuing silently.
