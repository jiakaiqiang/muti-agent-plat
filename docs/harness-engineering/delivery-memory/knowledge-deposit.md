# Knowledge Deposit

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

## 沉淀目标文件

- docs/harness-engineering/runs/
- docs/project-map.md
- docs/known-failures.md
- docs/agent-guidelines.md

### 项目知识

Stable module boundaries, entry points, and project constraints.

### 设计决策

Adopted and rejected design choices, reasons, and reevaluation conditions.

### 失败模式

Repeatable failure causes, prevention, and feedback-loop target stages.

### 验收经验

Evidence types that actually prove acceptance criteria.

### 用户偏好

Explicit, reusable user preferences.

## runs/ record format

record: delivery_memory

Fields: runId, sourceDelivery, category, summary, evidence, depositTarget, staleCondition.

## Rubric

- The deposit belongs to one of the five categories.
- Evidence exists.
- The target file is named.
