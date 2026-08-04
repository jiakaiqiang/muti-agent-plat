# Managed Worktree Execution v1

## Purpose

`apps/server/src/modules/worktree-execution/` isolates write-capable Codex CLI and Claude Code task executions from the user-selected server-local directory, then captures and writes changes back through the Workspace Provider.

The module owns workspace preparation and change capture. `WorkspaceWritebackService` owns FIFO application and conflict records; Runtime routing, CLI behavior and resolution UI remain outside this module.

## Activation

Managed execution is enabled when all conditions are true:

- phase is `task_execution`;
- the invocation has a `taskId`;
- workspace provider is `server_local`;
- write mode is not `none`;
- runtime is `codex` or `claude_code`;
- `AGENT_CLUSTER_WORKTREE_EXECUTION` is not `false`.

Git roots, nested directories inside a Git repository, and non-Git directories are supported.

## Lifecycle

```text
InvocationPlan
  -> prepare or restore sessionId/taskId worktree or staging copy
  -> copy current tracked and safe untracked changes into a detached baseline
  -> commit the baseline only inside the detached worktree
  -> bind invocationId to the isolated execution directory
  -> start Codex CLI or Claude Code
  -> let the CLI read, edit, and run tests in that directory
  -> calculate WorkspaceChangeSet from the real Git/filesystem delta
  -> enqueue Workspace FIFO writeback
  -> path-hash validation and optional three-way merge
  -> release the invocation binding
```

Each `sessionId/taskId` pair has its own Git worktree or staging copy. Two sessions selecting the same directory therefore receive different physical execution directories and cannot overwrite one another while their CLIs run.

Git tasks may execute in parallel. Non-Git read-only tasks may also execute in parallel, but non-Git write-capable tasks hold a per-directory FIFO lease from staging preparation through source writeback.

The source branch, source index, and source working tree are never reset, checked out, staged, or committed by this module.

## Dirty Baseline

The worktree starts from the source `HEAD`, then receives:

- tracked staged and unstaged changes through a binary Git patch;
- safe untracked regular files through bounded file copies.

That state is committed inside the detached worktree as the task baseline. The manifest records SHA-256 hashes from the source working tree's real bytes, not Git blob bytes. This keeps conflict detection correct on Windows repositories using CRLF checkout conversion.

## Change Authority

CLI-reported file changes are advisory. The authoritative result is `RuntimeWorkspaceExecution.changeSet`, calculated by the platform after the runtime finishes.

The returned result has these properties:

- `mode` is `git_worktree` or `staging_copy`;
- all file changes are marked `runtime_proposed_change`;
- a `code_diff` artifact carries the same `WorkspaceChangeSet`;
- normal write-capable execution sets `requiresUserConfirmation=false` and enters automatic FIFO writeback;
- `proposal_only` sets `requiresUserConfirmation=true` and remains proposal-only.

Existing expected hashes detect source changes that happened after the baseline was captured. Text updates include base content when available, allowing automatic three-way merge for non-overlapping edits. Conflicts produce a durable writeback record and stop the Session at `WAIT_WORKSPACE_CONFLICT_RESOLUTION`; the source directory is never silently overwritten.

## Persistence Layout

The default root is:

```text
${AGENT_CLUSTER_DATA_DIR}/execution-worktrees/
  manifests/<session>/<task>.json
  runs/<session>/<task>/                # Git worktree
  runs/<session>/<task>/baseline/       # non-Git baseline
  runs/<session>/<task>/workspace/      # non-Git execution copy
```

`AGENT_CLUSTER_WORKTREE_ROOT` overrides this root. Manifests allow the same task to resume in its existing worktree and preserve the CLI session working directory.

## Safety Limits

| Environment variable | Default | Purpose |
| --- | ---: | --- |
| `AGENT_CLUSTER_WORKTREE_MAX_BASELINE_FILES` | `512` | Maximum copied untracked baseline files |
| `AGENT_CLUSTER_WORKTREE_MAX_BASELINE_BYTES` | `16777216` | Maximum copied untracked baseline bytes |
| `AGENT_CLUSTER_WORKTREE_MAX_CHANGED_FILES` | `512` | Maximum captured changed files |
| `AGENT_CLUSTER_WORKTREE_MAX_FILE_BYTES` | `2097152` | Maximum captured file size |
| `AGENT_CLUSTER_WORKTREE_GIT_MAX_BUFFER` | `33554432` | Maximum buffered Git command output |

Sensitive untracked paths, symbolic links, binary changes, non-UTF-8 changes, and over-limit results fail closed.

## Module Boundaries

- `worktree-execution.service.ts`: lifecycle, manifest, baseline, invocation binding.
- `worktree-change-set.ts`: authoritative filesystem/Git delta conversion.
- `git-command.ts`: shell-free bounded Git subprocess wrapper.
- `worktree-execution.module.ts`: Nest module export boundary.
- `invocation-workspace-bindings.service.ts`: invocation-specific working directory override consumed by Codex and Claude adapters.

## Conflict resolution

The UI exposes five explicit actions: retry merge, ask the Agent to regenerate compatible changes, keep the current workspace, force the Session version with confirmation, or abandon the writeback. Successful apply/abandon completes the waiting task and resumes the remaining pipeline; workflow nodes remain running while conflict resolution is pending.

## Known Limits

- ChangeSets currently support UTF-8 regular files; binary and symlink changes are rejected.
- Worktree cleanup/retention policy is operational follow-up work; worktrees are retained for task resume and audit.
- FIFO serialization is process-local; multi-replica deployments need a distributed workspace writeback lock before enabling concurrent writers across replicas.

## Local Runtime boundary

`local_bridge` uses the same isolation principle on the user's machine: Local Runtime creates a private staging copy, runs Codex or Claude Code there, captures a ChangeSet, and applies it through the opaque registered Provider. The local absolute path remains outside platform Session/API payloads. The retired browser mirror path is not a supported fallback.
