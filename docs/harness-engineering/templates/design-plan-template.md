# Design Plan 设计方案模板

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

> 规程来源：[README.md](../README.md) §6 Context Protocol、§8 Stage Workflow
> 阶段：`design`　产出 Agent：`architect`
> 输入：Intent Contract + Project Context　输出：Design Plan

## 使用说明

- 这是 Design 阶段的交接产物，供 Planning 阶段继续使用。
- Architect Agent 只负责设计与影响范围，**不直接实现**（见 [03-agent-role-protocol.md](../03-agent-role-protocol.md)）。
- 设计必须可追溯到 Intent Contract 的每条验收标准；不允许引入契约外的新目标。
- 涉及 `docs/contracts` 契约变更时，必须在“契约影响”小节列出。

---

## 模板正文

```markdown
---
artifact: design_plan
stage: design
producedBy: architect
schemaVersion: "0.1"
status: draft            # draft | ready
deliveryId: <本次交付编号>
createdAt: <ISO 8601>
intentContractRef: <需求契约编号或标题>
---

# Design Plan: <标题>

## 方案概述 (Overview)
- 总体思路；如何满足 Intent Contract 的目标。

## 架构与模块边界 (Architecture & Module Boundaries)
- 涉及哪些模块（如 apps/server/src/modules/*、apps/web、packages/shared）。
- 模块职责与边界，新增 / 修改 / 复用。

## 影响范围 (Impact Scope)
- 受影响的代码路径（目录 / 文件级）。
- 受影响的运行时、数据、前端视图。

## 契约影响 (Contract Impact)
- API / Data / Event / Runtime / UI-State 契约是否变化。
- 若变化：变更点 + 是否破坏 v0.1 兼容性。无变化写 `无`。

## 数据与状态流 (Data & State Flow)
- 关键数据流动、状态机变化、持久化 collection 影响。

## 设计决策与取舍 (Decisions & Trade-offs)
- 决策点 / 选择 / 被否决的备选 / 理由。

## 备选方案 (Alternatives)
- 至少记录一个被放弃的方案及原因（高影响时需多方案，见 Human Intervention）。

## 风险与缓解 (Risks & Mitigations)
- 设计层面风险 + 缓解措施。

## 对验收标准的覆盖 (Acceptance Mapping)
- 验收标准 1 -> 由哪部分设计满足
- 验收标准 2 -> ...
```

---

## 完成标准 (Definition of Done)

- 每条 Intent Contract 验收标准都能在“对验收标准的覆盖”中找到对应设计。
- “契约影响”明确给出结论（无变化 / 具体变更 + 兼容性判断）。
- 高影响多方案场景已在“备选方案”记录，并按需触发 [Human Intervention](../06-human-intervention.md)。
- `status = ready` 后才进入 Planning 阶段。

## 交接 (Handoff)

- 下游消费者：Coordinator Agent（Planning 阶段）。
- 若发现 Intent Contract 不足以支撑设计：按 [07-feedback-loop.md](../07-feedback-loop.md) 回退到 `requirement`。

