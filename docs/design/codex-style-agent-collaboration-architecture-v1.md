# Pluggable Engineering Agent Collaboration Architecture v1

## 1. Background

Agent Cluster wants a group-chat style agent workspace where users can discuss requirements, see task decomposition, track execution, review validation, and receive delivery.

The current context work already moves in a Codex-like direction:

- `ProjectMap` describes repository areas and validation paths.
- `ContextRouter` selects task-specific context.
- `TaskContext` carries task map, stage plan, evidence selection, and validation rules.
- `ContextPack` is trimmed before runtime.
- `selectedEvidenceContents` separates readable content from workspace structure.

However, a token budget issue still appears when the runtime input remains too large. This means the direction is right, but the boundary is not strict enough.

The key lesson from Codex-style engineering agents is:

```text
Do not understand a whole project by injecting the whole project into the prompt.
Understand a project by using a small entry context, file/search tools, task-scoped reads, summaries, and verification.
```

## 2. Problem Statement

Replacing the current coordinator with Codex, Claude Code, or another CLI engineering agent does not automatically solve token overflow.

If the system still does this:

```text
Agent Cluster builds a large ContextPack
  -> serializes it into a runtime prompt
  -> sends it to a CLI engineering runtime
```

then the runtime is only a different consumer of the same oversized payload.

The real problem is not which model receives the prompt. The real problem is whether project understanding is implemented as:

```text
large preloaded context
```

or as:

```text
small routing context + controlled on-demand tool reads
```

## 3. Strict Conclusion

Recommendation: cautiously recommended.

Codex should be treated as the first implementation of a pluggable engineering runtime, not as a hard-coded main agent or larger prompt receiver.

Agent Cluster should remain responsible for:

- group-chat collaboration;
- user confirmation;
- task state;
- audit trace;
- permission governance;
- summary memory;
- debug visibility;
- delivery flow.

The active engineering runtime should be responsible for:

- reading the project with tools;
- locating impacted files;
- producing engineering task decomposition;
- editing files when authorized;
- running validation when authorized;
- returning diffs, artifacts, read traces, and verification results.

## 4. Target Architecture

```text
User
  -> Conversation Coordinator
  -> Project Map / Context Router
  -> Group-chat Planning
  -> Runtime Execution
       -> Engineering Agent Runtime
            -> Codex CLI Adapter
            -> Claude Code CLI Adapter
            -> Generic CLI Adapter
            -> Human Adapter
       -> Generic LLM Runtime
       -> Mock Runtime
  -> Review / Validation
  -> Delivery / Summary Memory
```

The orchestration layer must depend on the engineering runtime protocol, not on Codex-specific behavior.

### 4.1 Conversation Coordinator

The coordinator owns the collaboration flow, not the whole project context.

Responsibilities:

- classify user intent;
- create or revise task brief;
- decide whether user confirmation is needed;
- coordinate group-chat agents;
- route tasks to the correct runtime;
- preserve visible audit events.

It should not inject full project content into every agent.

### 4.2 Project Map Layer

The Project Map layer answers:

```text
What kind of project is this?
Which areas are probably relevant?
Where are entrypoints, contracts, tests, and validation commands?
```

It should store structure, not source bodies.

Allowed content:

- module names;
- paths;
- entrypoint paths;
- test paths;
- contract paths;
- package scripts;
- risk boundaries;
- memory/documentation locations;
- source refs.

Forbidden content:

- full file bodies;
- full event history;
- full artifact bodies;
- unbounded workspace file lists.

### 4.3 Context Router Layer

The Context Router produces a task-scoped routing result:

```text
TaskContext
workspaceFocus
candidate evidence refs
selected evidence refs
read / do / validate stage plan
```

The router should be an index selector, not a content mover.

For example:

```text
User asks about runtime token budget
  -> select token.ts
  -> select orchestrator runtime path
  -> select runtime contract
  -> select token-budget smoke tests
```

It should not preload the whole server module.

### 4.4 Group-chat Agent Layer

Group-chat agents should receive role-specific context packs.

Example:

```text
Coordinator Agent:
  goal, task brief, task state, constraints

Architect Agent:
  ProjectMap, design docs refs, risk boundaries

Backend Agent:
  server refs, shared contract refs, validation commands

Frontend Agent:
  web refs, UI state refs, browser smoke refs

Review Agent:
  diff summaries, validation rules, test evidence
```

Different agents should not receive the same large context. The group chat should coordinate perspectives, not multiply the same prompt payload.

### 4.5 Engineering Agent Runtime Layer

