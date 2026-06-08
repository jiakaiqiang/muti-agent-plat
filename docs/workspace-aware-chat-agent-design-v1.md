# Workspace-Aware Chat Agent Design v1

## Purpose

This document records the confirmed product direction for Agent Cluster:

Agent Cluster remains a chatroom-style multi-agent collaboration platform. It should not become a terminal-first clone of Codex or Claude Code. However, when users submit requirements and agents execute tasks, the platform should borrow the workspace-aware working model used by coding agents such as Codex and Claude Code.

In practice, agents should analyze the selected working directory before understanding, decomposing, and executing the user's requirement.

## Core Product Positioning

The user experience remains:

```text
User
  -> chatroom session
  -> Coordinator receives the requirement
  -> selected agents discuss
  -> user confirms the task contract
  -> agents execute
  -> chatroom shows outputs, diffs, verification, review, delivery
```

The working model changes to:

```text
Selected working directory
  -> workspace scan and file context
  -> requirement understanding
  -> requirement decomposition
  -> agent discussion
  -> user confirmation
  -> task execution against workspace files
  -> review and delivery
```

## Confirmed Requirements

1. The selected directory is the session workspace.
2. The selected directory is not merely an output folder for generated artifacts.
3. Before Coordinator analyzes a user requirement, the platform must inspect the workspace context.
4. Coordinator and agents should reason from both the user message and the workspace snapshot.
5. Requirement analysis, task decomposition, and execution should be grounded in real files, project structure, and existing implementation.
6. If a requirement involves code or document changes, agents should target the corresponding files in the selected workspace.
7. Chatroom visibility remains central: each stage should be shown as user-readable agent output, artifacts, status, file diffs, validation results, and confirmation cards.
8. Stage outputs should not be forced into fixed artifact filenames or fixed markdown formats. They should be generated according to the user's requirement and the affected workspace files.

## Correct End-to-End Flow

```text
1. User creates a chatroom session.
2. User selects a local working directory.
3. Frontend scans the working directory with browser-granted permission.
4. Frontend creates a workspace snapshot:
   - directory tree
   - selected readable text files
   - skipped files and reasons
   - detected project signals
5. Frontend sends the user requirement, selected agents, working directory metadata, and workspace snapshot to the backend.
6. Backend stores the session and workspace snapshot.
7. Coordinator receives the requirement in the chatroom.
8. Coordinator first analyzes the workspace snapshot, then interprets the requirement.
9. Coordinator outputs requirement understanding and task decomposition in the chatroom.
10. Other selected agents discuss based on the same workspace context.
11. User confirms or revises the task contract.
12. Agents execute tasks against the workspace context.
13. If files need changes, runtime outputs concrete file changes for real workspace paths.
14. Frontend shows the concrete diff/change content.
15. User-confirmed file changes are written back into the selected workspace.
16. Review agent compares the confirmed task contract with actual changes and validation output.
17. Final delivery summarizes completed work, risks, artifacts, and optional notification.
```

## Workspace Snapshot

The backend cannot directly read a user's local browser directory. The frontend must read the directory after the user grants permission, then send a bounded workspace snapshot to the backend.

Suggested contract:

```ts
type WorkspaceSnapshot = {
  rootName: string;
  scannedAt: string;
  fileCount: number;
  totalBytes: number;
  tree: WorkspaceTreeNode[];
  files: WorkspaceFileSnapshot[];
  skipped: WorkspaceSkippedFile[];
  detectedStack?: string[];
  entrypoints?: string[];
};

type WorkspaceTreeNode = {
  path: string;
  kind: 'file' | 'directory';
  children?: WorkspaceTreeNode[];
};

type WorkspaceFileSnapshot = {
  path: string;
  size: number;
  language?: string;
  content?: string;
  summary?: string;
};

type WorkspaceSkippedFile = {
  path: string;
  reason:
    | 'ignored_directory'
    | 'binary'
    | 'too_large'
    | 'sensitive'
    | 'limit_exceeded'
    | 'read_error';
};
```

## Workspace Scan Rules

Default skipped directories:

- `.git`
- `node_modules`
- `dist`
- `build`
- `.next`
- `.cache`
- `coverage`
- generated output directories

Default skipped sensitive files:

- `.env`
- `.env.*`
- files whose names suggest secrets, private keys, certificates, or credentials

Default preferred files:

