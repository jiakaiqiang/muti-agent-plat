# Implementation Summary 实现摘要模板

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

> 规程来源：[README.md](../README.md) §8 Stage Workflow、§9 Tool Governance
> 阶段：`implementation`　产出 Agent：`backend` / `frontend` / `notification`
> 输入：Task Plan + Tool Policy　输出：Implementation Summary

## 使用说明

- 这是 Implementation 阶段的交接产物，供 Verification 与 Review 阶段继续使用。
- Implementation Agent **只按设计执行，不擅自扩大范围**（见 [03-agent-role-protocol.md](../03-agent-role-protocol.md)）。
- 任何超出 Task Plan `allowedPaths` 或 `toolPolicy` 的改动，必须在“范围偏差”中显式记录并触发返工或确认。
- 高风险工具调用必须有确认和留痕，具体按 Tool Governance 执行。

---

## 模板正文

```markdown
---
artifact: implementation_summary
stage: implementation
producedBy: backend        # backend | frontend | notification（多 Agent 时各自产出，再汇总）
schemaVersion: "0.1"
status: draft              # draft | ready
deliveryId: <本次交付编号>
createdAt: <ISO 8601>
taskPlanRef: <任务计划编号或标题>
---

# Implementation Summary: <标题>

## 完成的任务 (Completed Tasks)
- T1 <标题>: 做了什么 / 结果
- T2 <标题>: ...

## 变更文件 (Changed Files)
- `path/to/file` — 新增 | 修改 | 删除 — 变更说明
- 所有条目应落在 Task Plan 的 allowedPaths 内。

## 关键实现说明 (Implementation Notes)
- 重要的实现思路、数据流、与设计的对应关系。

## 范围偏差 (Deviations from Plan)
- 与 Design / Task Plan 不一致之处；若无写 `无`。
- 每条偏差需说明：原因 + 是否已获确认 + 是否需返工。

## 工具调用记录 (Tool Invocations)
- tool.file_write: <次数 / 目标>
- tool.command_run: <命令 / 结果 / 是否已确认>
- 无高风险调用写 `无`。

## 自检 (Self-check)
- [ ] 改动均在 allowedPaths 内
- [ ] 未引入契约外的破坏性变更
- [ ] 本地构建 / 类型检查通过（或说明原因）

## 待验证项 (For Verification)
- 提示 Verification 阶段需重点验证的点。
```

---

## 完成标准 (Definition of Done)

- “变更文件”全部落在 Task Plan 的 `allowedPaths` 内，否则在“范围偏差”说明并处理。
- “范围偏差”给出明确结论（无 / 已确认 / 需返工）。
- 高风险工具调用均有记录且符合 [05-tool-governance.md](../05-tool-governance.md)。
- 自检清单已逐项确认。
- `status = ready` 后才进入 Verification 阶段。

## 交接 (Handoff)

- 下游消费者：Test Agent（Verification 阶段）。
- 若实现阶段发现设计有缺陷：按 [07-feedback-loop.md](../07-feedback-loop.md) 回退到 `design`，不要在实现阶段“顺手改设计”。

