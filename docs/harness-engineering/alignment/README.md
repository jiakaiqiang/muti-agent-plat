# Phase 2 Runtime Alignment

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

## 工程化 positioning

Runtime Alignment maps an existing collaboration process to Harness Engineering. It is not feature work, not API design, and not a project-only convention. Agent Cluster is the current reference instance; the method is reusable for any team that coordinates agents, humans, tools, stages, decisions, and delivery memory.

## 对齐结论矩阵

| Object | Degree | Notes |
| --- | --- | --- |
| SessionStatus | 部分 | WAIT_USER_CONFIRM, EXECUTING, COMPLETED, FAILED, and CANCELLED already carry stage meaning, while review and rework still need sharper governance semantics. |
| AgentRunPhase | 部分 | discussion, brief_generation, brief_revision, task_execution, post_review, final_delivery, and user_message_routing map to the stage workflow. |
| Events | 部分 | metadata.payload should carry structured decisions instead of relying on chat content alone. |
| Artifacts | 部分 | ArtifactType stores the material; harnessArtifactType should express the engineering role. |

## Source documents

- session-alignment.md
- orchestrator-alignment.md
- events-alignment.md
- artifacts-alignment.md
- gap-analysis.md

## metadata.payload

All reusable implementations should put stage, decision, targetStage, artifactId, confirmationId, and harnessArtifactType in metadata.payload when those facts exist.

## 后续阶段

Phase 3 binds prompt/context behavior, Phase 4 binds capability governance, and Phase 5 binds delivery memory.
