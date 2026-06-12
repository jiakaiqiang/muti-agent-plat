# Knowledge Deposit

> 最后修改时间：2026-06-12 11:20:34 +08:00
> 修改人：Claude Code
> 修改的 Agent：Claude Code

## 沉淀目标文件

- docs/harness-engineering/runs/（每次交付一条记录，首次沉淀时创建）
- docs/ai-agent-context/project-map.md（项目知识：模块边界、入口、约束）
- docs/design/（被采纳或否决的设计决策）
- docs/quality/（失败模式与验收经验）
- docs/ai-agent-context/（用户偏好与 Agent 工作方式）

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
