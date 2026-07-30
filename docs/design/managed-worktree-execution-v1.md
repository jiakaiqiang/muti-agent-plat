# Managed Worktree Execution v1

## Purpose

`apps/server/src/modules/worktree-execution/` isolates write-capable Codex CLI and Claude Code task executions from the user-selected server-local repository.

The module owns workspace preparation and change capture. It does not own runtime routing, CLI behavior, approval UI, or final ChangeSet application.

## Activation

Managed execution is enabled when all conditions are true:

- phase is `task_execution`;
- the invocation has a `taskId`;
- workspace provider is `server_local`;
- write mode is not `none`;
- runtime is `codex` or `claude_code`;
- `AGENT_CLUSTER_WORKTREE_EXECUTION` is not `false`.

The selected directory must currently be the Git repository root. A non-Git directory or a selected subdirectory fails closed before the CLI starts.

## Lifecycle

```text
InvocationPlan
  -> prepare or restore sessionId/taskId worktree
  -> copy current tracked and safe untracked changes into a detached baseline
  -> commit the baseline only inside the detached worktree
  -> bind invocationId to the isolated execution directory
  -> start Codex CLI or Claude Code
  -> let the CLI read, edit, and run tests in that directory
  -> calculate WorkspaceChangeSet from the real Git/filesystem delta
  -> release the invocation binding
```

Each `sessionId/taskId` pair has its own worktree. Two sessions selecting the same repository therefore receive different physical directories and cannot overwrite one another while their CLIs run.

The source branch, source index, and source working tree are never reset, checked out, staged, or committed by this module.

## Dirty Baseline

The worktree starts from the source `HEAD`, then receives:

- tracked staged and unstaged changes through a binary Git patch;
- safe untracked regular files through bounded file copies.

That state is committed inside the detached worktree as the task baseline. The manifest records SHA-256 hashes from the source working tree's real bytes, not Git blob bytes. This keeps conflict detection correct on Windows repositories using CRLF checkout conversion.

## Change Authority

CLI-reported file changes are advisory. The authoritative result is `RuntimeWorkspaceExecution.changeSet`, calculated by the platform after the runtime finishes.

The returned result has these properties:

- `mode` is `git_worktree`;
- all file changes are marked `runtime_proposed_change`;
- a `code_diff` artifact carries the same `WorkspaceChangeSet`;
- `requiresUserConfirmation` is always `true`;
- Orchestrator automatic source writes are disabled for managed results.

The ChangeSet is intended for a separate confirmation and normal Workspace Provider apply step. Existing expected hashes detect source changes that happened after the baseline was captured.

## Persistence Layout

The default root is:

```text
${AGENT_CLUSTER_DATA_DIR}/execution-worktrees/
  manifests/<session>/<task>.json
  runs/<session>/<task>/
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

## Known Limits

The limits below apply to the server-local Git worktree path.

- v1 accepts only a selected Git repository root.
- ChangeSets currently support UTF-8 regular files; binary and symlink changes are rejected.
- Worktree cleanup/retention policy is operational follow-up work; worktrees are retained for task resume and audit.
- Approval and ChangeSet application remain outside this module.

## Local Runtime boundary

Managed worktrees apply only to `server_local` execution. A `local_bridge` invocation runs through the Local Runtime CLI on the user's machine and never materializes the local directory on the server. The retired browser mirror/writeback path is not a supported fallback.
