# Task Plan 任务计划模板

> 最后修改时间：2026-06-12 11:20:34 +08:00
> 修改人：Claude Code
> 修改的 Agent：Claude Code

> 规程来源：[04-stage-workflow.md](../04-stage-workflow.md)、[05-tool-governance.md](../05-tool-governance.md)
> 阶段：`planning`　产出 Agent：`coordinator`
> 输入：Design Plan　输出：Task Plan

## 使用说明

- 这是 Planning 阶段的交接产物，供 Implementation 阶段继续使用。
- 每个任务必须能够追溯到 Design Plan 与 Intent Contract。
- 每个任务必须明确：负责 Agent、依赖、**允许修改的文件范围**、**工具权限**、验收标准。
- 文件范围与工具权限是 Implementation 阶段的硬边界，越界即视为返工（见 [05-tool-governance.md](../05-tool-governance.md)）。

---

## 模板正文

```markdown
---
artifact: task_plan
stage: planning
producedBy: coordinator
schemaVersion: "0.1"
status: draft            # draft | ready
deliveryId: <本次交付编号>
createdAt: <ISO 8601>
designPlanRef: <设计方案编号或标题>
---

# Task Plan: <标题>

## 任务拆解 (Task Breakdown)

### T1 <任务标题>
- 负责 Agent (assignee): backend            # coordinator|requirements|architect|frontend|backend|test|review|notification
- 依赖 (dependsOn): []                        # 例如 [T0]
- 允许修改的文件范围 (allowedPaths):
  - apps/server/src/modules/<module>/**
- 禁止修改的文件范围 (forbiddenPaths):
  - apps/server/src/modules/<other-module>/**
- 工具权限 (toolPolicy):
  - tool.file_write: required
  - tool.command_run: on-demand            # required | on-demand | denied
- 验收标准 (acceptanceCriteria):
  - [ ] ...
- 备注 (notes): 无

### T2 <任务标题>
- 负责 Agent (assignee): test
- 依赖 (dependsOn): [T1]
- 允许修改的文件范围 (allowedPaths):
  - tests/**
- 禁止修改的文件范围 (forbiddenPaths):
  - apps/**
- 工具权限 (toolPolicy):
  - tool.command_run: required
- 验收标准 (acceptanceCriteria):
  - [ ] ...

## 依赖关系 (Dependency Graph)
- T1 -> T2

## 范围与权限总览 (Scope & Policy Summary)
- 所有任务允许触及的文件范围合集。
- 所有任务禁止触及的文件范围合集（forbiddenPaths）。
- 涉及的高风险能力（tool.file_write / tool.command_run）清单，及确认要求。

## 风险与排序 (Risks & Sequencing)
- 关键路径、并行项、阻塞风险。
```

---

## 完成标准 (Definition of Done)

- 每个任务都有：负责 Agent、依赖、允许修改文件范围、工具权限、验收标准。
- 每个任务都声明 `allowedPaths` 与 `forbiddenPaths`。
- 所有任务的验收标准合并后可覆盖 Intent Contract 的全部验收标准。
- 依赖关系无环；关键路径已标注。
- 高风险工具（`tool.file_write` / `tool.command_run`）已在“范围与权限总览”登记。
- `status = ready` 后才进入 Implementation 阶段。

## 交接 (Handoff)

- 下游消费者：Backend / Frontend / Notification Agent（Implementation 阶段）。
- 若拆解粒度或依赖有误：按 [07-feedback-loop.md](../07-feedback-loop.md) 回退到 `planning`。
