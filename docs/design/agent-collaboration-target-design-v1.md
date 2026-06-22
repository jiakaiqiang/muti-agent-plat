# Agent Collaboration Target Design v1

## 1. Target

Agent Cluster's product target is a group-chat style multi-agent collaboration platform.

The user should be able to submit a goal in one workspace, watch agents discuss the goal, confirm a task brief, observe task decomposition and ownership, see execution and validation progress, and receive a final delivery that explains what was done, what was verified, and what risks remain.

Context governance is a supporting capability. Project Map, Context Router, minimal evidence selection, summary memory, token budget, and capability audit exist to make agent collaboration safer and more accurate. They are not the primary product surface.

## 2. Product Principle

The main screen must answer these user questions first:

- What are the agents discussing?
- What task contract did they produce?
- Who owns each task?
- What is each agent doing now?
- What evidence proves the work is complete?
- What needs my confirmation?

Debug and context-governance views should answer developer/operator questions:

- Why did this agent receive this context?
- Which evidence was selected or omitted?
- What token budget or compaction decision was applied?
- Which capability checks protected the workspace?

## 3. End-to-End Flow

```text
User goal
  -> agent group discussion
  -> task brief and user confirmation
  -> task decomposition
  -> agent claim / handoff / rejection
  -> scoped context pack per agent and phase
  -> execution artifacts, diffs, messages, and validation evidence
  -> independent review
  -> final delivery
  -> summary memory for continuation
```

## 4. Product Capabilities

### 4.1 Group Chat Collaboration

- User messages and agent messages are rendered as the primary timeline.
- Agent discussion, disagreement, handoff, risk, progress, and decisions are visible.
- User interruptions are treated as collaboration events, not plain chat.
- When a user changes scope, constraints, or acceptance criteria, affected agents and tasks are shown.

### 4.2 Task Brief and Decomposition

- Coordinator produces a user-confirmable task brief.
- The brief includes goal, scope, non-goals, constraints, acceptance criteria, risks, open questions, and suggested tasks.
- Tasks include assignee, status, dependencies, acceptance criteria, and result summary.
- Agents can claim, decline, hand off, wait, complete, or request more context.

### 4.3 Execution and Validation

- Execution agents produce artifacts, file changes, runtime messages, and handoff notes.
- Validation and Review agents evaluate outputs independently from execution agents.
- Final delivery cites completed items, validation results, remaining risks, and follow-up work.

### 4.4 Context Governance as Infrastructure

Context governance must serve collaboration quality:

- Project Map identifies relevant modules, entrypoints, contracts, tests, and validation commands.
- Context Router chooses the phase-specific context for each agent.
- Evidence Selection injects only the minimal evidence needed for the current agent and stage.
- Summary Memory preserves long-chain state without replaying full history.
- Capability Audit controls high-risk actions such as file writes, command execution, and external side effects.

These capabilities should be visible in audit/debug views and summarized in the chat only when they affect the user's decision or task progress.

## 5. Non-Goals

- Do not make Context Router the main user-facing product.
- Do not turn Harness Engineering into a business runtime feature.
- Do not hide agent collaboration behind a debug-only workflow.
- Do not let a runtime bypass task brief confirmation for high-risk actions.
- Do not claim strict minimal-evidence governance unless runtime inputs are actually restricted to selected evidence.

## 6. Implementation Priorities

### Phase A: Collaboration Mainline

- Keep chat, collaboration graph, and workflow views centered on agent discussion, task ownership, progress, and delivery.
- Ensure task brief confirmation remains the gate before execution.
- Ensure user interruptions update the visible collaboration state.

### Phase B: Context Governance Behind the Mainline

- Use Project Map and Context Router to improve task decomposition and scoped execution.
- Keep context choice explainable in debug/audit views.
- Surface context insufficiency in chat only as an actionable request.

### Phase C: Stronger Runtime Boundaries

- Replace full workspace injection with selected evidence content and a workspace manifest.
- Resolve requested context by reading, validating, and injecting requested refs or paths.
- Run real coding runtimes in an isolated worktree or proposed-diff flow before applying changes.

### Phase D: Behavioral Verification

- Test that group-chat task decomposition remains the primary flow.
- Test that selected evidence, requested context, and capability audit affect real runtime behavior, not only debug metadata.
- Test that sensitive or omitted files do not enter runtime input.

## 7. Success Criteria

The target is achieved when:

- A user can complete the full journey from goal input to final delivery in the collaboration workspace.
- The user can clearly see discussion, task decomposition, ownership, execution, validation, review, and delivery.
- Debug/audit views can explain context and permission decisions without replacing the collaboration experience.
- Each agent receives context scoped to its role, task, and phase.
- Context insufficiency triggers a real supplemental context resolution flow.
- High-risk runtime actions are gated and auditable before they affect the workspace.
