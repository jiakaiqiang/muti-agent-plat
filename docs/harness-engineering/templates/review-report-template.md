# Review Report 评审报告模板

> 规程来源：[README.md](../README.md) §7 Agent Role Protocol、§11 Feedback Loop
> 阶段：`review`　产出 Agent：`review`
> 输入：全过程产物　输出：Approve / Rework / Ask User

## 使用说明

- 这是 Review 阶段的交接产物，决定是否进入 Delivery 或回到前序阶段。
- Review Agent **独立评审，可以要求返工**（见 [03-agent-role-protocol.md](../03-agent-role-protocol.md)）。
- 评审是跨阶段一致性检查：Intent Contract、Design Plan、Implementation Summary、Verification Result、变更文件是否互相对齐。
- 决策为 `approve` / `rework` / `ask_user` / `fail`。要求返工时必须给出目标阶段。

---

## 模板正文

```markdown
---
artifact: review_report
stage: review
producedBy: review
schemaVersion: "0.1"
status: draft            # draft | final
decision: pending        # approve | rework | ask_user | fail
targetStage:             # rework 时必填: requirement|design|planning|implementation|verification
deliveryId: <本次交付编号>
createdAt: <ISO 8601>
---

# Review Report: <标题>

## 评审输入 (Reviewed Artifacts)
- intent_contract: <id>
- design_plan: <id>
- task_plan: <id>
- implementation_summary: <id>
- verification_summary: <id>

## 一致性检查 (Consistency Checks)
- [ ] 实现覆盖了 Intent Contract 全部目标与验收标准
- [ ] 未引入契约外 / 范围外改动（对照 Design 与 Task Plan）
- [ ] 验证结论可信，证据充分
- [ ] 风险已被识别并有处置
- [ ] 高风险工具调用均合规且已确认

## 发现 (Findings)
- F1：维度（需求/设计/实现/验证/范围/权限）— 严重度（blocker/major/minor）— 描述 — 证据。

## 范围变化 (Scope Changes)
- 评审中是否发现范围扩大/缩小；若有，必须走 Human Intervention（见 README §10）。

## 决策 (Decision)
- decision: approve | rework | ask_user | fail
- 理由 (reason): ...
- 若 rework：targetStage + 需要修正的产物 + 修正要点。
- 若 ask_user：需要用户确认的问题清单。
```

---

## 完成标准 (Definition of Done)

- “评审输入”列全所有上游 artifact 引用。
- “一致性检查”逐项给出结论。
- 每个 `blocker` / `major` 发现都映射到一个决策（rework 的 `targetStage`，或 ask_user 的问题）。
- `decision` 明确，且与 [07-feedback-loop.md](../07-feedback-loop.md) 的回退路径一致。
- 仅当 `decision = approve` 时才进入 Delivery 阶段。

## 交接 (Handoff)

- approve -> Delivery Agent（Delivery 阶段）。
- rework -> 按 `targetStage` 回退，并在 [07-feedback-loop.md](../07-feedback-loop.md) 记录返工原因。
- ask_user -> [Human Intervention](../06-human-intervention.md)，记录确认人/内容/原因/回到的阶段。

