# Runtime Context Contract

> 最后修改时间：2026-07-12 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

## Purpose

ContextAssembly should provide enough internal evidence for the current phase and avoid unrelated noise. Before Runtime dispatch, it is compiled into `InvocationPlan.contextEnvelope: ContextEnvelopeV2`; adapters do not consume ContextAssembly directly.

## ContextAssembly fields

Top-level fields currently covered by this contract:

| Field | Purpose | Notes |
| --- | --- | --- |
| workItemId | Logical WorkItem that owns the invocation context. | Prevents tasks, memories, events, artifacts, and decisions from leaking across unrelated WorkItems in the same Session. |
| contextSnapshotId | Revisioned intent-context snapshot used to assemble the invocation. | Provides an auditable reference for stale-snapshot validation and route replay. |
| decisionSetHash | Stable hash of the confirmed decision set included in the context. | Lets dispatch and review verify that the invocation used the intended Decision Ledger revision. |
| inheritedDecisionIds | Explicitly inherited confirmed decisions for a related WorkItem. | Independent WorkItems receive an empty set; inheritance is never inferred from Session history. |
| inheritedArtifactIds | Explicitly inherited artifacts for a related WorkItem. | Independent WorkItems receive an empty set; unrelated artifacts stay excluded. |
| systemRules | Non-negotiable runtime behavior rules. | Must include side-effect and workspace grounding rules. |
| sessionGoal | User's original or current goal. | Always present. |
| currentContractGoal | Latest authoritative task-contract goal. | Keeps a revised brief goal distinct from the immutable original Session input. |
| currentUserMessage | Exact user message that triggered the current routing invocation. | Untrusted invocation input; it is projected to L1 only and must not be reclassified as an authority rule or constraint. |
| attachmentRefs | Metadata-only references attached to the current user message. | Carries stable attachment/session identifiers and display metadata without binary contents; Runtime must use the attachment capability for any explicit read. |
| taskContext | Task Context Pack for the current invocation. | Carries task domain/intent, current stage, Project Map or Domain Map, stage plan, evidence selection, evidence refs, validation rules, and Execution/Validation/Review responsibilities. |
| summaryMemory | Compact continuation memory for long chains. | Carries current goal, current state, confirmed facts, completed work, decisions, open questions, risks, and next steps. |
| continuationState | Structured runtime continuation state. | Carries current phase/status, active task/agent, task queues, latest checkpoint, handoff refs, source refs, next agents, and resume hints. |
| contextEnvelopeV2 | Authoritative L0-L6 context envelope for v2 sessions. | Carries policy, task, navigation, grounded evidence, history, state, and artifact layers; v2 runtime payloads do not duplicate legacy workspace fields. |
| resolvedExecutionTarget | Auditable per-invocation runtime resolution. | Records runtime/model/source/reason after task, phase, workspace capability, policy, and availability checks; it must not be derived from the Agent profile in v2. |
| workingDirectory | Selected workspace binding. | Present when browser or server-local workspace is attached. |
| workspaceManifest | Runtime-facing workspace structure and file metadata. | Preferred structure input. Exposes tree, paths, sizes, readability, content length, stack, and entrypoints without file bodies. |
| selectedEvidenceContents | Runtime-readable selected evidence content. | Preferred content input. Derived from selected evidence refs and trimmed by token budget. |
| fileRevisionEvidence | Immutable evidence for one confirmed user-file revision. | Present only for `file_revision` and `revision_synthesis` tasks; carries bounded original/revised/Diff evidence and successful Agent proposals into L3. |
| requiredDocument | Immutable discussion-document reference that the invocation must read. | Carries only `documentId`, `revision`, workspace-relative `relativePath`, and `contentHash`; Markdown正文不进入 Prompt。Runtime 必须调用 `read_file` 完整读取精确路径，且读取回执、活动版本和哈希全部匹配后才可成功。 |
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

## ContextEnvelopeV2 fields

The Runtime-facing envelope has only these top-level fields: `version`, `createdAt`, `workspaceId`, `sessionId`, `L0`, `L1`, `L2`, `L3`, `L4`, `L5`, `L6`, `budget`, and optional `contextScope`. L0 carries authority and Workspace identity; L1 carries the invocation goal, optional untrusted `currentUserMessage`, task, and navigation; L2 carries the Project Map; L3 carries grounded readable evidence; L4 carries tool results; L5 carries bounded history; L6 carries delivery state. `contextScope` carries the owning WorkItem, source context snapshot, decision-set hash, and explicit decision/artifact inheritance used to build the envelope. Adapters must not receive parallel legacy Workspace fields.

Phase filtering must remain consistent with the grounded-evidence gate. Discussion and delivery may carry bounded L3 when the selected strategy requires evidence; delivery also keeps L1 navigation so every L3 path can be validated against the current Workspace manifest. Phase filtering must never require L3 and then erase it before Runtime dispatch.

## 分阶段注入矩阵

