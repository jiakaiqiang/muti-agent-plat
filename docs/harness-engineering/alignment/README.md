# Phase 2 Runtime Alignment 运行时对齐

> 本目录属于 reference 层：解释 Agent Cluster 如何映射 Harness，不定义 Harness 本体。

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

## 工程化定位

Runtime Alignment 把一套既有的协作流程对齐到 Harness Engineering 上。它不是功能开发，不是 API 设计，也不是某个项目独有的约定。Agent Cluster 是当前参考实例；这套方法同样适用于任何需要协调 Agent、人工、工具、阶段、决策与交付记忆的团队。

## 对齐结论矩阵

| 对象 | 程度 | 说明 |
| --- | --- | --- |
| SessionStatus | 部分 | WAIT_USER_CONFIRM、EXECUTING、COMPLETED、FAILED、CANCELLED 已经具备阶段含义，review 与 rework 还需要更清晰的治理语义。 |
| AgentRunPhase | 部分 | discussion、brief_generation、brief_revision、task_execution、post_review、final_delivery、user_message_routing 已映射到阶段工作流。 |
| Events | 部分 | metadata.payload 应承载结构化决策，而不是只依赖聊天内容。 |
| Artifacts | 部分 | ArtifactType 表达物料形式，harnessArtifactType 表达工程角色。 |

## 来源文档

- session-alignment.md
- orchestrator-alignment.md
- events-alignment.md
- artifacts-alignment.md
- gap-analysis.md

## metadata.payload

所有可复用实现都应把 `stage`、`decision`、`targetStage`、`artifactId`、`confirmationId`、`harnessArtifactType` 这些事实放进 `metadata.payload`（如果存在的话）。

## 后续阶段

Phase 3 绑定 prompt / context 行为，Phase 4 绑定 capability 治理，Phase 5 绑定交付记忆。
