# 04 Stage Workflow 阶段工作流

> 最后修改时间：2026-06-11 14:47:47 +08:00
> 修改人：Codex
> 修改的 Agent：Codex

## 目的

规定一次 Agent 协作交付如何按阶段推进。

## 标准流程

```text
Requirement
  -> Design
  -> Planning
  -> Implementation
  -> Verification
  -> Review
  -> Delivery
```

## 阶段规则

### Requirement

输入：

- 用户原始需求

输出：

- Intent Contract

退出条件：

- 需求目标明确。
- 验收标准可判断。
- 待确认问题已处理。

### Design

输入：

- Intent Contract
- Project Context

输出：

- Design Plan
- Architecture Constraints

退出条件：

- 每条验收标准都有设计覆盖。
- 影响范围明确。
- 风险与取舍明确。
- 已产出本次任务必须遵守的 Architecture Constraints：
  - `module_boundaries`：模块边界。
  - `ownership_boundaries`：所属职责边界。
  - `dependency_direction`：依赖方向。
  - `contract_stability`：契约稳定性。
  - `allowed_change_scope`：允许修改范围。
  - `forbidden_change_scope`：禁止修改范围。
  - `invariants`：不变量。

### Planning

输入：

- Design Plan

输出：

- Task Plan

退出条件：

- 任务有负责人。
- 任务有依赖关系。
- 任务有允许范围。
- 架构约束已转换为 `allowedPaths` / `forbiddenPaths`。
- 任务有验收标准。

### Implementation

输入：

- Task Plan
- Tool Governance

输出：

- Implementation Summary

退出条件：

- 实现内容有摘要。
- 变更范围可说明。
- 偏差已记录。

### Verification

输入：

- Intent Contract
- Implementation Summary

输出：

- Verification Result

退出条件：

- 每条验收标准都有证据。
- 缺陷或阻塞已分类。

### Review

输入：

- 全过程阶段产物

输出：

- Approve / Rework / Ask User / Fail

退出条件：

- 评审结论明确。
- 架构不变量未被破坏。
- 如需返工，目标阶段明确。

### Delivery

输入：

- 全部阶段产物
- Review 结论

输出：

- Final Delivery
- Delivery Memory

退出条件：

- 完成项、未完成项、风险、后续建议明确。

## 硬规则

- 阶段之间必须通过结构化产物交接。
- 不能跳过 Requirement 直接 Design。
- 不能跳过 Design 直接 Implementation。
- Review 未通过不能 Delivery。
