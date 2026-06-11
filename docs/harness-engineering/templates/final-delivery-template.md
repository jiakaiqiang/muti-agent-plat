# Final Delivery 最终交付模板

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

> 规程来源：[README.md](../README.md) §8 Stage Workflow、§12 Delivery Memory
> 阶段：`delivery`　产出 Agent：`coordinator` / `notification`
> 输入：全部产物　输出：Final Delivery

## 使用说明

- 这是 Delivery 阶段的最终交付产物，用于向用户说明交付结果和剩余风险。
- 本模板只约束工程交付内容；如后续接入系统功能，可再映射到事件或 artifact。
- Notification Agent 仅创建 `feishu_draft` 草稿，**不直接对外发送**；外发需显式确认（见 [05-tool-governance.md](../05-tool-governance.md)）。
- 交付不是结束：必须按 §12 同步沉淀 Delivery Memory。

---

## 模板正文

```markdown
---
artifact: final_delivery
stage: delivery
producedBy: coordinator
schemaVersion: "0.1"
status: draft            # draft | delivered
deliveryId: <本次交付编号>
createdAt: <ISO 8601>
reviewReportRef: <评审报告编号或标题>
---

# Final Delivery: <标题>

## 交付摘要 (Summary)
- 本次交付一句话总结。

## 已完成项 (Completed Items)
- 对照 Intent Contract 验收标准，逐条说明已满足项。

## 未完成项 (Incomplete Items)
- 未交付/延后项 + 原因（无写 `无`）。

## 范围外改动 (Out-of-scope Changes)
- 偏离原始范围的改动 + 已获确认情况（无写 `无`）。

## 测试结果 (Test Results)
- 引用 Verification Result 的关键结论与命令。

## 剩余风险 (Risks)
- 交付后仍存在的风险与建议跟进。

## 关联产物 (Artifacts)
- intent_contract / design_plan / task_plan / implementation_summary / verification_summary / review_report 的引用列表。

## 交付记忆沉淀 (Delivery Memory) — 见 README §12
- 能力域 (capability domain): ...
- 涉及代码路径: ...
- 被采用的设计决策: ...
- 出现过的失败模式: ...
- 有效的验证方式: ...
- 需要记住的用户偏好: ...
- 沉淀位置: docs/harness-engineering/runs/ | docs/project-map.md | docs/known-failures.md | docs/agent-guidelines.md
```

---

## 完成标准 (Definition of Done)

- 七个交付小节齐全；“已完成项”可逐条追溯到 Intent Contract 验收标准。
- “范围外改动”要么为 `无`，要么每条均已获确认。
- “关联产物”列出全过程产物引用，形成可追溯链。
- “交付记忆沉淀”已填写并指明沉淀位置（[README.md](../README.md) §12）。
- 仅在 Review `decision = approve` 后才允许 `status = delivered`。

## 交接 (Handoff)

- 终点阶段：`completed`。
- 反向增强：将 Delivery Memory 写入对应项目知识文件，让每次交付沉淀为项目知识。