The engineering runtime should receive a small task packet:

```text
goal
current task
acceptance criteria
constraints
allowed workspace root
initial candidate paths
validation commands
budget
capability policy
```

The runtime should then use tools to read files on demand:

```text
rg
read file
git diff
run tests
inspect package scripts
```

The runtime should return:

- read trace;
- files inspected;
- task decomposition;
- changed files;
- diff/artifacts;
- validation results;
- missing context requests;
- summary for group chat.

It should not require Agent Cluster to pre-inject full workspace file content.

Supported implementations may include:

- `codex`
- `claude_code`
- `gemini_cli`
- `aider`
- `custom_cli`
- `generic_llm`
- `human`

Codex can be the default implementation, but the architecture must allow the main engineering runtime to be switched later.

### 4.6 Runtime Selection

Runtime selection should be layered:

```text
Agent override
  > Session override
  > Project default
  > Global default
```

Example:

```text
Global default engineering runtime: codex
Project default engineering runtime: claude_code
Session override: codex
Backend Agent override: codex
Review Agent override: claude_code
```

The selected runtime changes the adapter implementation, not the collaboration flow.

The common protocol should preserve:

- task packet input;
- controlled context requests;
- tool read trace;
- artifact output;
- file change output;
- validation result output;
- usage reporting;
- capability and budget enforcement.

## 5. Token Budget Risk Analysis

The following fields can still cause large runtime payloads if not bounded:

| Field | Risk | Required Rule |
| --- | --- | --- |
| `workspaceSnapshot` | Can preserve large file metadata or content if used as project dump. | Runtime-facing snapshot must be manifest-only and length-bounded. |
| `workspaceManifest` | Large tree and file metadata still consume tokens. | Keep only ranked, bounded structure. |
| `selectedEvidenceContents` | Main readable-content channel. | Hard limit item count, per-item chars, total chars, source refs, and dedupe. |
| `projectMap` | Can grow if it becomes a full repository model. | Keep module-level map and source refs only. |
| `taskContext` | Evidence refs, reasons, task map, stage plan can grow. | Bound all arrays and keep `evidenceRefs === selectedRefs`. |
| `artifacts` | Artifact summaries can become hidden history. | Send summaries only, bounded by phase. |
| `relevantEvents` | Event history can grow linearly. | Send recent/relevant slices only. |
| `relevantMemories` | Memory content can become long. | Send compact relevant memories only. |
| `ragSnippets` | Retrieval snippets can grow. | Bound count and snippet length. |

## 6. Required Architecture Constraints

### 6.1 ContextPack Is A Navigation Packet

`ContextPack` must not be treated as a project dump.

It should contain:

- goal;
- task brief;
- current task;
- stage plan;
- selected refs;
- compact workspace structure;
- constraints;
- budget;
- capability policy;
- small selected evidence content only when necessary.

It should not contain:

- full workspace file content;
- full workspace file list for large projects;
- full event history;
- full memory history;
- full artifact body list.

### 6.2 Runtime Reads Must Be Tool-based

Engineering runtimes must request or read files through controlled tools.

Every read should be auditable:

```ts
type RuntimeReadTrace = {
  path: string;
  reason: string;
  source: 'initial_ref' | 'search_result' | 'runtime_request';
  tokenEstimate?: number;
};
```

### 6.3 Supplemental Context Must Stay Incremental

The retry path must stay small:

```text
CONTEXT_INSUFFICIENT
  -> requestedContext
  -> select requested refs
  -> inject only requested readable content
  -> retry same phase
```

It must not expand into:

```text
context insufficient
  -> inject whole workspace
```

### 6.4 Emergency Compaction Must Exist

The system needs one final fallback after normal minimal compaction:

```text
normal trim
  -> focused trim
  -> compact trim
  -> minimal trim
  -> emergency navigation-only pack
```

The emergency pack should keep only what is required to ask for more context or start tool-based reading.

### 6.5 Debug Must Not Become Runtime Input

Debug views may show rich explanations, but runtime prompts must receive only bounded runtime fields.

Debug payload and runtime payload should be treated as different surfaces.

## 7. Recommended Flow

### 7.1 Task Planning

```text
User request
  -> Coordinator classifies intent
  -> ProjectMap finds likely modules
  -> ContextRouter creates task-scoped refs
  -> Group-chat agents discuss with role-specific packs
  -> Task brief is confirmed
```

### 7.2 Engineering Execution

