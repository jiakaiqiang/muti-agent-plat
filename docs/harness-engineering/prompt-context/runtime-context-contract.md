# Runtime Context Contract

> 最后修改时间：2026-06-12 11:20:34 +08:00
> 修改人：Claude Code
> 修改的 Agent：Claude Code

## Purpose

ContextPack should provide enough context for the current phase and avoid unrelated noise. The pack is assembled per runtime invocation, not treated as a dump of all session state.

## ContextPack fields

Top-level fields currently covered by this contract:

| Field | Purpose | Notes |
| --- | --- | --- |
| systemRules | Non-negotiable runtime behavior rules. | Must include side-effect and workspace grounding rules. |
| sessionGoal | User's original or current goal. | Always present. |
| workingDirectory | Selected workspace binding. | Present when browser or server-local workspace is attached. |
| workspaceSnapshot | Scanned workspace tree/files. | May be trimmed by token budget before runtime invocation. |
| workspaceFocus | Relevance summary for the current requirement. | Contains `relevantFiles`, `possibleEntryPoints`, `detectedStack`, and `rationale`. |
| relevantFiles | Workspace files likely related to the requirement. | Nested under `workspaceFocus`. |
| possibleEntryPoints | Candidate project entrypoints. | Nested under `workspaceFocus`. |
| detectedStack | Inferred tech stack from workspace scan. | Nested under `workspaceFocus`. |
| rationale | Why the workspace focus was selected. | Nested under `workspaceFocus`; assumptions must stay explicit. |
| taskBrief | Confirmed or draft task brief for the phase. | Required for execution/review/delivery phases. |
| currentTask | Current task being executed. | Required for `task_execution`. |
| agentProfile | Runtime-facing Agent identity and role. | Always present. |
| relevantEvents | Recent event summaries. | Bounded slice, not full event history. |
| relevantMemories | Session/Agent memory hits. | Only relevant memories for current agent/query. |
| ragSnippets | Knowledge retrieval hits. | Include source ids for traceability. |
| artifacts | Existing artifact summaries. | Do not inject full artifact bodies by default. |
| capabilities | Capabilities bound to current Agent. | High-risk use still requires policy checks. |
| constraints | Brief/user constraints. | Keep confirmed constraints distinct from assumptions. |
| budget | Runtime token/cost budget. | Used by preflight trimming and debug token usage. |

## 分阶段注入矩阵

| AgentRunPhase | Should see | 不应该看到 |
| --- | --- | --- |
| discussion | sessionGoal, agentProfile, constraints, relevantEvents, workingDirectory, workspaceSnapshot, workspaceFocus | Full implementation logs or unrelated artifacts. |
| brief_generation | sessionGoal, relevantEvents, relevantMemories, ragSnippets, workingDirectory, workspaceSnapshot, workspaceFocus | Unconfirmed implementation details or hidden side effects. |
| brief_revision | previous taskBrief, user feedback, relevantEvents, relevantMemories, workspaceFocus | Unrelated tool output. |
| task_acceptance | taskBrief, currentTask, agentProfile, constraints, budget | Other agents' unrelated tasks or full event history. |
| task_execution | taskBrief, currentTask, capabilities, artifacts, constraints, budget, workingDirectory, workspaceSnapshot, workspaceFocus | Other agents' unrelated tasks or unapproved external side effects. |
| post_review | taskBrief, artifacts, relevantEvents, verification evidence, budget | Unverified guesses or private speculation. |
| final_delivery | review result, artifacts, risks, memory candidates, budget | Private speculation or unconfirmed external send actions. |
| user_message_routing | current state, user message, relevantEvents, constraints | Full history noise or irrelevant workspace contents. |

## Workspace context rules

- `workingDirectory` indicates where file changes may be proposed or applied; it is not permission to write outside that root.
- `workspaceSnapshot` can include tree, file metadata, summaries, and limited content. Runtime prompts must ground file-level conclusions in this data when present.
- `workspaceFocus.relevantFiles` guides impact analysis, but the Agent must still state uncertainty when the snapshot is incomplete.
- `possibleEntryPoints`, `detectedStack`, and `rationale` should be used to explain why a task affects specific files.
- Token preflight may remove or truncate workspace file contents. Agents must not pretend omitted content was read.

## Token and trimming rules

- `budget.maxInputTokens` limits context sent to runtime.
- If context exceeds budget, the system first trims `relevantEvents`, `ragSnippets`, `artifacts`, and workspace contents.
- If still over budget, runtime receives a `TOKEN_BUDGET_EXCEEDED` failure rather than an oversized prompt.
- Debug APIs must expose enough context and token usage for verification without leaking unrelated data.

## Rubric

- Every phase has explicit context boundaries.
- Irrelevant data is excluded.
- Unconfirmed assumptions are labeled.
- Workspace-derived conclusions cite `workspaceSnapshot` or `workspaceFocus` rather than guessing.
- Context can be traced back to upstream artifacts, events, memory, RAG, or workspace scan evidence.