- `AGENTS.md`
- `CLAUDE.md`
- `README.md`
- `package.json`
- lock files as metadata or summaries
- framework config files
- source files under `src/`, `apps/`, `packages/`, or project-specific entry directories

Hard limits should exist for:

- max scanned files
- max readable files
- max single-file bytes
- max total content bytes
- max total estimated tokens

## Context Pack Changes

`ContextPack` should include workspace context:

```ts
type ContextPack = {
  sessionGoal: string;
  workingDirectory?: SessionWorkingDirectory;
  workspaceSnapshot?: WorkspaceSnapshot;
  workspaceFocus?: {
    relevantFiles: string[];
    possibleEntryPoints: string[];
    detectedStack: string[];
    rationale: string;
  };
  taskBrief?: RuntimeTaskBrief;
  currentTask?: RuntimeAgentTask;
  agentProfile: RuntimeAgentProfile;
  relevantEvents: RuntimeEventSummary[];
  relevantMemories: RuntimeMemoryItem[];
  ragSnippets: RuntimeRagSnippet[];
  artifacts: RuntimeArtifactSummary[];
  capabilities: RuntimeCapabilityDefinition[];
  constraints: string[];
  budget: RuntimeBudget;
};
```

Coordinator and runtime prompts should explicitly require:

```text
Analyze workspaceSnapshot before analyzing the requirement.
Use workspace files as the primary project context.
Do not invent existing files.
If proposing edits, target real workspace paths when possible.
If the workspace snapshot is insufficient, ask for clarification or request more files.
```

## Dynamic Stage Outputs

Stage output should remain visible in the chatroom, but should not be forced into fixed file names or fixed markdown structures.

Examples:

- For a frontend styling request:
  - workspace analysis
  - affected component/style files
  - CSS diff
  - visual verification notes
- For a backend API request:
  - route/service/test impact analysis
  - contract changes
  - implementation file changes
  - API validation output
- For a pure planning request:
  - requirement understanding
  - affected areas
  - risks and open questions
  - no workspace writes unless user asks for a document

`agent-output/` may still be used for optional analysis or delivery summaries, but it must not replace real workspace file edits when the user's task requires editing existing files.

## File Change Policy

File changes should use safe relative workspace paths:

```ts
type RuntimeFileChange = {
  path: string;
  operation: 'create' | 'update' | 'delete';
  content?: string;
  encoding?: 'utf-8';
};
```

Rules:

1. Paths must stay inside the selected workspace.
2. Existing files should be updated in place when the task targets existing implementation.
3. New files should be created only when justified by the task.
4. Deletions require strong justification and user-visible confirmation.
5. The frontend must show concrete change content or diff before/while applying changes.

## Chatroom Visibility

The chatroom should show these stage outputs clearly:

- workspace scan summary
- relevant files and skipped files
- Coordinator requirement understanding
- agent discussion conclusions
- task contract and suggested tasks
- execution plan
- file changes and diffs
- verification results
- review report
- final delivery
- Feishu notification confirmation

Internal implementation details may be hidden, but the user's mental model should remain: "the agent team looked at my workspace, understood the task, discussed it, and changed the right files."

## Non-Goals

This direction does not mean:

- replacing the chatroom UI with a terminal
- making users operate Codex or Claude Code directly
- removing multi-agent discussion
- hiding the process behind a single coding-agent run
- blindly reading every local file
- sending sensitive local files without filtering

## Current Implementation Gap

Current implementation partially supports selecting a local directory and applying `fileChanges`, but it does not yet implement the correct workspace-aware flow:

- the frontend does not scan/read the selected workspace before session creation
- the backend receives only working directory metadata, not workspace file context
- Coordinator does not analyze workspace files before generating the task brief
- several stage artifacts are still fixed markdown-like outputs
- execution can still generate files under `agent-output/` instead of modifying real affected workspace files

## Implementation Direction

Recommended implementation batches:

1. Add shared workspace snapshot contracts.
2. Add frontend workspace scanner with safe filtering and size limits.
3. Send workspace snapshot during session creation.
4. Store workspace snapshot on the session/backend side.
5. Inject workspace context into Coordinator discussion and runtime Context Pack.
6. Make stage outputs requirement-driven rather than fixed filename-driven.
7. Prefer real workspace file paths for execution `fileChanges`.
8. Keep all stage outputs visible in the chatroom.