```text
Confirmed task
  -> Codex Runtime receives small engineering task packet
  -> Codex searches/reads files on demand
  -> Codex edits or proposes patch if authorized
  -> Codex runs validation if authorized
  -> Codex returns diff, read trace, test evidence
```

### 7.3 Review And Delivery

```text
Runtime result
  -> Review Agent receives diff summary and validation evidence
  -> Coordinator checks acceptance criteria
  -> SummaryMemory stores compact confirmed facts
  -> User receives final delivery
```

## 8. Minimum Acceptance Criteria

### 8.1 Large Workspace Safety

For a workspace with hundreds of files and large readable content:

- runtime payload must stay under budget;
- `workspaceSnapshot.files[].content` must not appear in runtime input;
- full workspace file lists must not be required for runtime execution.

### 8.2 Selected Evidence Bounds

`selectedEvidenceContents` must have:

- max item count;
- max per-item content length;
- max total content length;
- dedupe by source/ref;
- debug-visible truncation state;
- traceable source refs.

### 8.3 Role-specific Context

Group-chat agents must not all receive the same large context.

Each agent receives a context pack aligned to its role and current phase.

### 8.4 Engineering Runtime Prompt Bound

Engineering runtime prompt must include:

- task contract;
- refs and candidate paths;
- constraints;
- capability policy;
- validation commands.

It must not include:

- complete workspace bodies;
- complete event history;
- complete artifact bodies;
- unbounded workspace metadata.

### 8.5 Tool Read Trace

Engineering runtime must report:

- files searched;
- files read;
- reason for each read;
- validation commands run;
- artifacts or diffs produced.

### 8.6 Retry Stability

Repeated `CONTEXT_INSUFFICIENT` handling must not grow context linearly with each retry.

The retry context must promote only requested refs and retain token budget constraints.

## 9. Suggested Verification

Minimum automated checks:

```bash
npm run test:e2e:token-budget
npm run test:e2e:workspace-snapshot-payload
npm run test:e2e:context-insufficient-retry
npm run test:e2e:selected-evidence-content
npm run typecheck
```

Additional required test for pluggable engineering runtime adoption:

```text
Engineering runtime large-workspace prompt-size smoke:
  - create a workspace with 300+ files and hundreds of KB content
  - route an engineering task to the selected engineering runtime
  - assert runtime prompt is below maxInputTokens
  - assert prompt does not contain unselected file content
  - assert prompt contains only refs, compact manifest, and bounded selected evidence
```

Additional required test for runtime switching:

```text
Engineering runtime selection smoke:
  - configure global default as codex
  - override session runtime as claude_code
  - override one agent runtime as custom_cli
  - assert Orchestrator uses the selected adapter by priority
  - assert all adapters receive the same bounded task packet shape
```

Additional required test for group-chat context isolation:

```text
Group-chat role context smoke:
  - create a multi-agent task
  - inspect each agent ContextPack
  - assert each role receives phase/role-specific context
  - assert shared context does not duplicate full project structure across all agents
```

## 10. Implementation Roadmap

### Phase 1: Harden Current ContextPack

- Cap `workspaceSnapshot.files`, not only `workspaceSnapshot.tree`.
- Ensure runtime-facing `workspaceSnapshot` is always manifest-only.
- Add emergency navigation-only compaction.
- Expose token diagnostics in debug.

### Phase 2: Split Debug Payload From Runtime Payload

- Keep debug rich.
- Keep runtime small.
- Make token diagnostics explain which fields were cut.

### Phase 3: Add Engineering Runtime Tool-read Contract

- Define runtime read request/read trace contract.
- Add path allowlist and workspace boundary checks.
- Make reads visible in events/debug.

### Phase 4: Role-specific Group-chat Context

- Generate per-agent context slices.
- Prevent copying the same full ContextPack to all agents.
- Add tests for role context isolation.

### Phase 5: Pluggable Engineering Runtime

- Send the selected engineering runtime a small task packet.
- Let the selected runtime read files on demand.
- Capture diff, artifacts, validation, read trace, and missing context requests.
- Support runtime selection by global, project, session, and agent override.

## 11. Final Position

Codex-style collaboration is the right direction only if the system adopts the real operating model of engineering agents:

```text
small context + tools + trace + summary
```

It is the wrong direction if it becomes:

```text
large ContextPack + a CLI runtime as a bigger LLM endpoint
```

Therefore the recommended product architecture is:

```text
Agent Cluster remains the collaboration and governance platform.
Codex, Claude Code, or another CLI becomes the selected controlled engineering runtime.
ContextPack becomes a bounded navigation packet, not the container for the whole project.
```