| AgentRunPhase | Should see | 不应该看到 |
| --- | --- | --- |
| discussion | sessionGoal, taskContext, summaryMemory, continuationState, agentProfile, constraints, relevantEvents, workingDirectory, workspaceManifest, selectedEvidenceContents, workspaceFocus, requiredDocument when a discussion plan is active | Full implementation logs, full workspace file bodies, discussion-document正文 copied into Prompt, or unrelated artifacts. |
| brief_generation | sessionGoal, taskContext, summaryMemory, continuationState, relevantEvents, relevantMemories, ragSnippets, workingDirectory, workspaceManifest, selectedEvidenceContents, workspaceFocus | Unconfirmed implementation details, full workspace file bodies, or hidden side effects. |
| brief_revision | previous taskBrief, user feedback, taskContext, summaryMemory, continuationState, relevantEvents, relevantMemories, workspaceFocus | Unrelated tool output. |
| brief_consultation | currentContractGoal, taskBrief, user question, taskContext, summaryMemory, relevantEvents, workspaceFocus | Unrelated execution output or authority to bypass brief confirmation. |
| task_acceptance | taskBrief, currentTask, taskContext, summaryMemory, continuationState, agentProfile, constraints, budget | Other agents' unrelated tasks or full event history. |
| task_execution | taskBrief, currentTask, taskContext, summaryMemory, continuationState, relevantMemories, capabilities, artifacts, constraints, budget, workingDirectory, workspaceManifest, selectedEvidenceContents, workspaceFocus, and task-scoped fileRevisionEvidence when applicable | Other agents' unrelated tasks, full workspace file bodies, or unapproved external side effects. |
| post_review | taskBrief, taskContext, summaryMemory, continuationState, artifacts, relevantEvents, verification evidence, budget | Unverified guesses or private speculation. |
| final_delivery | review result, taskContext, summaryMemory, continuationState, artifacts, risks, memory candidates, budget | Private speculation or unconfirmed external send actions. |
| user_message_routing | current state, currentUserMessage, taskContext, summaryMemory, continuationState, relevantEvents, constraints | Full history noise, currentUserMessage in L0/constraints, or irrelevant workspace contents. |

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

- `contextEnvelopeV2` is the sole authoritative workspace context channel delivered to the runtime. L0-L6 respectively carry policy, task, navigation, grounded evidence, history, state, and artifacts.
- Before every runtime call, Orchestrator removes duplicated `workspaceSnapshot`, `workspaceManifest`, `selectedEvidenceContents`, and `projectMap` fields from the runtime-facing pack. There is no v1 compatibility payload.
- `resolvedExecutionTarget` is resolved for every invocation and included for auditability. Agent role, Markdown, Skills, Tools, and capability declarations may constrain eligibility, but `Agent.runtimeType` and `Agent.modelId` do not select the target.
- If no registered target satisfies required task/workspace capabilities, routing fails closed with `CAPABILITY_BLOCKED`; browser fallback may downgrade only to an eligible read-only runtime.

- `workingDirectory` indicates where file changes may be proposed or applied; it is not permission to write outside that root.
- `workspaceManifest` can include tree, file metadata, summaries, detected stack, and entrypoints. It must not include file bodies.
- `selectedEvidenceContents` is the only default workspace-derived readable content channel for runtime prompts. It must be derived from `taskContext.evidenceSelection.selectedRefs`, token-trimmed, and traceable by source/ref.
- `fileRevisionEvidence` is a dedicated exception for a confirmed file-revision task: the user-revised snapshot is authoritative, while the original snapshot and deterministic Diff are comparison evidence. The envelope builder must bound this evidence inside L3 and preserve content references when bodies are truncated.
- `requiredDocument` is a mandatory tool-read gate, not an evidence-body channel. It exposes only the active discussion document identity, version, relative path, and expected hash. A missing, truncated, wrong-path, superseded, or hash-mismatched `read_file` receipt must fail closed with `DOCUMENT_READ_REQUIRED` or the corresponding document-read error and must not be converted into a successful Agent result.
- Every Agent selected for one revision receives the same frozen `revisionId`, file path, original Hash, revised Hash, and Diff. A synthesis invocation may additionally receive completed Agent proposals from that same revision; unrelated revision runs must never be mixed.
- File-revision evidence does not grant write authority. Revision tasks use proposal-only execution, and the live file can change only after a matching user confirmation and expected-Hash check.
- `workspaceSnapshot` is retained for compatibility as a manifest-style fallback. Runtime prompts must not assume `workspaceSnapshot.files[].content` is present.
- `workspaceFocus.relevantFiles` guides impact analysis, while `impactedFiles` narrows the likely modification surface. The Agent must still state uncertainty when the snapshot is incomplete.
- `testFiles` and `validationCommands` should be used to choose scoped validation before broader typecheck/test/build/e2e runs.
- `configFiles`, `possibleEntryPoints`, `detectedStack`, and `rationale` should be used to explain why a task affects specific files.
- Token preflight may remove or truncate selected evidence contents. Agents must not pretend omitted or manifest-only content was read.
- For real `codex` and `claude_code` runtime execution, ContextEnvelopeV2 delivery is separate from permission. Orchestrator must pass Tool Authority and write-mode preflight before launching a source-writing runtime, and a blocked preflight must leave the task waiting without starting the runtime process.

