# Runtime Context Contract

## Purpose

ContextPack should provide enough context for the current phase and avoid unrelated noise.

## ContextPack fields

systemRules, sessionGoal, taskBrief, currentTask, agentProfile, relevantEvents, relevantMemories, ragSnippets, artifacts, capabilities, constraints, budget.

## 分阶段注入矩阵

| AgentRunPhase | Should see | 不应该看到 |
| --- | --- | --- |
| discussion | sessionGoal, agentProfile, constraints, relevantEvents | Full implementation logs. |
| brief_generation | sessionGoal, relevantEvents, relevantMemories, ragSnippets | Unconfirmed implementation details. |
| brief_revision | previous taskBrief, user feedback, relevantEvents | Unrelated tool output. |
| task_execution | taskBrief, currentTask, capabilities, artifacts, constraints, budget | Other agents' unrelated tasks. |
| post_review | taskBrief, artifacts, relevantEvents, verification evidence | Unverified guesses. |
| final_delivery | review result, artifacts, risks, memory candidates | Private speculation. |
| user_message_routing | current state, user message, relevantEvents, constraints | Full history noise. |

## Rubric

- Every phase has explicit context boundaries.
- Irrelevant data is excluded.
- Unconfirmed assumptions are labeled.
- Context can be traced back to upstream artifacts.
