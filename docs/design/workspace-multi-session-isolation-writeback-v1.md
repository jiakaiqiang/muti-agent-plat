# Workspace Multi-Session Isolation and Writeback v1

## Purpose

The same `server_local` or `local_bridge` workspace may be bound to multiple active Sessions. Session creation is never rejected only because another Session uses the same directory.

Concurrency safety is enforced at execution and writeback time:

```text
Session A/B
  -> independent task execution directory
  -> authoritative WorkspaceChangeSet
  -> per-workspace FIFO writeback
  -> path hash validation
  -> conservative three-way merge when possible
  -> durable conflict resolution when not possible
```

## Execution matrix

| Workspace | Task | Isolation | Concurrency |
| --- | --- | --- | --- |
| `server_local`, Git | Codex/Claude write | detached worktree per Session/task | parallel execution, FIFO writeback |
| `server_local`, non-Git | Codex/Claude write | baseline + staging copy per Session/task | serialized per normalized source directory |
| `server_local` | read-only | source Provider | parallel |
| `local_bridge` | Codex/Claude write | Local Runtime temporary staging copy | parallel execution, FIFO Provider writeback |
| `local_bridge` | read-only | registered Local Provider | parallel |

`proposal_only` never enters automatic writeback. Normal write-capable task execution does.

## Change authority

Runtime-reported file lists are advisory. Git worktree diff or staging-directory diff produces the authoritative `WorkspaceChangeSet`.

- create carries candidate UTF-8 content;
- update carries candidate content, `expectedHash`, and baseline content;
- delete carries `expectedHash` and baseline content;
- move carries source and destination paths plus source `expectedHash`.

Binary, non-UTF-8, symlink, sensitive-path, out-of-scope, oversized, and over-count changes fail closed.

## Writeback state machine

```text
queued -> merging -> applying -> applied
                    |            |
                    +-> conflicted
                    +-> failed

conflicted/failed -> queued (retry or force)
conflicted/failed -> abandoned
```

The Session enters `APPLYING_CHANGES` during automatic writeback. A conflict or Provider failure moves it to `WAIT_WORKSPACE_CONFLICT_RESOLUTION`, and the affected task remains `waiting`. Parallel tasks may create multiple writeback records; the Session resumes only after every `conflicted` or `failed` record is resolved. The UI renders every blocking record rather than only the latest one.

Resolution is a strict terminal transition. Only `conflicted` or `failed` records accept a resolution action; replayed or competing actions against an already `applied` or `abandoned` record are rejected. Operations for one writeback record and writes for one workspace are serialized in process.

## Merge and atomicity

If an update hash changed and baseline content is available, the Provider compares `base`, current workspace, and Session candidate. Non-overlapping line edits merge automatically. Overlapping edits return `WORKSPACE_MERGE_CONFLICT`.

Before apply, every touched path is snapshotted. An apply-time race or filesystem error restores the entire batch. Rollback first verifies that a path still equals the value written by the batch; a later user edit is never overwritten and instead raises `WORKSPACE_ROLLBACK_REQUIRES_ATTENTION` (or the Local Runtime equivalent). No conflict path is silently overwritten.

## User resolution

- `retry_merge`: validate and merge again against the current workspace.
- `resolve_with_agent`: abandon the old candidate, discard the old Server isolation directory, rebuild from the current workspace, and rerun the task.
- `keep_workspace`: keep current files, abandon the candidate, and continue.
- `use_session`: force the Session candidate after exact writeback-id confirmation.
- `abandon_writeback`: explicitly discard the candidate and continue.

Applied or abandoned writebacks complete the waiting task and resume unfinished execution. Workflow nodes stay non-terminal while a writeback waits for resolution.

For `local_bridge`, a consumed one-time `workspace_delete` grant is bound to the exact produced ChangeSet by `workspaceId`, ChangeSet ID, and a canonical SHA-256 digest of the complete ChangeSet. The grant lives across WebSocket reconnects in the running bridge process, remains usable for that ChangeSet's later Provider writeback, is consumed only after a successful apply, and expires after 30 minutes. It does not authorize another or mutated ChangeSet.

## Recovery

Writeback records are persisted in both file-backed state and PostgreSQL migration V4 (`agent_cluster.workspace_writebacks`). On backend restart, `queued`, `merging`, or `applying` records become retryable `failed` records. Sessions left in `APPLYING_CHANGES` become `WAIT_WORKSPACE_CONFLICT_RESOLUTION`. Runtime commands are not replayed automatically.

## Limits

- FIFO and non-Git directory leases are process-local; multi-replica deployment requires a distributed lock keyed by `workspaceId` before cross-replica concurrent writers are enabled.
- ChangeSet payloads currently support bounded UTF-8 regular files only.
- Managed execution directory retention and garbage collection remain operational follow-up work.
