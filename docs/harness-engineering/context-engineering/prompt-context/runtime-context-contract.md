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
| taskContext | Task Context Pack for the current invocation. | Carries task domain/intent, current stage, Project Map or Domain Map, stage plan, evidence selection, evidence refs, validation rules, and Execution/Validation/Review responsibilities. |
| summaryMemory | Compact continuation memory for long chains. | Carries current goal, current state, confirmed facts, completed work, decisions, open questions, risks, and next steps. |
| continuationState | Structured runtime continuation state. | Carries current phase/status, active task/agent, task queues, latest checkpoint, handoff refs, source refs, next agents, and resume hints. |
| workingDirectory | Selected workspace binding. | Present when browser or server-local workspace is attached. |
| workspaceManifest | Runtime-facing workspace structure and file metadata. | Preferred structure input. Exposes tree, paths, sizes, readability, content length, stack, and entrypoints without file bodies. |
| selectedEvidenceContents | Runtime-readable selected evidence content. | Preferred content input. Derived from selected evidence refs and trimmed by token budget. |
| workspaceSnapshot | Compatibility workspace tree/files fallback. | Runtime-facing snapshots are manifest-style and may omit all file bodies. New runtime behavior should not rely on `files[].content`. |
| workspaceFocus | Relevance summary for the current requirement. | Contains `relevantFiles`, `impactedFiles`, `testFiles`, `configFiles`, `possibleEntryPoints`, `detectedStack`, `validationCommands`, and `rationale`. |
| relevantFiles | Workspace files likely related to the requirement. | Nested under `workspaceFocus`. |
| impactedFiles | Files likely to be changed or inspected for the current implementation surface. | Nested under `workspaceFocus`; should be compact and derived from selected relevant files plus entrypoints. |
| testFiles | Test or smoke files related to the implementation surface. | Nested under `workspaceFocus`; should guide validation without loading all tests. |
| configFiles | Project instructions and build/runtime config files. | Nested under `workspaceFocus`; useful as Project Map key materials. |
| possibleEntryPoints | Candidate project entrypoints. | Nested under `workspaceFocus`. |
| detectedStack | Inferred tech stack from workspace scan. | Nested under `workspaceFocus`. |
| validationCommands | Detected package scripts such as typecheck, test, build, e2e, smoke, or lint. | Nested under `workspaceFocus`; useful as Project Map validation paths. |
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
| discussion | sessionGoal, taskContext, summaryMemory, continuationState, agentProfile, constraints, relevantEvents, workingDirectory, workspaceManifest, selectedEvidenceContents, workspaceFocus | Full implementation logs, full workspace file bodies, or unrelated artifacts. |
| brief_generation | sessionGoal, taskContext, summaryMemory, continuationState, relevantEvents, relevantMemories, ragSnippets, workingDirectory, workspaceManifest, selectedEvidenceContents, workspaceFocus | Unconfirmed implementation details, full workspace file bodies, or hidden side effects. |
| brief_revision | previous taskBrief, user feedback, taskContext, summaryMemory, continuationState, relevantEvents, relevantMemories, workspaceFocus | Unrelated tool output. |
| task_acceptance | taskBrief, currentTask, taskContext, summaryMemory, continuationState, agentProfile, constraints, budget | Other agents' unrelated tasks or full event history. |
| task_execution | taskBrief, currentTask, taskContext, summaryMemory, continuationState, capabilities, artifacts, constraints, budget, workingDirectory, workspaceManifest, selectedEvidenceContents, workspaceFocus | Other agents' unrelated tasks, full workspace file bodies, or unapproved external side effects. |
| post_review | taskBrief, taskContext, summaryMemory, continuationState, artifacts, relevantEvents, verification evidence, budget | Unverified guesses or private speculation. |
| final_delivery | review result, taskContext, summaryMemory, continuationState, artifacts, risks, memory candidates, budget | Private speculation or unconfirmed external send actions. |
| user_message_routing | current state, user message, taskContext, summaryMemory, continuationState, relevantEvents, constraints | Full history noise or irrelevant workspace contents. |

## Task Context Pack rules