## Token and trimming rules

- `budget.maxInputTokens` limits context sent to runtime.
- If context exceeds budget, the system first trims `relevantEvents`, `ragSnippets`, `artifacts`, and `selectedEvidenceContents`.
- The corresponding bounded L0-L6 arrays and evidence contents in `contextEnvelopeV2` are trimmed before assembly-only legacy duplicates are removed.
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

## 工作区扫描盲区与运行时回填（Context Engineering Remediation v1）

实现参考：`docs/roadmap/context-engineering-remediation-v1.md`（任务追踪 `.tasks.json`）。

### `workspaceManifest.coverage`

`WorkspaceManifestCoverage = { totalEntriesSeen, scannedEntries, readableFiles, skippedByReason }`，由扫描端（`apps/server/src/common/workspace-scanner.ts`、`apps/web/src/stores/local-workspace-scanner.ts`）在 finalize 阶段聚合 `skipped[]` 写入。

- 服务端与浏览器端共用 `WorkspaceSkippedReason` 枚举：`ignored_directory | binary | too_large | sensitive | limit_exceeded | read_error`。
- `coverage` 进入内部 `ContextAssembly.workspaceManifest.coverage`，再由 envelope builder 转换为受限的导航与规则信息。
- 当 `scannedEntries < totalEntriesSeen` 或 `skippedByReason` 非空时，`ContextEnvelopeV2.L0.systemRules` 必须包含 CONTEXT_INSUFFICIENT 提示，要求 runtime 用 `requestedPaths` 取回缺失内容而非凭空推测。

### `selectedEvidenceContents[].truncatedHint`

智能截断接口 `truncateContentForEvidence(path, content, budget, options?)`（`apps/server/src/common/evidence-truncation.ts`）返回 `{ content, truncated, truncatedHint }`。`EvidenceTruncatedHint`（合同位于 `packages/shared/src/contracts.ts`）字段：

- `strategy`：`slice | ts-symbol-window | md-section-window`。
- `originalBytes`、`keptBytes`、`droppedRanges?`。
- `keptSections?`、`droppedSections?`（仅 `md-section-window` 填充）。

截断策略：

- TS / JS / Vue（含 .tsx/.jsx/.mjs/.cjs）：在 `options.query` 命中时，先保留顶部 imports / `export type|interface|* from|{...}`，再从命中位置回溯最近的 `export (function|class|const|let|var|interface|type|enum)` 符号声明并按剩余 budget 切窗。
- Markdown（.md/.markdown/.mdx）：按 `^## ` 切段，优先保 `topRegion` 与命中 `options.query` 的章节，hint 写明 `keptSections` / `droppedSections`。
- 其他扩展或上述策略未命中时回退 `slice`。

`workspaceEvidenceContent` 调用截断接口后把 `truncatedHint` 透传给内部 `ContextAssembly.selectedEvidenceContents` 项，最终可读证据进入 `ContextEnvelopeV2.L3`，debug 接口可读。

### CONTEXT_INSUFFICIENT 重试预算与 dedupe

- env：`AGENT_CLUSTER_CONTEXT_INSUFFICIENT_MAX_RETRIES`（默认 3，负值/非数值回退默认）。
- `canRetryWithSupplementalContext(code, requestedContext, retryCount, maxRetries)` 校验：必须是 `CONTEXT_INSUFFICIENT` + 携带 `requestedContext` + `retryCount < maxRetries`。
- 入库前 dedupe：`refSignature(ref) = "${type}::${ref ?? label}"`，paths 与 commands 按字符串精确去重。`trimToNovelContext(candidate, seen)` 只保留新条目，纯重复返回 `undefined` → orchestrator 在 `session.events` 落 `agent_message{phase:'context_supplement', rejectionReason:'duplicate_request'}`，不进入 retry 计数。

### v2 预算与证据保留

v2 不再使用事后多阶段裁剪，也不存在 `ultra-minimal` 或 `navigation_only`。预算在 Envelope 组装时分配到 L0-L6，并由 Evidence selector 在 L3 内按任务意图、入口、模块边界和用户点名路径选择正文。

- 代码实现和架构分析要求 grounded evidence 时，L3 至少保留一份可读源码正文；不得为了适配预算清空 `selectedEvidenceContents` 后继续执行。
- 当前预算无法容纳必要证据时，Runtime 返回 `CONTEXT_INSUFFICIENT` 和严格校验后的 `requestedPaths/requestedRefs`，由 Workspace Provider 补读后重新组装完整 v2 Invocation。
- 补读结果记录 `hydratedPaths / failedPaths / deferredPaths / contentBytes`；只有成功 hydrate 的路径才进入 Evidence 和 dedupe 集合。
- 读取失败必须区分 `NOT_FOUND / PERMISSION_REQUIRED / BROKER_OFFLINE / READ_UNAVAILABLE / READ_ERROR`，不得吞掉异常或把请求本身当成已获得证据。
