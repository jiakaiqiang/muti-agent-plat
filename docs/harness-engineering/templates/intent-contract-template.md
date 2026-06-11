# Intent Contract 需求契约模板

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

> 规程来源：[README.md](../README.md) §5 Intent Contract、§8 Stage Workflow
> 阶段：`requirement`　产出 Agent：`requirements`
> 工程规则：**没有 Intent Contract，不进入设计。**

## 使用说明

- 这是 Requirement 阶段的交接产物，供 Design 阶段继续使用。
- 本模板只约束工程交付内容；如后续接入系统功能，可再映射到事件或 artifact。
- 复制下方“模板正文”，逐项填写。不要删除任何小节标题；没有内容写 `无` 或 `待确认`。
- 存在 `待确认` 项时 `requiresHumanIntervention` 必须为 `true`，并进入 [Human Intervention](../06-human-intervention.md)。

---

## 模板正文

```markdown
---
artifact: intent_contract
stage: requirement
producedBy: requirements
schemaVersion: "0.1"
status: draft            # draft | confirmed
deliveryId: <本次交付编号>
createdAt: <ISO 8601>
requiresHumanIntervention: false
---

# Intent Contract: <一句话标题>

## 目标 (Goal)
- 用一句话说明本次交付要达成什么。

## 背景 (Background)
- 为什么现在要做；触发需求的用户原话或场景。

## 非目标 (Non-goals / Out of Scope)
- 明确不做的事，防止范围蔓延。

## 约束 (Constraints)
- 技术约束、契约约束（如保持 v0.1 契约稳定）、时间或资源约束。

## 验收标准 (Acceptance Criteria)
- [ ] 可验证标准 1（可被 Verification 阶段客观判定）
- [ ] 可验证标准 2

## 风险 (Risks)
- 风险点 + 影响 + 初步应对方向。

## 需要用户确认的问题 (Open Questions)
- 问题 1（必须由用户回答，未答前不进入 Design）
```

---

## 完成标准 (Definition of Done)

- 七个小节（目标 / 背景 / 非目标 / 约束 / 验收标准 / 风险 / 需要用户确认的问题）齐全。
- 验收标准均为**可客观验证**的条目，而非主观描述。
- 所有 `待确认` 问题要么被解决，要么 `requiresHumanIntervention = true`。
- `status` 标记为 `confirmed` 后，才允许进入 Design 阶段。

## 交接 (Handoff)

- 下游消费者：Architect Agent（Design 阶段）。
- 关联规程：[03-agent-role-protocol.md](../03-agent-role-protocol.md)、[07-feedback-loop.md](../07-feedback-loop.md)。
- 若 Design/Review 阶段发现需求不清，按 Feedback Loop 回退到 `requirement` 并更新本契约版本。