- `taskContext.domain` is `coding`, `non_coding`, or `mixed`; the skeleton stays shared, while maps, evidence, and validation rules diverge by domain.
- `taskContext.intent` covers inquiry, analysis, implementation, planning, troubleshooting, review, validation, delivery, and qa.
- Coding and mixed tasks use `taskContext.taskMap.kind=project_map`; non-coding tasks use `domain_map`.
- Project Map entries should expose modules, boundaries, entrypoints, key materials, and validation paths without loading the whole repository.
- Domain Map entries should expose topic boundaries, key materials, decision records, and validation paths without free-form guessing.
- Task Map `key_material` entries should be derived from `taskContext.evidenceSelection.selectedRefs` when available, so the map shows the exact evidence slice currently available to the Agent.
- `taskContext.stagePlan` must state what the current phase should read, do, and validate. `read` items should cite current map/evidence refs, `do` items should stay inside the phase boundary, and `validate` items should mirror `taskContext.validationRules`.
- `taskContext.evidenceSelection` must explain how candidate evidence was reduced to the minimal selected set for the current phase. It should include strategy, query, max refs, selected/omitted counts, selected/omitted types, selected refs, a small omitted-ref sample, selection rules, token estimates, and selected/omitted reasons.
- `taskContext.evidenceRefs` must equal `taskContext.evidenceSelection.selectedRefs`. Runtime agents should cite selected refs and treat omitted refs as unavailable context.
- `taskContext.evidenceRefs` is the minimum evidence set for the current invocation. Coding refs may include files, symbols, logs, tests, and diffs; non-coding refs may include document fragments, meeting notes, data tables, external references, and historical decisions.
- If the selected refs are insufficient, Runtime agents must return `CONTEXT_INSUFFICIENT` or a blocked `TaskExecutionResultOutput.requestedContext` with the missing refs, paths, commands, and reason. They must not infer unread file contents, APIs, logs, or test results.
- When Runtime returns `CONTEXT_INSUFFICIENT`, Orchestrator must persist the requested refs, paths, and commands on the session as task-scoped supplemental context. The retry Context Pack must promote those requested items into selected evidence and inject readable requested workspace file content through `selectedEvidenceContents`.
- RAG hits and relevant memories should also be mirrored into `taskContext.evidenceRefs` using their source type (`document_fragment`, `meeting_note`, `data_table`, `external_reference`) and `memory`, so agents can cite the same compact evidence set after context trimming.
- Artifact `fileChanges` should be mirrored into `taskContext.evidenceRefs` as `diff` refs when available.
- `taskContext.agentResponsibilities` must name Execution, Validation, and Review responsibilities. Validation and Review must be independent from Execution when more than one agent is available.
- `taskContext.validationRules` defines the evidence needed to close the loop. Coding rules cover typecheck/test/build/e2e; non-coding rules cover fact consistency, scope consistency, traceability, and delivery completeness.
- Validation Agent `test_report` artifacts should include `metadata.validationEvidence`, recording validator agent identity, independent-from agent keys, and every validation rule mapped to cited evidence refs, verdict status, notes, and missing evidence. This keeps validation traceable after context trimming or cross-agent handoff.

## Summary memory rules

- `summaryMemory.currentState` should be sufficient to resume after context compaction.
- `summaryMemory.confirmedFacts` must only contain facts grounded in user input, project state, events, artifacts, memory, RAG, or workspace scans.
- `summaryMemory.completed`, `decisions`, `openQuestions`, `risks`, and `nextSteps` are compact continuation state, not a replacement for authoritative evidence.
- Key stage boundaries should persist a `summary_memory_checkpoint` artifact and a matching Memory item. Later Context Packs should merge the latest checkpoint and retain `checkpointRefs`, `sourceEventIds`, `sourceArtifactIds`, and `sourceMemoryIds` for auditability after context trimming.

## Continuation state rules

- `continuationState.phase` and `sessionStatus` must match the current runtime invocation and session.
- `activeTaskId` and `activeAgentKey` identify the current handoff target when a task is being accepted or executed.
- `pendingTaskIds`, `runningTaskIds`, `completedTaskIds`, and `blockedTaskIds` provide the minimal task queue state needed to resume without reloading the full task/event history.
- `lastCheckpointRef`, `handoffRefs`, `sourceEventIds`, and `sourceArtifactIds` keep pause/resume, review, validation, and final delivery traceable.
- `resumeHints` should be compact operational instructions, not new facts; facts still belong in `summaryMemory` or evidence refs.

## Workspace context rules

- `workingDirectory` indicates where file changes may be proposed or applied; it is not permission to write outside that root.
- `workspaceManifest` can include tree, file metadata, summaries, detected stack, and entrypoints. It must not include file bodies.
- `selectedEvidenceContents` is the only default workspace-derived readable content channel for runtime prompts. It must be derived from `taskContext.evidenceSelection.selectedRefs`, token-trimmed, and traceable by source/ref.
- `workspaceSnapshot` is retained for compatibility as a manifest-style fallback. Runtime prompts must not assume `workspaceSnapshot.files[].content` is present.
- `workspaceFocus.relevantFiles` guides impact analysis, while `impactedFiles` narrows the likely modification surface. The Agent must still state uncertainty when the snapshot is incomplete.
- `testFiles` and `validationCommands` should be used to choose scoped validation before broader typecheck/test/build/e2e runs.
- `configFiles`, `possibleEntryPoints`, `detectedStack`, and `rationale` should be used to explain why a task affects specific files.
- Token preflight may remove or truncate selected evidence contents. Agents must not pretend omitted or manifest-only content was read.
- For real `codex` and `claude_code` runtime execution, ContextPack delivery is separate from permission. Orchestrator must pass `cap-file-write` preflight before launching a source-writing runtime, and a blocked preflight must leave the task waiting without starting the runtime process.

## Token and trimming rules

- `budget.maxInputTokens` limits context sent to runtime.
- If context exceeds budget, the system first trims `relevantEvents`, `ragSnippets`, `artifacts`, and `selectedEvidenceContents`.
- If still over budget, runtime receives a `TOKEN_BUDGET_EXCEEDED` failure rather than an oversized prompt.
- Debug APIs must expose enough context and token usage for verification without leaking unrelated data.

## Rubric

- Every phase has explicit context boundaries.
- Irrelevant data is excluded.
- Unconfirmed assumptions are labeled.
- Workspace-derived structural conclusions cite `workspaceManifest` or `workspaceFocus`; content-specific conclusions cite `selectedEvidenceContents` or other selected refs rather than guessing.
- Context can be traced back to upstream artifacts, events, memory, RAG, or workspace scan evidence.

## 运行时选择 / 项目地图 / 可用工具

- `runtimeSelection` (Engineering Runtime Selection): identifies the currently selected runtime profile for the active agent run. Optional; populated when the project enables runtime selection.
- `projectMap` (Project Map): structured project topology surfaced to the agent prompt. Optional; populated when cross-module navigation is needed for the active task.
- `availableTools` (Workspace Tool Descriptors): the tool surface available to the agent at prompt construction time. Optional; populated when the runtime resolves a tool catalog for the workspace.
